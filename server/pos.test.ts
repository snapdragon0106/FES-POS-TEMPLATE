import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock posAuth module.
//
// Only the JWT/cookie side is faked. hashPin/verifyPin/isLegacyPlaintextPin
// and isAdminOperator are pure functions over Node's crypto and the roster
// (from the env), so the real implementations are kept: hand-written stand-ins for
// them are what silently drifted away from the module before and left
// posSession.login untested.
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

// Mock db module. Every function routers.ts calls must appear here — a
// missing one surfaces as "db.x is not a function" rather than a useful
// failure, which is how resetAll's test broke when accounting was added.
vi.mock("./db", () => {
  const listProducts = vi.fn().mockResolvedValue([
    { id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, initialStock: 50, threshold: 10, displayOrder: 1 },
  ]);
  const listTransactions = vi.fn().mockResolvedValue([]);
  const listRestocks = vi.fn().mockResolvedValue([]);
  const checkoutsByKey = new Map<string, number>();
  const lastBuilt: { value: any } = { value: null };
  return {
    getMemberPin: vi.fn(),
    upsertMemberPin: vi.fn(),
    listMemberPins: vi.fn().mockResolvedValue([]),
    deleteMemberPin: vi.fn(),
    listProducts,
    createProduct: vi.fn().mockResolvedValue(2),
    updateProduct: vi.fn(),
    deleteProduct: vi.fn(),
    deleteAllProducts: vi.fn(),
    setProductImage: vi.fn().mockResolvedValue(true),
    listCashEvents: vi.fn().mockResolvedValue([]),
    createCashEvent: vi.fn().mockResolvedValue(1),
    getCashEventById: vi.fn(),
    deleteCashEvent: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn(),
    getProductImage: vi.fn(),
    listTransactions,
    createTransaction: vi.fn().mockResolvedValue(1),
    // Mirrors the real createTransactionSerialized: runs `build` against
    // the same listProducts/listTransactions/listRestocks mocks above (a
    // stand-in for the DB-transaction-scoped reads the real version uses),
    // so tests that override listProducts etc. still take effect here too.
    // Mirrors the real function's idempotency contract: a clientRequestId
    // it has already recorded is answered with that sale (duplicate: true)
    // without building or inserting anything. Keys live for the whole file,
    // so each test uses its own.
    createTransactionSerialized: vi.fn(async (
      _productIds: number[],
      build: (tx: any) => Promise<any>,
      options?: { clientRequestId?: string }
    ) => {
      const key = options?.clientRequestId;
      if (key && checkoutsByKey.has(key)) return { id: checkoutsByKey.get(key)!, duplicate: true, orderNo: 1 };
      // lockPayment is only reached by cashless checkouts, which have
      // their own suite (payments.test.ts) with a stateful payments mock.
      // Every cash path in this file must never touch it.
      lastBuilt.value = await build({
        listProducts,
        listTransactions,
        listRestocks,
        // No cashless payments exist in this suite, so nothing is ever
        // reserved and stock behaves exactly as it did before cashless.
        listOpenPayments: vi.fn(async () => []),
        lockPayment: vi.fn(async () => {
          throw new Error("lockPayment must not be called for a cash transaction");
        }),
      });
      if (key) checkoutsByKey.set(key, 1);
      return { id: 1, duplicate: false, orderNo: 1 };
    }),
    __lastBuilt: lastBuilt,
    getTransactionById: vi.fn().mockResolvedValue({ id: 1, total: 400 }),
    voidTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
    getTransactionsByIds: vi.fn().mockResolvedValue([]),
    deleteVoidedTransactionsByIds: vi.fn().mockResolvedValue(1),
    deleteAllTransactions: vi.fn(),
    listRestocks,
    createRestock: vi.fn().mockResolvedValue(1),
    getRestockById: vi.fn().mockResolvedValue(null),
    deleteRestock: vi.fn().mockResolvedValue(undefined),
    deleteAllRestocks: vi.fn(),
    listActivityLogs: vi.fn().mockResolvedValue([]),
    createActivityLog: vi.fn(),
    deleteAllActivityLogs: vi.fn(),
    listAccountingEntries: vi.fn().mockResolvedValue([]),
    createAccountingEntry: vi.fn().mockResolvedValue(1),
    deleteAccountingEntry: vi.fn(),
    getAccountingEntryById: vi.fn().mockResolvedValue(null),
    deleteAllAccountingEntries: vi.fn(),
    createPayment: vi.fn().mockResolvedValue(1),
    getPaymentById: vi.fn(),
    getPaymentByProviderId: vi.fn(),
    getPaymentByOrderRef: vi.fn(),
    updatePayment: vi.fn(),
    settlePaymentStatus: vi.fn().mockResolvedValue(true),
    listPayments: vi.fn().mockResolvedValue([]),
    listOpenPayments: vi.fn().mockResolvedValue([]),
    deleteAllPayments: vi.fn(),
    resetAllData: vi.fn(),
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

describe("POS System API", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let posAuth: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    posAuth = await import("./posAuth");
    caller = appRouter.createCaller(createTestContext());
  });

  describe("access control", () => {
    it("the roster is only for logged-in users", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue(null);
      await expect(caller.member.list()).rejects.toThrow("POSセッションが無効です");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "" });
      const list = await caller.member.list();
      expect(list).toHaveLength(40);
      expect(list[0]).toEqual({ id: "3501", name: "テスト 生徒01" });
    });

    it("pin.list never sends the stored PIN hashes", async () => {
      const db = await import("./db");
      (db.listMemberPins as any).mockResolvedValueOnce([{ memberId: "3501", pin: "salt:hash", approved: false, requestCode: "ACDE" }]);
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "" });
      // Nor the request code: the admin must read that off the member's screen.
      const rows = await caller.pin.list();
      expect(rows).toEqual([{ memberId: "3501", approved: false, hasRequestCode: true, createdAt: undefined, updatedAt: undefined }]);
      expect(JSON.stringify(rows)).not.toContain("salt:hash");
      expect(JSON.stringify(rows)).not.toContain("ACDE");
    });

  });

  describe("pin.reset (admin only)", () => {
    it("allows admin to reset PIN", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.pin.reset({ memberId: "3501", pin: "4827" });
      expect(result).toEqual({ success: true });
    });

    it("refuses an obvious PIN", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      for (const pin of ["9999", "1234", "4321", "1212", "2580", "2024"]) {
        await expect(caller.pin.reset({ memberId: "3501", pin })).rejects.toThrow("推測されやすいPIN");
      }
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.pin.reset({ memberId: "3501", pin: "9999" })
      ).rejects.toThrow("管理者権限が必要です");
    });

    it("rejects unauthenticated", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue(null);
      await expect(
        caller.pin.reset({ memberId: "3501", pin: "9999" })
      ).rejects.toThrow("POSセッションが無効です");
    });
  });

  describe("accounting.delete (admin only)", () => {
    it("refuses an entry that doesn't exist (no false audit line)", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "" });
      await expect(caller.accounting.delete({ id: 999, category: "purchase" })).rejects.toThrow("見つかりません");
      expect(db.createActivityLog).not.toHaveBeenCalled();
    });

    it("logs the stored entry's category and amount, not the request's", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "" });
      (db.getAccountingEntryById as any).mockResolvedValueOnce({ id: 5, category: "loan_repay", label: "返済1回目", amount: 20000 });
      await caller.accounting.delete({ id: 5, category: "purchase" });
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "delete_loan_repay", detail: expect.stringContaining("返済1回目") }));
    });
  });

  describe("pin.delete (admin only)", () => {
    it("allows admin to delete PIN", async () => {
      const db = await import("./db");
      (db.getMemberPin as any).mockResolvedValueOnce({ memberId: "3501", pin: "x" });
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.pin.delete({ memberId: "3501" });
      expect(result).toEqual({ success: true });
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.pin.delete({ memberId: "3501" })
      ).rejects.toThrow("管理者権限が必要です");
    });
  });

  describe("product.list", () => {
    it("returns products list", async () => {
      const result = await caller.product.list();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("たこ焼き");
    });
  });

  describe("cash drawer", () => {
    const asCashier = () =>
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
    const asAdmin = () =>
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
    // A cashier the admin named 会計係 (app_settings cash.managers).
    const asManager = async () => {
      const db = await import("./db");
      asCashier();
      (db.getSetting as any).mockImplementation(async (key: string) => (key === "cash.managers" ? NON_ADMIN : null));
    };
    const float = { id: 1, kind: "float", amount: 15000, createdAt: new Date(Date.now() - 3600_000) };

    afterEach(async () => {
      const db = await import("./db");
      (db.getSetting as any).mockReset();
      (db.getSetting as any).mockResolvedValue(null);
    });

    it("float, 締め and 返却 are for the admin and the 会計係 only; 回収 and 両替 for any cashier", async () => {
      asCashier();
      await expect(caller.cash.setFloat({ breakdown: { "1000": 10 } })).rejects.toThrow("管理者か会計係");
      await expect(caller.cash.count({ breakdown: { "1000": 10 } })).rejects.toThrow("管理者か会計係");
      await expect(caller.cash.returnFloat({ amount: 1000 })).rejects.toThrow("管理者か会計係");
      await expect(caller.cash.collect({ amount: 1000 })).rejects.toThrow("先に釣り銭を登録してください");
      expect(await caller.posSession.me()).toMatchObject({ canManageCash: false });
      asAdmin();
      await expect(caller.cash.setFloat({ breakdown: { "1000": 10 } })).resolves.toMatchObject({ amount: 10000 });
      await asManager();
      await expect(caller.cash.setFloat({ breakdown: { "1000": 10 } })).resolves.toMatchObject({ amount: 10000 });
      expect(await caller.posSession.me()).toMatchObject({ isAdmin: false, canManageCash: true });
    });

    it("only the admin names the 会計係, and it is logged", async () => {
      const db = await import("./db");
      asCashier();
      await expect(caller.cash.setManagers({ memberIds: [NON_ADMIN] })).rejects.toThrow("管理者権限が必要です");
      asAdmin();
      await caller.cash.setManagers({ memberIds: [NON_ADMIN, NON_ADMIN] });
      expect(db.setSetting).toHaveBeenCalledWith("cash.managers", NON_ADMIN);
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "cash_managers" }));
      await expect(caller.cash.setManagers({ memberIds: ["9999"] })).rejects.toThrow();
    });

    it("a 会計係 can register the float; the amount comes from the breakdown", async () => {
      const db = await import("./db");
      await asManager();
      const r = await caller.cash.setFloat({ breakdown: { "1000": 10, "500": 5, "100": 25 } });
      expect(r.amount).toBe(15000);
      expect(db.createCashEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "float", amount: 15000, operator: NON_ADMIN }));
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "cash_float" }));
    });

    it("rejects an empty float and unknown denominations", async () => {
      await asManager();
      await expect(caller.cash.setFloat({ breakdown: {} })).rejects.toThrow("釣り銭の枚数を入力してください");
      await expect(caller.cash.setFloat({ breakdown: { "2000": 1 } })).rejects.toThrow();
    });

    it("count freezes the server-side expected amount and the difference", async () => {
      const db = await import("./db");
      await asManager();
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      (db.listTransactions as any).mockResolvedValueOnce([
        { total: 400, voided: false, paymentMethod: "cash", createdAt: new Date() },
        { total: 400, voided: true, paymentMethod: "cash", createdAt: new Date() },
      ]);
      const r = await caller.cash.count({ breakdown: { "10000": 1, "1000": 5, "100": 3 } });
      expect(r).toMatchObject({ counted: 15300, expected: 15400, difference: -100 });
      expect(db.createCashEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "count", amount: 15300, expected: 15400 }));
    });

    it("won't start a new day while the current one is still open", async () => {
      const db = await import("./db");
      await asManager();
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.setFloat({ breakdown: { "1000": 10 } })).rejects.toThrow("すでに登録されています");
      // After 締め the next day's float is fine.
      (db.listCashEvents as any).mockResolvedValueOnce([float, { id: 2, kind: "count", amount: 15000, createdAt: new Date() }]);
      await expect(caller.cash.setFloat({ breakdown: { "1000": 10 } })).resolves.toMatchObject({ amount: 10000 });
    });

    it("no collection after 締め", async () => {
      const db = await import("./db");
      asCashier();
      (db.listCashEvents as any).mockResolvedValueOnce([float, { id: 2, kind: "count", amount: 15000, createdAt: new Date() }]);
      await expect(caller.cash.collect({ amount: 1000 })).rejects.toThrow("締めた後");
    });

    it("count and collect need a float first", async () => {
      await asManager();
      await expect(caller.cash.count({ breakdown: { "1000": 1 } })).rejects.toThrow("先に釣り銭を登録してください");
      await expect(caller.cash.collect({ amount: 1000 })).rejects.toThrow("先に釣り銭を登録してください");
    });

    it("collect refuses more than the box should hold (extra-zero typo)", async () => {
      const db = await import("./db");
      asCashier();
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.collect({ amount: 150000 })).rejects.toThrow("より多い金額です");
    });

    it("the float remembers who provided it; returning it is capped by the float and by the box", async () => {
      const db = await import("./db");
      await asManager();
      await caller.cash.setFloat({ breakdown: { "1000": 10 }, party: "担任の先生" });
      expect(db.createCashEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "float", party: "担任の先生" }));
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ detail: "釣り銭 ¥10,000 を登録（用意：担任の先生）" }));

      const withParty = { ...float, party: "担任の先生" };
      // More than was lent.
      (db.listCashEvents as any).mockResolvedValueOnce([withParty]);
      await expect(caller.cash.returnFloat({ amount: 15001 })).rejects.toThrow("釣り銭として登録した額（¥15,000）より多い金額です");
      // More than the box should hold (after ¥10,000 went to 本部 and ¥1,000 of sales came in).
      (db.listCashEvents as any).mockResolvedValueOnce([withParty, { id: 2, kind: "collect", amount: 10000, createdAt: new Date() }]);
      (db.listTransactions as any).mockResolvedValueOnce([{ total: 1000, voided: false, paymentMethod: "cash", createdAt: new Date() }]);
      await expect(caller.cash.returnFloat({ amount: 15000 })).rejects.toThrow("レジにあるはずの現金（¥6,000）より多い金額です");
      // Part now, the rest later; the float's party is used when none is given.
      (db.listCashEvents as any).mockResolvedValueOnce([withParty]);
      const r = await caller.cash.returnFloat({ amount: 10000 });
      expect(r).toMatchObject({ returned: 10000, float: 15000 });
      expect(db.createCashEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "return", amount: 10000, party: "担任の先生" }));
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "cash_return", detail: "釣り銭 ¥10,000 を担任の先生へ返却（残り ¥5,000）" }));
      (db.listCashEvents as any).mockResolvedValueOnce([withParty, { id: 3, kind: "return", amount: 10000, createdAt: new Date() }]);
      await expect(caller.cash.returnFloat({ amount: 6000 })).rejects.toThrow("うち ¥10,000 は返却済み");
      // Returning after 締め is the normal end of the festival.
      (db.listCashEvents as any).mockResolvedValueOnce([withParty, { id: 3, kind: "return", amount: 10000, createdAt: new Date() }, { id: 4, kind: "count", amount: 5000, createdAt: new Date() }]);
      await expect(caller.cash.returnFloat({ amount: 5000 })).resolves.toMatchObject({ returned: 15000 });
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ detail: "釣り銭 ¥5,000 を担任の先生へ返却（全額返却済み）" }));
    });

    it("returning needs a float", async () => {
      await asManager();
      await expect(caller.cash.returnFloat({ amount: 1000 })).rejects.toThrow("先に釣り銭を登録してください");
    });

    it("a 両替 must balance, is stored as the net change, and is refused after 締め", async () => {
      const db = await import("./db");
      asCashier();
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.exchange({ out: { "1000": 5 }, in: { "100": 40 } })).rejects.toThrow("合計が合っていません");
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.exchange({ out: {}, in: { "100": 40 } })).rejects.toThrow("両方を入力してください");
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.exchange({ out: { "100": 5 }, in: { "100": 5 } })).rejects.toThrow("同じお金どうし");
      (db.listCashEvents as any).mockResolvedValueOnce([float]);
      await expect(caller.cash.exchange({ out: { "1000": 5 }, in: { "100": 50 } })).resolves.toMatchObject({ amount: 5000 });
      expect(db.createCashEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "exchange", amount: 5000, breakdown: { "1000": -5, "100": 50 } }));
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "cash_exchange", detail: "両替（¥5,000）：千円札5枚 → 100円玉50枚" }));
      (db.listCashEvents as any).mockResolvedValueOnce([float, { id: 2, kind: "count", amount: 15000, createdAt: new Date() }]);
      await expect(caller.cash.exchange({ out: { "1000": 5 }, in: { "100": 50 } })).rejects.toThrow("締めた後");
    });

    it("deleting an entry and changing the threshold are admin only", async () => {
      const db = await import("./db");
      asCashier();
      await expect(caller.cash.delete({ id: 1 })).rejects.toThrow("管理者権限が必要です");
      await expect(caller.cash.setCollectThreshold({ amount: 20000 })).rejects.toThrow("管理者権限が必要です");
      asAdmin();
      (db.getCashEventById as any).mockResolvedValueOnce(float);
      await expect(caller.cash.delete({ id: 1 })).resolves.toEqual({ success: true });
      await caller.cash.setCollectThreshold({ amount: 20000 });
      expect(db.setSetting).toHaveBeenCalledWith("cash.collectThreshold", "20000");
    });

    it("list reports the default threshold until one is set", async () => {
      asCashier();
      const r = await caller.cash.list();
      expect(r.collectThreshold).toBe(30000);
    });
  });

  describe("product.setImage (admin only)", () => {
    // Smallest valid PNG header + padding: enough for the magic-byte check.
    const png = "data:image/png;base64," +
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");

    it("stores a valid image and returns its hash", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.product.setImage({ id: 1, image: png });
      expect(result.imageHash).toMatch(/^[0-9a-f]{16}$/);
      expect(db.setProductImage).toHaveBeenCalledWith(1, expect.objectContaining({ mime: "image/png", hash: result.imageHash }));
    });

    it("removes the image with null", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.product.setImage({ id: 1, image: null });
      expect(result).toEqual({ imageHash: null });
      expect(db.setProductImage).toHaveBeenCalledWith(1, null);
    });

    it("rejects non-admin", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(caller.product.setImage({ id: 1, image: png })).rejects.toThrow("管理者権限が必要です");
      expect(db.setProductImage).not.toHaveBeenCalled();
    });

    it("rejects SVG (can carry script) and mismatched content", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const svg = "data:image/svg+xml;base64," + Buffer.from("<svg onload='alert(1)'/>").toString("base64");
      await expect(caller.product.setImage({ id: 1, image: svg })).rejects.toThrow();
      const fakeJpeg = "data:image/jpeg;base64," + Buffer.from("<html>not an image</html>").toString("base64");
      await expect(caller.product.setImage({ id: 1, image: fakeJpeg })).rejects.toThrow("画像の中身が形式と一致しません");
      expect(db.setProductImage).not.toHaveBeenCalled();
    });

    it("rejects an image over the size limit", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const big = "data:image/png;base64," +
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300 * 1024)]).toString("base64");
      await expect(caller.product.setImage({ id: 1, image: big })).rejects.toThrow();
    });

    it("reports a missing product", async () => {
      const db = await import("./db");
      (db.setProductImage as any).mockResolvedValueOnce(false);
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      await expect(caller.product.setImage({ id: 999, image: png })).rejects.toThrow("商品が見つかりません");
    });
  });

  describe("product.create (admin only)", () => {
    it("allows admin to create a product", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.product.create({
        name: "焼きそば",
        emoji: "🍜",
        price: 400,
        cost: 160,
        initialStock: 40,
        threshold: 10,
        displayOrder: 2,
      });
      expect(result).toEqual({ id: 2 });
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.product.create({
          name: "焼きそば",
          emoji: "🍜",
          price: 400,
          cost: 160,
          initialStock: 40,
          threshold: 10,
          displayOrder: 2,
        })
      ).rejects.toThrow("管理者権限が必要です");
    });
  });

  describe("transaction.create (authenticated)", () => {
    it("creates a transaction for authenticated operator", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3509", operatorName: "テスト 生徒09" });
      const result = await caller.transaction.create({
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
        total: 800,
        received: 1000,
        changeAmount: 200,
      });
      // The order number is what the customer is told for the handover counter.
      expect(result).toEqual({ id: 1, duplicate: false, orderNo: 1 });
    });

    // A checkout whose response was lost on bad Wi-Fi is retried with the
    // same key; the server must answer with the sale it already recorded.
    it("answers a retried checkout with the sale already recorded", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3501", operatorName: "テスト 生徒01" });
      const db = await import("./db");
      const input = {
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 1 }],
        total: 400, received: 500, changeAmount: 100,
        clientRequestId: "retry-test-0001-aaaa",
      };

      const first = await caller.transaction.create(input);
      const retry = await caller.transaction.create(input);

      expect(first).toEqual({ id: 1, duplicate: false, orderNo: 1 });
      // A retry gets the same number, not a new one.
      expect(retry).toEqual({ id: 1, duplicate: true, orderNo: 1 });
      expect(db.createTransactionSerialized).toHaveBeenCalledWith(
        [1], expect.any(Function), { clientRequestId: "retry-test-0001-aaaa" }
      );
    });

    it.each([
      ["zero", 0],
      ["negative", -3],
      ["fractional", 1.5],
    ])("rejects a %s quantity — it would add stock and subtract sales", async (_label, qty) => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3501", operatorName: "テスト 生徒01" });
      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty }],
          total: 400, received: 400, changeAmount: 0,
        })
      ).rejects.toThrow();
    });

    it("rejects an empty cart instead of recording a ¥0 sale", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3501", operatorName: "テスト 生徒01" });
      await expect(
        caller.transaction.create({ items: [], total: 0, received: 0, changeAmount: 0 })
      ).rejects.toThrow("カートが空です");
    });

    it("rejects an absurd amount received (an extra few zeros) before it reaches the database", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3501", operatorName: "テスト 生徒01" });
      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 1 }],
          total: 400, received: 10_000_000_000, changeAmount: 0,
        })
      ).rejects.toThrow("預かり金額が大きすぎます");
    });

    it("drops a stray decimal from the amount received (yen has no minor unit)", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3501", operatorName: "テスト 生徒01" });
      const db = await import("./db");
      await caller.transaction.create({
        items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
        total: 800, received: 1000.7, changeAmount: 200.7,
      });
      const built = (db as any).__lastBuilt.value;
      expect(built.received).toBe(1000);
      expect(built.changeAmount).toBe(200);
    });

    it("rejects unauthenticated", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue(null);
      await expect(
        caller.transaction.create({
          items: [{ product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 2 }],
          total: 800,
          received: 1000,
          changeAmount: 200,
        })
      ).rejects.toThrow("POSセッションが無効です");
    });

    // Regression test: two line items referencing the same product (stock
    // is 50) must be checked against a running total, not each against the
    // original 50 independently — otherwise 30+30=60 units would sell
    // against only 50 in stock.
    it("rejects duplicate product_id line items that together exceed stock", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3509", operatorName: "テスト 生徒09" });
      await expect(
        caller.transaction.create({
          items: [
            { product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 30 },
            { product_id: 1, name: "たこ焼き", emoji: "🐙", price: 400, cost: 150, qty: 30 },
          ],
          total: 24000,
          received: 24000,
          changeAmount: 0,
        })
      ).rejects.toThrow("在庫が不足しています");
    });
  });

  describe("transaction.void (admin only)", () => {
    it("allows admin to void a transaction", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.transaction.void({ id: 1 });
      expect(result).toEqual({ success: true });
    });

    it("refuses to void the same sale twice (no second log entry)", async () => {
      const db = await import("./db");
      (db.getTransactionById as any).mockResolvedValueOnce({ id: 1, total: 400, voided: true });
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      await expect(caller.transaction.void({ id: 1 })).rejects.toThrow("すでに取消済み");
      expect(db.voidTransaction).not.toHaveBeenCalled();
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.transaction.void({ id: 1 })
      ).rejects.toThrow("管理者権限が必要です");
    });
  });

  describe("transaction.delete (admin only)", () => {
    it("allows admin to delete a voided transaction", async () => {
      const db = await import("./db");
      (db.getTransactionById as any).mockResolvedValueOnce({ id: 1, total: 400, voided: true, items: [{ name: "たこ焼き", qty: 1 }] });
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.transaction.delete({ id: 1 });
      expect(result).toEqual({ success: true });
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "delete_tx", detail: expect.stringContaining("たこ焼き×1") }));
    });

    it("refuses to delete a sale that hasn't been voided (its money would vanish)", async () => {
      const db = await import("./db");
      (db.getTransactionById as any).mockResolvedValueOnce({ id: 1, total: 400, voided: false, items: [] });
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      await expect(caller.transaction.delete({ id: 1 })).rejects.toThrow("取消済みの取引だけ");
      expect(db.deleteTransaction).not.toHaveBeenCalled();
    });

    it("bulk delete is all-or-nothing: any live sale in the selection refuses the whole request", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      (db.getTransactionsByIds as any).mockResolvedValueOnce([{ id: 1, voided: true }, { id: 2, voided: false }]);
      await expect(caller.transaction.deleteMany({ ids: [1, 2] })).rejects.toThrow("#2");
      expect(db.deleteVoidedTransactionsByIds).not.toHaveBeenCalled();
      (db.getTransactionsByIds as any).mockResolvedValueOnce([{ id: 1, voided: true }, { id: 3, voided: true }]);
      (db.deleteVoidedTransactionsByIds as any).mockResolvedValueOnce(2);
      await expect(caller.transaction.deleteMany({ ids: [1, 3] })).resolves.toEqual({ success: true, count: 2 });
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.transaction.delete({ id: 1 })
      ).rejects.toThrow("管理者権限が必要です");
    });
  });

  describe("restock.create (admin only)", () => {
    it("allows admin to create a restock entry", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const result = await caller.restock.create({ productId: 1, amount: 10 });
      expect(result).toEqual({ id: 1, availableOn: null });
    });

    it("can schedule stock for a later day; today means at once; past, far-future and impossible dates are refused", async () => {
      const db = await import("./db");
      const { jstDate } = await import("@shared/stockSchedule");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      const day = (offset: number) => jstDate(Date.now() + offset * 86_400_000);
      const r = await caller.restock.create({ productId: 1, amount: 80, availableOn: day(1) });
      expect(r.availableOn).toBe(day(1));
      expect(db.createRestock).toHaveBeenCalledWith(expect.objectContaining({ amount: 80, availableOn: day(1) }));
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "restock", detail: expect.stringContaining("+80個（日付指定）") }));
      await expect(caller.restock.create({ productId: 1, amount: 5, availableOn: day(0) })).resolves.toMatchObject({ availableOn: null });
      await expect(caller.restock.create({ productId: 1, amount: 5, availableOn: day(-1) })).rejects.toThrow("過去の日付");
      await expect(caller.restock.create({ productId: 1, amount: 5, availableOn: day(61) })).rejects.toThrow("60日より先");
      await expect(caller.restock.create({ productId: 1, amount: 5, availableOn: "2026-02-30" })).rejects.toThrow("日付が正しくありません");
      await expect(caller.restock.create({ productId: 1, amount: 5, availableOn: "10/4" })).rejects.toThrow();
    });

    it("a scheduled restock can be taken back before its day, but not once it is on sale (admin only)", async () => {
      const db = await import("./db");
      const { jstDate } = await import("@shared/stockSchedule");
      const later = { id: 7, productId: 1, amount: 80, operator: ADMIN, availableOn: jstDate(Date.now() + 86_400_000), createdAt: new Date(), updatedAt: new Date() };
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(caller.restock.cancelScheduled({ id: 7 })).rejects.toThrow("管理者権限が必要です");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      (db.getRestockById as any).mockResolvedValueOnce(later);
      await expect(caller.restock.cancelScheduled({ id: 7 })).resolves.toEqual({ success: true });
      expect(db.deleteRestock).toHaveBeenCalledWith(7);
      expect(db.createActivityLog).toHaveBeenCalledWith(expect.objectContaining({ action: "restock", detail: expect.stringContaining("予定を取消") }));
      (db.getRestockById as any).mockResolvedValueOnce({ ...later, availableOn: null });
      await expect(caller.restock.cancelScheduled({ id: 7 })).rejects.toThrow("すでに販売中");
      await expect(caller.restock.cancelScheduled({ id: 99 })).rejects.toThrow("記録が見つかりません");
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(
        caller.restock.create({ productId: 1, amount: 10 })
      ).rejects.toThrow("管理者権限が必要です");
    });
  });

  // The 操作 tab is admin-only, and so is the data behind it: every other
  // register used to download the whole log every 8 seconds for nothing.
  describe("activityLog.list (admin only)", () => {
    it("allows the admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      await expect(caller.activityLog.list()).resolves.toEqual([]);
    });

    it("rejects a regular register", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(caller.activityLog.list()).rejects.toThrow("管理者権限が必要です");
    });
  });

  // What the cashier actually reads when something goes wrong. Goes
  // through the HTTP handler because that is where errorFormatter runs.
  describe("error messages over HTTP", () => {
    async function callOverHttp(path: string, init?: RequestInit) {
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: new Request(`http://localhost/api/trpc/${path}`, init),
        router: appRouter,
        createContext: () => createTestContext(),
      });
      return (await res.json()) as any;
    }

    it("shows a plain instruction instead of a raw database error", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      const db = await import("./db");
      (db.listTransactions as any).mockRejectedValueOnce(
        new Error("Failed query: select `id`, `operator`, `items` from `transactions`")
      );

      const body = await callOverHttp("transaction.list");

      expect(body.error.json.message).toBe(
        "サーバーでエラーが発生しました。少し待ってからもう一度お試しください。"
      );
    });

    it("keeps the message of an error thrown on purpose", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      const body = await callOverHttp("resetAll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      });
      expect(body.error.json.message).toBe("管理者権限が必要です");
    });

    it("shows the validation message rather than zod's JSON dump", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      const body = await callOverHttp("transaction.create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { items: [], total: 0, received: 0, changeAmount: 0 } }),
      });
      expect(body.error.json.message).toBe("カートが空です");
    });
  });

  describe("activity log", () => {
    it("has no API for the screens to write it: every entry is written by the server", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect((caller as any).activityLog.create({ action: "reset_all", detail: "x" })).rejects.toThrow(/No procedure found/);
      expect(Object.keys(appRouter._def.procedures)).not.toContain("activityLog.create");
    });

    it("a product can be saved without an emoji (the log shows just the name)", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "" });
      await caller.product.create({ name: "コーラ", emoji: "", price: 100, cost: 46, initialStock: 42, threshold: 10, displayOrder: 1 });
      expect(db.createProduct).toHaveBeenLastCalledWith(expect.objectContaining({ emoji: "" }));
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ detail: "コーラを追加" }));
      await expect(caller.product.create({ name: "x", emoji: "🥤🥤🥤🥤🥤🥤🥤🥤🥤🥤🥤", price: 100, cost: 1, initialStock: 1, threshold: 1, displayOrder: 1 })).rejects.toThrow("絵文字が長すぎます");
    });

    it("product changes, restocks and sales are logged by the server with the verified operator", async () => {
      const db = await import("./db");
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "偽の名前" });
      await caller.product.create({ name: "わたあめ", emoji: "🍭", price: 100, cost: 30, initialStock: 10, threshold: 2, displayOrder: 9 });
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ operator: ADMIN, operatorName: "テスト 生徒09", action: "add_product", detail: "🍭 わたあめを追加" }));
      await caller.restock.create({ productId: 1, amount: 5 });
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "restock", detail: "🐙 たこ焼き +5個" }));
      await caller.transaction.create({
        items: [{ product_id: 1, name: "x", emoji: "x", price: 1, cost: 0, qty: 2 }],
        total: 1, received: 1000, changeAmount: 0, clientRequestId: "log-test-0001",
      });
      // The booked total, from the product master — not the ¥1 the client claimed.
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "checkout", detail: "合計¥800 (2点) 現金" }));
    });
  });

  describe("resetAll (admin only)", () => {
    it("allows admin to reset all data", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: ADMIN, operatorName: "テスト 生徒09" });
      await expect(caller.resetAll({ confirm: "はい" } as any)).rejects.toThrow("全データリセット");
      const db = await import("./db");
      expect(db.resetAllData).not.toHaveBeenCalled();
      const result = await caller.resetAll({ confirm: "全データリセット" });
      expect(result).toEqual({ success: true });
      // Leaves no sample products behind.
      expect(db.resetAllData).toHaveBeenCalledWith([]);
      // The reset itself is the first line of the new log.
      expect(db.createActivityLog).toHaveBeenLastCalledWith(expect.objectContaining({ operator: ADMIN, action: "reset_all" }));
    });

    it("rejects non-admin", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: NON_ADMIN, operatorName: "テスト 生徒01" });
      await expect(caller.resetAll({ confirm: "全データリセット" })).rejects.toThrow("管理者権限が必要です");
    });

    it("rejects unauthenticated", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue(null);
      await expect(caller.resetAll()).rejects.toThrow("POSセッションが無効です");
    });
  });

  // PIN verification lives inside posSession.login (it used to be a separate
  // pin.verify / pin.setup pair), so the login tests carry that coverage:
  // a session token must never be issued without either matching an existing
  // PIN or registering a brand-new one on first login.
  describe("posSession", () => {

    it("logout clears session", async () => {
      const result = await caller.posSession.logout();
      expect(result).toEqual({ success: true });
      expect(posAuth.clearPosSessionCookie).toHaveBeenCalled();
    });

    it("me returns session info", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue({ operatorId: "3509", operatorName: "テスト 生徒09" });
      const result = await caller.posSession.me();
      expect(result).toEqual({ operatorId: "3509", operatorName: "テスト 生徒09", isAdmin: true, canManageCash: true });
    });

    it("me returns null when no session", async () => {
      (posAuth.verifyPosSession as any).mockResolvedValue(null);
      const result = await caller.posSession.me();
      expect(result).toBeNull();
    });
  });
});
