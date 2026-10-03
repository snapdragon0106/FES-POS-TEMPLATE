import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Cashless payment tests.
 *
 * The whole point of these is the boundary between "a payment happened"
 * and "a sale happened". Everything worth breaking lives there: paying
 * once and booking twice, booking a sale for a payment that never
 * completed, and a webhook that claims a different amount than we
 * charged.
 */

// Mutable env stand-in so a single test can turn cashless off again.
// vi.hoisted because vi.mock is hoisted above ordinary const declarations.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    appId: "",
    cookieSecret: "test-only-secret-not-used-in-production-xxxxxxxx",
    databaseUrl: "",
    oAuthServerUrl: "",
    ownerOpenId: "",
    isProduction: false,
    forgeApiUrl: "",
    forgeApiKey: "",
    paymentProvider: "mock",
    paymentMethods: "",
    paymentWebhookSecret: "test-webhook-secret",
    paymentTerminalLaunchUrl: "",
    paymentTerminalCallbackUrl: "",
    paymentTerminalLabel: "",
  },
}));

vi.mock("./_core/env", () => ({ ENV: mockEnv }));

vi.mock("./posAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./posAuth")>();
  return {
    ...actual,
    createPosSessionToken: vi.fn().mockResolvedValue("mock-token"),
    verifyPosSession: vi.fn(),
    // The 合言葉 cookie is checked for real in its own tests below; every
    // other test runs as a browser that has entered it.
    verifyGate: vi.fn().mockResolvedValue(true),
    setGateCookie: vi.fn(),
    setPosSessionCookie: vi.fn(),
    clearPosSessionCookie: vi.fn(),
  };
});

/**
 * In-memory stand-in for the payments table. Unlike a bag of vi.fn()s,
 * this reproduces the two behaviours the real DB layer relies on:
 * settlePaymentStatus only moves a payment out of an open state, and
 * createTransactionSerialized stamps transactionId onto the payment it
 * consumed. Tests that assert "cannot be spent twice" are meaningless
 * against a mock that doesn't model that.
 */
const { store } = vi.hoisted(() => ({
  store: {
    payments: new Map<number, any>(),
    nextPaymentId: 1,
    products: [] as any[],
    transactions: [] as any[],
    restocks: [] as any[],
    nextTransactionId: 1,
  },
}));

vi.mock("./db", () => {
  const listProducts = vi.fn(async () => store.products);
  const listTransactions = vi.fn(async () => store.transactions);
  const listRestocks = vi.fn(async () => store.restocks);

  return {
    listProducts,
    listTransactions,
    listRestocks,
    createActivityLog: vi.fn(),
    getMemberPin: vi.fn(),
    upsertMemberPin: vi.fn(),

    createPayment: vi.fn(async (data: any) => {
      const id = store.nextPaymentId++;
      store.payments.set(id, { id, transactionId: null, errorMessage: null, ...data });
      return id;
    }),
    getPaymentById: vi.fn(async (id: number) => store.payments.get(id)),
    getPaymentByProviderId: vi.fn(async (provider: string, providerPaymentId: string) =>
      [...store.payments.values()].find(
        (p) => p.provider === provider && p.providerPaymentId === providerPaymentId
      )
    ),
    getPaymentByOrderRef: vi.fn(async (orderRef: string) =>
      [...store.payments.values()].find((p) => p.orderRef === orderRef)
    ),
    updatePayment: vi.fn(async (id: number, data: any) => {
      const existing = store.payments.get(id);
      if (existing) store.payments.set(id, { ...existing, ...data });
    }),
    settlePaymentStatus: vi.fn(async (id: number, status: string, extra?: any) => {
      const existing = store.payments.get(id);
      // Mirrors the real WHERE status IN ('pending','authorized') guard.
      if (!existing || !["pending", "authorized"].includes(existing.status)) return false;
      store.payments.set(id, { ...existing, status, ...(extra ?? {}) });
      return true;
    }),
    listPayments: vi.fn(async () => [...store.payments.values()]),
    listOpenPayments: vi.fn(async () =>
      [...store.payments.values()].filter((p) => ["pending", "authorized"].includes(p.status))
    ),
    deleteAllPayments: vi.fn(),

    createTransactionSerialized: vi.fn(async (_ids: number[], build: (tx: any) => Promise<any>) => {
      const data = await build({
        listProducts,
        listTransactions,
        listRestocks,
        listOpenPayments: async () =>
          [...store.payments.values()].filter((p) => ["pending", "authorized"].includes(p.status)),
        lockPayment: async (paymentId: number) => store.payments.get(paymentId),
      });
      const id = store.nextTransactionId++;
      store.transactions.push({ id, voided: false, createdAt: new Date(), ...data });
      if (data.paymentId != null) {
        const payment = store.payments.get(data.paymentId);
        if (payment) store.payments.set(data.paymentId, { ...payment, transactionId: id });
      }
      return { id, duplicate: false };
    }),
  };
});

function createTestContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: { cookie: "pos_session=mock-token" } } as unknown as TrpcContext["req"],
    res: { clearCookie: vi.fn(), cookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

const ADMIN = "3509";
const NON_ADMIN = "3501";
const TAKOYAKI = { id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, initialStock: 50, threshold: 10, displayOrder: 1 };

describe("Cashless payments", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let posAuth: any;
  let payments: typeof import("./payments");

  beforeEach(async () => {
    vi.clearAllMocks();
    store.payments.clear();
    store.nextPaymentId = 1;
    store.transactions = [];
    store.restocks = [];
    store.nextTransactionId = 1;
    store.products = [{ ...TAKOYAKI }];

    mockEnv.paymentProvider = "mock";
    mockEnv.paymentMethods = "";
    mockEnv.isProduction = false;
    mockEnv.paymentTerminalLaunchUrl = "";

    payments = await import("./payments");
    payments.resetPaymentProviderCache();

    posAuth = await import("./posAuth");
    (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
    caller = appRouter.createCaller(createTestContext());
  });

  describe("payment.config", () => {
    it("reports cashless as disabled when no provider is configured", async () => {
      mockEnv.paymentProvider = "";
      payments.resetPaymentProviderCache();

      const config = await caller.payment.config();

      expect(config.cashlessEnabled).toBe(false);
      expect(config.provider).toBeNull();
      // Cash is always offered — a shop that can't take money is worse
      // than a shop with no cashless.
      expect(config.methods).toEqual(["cash"]);
    });

    it("lists the provider's methods, always including cash", async () => {
      const config = await caller.payment.config();

      expect(config.cashlessEnabled).toBe(true);
      expect(config.provider).toBe("mock");
      expect(config.methods[0]).toBe("cash");
      expect(config.methods).toContain("paypay");
    });

    it("narrows the offered methods to PAYMENT_METHODS", async () => {
      mockEnv.paymentMethods = "paypay";
      payments.resetPaymentProviderCache();

      const config = await caller.payment.config();

      expect(config.methods).toEqual(["cash", "paypay"]);
    });

    it("rejects an unknown PAYMENT_PROVIDER rather than silently falling back to cash", async () => {
      mockEnv.paymentProvider = "paypya"; // typo of "paypay"
      payments.resetPaymentProviderCache();

      await expect(caller.payment.config()).rejects.toThrow("未知の決済プロバイダ");
    });

    it("refuses the mock provider in production", async () => {
      mockEnv.isProduction = true;
      payments.resetPaymentProviderCache();

      await expect(caller.payment.config()).rejects.toThrow("本番環境では使用できません");
    });
  });

  describe("payment.createIntent", () => {
    it("prices the cart from the product master, not from the client", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });

      expect(intent.amount).toBe(800);
      expect(intent.status).toBe("pending");
      expect(intent.transactionId).toBeNull();
    });

    it("rejects cash — no provider round-trip is needed to take cash", async () => {
      await expect(
        caller.payment.createIntent({ method: "cash", items: [{ product_id: 1, qty: 1 }] })
      ).rejects.toThrow("現金の会計に決済の開始は不要です");
    });

    it("rejects a method the provider does not offer", async () => {
      mockEnv.paymentMethods = "paypay";
      payments.resetPaymentProviderCache();

      await expect(
        caller.payment.createIntent({ method: "credit", items: [{ product_id: 1, qty: 1 }] })
      ).rejects.toThrow("この支払い方法は利用できません");
    });

    it("refuses to take money for stock that is already gone", async () => {
      store.products = [{ ...TAKOYAKI, initialStock: 1 }];

      await expect(
        caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 2 }] })
      ).rejects.toThrow("在庫が不足しています");
    });

    it("rejects an unknown product", async () => {
      await expect(
        caller.payment.createIntent({ method: "paypay", items: [{ product_id: 999, qty: 1 }] })
      ).rejects.toThrow("見つかりません");
    });

    it("fails cleanly when cashless is switched off", async () => {
      mockEnv.paymentProvider = "";
      payments.resetPaymentProviderCache();

      await expect(
        caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 1 }] })
      ).rejects.toThrow("有効化されていません");
    });
  });

  /**
   * Drives a payment to "completed" the way the mock provider actually
   * does it — a signed webhook. Deliberately not confirmManual: the mock
   * provider has a real API, so manual confirmation is (correctly)
   * refused for it and is exercised against the manual provider instead.
   */
  async function completePayment(paymentId: number) {
    const provider = payments.getPaymentProvider()!;
    const stored = store.payments.get(paymentId);
    await payments.applyWebhookEvent(provider.id, {
      providerPaymentId: stored.providerPaymentId,
      status: "completed",
      amount: stored.amount,
    });
  }

  describe("transaction.create with a cashless payment", () => {
    async function completedPayment(qty = 2) {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty }],
      });
      await completePayment(intent.paymentId);
      return intent;
    }

    const cartFor = (qty: number) => [
      { product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty },
    ];

    it("records the sale with no cash drawer movement", async () => {
      const intent = await completedPayment();

      const result = await caller.transaction.create({
        items: cartFor(2),
        total: 800,
        // A client could send anything here; for a cashless sale the
        // server must ignore it entirely.
        received: 99999,
        changeAmount: 99999,
        paymentMethod: "paypay",
        paymentId: intent.paymentId,
      });

      const tx = store.transactions.find((t) => t.id === result.id);
      expect(tx.paymentMethod).toBe("paypay");
      expect(tx.total).toBe(800);
      expect(tx.received).toBe(800);
      expect(tx.changeAmount).toBe(0);
      expect(tx.paymentId).toBe(intent.paymentId);
    });

    it("marks the payment as consumed so it cannot be spent again", async () => {
      const intent = await completedPayment();

      const first = await caller.transaction.create({
        items: cartFor(2),
        total: 800,
        received: 800,
        changeAmount: 0,
        paymentMethod: "paypay",
        paymentId: intent.paymentId,
      });

      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "paypay",
          paymentId: intent.paymentId,
        })
      ).rejects.toThrow(`この決済は取引#${first.id}で会計済みです`);
    });

    it("refuses to book a sale for a payment that never completed", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });

      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "paypay",
          paymentId: intent.paymentId,
        })
      ).rejects.toThrow("支払いがまだ完了していません");
    });

    it("refuses when the amount paid no longer matches the cart", async () => {
      const intent = await completedPayment(2); // paid ¥800

      // The price went up between paying and confirming.
      store.products = [{ ...TAKOYAKI, price: 500 }];

      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 1000,
          received: 1000,
          changeAmount: 0,
          paymentMethod: "paypay",
          paymentId: intent.paymentId,
        })
      ).rejects.toThrow("一致しません");
    });

    it("refuses when the method does not match the payment", async () => {
      const intent = await completedPayment();

      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "credit",
          paymentId: intent.paymentId,
        })
      ).rejects.toThrow("支払い方法が一致しません");
    });

    it("requires a payment id for a cashless sale", async () => {
      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "paypay",
        })
      ).rejects.toThrow("決済IDが必要です");
    });

    // Regression guard for the whole design: cashless was added without
    // changing what a cash sale does, including one that never mentions
    // payment at all.
    it("leaves plain cash checkout untouched", async () => {
      const result = await caller.transaction.create({
        items: cartFor(2),
        total: 800,
        received: 1000,
        changeAmount: 200,
      });

      const tx = store.transactions.find((t) => t.id === result.id);
      expect(tx.paymentMethod).toBe("cash");
      expect(tx.paymentId).toBeNull();
      expect(tx.received).toBe(1000);
      expect(tx.changeAmount).toBe(200);
    });

    it("still rejects cash that does not cover the total", async () => {
      await expect(
        caller.transaction.create({
          items: cartFor(2),
          total: 800,
          received: 500,
          changeAmount: 0,
          paymentMethod: "cash",
        })
      ).rejects.toThrow("預かり金が合計金額に足りません");
    });
  });

  // The "manual" provider is the printed-QR-on-the-counter case: no API
  // exists to confirm against, so a human decides. That is exactly why
  // these paths are admin-gated.
  describe("payment.confirmManual (manual provider)", () => {
    beforeEach(() => {
      mockEnv.paymentProvider = "manual";
      payments.resetPaymentProviderCache();
    });

    it("lets an admin confirm a payment by eye", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });

      const confirmed = await caller.payment.confirmManual({ paymentId: intent.paymentId });

      expect(confirmed.status).toBe("completed");
    });

    it("rejects a non-admin — it books money on the cashier's word alone", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });

      await expect(
        caller.payment.confirmManual({ paymentId: intent.paymentId })
      ).rejects.toThrow("管理者権限が必要です");
    });

    it("rejects confirming the same payment twice", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });
      await caller.payment.confirmManual({ paymentId: intent.paymentId });

      await expect(
        caller.payment.confirmManual({ paymentId: intent.paymentId })
      ).rejects.toThrow("すでに");
    });

    it("is refused by a provider that has a real API to check against", async () => {
      mockEnv.paymentProvider = "mock";
      payments.resetPaymentProviderCache();
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });

      await expect(
        caller.payment.confirmManual({ paymentId: intent.paymentId })
      ).rejects.toThrow("手動確認は使用できません");
    });
  });

  /**
   * Stock reservation. A cashless payment is not instantaneous, so the
   * goods it is for have to stop being sellable the moment it opens —
   * otherwise the register next to this one sells the last たこ焼き while
   * this customer's card is still being read, and someone ends up paying
   * for something that no longer exists.
   */
  describe("在庫引当 (stock held by in-flight payments)", () => {
    beforeEach(() => {
      store.products = [{ ...TAKOYAKI, initialStock: 2 }];
    });

    it("stops a second payment from claiming stock the first one holds", async () => {
      await caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 2 }] });

      await expect(
        caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 1 }] })
      ).rejects.toThrow("在庫が不足しています");
    });

    it("reports the held units to the register", async () => {
      await caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 2 }] });

      expect(await caller.payment.reservedStock()).toEqual({ 1: 2 });
    });

    it("releases the stock when the payment is cancelled", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });
      await caller.payment.cancel({ paymentId: intent.paymentId });

      expect(await caller.payment.reservedStock()).toEqual({});
      await expect(
        caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 2 }] })
      ).resolves.toMatchObject({ amount: 800 });
    });

    it("blocks a cash sale for stock another customer is paying for", async () => {
      await caller.payment.createIntent({ method: "paypay", items: [{ product_id: 1, qty: 2 }] });

      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 1 }],
          total: 400,
          received: 400,
          changeAmount: 0,
        })
      ).rejects.toThrow("在庫が不足しています");
    });

    // The reservation exists to protect this very checkout; counting it
    // against itself would make every cashless sale impossible.
    it("does not block the checkout that owns the reservation", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });
      await completePayment(intent.paymentId);

      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "paypay",
          paymentId: intent.paymentId,
        })
      ).resolves.toMatchObject({ id: expect.any(Number) });
    });

    it("stops holding stock once the payment became a sale", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });
      await completePayment(intent.paymentId);
      await caller.transaction.create({
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
        total: 800,
        received: 800,
        changeAmount: 0,
        paymentMethod: "paypay",
        paymentId: intent.paymentId,
      });

      // Sold, not reserved — and counted exactly once.
      expect(await caller.payment.reservedStock()).toEqual({});
      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 1 }],
          total: 400,
          received: 400,
          changeAmount: 0,
        })
      ).rejects.toThrow("在庫が不足しています");
    });

    it("reports nothing when cashless is disabled", async () => {
      mockEnv.paymentProvider = "";
      payments.resetPaymentProviderCache();

      expect(await caller.payment.reservedStock()).toEqual({});
    });
  });

  // Same total, different goods: the amount check alone would let this
  // through, and the wrong products' stock would be decremented.
  describe("cart verification", () => {
    it("refuses a sale whose items differ from the ones paid for", async () => {
      store.products = [
        { ...TAKOYAKI },
        { ...TAKOYAKI, id: 2, name: "焼きそば", emoji: "🍜" },
      ];
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });
      await completePayment(intent.paymentId);

      await expect(
        caller.transaction.create({
          items: [{ product_id: 2, name: "焼きそば", emoji: "🍜", price: 400, cost: 150, qty: 2 }],
          total: 800,
          received: 800,
          changeAmount: 0,
          paymentMethod: "paypay",
          paymentId: intent.paymentId,
        })
      ).rejects.toThrow("商品内容と会計内容が一致しません");
    });
  });

  /**
   * App-to-app terminal providers (the Airペイ / Square / stera shape).
   * There is no server API to ask and no signed webhook, so the register
   * reports what the card reader decided — which is why an approval must
   * carry a slip number that can be matched against the payment
   * company's 入金明細 later.
   */
  describe("payment.reportTerminalResult (terminal provider)", () => {
    beforeEach(() => {
      mockEnv.paymentProvider = "terminal";
      mockEnv.paymentTerminalLaunchUrl = "examplepay://pay?amount={amount}&order={orderRef}";
      payments.resetPaymentProviderCache();
    });

    async function openTerminalPayment() {
      return caller.payment.createIntent({ method: "credit", items: [{ product_id: 1, qty: 2 }] });
    }

    it("hands the register a launch URL with the amount filled in", async () => {
      const intent = await openTerminalPayment();

      expect(intent.presentation.kind).toBe("terminal");
      expect(intent.presentation.launchUrl).toContain("amount=800");
    });

    it("completes the payment and stores the slip reference", async () => {
      const intent = await openTerminalPayment();

      const reported = await caller.payment.reportTerminalResult({
        paymentId: intent.paymentId,
        approved: true,
        providerRef: "0001234",
      });

      expect(reported.status).toBe("completed");
      expect(reported.providerRef).toBe("0001234");
    });

    // Without a reference the sale can never be checked against the
    // payment company's settlement report, which is the only audit this
    // integration has.
    it("refuses an approval with no slip reference", async () => {
      const intent = await openTerminalPayment();

      await expect(
        caller.payment.reportTerminalResult({ paymentId: intent.paymentId, approved: true })
      ).rejects.toThrow("伝票番号");

      expect(store.payments.get(intent.paymentId).status).toBe("pending");
    });

    it("records a declined card as failed and frees the stock", async () => {
      const intent = await openTerminalPayment();

      const reported = await caller.payment.reportTerminalResult({
        paymentId: intent.paymentId,
        approved: false,
        errorMessage: "カードが読み取れませんでした",
      });

      expect(reported.status).toBe("failed");
      expect(await caller.payment.reservedStock()).toEqual({});
    });

    // Reconciliation happens from the CSV export, which reads the
    // transaction table alone — so the slip number has to land there too.
    it("carries the slip reference onto the sale", async () => {
      const intent = await openTerminalPayment();
      await caller.payment.reportTerminalResult({
        paymentId: intent.paymentId,
        approved: true,
        providerRef: "0001234",
      });

      const result = await caller.transaction.create({
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
        total: 800,
        received: 800,
        changeAmount: 0,
        paymentMethod: "credit",
        paymentId: intent.paymentId,
      });

      expect(store.transactions.find((t) => t.id === result.id).paymentRef).toBe("0001234");
    });

    it("refuses to report the same payment twice", async () => {
      const intent = await openTerminalPayment();
      await caller.payment.reportTerminalResult({
        paymentId: intent.paymentId,
        approved: true,
        providerRef: "0001234",
      });

      await expect(
        caller.payment.reportTerminalResult({
          paymentId: intent.paymentId,
          approved: true,
          providerRef: "0001234",
        })
      ).rejects.toThrow("すでに");
    });

    it("is refused by a provider that has a real server API", async () => {
      mockEnv.paymentProvider = "mock";
      payments.resetPaymentProviderCache();
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });

      await expect(
        caller.payment.reportTerminalResult({
          paymentId: intent.paymentId,
          approved: true,
          providerRef: "0001234",
        })
      ).rejects.toThrow("端末連携に対応していません");
    });

    it("refuses to start without a configured launch URL", async () => {
      mockEnv.paymentTerminalLaunchUrl = "";
      payments.resetPaymentProviderCache();

      await expect(caller.payment.config()).rejects.toThrow("PAYMENT_TERMINAL_LAUNCH_URL");
    });
  });

  describe("payment.cancel", () => {
    it("cancels a pending payment", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });

      const canceled = await caller.payment.cancel({ paymentId: intent.paymentId });

      expect(canceled.status).toBe("canceled");
    });

    it("refuses to cancel a payment that is already a sale", async () => {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 1 }],
      });
      await completePayment(intent.paymentId);
      await caller.transaction.create({
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 1 }],
        total: 400,
        received: 400,
        changeAmount: 0,
        paymentMethod: "paypay",
        paymentId: intent.paymentId,
      });

      await expect(
        caller.payment.cancel({ paymentId: intent.paymentId })
      ).rejects.toThrow("会計済みの決済は取り消せません");
    });
  });

  describe("webhooks", () => {
    function sign(body: string, secret = "test-webhook-secret") {
      return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
    }

    async function pendingPayment() {
      const intent = await caller.payment.createIntent({
        method: "paypay",
        items: [{ product_id: 1, qty: 2 }],
      });
      const stored = store.payments.get(intent.paymentId);
      return { intent, providerPaymentId: stored.providerPaymentId };
    }

    it("completes a payment on a correctly signed event", async () => {
      const { intent, providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;
      const body = JSON.stringify({ paymentId: providerPaymentId, status: "completed", amount: 800 });

      const event = await provider.verifyWebhook!(Buffer.from(body, "utf8"), {
        "x-fespos-signature": sign(body),
      });
      expect(event).not.toBeNull();

      const result = await payments.applyWebhookEvent(provider.id, event!);

      expect(result.handled).toBe(true);
      expect(store.payments.get(intent.paymentId).status).toBe("completed");
    });

    it("rejects a forged signature and changes nothing", async () => {
      const { intent, providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;
      const body = JSON.stringify({ paymentId: providerPaymentId, status: "completed", amount: 800 });

      const event = await provider.verifyWebhook!(Buffer.from(body, "utf8"), {
        "x-fespos-signature": sign(body, "wrong-secret"),
      });

      expect(event).toBeNull();
      expect(store.payments.get(intent.paymentId).status).toBe("pending");
    });

    it("rejects a signature computed over different bytes", async () => {
      const { providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;
      const signedBody = JSON.stringify({ paymentId: providerPaymentId, status: "completed", amount: 800 });
      const tamperedBody = JSON.stringify({ paymentId: providerPaymentId, status: "completed", amount: 1 });

      const event = await provider.verifyWebhook!(Buffer.from(tamperedBody, "utf8"), {
        "x-fespos-signature": sign(signedBody),
      });

      expect(event).toBeNull();
    });

    // A validly-signed event can still be wrong — e.g. the provider's
    // dashboard was misconfigured, or the amount was tampered with before
    // signing. Completing on an amount we never charged is the one
    // outcome that silently loses money, so it fails instead.
    it("fails the payment when a signed event reports the wrong amount", async () => {
      const { intent, providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;

      const result = await payments.applyWebhookEvent(provider.id, {
        providerPaymentId,
        status: "completed",
        amount: 1,
      });

      expect(result.handled).toBe(true);
      const stored = store.payments.get(intent.paymentId);
      expect(stored.status).toBe("failed");
      expect(stored.errorMessage).toContain("金額");
    });

    it("treats a redelivered event as handled without re-applying it", async () => {
      const { intent, providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;

      await payments.applyWebhookEvent(provider.id, { providerPaymentId, status: "completed", amount: 800 });
      const second = await payments.applyWebhookEvent(provider.id, { providerPaymentId, status: "completed", amount: 800 });

      // Handled (so the provider stops retrying) but the status was not
      // moved a second time.
      expect(second.handled).toBe(true);
      expect(second.reason).toBe("already settled");
      expect(store.payments.get(intent.paymentId).status).toBe("completed");
    });

    it("cannot resurrect a payment that already settled", async () => {
      const { intent, providerPaymentId } = await pendingPayment();
      const provider = payments.getPaymentProvider()!;

      await payments.applyWebhookEvent(provider.id, { providerPaymentId, status: "failed" });
      await payments.applyWebhookEvent(provider.id, { providerPaymentId, status: "completed", amount: 800 });

      expect(store.payments.get(intent.paymentId).status).toBe("failed");
    });

    it("reports an unknown payment so the provider stops retrying", async () => {
      const provider = payments.getPaymentProvider()!;

      const result = await payments.applyWebhookEvent(provider.id, {
        providerPaymentId: "mock_does-not-exist",
        status: "completed",
      });

      expect(result.handled).toBe(false);
    });
  });
});
