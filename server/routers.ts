import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { isMember, listMembers, memberName } from "./roster";
import {
  revokePosSession,
  renewPosSessionIfNeeded,
  forgetPinCache,
  verifyPosSession,
  clearPosSessionCookie,
  isAdminOperator,
  hashPin,
  readDevice,
  rememberMemberOnDevice,
  type PosSessionPayload,
} from "./posAuth";
import { loginAlerts } from "./login";
import { shopName } from "./shop";
import { handoverChanged, handoverQueue } from "./handover";
import { WEAK_PIN_MESSAGE, isWeakPin } from "./pinPolicy";
import { TRPCError } from "@trpc/server";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_STYLE,
  DEFAULT_PAYMENT_METHOD,
  isCashless,
  type PaymentMethod,
} from "@shared/paymentTypes";
import {
  cancelPayment,
  confirmManualPayment,
  getPaymentConfig,
  getPaymentStatus,
  getReservedStock,
  reportTerminalResult,
  startPayment,
} from "./payments";
import { computeStock, paymentLines, sameCart } from "./stock";
import { MAX_SCHEDULE_DAYS, isRestockAvailable, jstDate, shortDate } from "@shared/stockSchedule";
import { MAX_IMAGE_BYTES, parseImageDataUrl } from "./productImage";
import {
  DENOMINATIONS,
  DEFAULT_COLLECT_THRESHOLD,
  breakdownTotal,
  cashEventLabel,
  computeDrawer,
  describeExchange,
  type Breakdown,
} from "@shared/cash";

const COLLECT_THRESHOLD_KEY = "cash.collectThreshold";
// Members besides the admin who may register the float, close the day and
// give the float back (会計係). Comma-separated IDs; set by the admin.
const CASH_MANAGERS_KEY = "cash.managers";
const RESET_CONFIRM = "全データリセット";
// The 収支報告 (会計 tab): the festival's name, the group's name and the
// 仕入代金借入高 — this year's values used to be written into the screen
// (経高祭, ¥40,000), so another year or class had to change the code.
const REPORT_KEYS = { eventName: "report.eventName", groupName: "report.groupName", loanAmount: "report.loanAmount" } as const;
const DEFAULT_LOAN_AMOUNT = 40000;
// What practice.seed adds. ¥100 like the real goods (the float is 100円玉);
// the last one has 3 in stock so 売切 and 在庫不足 can be tried too.
const PRACTICE_PRODUCTS = [
  { name: "【練習】ドリンク", emoji: "🧃", price: 100, cost: 0, initialStock: 100, threshold: 5, displayOrder: 91 },
  { name: "【練習】おかし", emoji: "🍬", price: 100, cost: 0, initialStock: 100, threshold: 5, displayOrder: 92 },
  { name: "【練習】残りわずか", emoji: "🧪", price: 100, cost: 0, initialStock: 3, threshold: 2, displayOrder: 93 },
];

async function cashManagers(): Promise<string[]> {
  const raw = await db.getSetting(CASH_MANAGERS_KEY);
  return (raw ?? "").split(",").map((x) => x.trim()).filter((x) => x && isMember(x));
}

/** "🐙 たこ焼き", or just the name when there is no emoji. */
const productLabel = (p: { emoji: string; name: string }) => (p.emoji ? `${p.emoji} ${p.name}` : p.name);

/** "たこ焼き×2、お茶×1" — for audit log lines about a sale. */
function describeItems(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items.map((it: any) => `${it?.name ?? "?"}×${it?.qty ?? "?"}`).join("、");
}

// Bounds on everything a client can send, matching the column sizes: an
// over-long name or an absurd number is refused with a message, instead
// of failing inside the database (or quietly overflowing an INT).
const MAX_YEN = 10_000_000;
const productFields = {
  name: z.string().trim().min(1, "商品名を入力してください").max(100, "商品名が長すぎます"),
  // Optional (a product with a photo doesn't need one; one without shows
  // a plain box icon). Counted in characters (code points), like the
  // varchar(10) column.
  emoji: z.string().trim().refine((v) => Array.from(v).length <= 10, "絵文字が長すぎます"),
  price: z.number().int("価格は整数で入力してください").positive("価格は1円以上にしてください").max(1_000_000, "価格が大きすぎます"),
  cost: z.number().int("原価は整数で入力してください").nonnegative("原価は0円以上にしてください").max(1_000_000, "原価が大きすぎます"),
  initialStock: z.number().int("在庫数は整数で入力してください").nonnegative("在庫数は0以上にしてください").max(100_000, "在庫数が大きすぎます"),
  threshold: z.number().int("警告閾値は整数で入力してください").nonnegative("警告閾値は0以上にしてください").max(100_000, "警告閾値が大きすぎます"),
  displayOrder: z.number().int("表示順は整数で入力してください").min(-100_000).max(100_000),
};

// Every activity log entry is written by the server, as part of the action
// it records. The screens used to write some themselves (会計, 補充, 商品,
// リセット…) through an API that took any text — so anyone logged in
// could add a "全リセット" line that never happened.
async function writeLog(op: PosSessionPayload, action: string, detail?: string): Promise<void> {
  await db.createActivityLog({ operator: op.operatorId, operatorName: memberName(op.operatorId), action, detail });
}
const yenText = (n: number) => "¥" + n.toLocaleString("ja-JP");

// Count per denomination. Keys are the denominations as strings
// ("1000", "100", …); the cap is far beyond any real cash box and only
// stops a typo from turning into a ten-digit float.
const breakdownInput = z
  .record(z.string(), z.number().int().min(0).max(10000))
  .refine((b) => Object.keys(b).every((k) => (DENOMINATIONS as readonly number[]).includes(Number(k))), {
    message: "金種が正しくありません",
  });


// Requires a valid POS session (PIN-verified login). Throws UNAUTHORIZED
// if the session cookie/header is missing or invalid.
const posAuthenticatedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const session = await verifyPosSession(ctx.req);
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "POSセッションが無効です。再ログインしてください。" });
  }
  await renewPosSessionIfNeeded(ctx.req, ctx.res, session);
  // Phones logged in before the device cookie existed get it here, without
  // logging out (server/posAuth.ts, rememberMemberOnDevice).
  const device = await readDevice(ctx.req);
  if (!device?.ids.includes(session.operatorId)) {
    await rememberMemberOnDevice(ctx.req, ctx.res, session.operatorId, device);
  }
  return next({ ctx: { ...ctx, posOperator: session } });
});

// Requires the authenticated operator to be an admin (POS_ADMIN_IDS).
const posAdminProcedure = posAuthenticatedProcedure.use(({ ctx, next }) => {
  if (!isAdminOperator((ctx as any).posOperator.operatorId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "管理者権限が必要です" });
  }
  return next();
});

// The admin, or a 会計係 the admin named: registering the float, closing
// the day and giving the float back decide what the day's cash is checked
// against. Anyone could do them before; a 締め followed by a new float in
// the middle of the day dropped the earlier sales out of the count.
// (Not admin-only: whoever handles the money isn't always the admin.)
const cashManagerProcedure = posAuthenticatedProcedure.use(async ({ ctx, next }) => {
  const id = (ctx as any).posOperator.operatorId as string;
  if (!isAdminOperator(id) && !(await cashManagers()).includes(id)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "釣り銭の登録・締め・返却は、管理者か会計係が行います" });
  }
  return next();
});

export const appRouter = router({
  // ===== POS Session =====
  posSession: router({
    // Logging in is the server-rendered page at "/" (server/login.ts).
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const session = await verifyPosSession(ctx.req);
      if (session) await writeLog(session, "logout").catch((err) => console.error("[Logout] activity log failed:", err));
      await revokePosSession(ctx.req);
      clearPosSessionCookie(ctx.res, ctx.req);
      return { success: true };
    }),
    // Who is logged in on this device, with the admin flag decided by the
    // server — the screens no longer carry the admin ID or the roster.
    me: publicProcedure.query(async ({ ctx }) => {
      const session = await verifyPosSession(ctx.req);
      if (!session) return null;
      const isAdmin = isAdminOperator(session.operatorId);
      return {
        operatorId: session.operatorId,
        operatorName: memberName(session.operatorId),
        isAdmin,
        canManageCash: isAdmin || (await cashManagers()).includes(session.operatorId),
      };
    }),
  }),

  // ===== Class roster =====
  // Names for the logged-in screens (history, cash records, PIN
  // management). Never public: the roster is personal information.
  member: router({
    list: posAuthenticatedProcedure.query(() => listMembers()),
  }),

  // ===== PIN management =====
  pin: router({
    list: posAdminProcedure.query(async () => {
      const rows = await db.listMemberPins();
      // Not the request code: the admin has to read it off the member's screen.
      return rows.map((r) => ({ memberId: r.memberId, approved: r.approved, hasRequestCode: !!r.requestCode, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    }),
    // Wrong PINs in the last hour (server/login.ts), for the admin's warning.
    alerts: posAdminProcedure.query(() => loginAlerts()),
    // A PIN chosen at first login opens nothing until this (server/login.ts),
    // with the request code shown on the screen of the device that asked:
    // the member shows it, the admin types it. A request someone else made
    // under their number has a different code, so it can't be approved by
    // mistake for theirs.
    approve: posAdminProcedure
      .input(z.object({
        memberId: z.string().refine((v) => isMember(v), "不正な個人番号です"),
        code: z.string().trim().max(10),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const row = await db.getMemberPin(input.memberId);
        if (!row || row.approved) {
          throw new TRPCError({ code: "NOT_FOUND", message: "承認待ちのPINがありません" });
        }
        if (!row.requestCode) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "申請コードのない古い申請です。却下して、本人にもう一度PINを設定してもらってください" });
        }
        const code = input.code.toUpperCase();
        if (code !== row.requestCode || !(await db.approveMemberPin(input.memberId, code))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "申請コードが違います。本人の画面のコードを確認してください（新しく申請し直すとコードは変わります）" });
        }
        forgetPinCache(input.memberId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "approve_pin",
          detail: `メンバー${input.memberId}（${memberName(input.memberId)}）のPINを承認`,
        });
        return { success: true };
      }),
    reset: posAdminProcedure
      .input(z.object({
        memberId: z.string().refine((v) => isMember(v), "不正な個人番号です"),
        pin: z.string().regex(/^\d{4}$/, "PINは4桁の数字で入力してください"),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        if (isWeakPin(input.pin)) throw new TRPCError({ code: "BAD_REQUEST", message: WEAK_PIN_MESSAGE });
        await db.upsertMemberPin(input.memberId, await hashPin(input.pin));
        // Ends that member's open sessions (they were opened with the old PIN).
        forgetPinCache(input.memberId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "reset_pin",
          detail: `メンバー${input.memberId}のPINをリセット`,
        });
        return { success: true };
      }),
    delete: posAdminProcedure
      .input(z.object({ memberId: z.string().refine((v) => isMember(v), "不正な個人番号です") }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const existing = await db.getMemberPin(input.memberId);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "このメンバーはまだPINを設定していません" });
        }
        await db.deleteMemberPin(input.memberId);
        forgetPinCache(input.memberId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "delete_pin",
          detail: existing.approved ? `メンバー${input.memberId}のPINを削除` : `メンバー${input.memberId}のPIN登録申請を却下`,
        });
        return { success: true };
      }),
  }),

  // ===== Products =====
  product: router({
    list: posAuthenticatedProcedure.query(async () => {
      return db.listProducts();
    }),
    create: posAdminProcedure
      .input(z.object({
        ...productFields,
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await db.createProduct(input);
        await writeLog((ctx as any).posOperator, "add_product", `${productLabel(input)}を追加`);
        return { id };
      }),
    update: posAdminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        ...productFields,
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        await db.updateProduct(id, data);
        await writeLog((ctx as any).posOperator, "edit_product", `${productLabel(input)}を編集`);
        return { success: true };
      }),
    delete: posAdminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const product = (await db.listProducts()).find((p) => p.id === input.id);
        if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "商品が見つかりません" });
        await db.deleteProduct(input.id);
        await writeLog((ctx as any).posOperator, "delete_product", `${productLabel(product)}を削除`);
        return { success: true };
      }),
    // Sets the product's photo, or removes it with `image: null` (the emoji
    // is shown again). Admin only, like every other product change. The
    // string length bound is a cheap pre-check; parseImageDataUrl enforces
    // the real byte limit and the file format.
    setImage: posAdminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        image: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64).nullable(),
      }))
      .mutation(async ({ input }) => {
        const image = input.image === null ? null : parseImageDataUrl(input.image);
        const found = await db.setProductImage(input.id, image);
        if (!found) {
          throw new TRPCError({ code: "NOT_FOUND", message: "商品が見つかりません" });
        }
        return { imageHash: image?.hash ?? null };
      }),
  }),

  // ===== Cashless payments =====
  //
  // This router only ever *prepares* money movement — it never writes a
  // sale. A transaction is created by transaction.create, and only for a
  // payment that already reached "completed". Keeping the two apart is
  // what makes a failed or abandoned payment a non-event rather than a
  // phantom sale in the day's takings.
  payment: router({
    // Tells the client whether to render the payment-method picker at
    // all. Authenticated because it names the provider — not a secret,
    // but not something to hand to anonymous visitors either.
    config: posAuthenticatedProcedure.query(() => getPaymentConfig()),

    // Opens a payment with the provider. The client sends the cart, never
    // an amount: the total is recomputed from the product master inside
    // startPayment, so a hand-crafted request cannot pay ¥1 for a ¥400
    // order.
    createIntent: posAuthenticatedProcedure
      .input(z.object({
        method: z.enum(PAYMENT_METHODS),
        items: z.array(z.object({
          product_id: z.number().int().positive(),
          qty: z.number().int().positive(),
        })).min(1, "カートが空です"),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        return startPayment({
          method: input.method,
          items: input.items,
          operatorId: op.operatorId,
        });
      }),

    // Polled by the register while the customer pays. Also the path that
    // notices a provider-side completion when the webhook never arrived
    // (venue wifi being what it is).
    get: posAuthenticatedProcedure
      .input(z.object({ paymentId: z.number().int().positive() }))
      .query(async ({ input }) => getPaymentStatus(input.paymentId)),

    // Admin-only on purpose: with a printed counter QR there is no API to
    // confirm against, so this books money on the cashier's word. Gating
    // it to the admin keeps every such confirmation attributable, and the
    // activity log entry below is deliberately marked as a warning.
    confirmManual: posAdminProcedure
      .input(z.object({ paymentId: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const payment = await confirmManualPayment(input.paymentId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "payment_confirm",
          detail: `決済#${payment.paymentId} (¥${payment.amount.toLocaleString("ja-JP")}) を手動確定`,
        });
        return payment;
      }),

    // App-to-app terminal result (Airペイ / Square / stera 型). Not
    // admin-gated: with a card reader this runs on every single sale, so
    // gating it would mean the admin has to stand at the register all
    // day. The safeguards are different in kind — an approval must carry
    // a slip reference, and the operator who reported it is logged, so
    // the day's cashless sales can be matched against the payment
    // company's 入金明細 afterwards. See service.reportTerminalResult.
    reportTerminalResult: posAuthenticatedProcedure
      .input(z.object({
        paymentId: z.number().int().positive(),
        approved: z.boolean(),
        providerRef: z.string().max(191).optional(),
        providerPaymentId: z.string().max(191).optional(),
        errorMessage: z.string().max(255).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const payment = await reportTerminalResult(input.paymentId, {
          approved: input.approved,
          providerRef: input.providerRef,
          providerPaymentId: input.providerPaymentId,
          errorMessage: input.errorMessage,
        });
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "payment_terminal",
          detail: input.approved
            ? `決済#${payment.paymentId} (¥${payment.amount.toLocaleString("ja-JP")}) 端末承認 伝票${payment.providerRef ?? "-"}`
            : `決済#${payment.paymentId} 端末で否認 (${input.errorMessage || "理由不明"})`,
        });
        return payment;
      }),

    // Units held by payments other customers are in the middle of making.
    // Polled by the register so the product grid shows what can actually
    // be sold right now rather than what is merely unsold.
    reservedStock: posAuthenticatedProcedure.query(async () => getReservedStock()),

    cancel: posAuthenticatedProcedure
      .input(z.object({ paymentId: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const payment = await cancelPayment(input.paymentId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "payment_cancel",
          detail: `決済#${payment.paymentId} (¥${payment.amount.toLocaleString("ja-JP")}) を取消`,
        });
        return payment;
      }),

    // For end-of-day reconciliation: payments that never became sales
    // (expired, cancelled, failed) are invisible in the transaction
    // history by design, and this is where they can be found.
    list: posAdminProcedure.query(async () => db.listPayments()),
  }),

  // ===== Transactions =====
  transaction: router({
    list: posAuthenticatedProcedure.query(async () => {
      return db.listTransactions();
    }),
    create: posAuthenticatedProcedure
      .input(z.object({
        items: z.array(z.object({
          // Positive integers only. price/cost/total below are recomputed
          // from the product master, but qty is taken as given — a zero or
          // negative qty would pass the stock check trivially and then
          // *add* stock and *subtract* sales, silently corrupting both.
          product_id: z.number().int().positive(),
          name: z.string(),
          emoji: z.string(),
          price: z.number(),
          cost: z.number(),
          qty: z.number().int().positive().max(999),
        })).min(1, "カートが空です").max(100, "カートの品目が多すぎます"),
        total: z.number(),
        // Bounded so a slipped finger (an extra few zeros) is rejected with
        // a message instead of overflowing the INT column mid-transaction.
        received: z.number().nonnegative().max(10_000_000, "預かり金額が大きすぎます"),
        changeAmount: z.number(),
        // Both optional so an older client (or any caller that predates
        // cashless) keeps producing exactly the cash sale it always did.
        paymentMethod: z.enum(PAYMENT_METHODS).optional(),
        paymentId: z.number().int().positive().optional(),
        // One per checkout attempt, reused by every retry of it — see
        // transactions.clientRequestId. Optional so an old cached client
        // keeps working (it just doesn't get retry protection).
        clientRequestId: z.string().min(8).max(64).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const paymentMethod: PaymentMethod = input.paymentMethod ?? DEFAULT_PAYMENT_METHOD;
        // Yen has no minor unit; a stray decimal typed into the 預かり field
        // must not reach the INT columns as a fraction.
        const received = Math.floor(input.received);

        // Row-lock the involved products for the duration of the checkout
        // (see createTransactionSerialized) so two registers can never both
        // read the same pre-sale stock and both oversell the last unit.
        const productIds = input.items.map((it) => it.product_id);

        // The total as booked (from the product master), for the log line.
        let bookedTotal = input.total;
        const result = await db.createTransactionSerialized(productIds, async (tx) => {
          // Server-side stock validation to prevent overselling across
          // multiple registers. computeStock is the same function the
          // pre-payment check and the register's display use, so all
          // three agree on what "in stock" means — including the units
          // reserved by payments other customers are still making.
          const [products, txs, restocks, openPayments] = await Promise.all([
            tx.listProducts(),
            tx.listTransactions(),
            tx.listRestocks(),
            tx.listOpenPayments(),
          ]);
          const productMap: Record<number, (typeof products)[number]> = {};
          for (const p of products) productMap[p.id] = p;

          const snapshot = computeStock({
            products,
            transactions: txs,
            restocks,
            openPayments,
            // This checkout's own payment reserved these very items;
            // counting that reservation would block the sale it exists
            // to protect.
            excludePaymentId: input.paymentId,
          });
          const stock = snapshot.available;

          // Recompute authoritative price/cost/total from the product master
          // instead of trusting client-submitted values.
          let serverTotal = 0;
          const verifiedItems = input.items.map((it) => {
            const product = productMap[it.product_id];
            if (!product) {
              throw new TRPCError({ code: "BAD_REQUEST", message: `商品ID ${it.product_id} が見つかりません` });
            }
            if ((stock[it.product_id] ?? 0) < it.qty) {
              throw new TRPCError({ code: "CONFLICT", message: `${product.name}の在庫が不足しています` });
            }
            // Decrement the running balance immediately so a second line
            // item referencing the same product_id (whether from a client
            // bug or a hand-crafted request) is checked against what's
            // actually left, not the pre-checkout snapshot.
            stock[it.product_id] -= it.qty;
            serverTotal += product.price * it.qty;
            return {
              product_id: it.product_id,
              name: product.name,
              emoji: product.emoji,
              price: product.price,
              cost: product.cost,
              qty: it.qty,
            };
          });

          bookedTotal = serverTotal;

          if (!isCashless(paymentMethod)) {
            if (received < serverTotal) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "預かり金が合計金額に足りません" });
            }
            return {
              operator: op.operatorId,
              items: verifiedItems,
              total: serverTotal,
              received,
              changeAmount: received - serverTotal,
              paymentMethod,
              paymentStatus: "completed",
              paymentId: null,
              paymentRef: null,
            };
          }

          // ===== Cashless: the sale is only allowed to exist because a
          // payment already completed. Every check below is against the
          // row locked in this same DB transaction, so two registers
          // quoting one payment serialize and the second one loses.
          if (input.paymentId == null) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "キャッシュレス決済には決済IDが必要です",
            });
          }
          const payment = await tx.lockPayment(input.paymentId);
          if (!payment) {
            throw new TRPCError({ code: "NOT_FOUND", message: "決済が見つかりません" });
          }
          if (payment.transactionId != null) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `この決済は取引#${payment.transactionId}で会計済みです`,
            });
          }
          if (payment.status !== "completed") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "支払いがまだ完了していません",
            });
          }
          if (payment.method !== paymentMethod) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "決済の支払い方法が一致しません",
            });
          }
          // Guards the window between "customer paid" and "cashier
          // confirmed": if a product's price changed in between, the
          // amount collected no longer matches the cart, and booking it
          // anyway would silently over- or under-charge.
          if (payment.amount !== serverTotal) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `決済金額（¥${payment.amount.toLocaleString("ja-JP")}）と合計金額（¥${serverTotal.toLocaleString("ja-JP")}）が一致しません`,
            });
          }
          // Matching totals is not the same as matching goods: two carts
          // can add up to the same yen figure, and booking the wrong one
          // would deduct stock from products the customer never bought.
          // (Payments opened before this column existed have no stored
          // cart; those fall back to the amount check above.)
          const paidLines = paymentLines(payment);
          if (paidLines.length > 0 && !sameCart(paidLines, input.items)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "決済時の商品内容と会計内容が一致しません",
            });
          }

          return {
            operator: op.operatorId,
            items: verifiedItems,
            total: serverTotal,
            // No cash drawer movement: the till reconciliation adds up
            // `received`/`changeAmount` across the day, so a cashless
            // sale must contribute nothing to either.
            received: serverTotal,
            changeAmount: 0,
            paymentMethod,
            paymentStatus: "completed",
            paymentId: payment.id,
            // Carried onto the sale so the day's cashless takings can be
            // matched against the payment company's 入金明細 from the CSV
            // export alone.
            paymentRef: payment.providerRef ?? null,
          };
        }, { clientRequestId: input.clientRequestId });

        // The log line (it used to be written by the register, after the
        // fact). A retry of a recorded sale isn't a second sale. The sale is
        // recorded either way: a failed log write mustn't fail the checkout.
        if (!result.duplicate) {
          const count = input.items.reduce((n, it) => n + it.qty, 0);
          await writeLog(op, "checkout", `合計${yenText(bookedTotal)} (${count}点) ${PAYMENT_METHOD_STYLE[paymentMethod].label}`)
            .catch((err) => console.error("[Checkout] activity log failed:", err));
        }

        // `duplicate` tells the register this was a retry of a sale that
        // had already been recorded (its first response never arrived), so
        // it can say so instead of implying a second sale happened.
        handoverChanged();
        return { id: result.id, duplicate: result.duplicate, orderNo: result.orderNo ?? null };
      }),
    // Logs atomically inside the mutation (like deleteMany/accounting.create
    // already did) instead of depending on a second client round-trip —
    // otherwise a dropped connection between the mutation and the client's
    // follow-up activityLog.create call leaves the void with no audit entry.
    void: posAdminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const tx = await db.getTransactionById(input.id);
        if (!tx) {
          throw new TRPCError({ code: "NOT_FOUND", message: "取引が見つかりません" });
        }
        if (tx.voided) {
          throw new TRPCError({ code: "CONFLICT", message: "この取引はすでに取消済みです" });
        }
        await db.voidTransaction(input.id);
        handoverChanged();
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "void_tx",
          detail: `取引#${input.id} (¥${tx.total.toLocaleString("ja-JP")}) を取消`,
        });
        return { success: true };
      }),
    delete: posAdminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const tx = await db.getTransactionById(input.id);
        if (!tx) {
          throw new TRPCError({ code: "NOT_FOUND", message: "取引が見つかりません" });
        }
        // A sale is erased only after it has been voided. Deleting a live
        // sale made its money vanish from the day's takings with nothing
        // but a log line to show for it — and for a cash sale, the drawer's
        // expected amount dropped too, so the till then read as over.
        // Voiding first leaves its own log entry and takes the sale out of
        // every total; deleting afterwards only tidies the list.
        if (!tx.voided) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "削除できるのは取消済みの取引だけです。先に取消してください" });
        }
        await db.deleteTransaction(input.id);
        handoverChanged();
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "delete_tx",
          detail: `取消済みの取引#${input.id} (¥${tx.total.toLocaleString("ja-JP")}) を削除: ${describeItems(tx.items)}`.slice(0, 500),
        });
        return { success: true };
      }),
    deleteMany: posAdminProcedure
      .input(z.object({ ids: z.array(z.number().int().positive()).min(1, "1件以上選択してください").max(1000) }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        // Same rule as delete: voided sales only, all or nothing.
        const rows = await db.getTransactionsByIds(input.ids);
        const live = rows.filter((t) => !t.voided);
        if (live.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `取消されていない取引（#${live.slice(0, 5).map((t) => t.id).join(", #")}${live.length > 5 ? " ほか" : ""}）は削除できません。先に取消してください`,
          });
        }
        const deletedCount = await db.deleteVoidedTransactionsByIds(input.ids);
        handoverChanged();
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "delete_tx",
          detail: `取消済みの取引を${deletedCount}件まとめて削除（#${rows.map((t) => t.id).join(", #")}）`.slice(0, 500),
        });
        return { success: true, count: deletedCount };
      }),
  }),

  // ===== Restocks =====
  restock: router({
    list: posAuthenticatedProcedure.query(async () => {
      return db.listRestocks();
    }),
    // Admin-only, matching the UI (InventoryTab only renders the restock
    // buttons when isAdmin). Without this, any logged-in operator could
    // call the endpoint directly and inflate stock past the UI's gate.
    create: posAdminProcedure
      .input(z.object({
        productId: z.number().int().positive(),
        amount: z.number().int().positive().max(100_000, "補充数が大きすぎます"),
        // Stock for a later day (Japan time): counts from 0:00 that day
        // (shared/stockSchedule.ts). Omitted, or today: available at once.
        availableOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付が正しくありません").optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const products = await db.listProducts();
        const product = products.find((p) => p.id === input.productId);
        if (!product) {
          throw new TRPCError({ code: "NOT_FOUND", message: "商品が見つかりません" });
        }
        let availableOn: string | null = null;
        if (input.availableOn) {
          const day = new Date(`${input.availableOn}T00:00:00+09:00`);
          if (Number.isNaN(day.getTime()) || jstDate(day) !== input.availableOn) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "日付が正しくありません" });
          }
          const today = jstDate();
          if (input.availableOn < today) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "過去の日付は指定できません" });
          }
          if (input.availableOn > jstDate(Date.now() + MAX_SCHEDULE_DAYS * 86_400_000)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `${MAX_SCHEDULE_DAYS}日より先の日付は指定できません` });
          }
          if (input.availableOn > today) availableOn = input.availableOn;
        }
        const id = await db.createRestock({
          productId: input.productId,
          amount: input.amount,
          operator: op.operatorId,
          availableOn,
        });
        await writeLog(
          op,
          "restock",
          availableOn
            ? `${productLabel(product)}：${shortDate(availableOn)}から +${input.amount}個（日付指定）`
            : `${productLabel(product)} +${input.amount}個`
        );
        return { id, availableOn };
      }),

    // Takes back stock planned for a later day, before that day comes
    // (entered on the wrong date or in the wrong amount). Stock that has
    // already gone on sale stays: it is part of what was sold against.
    cancelScheduled: posAdminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const restock = await db.getRestockById(input.id);
        if (!restock) throw new TRPCError({ code: "NOT_FOUND", message: "記録が見つかりません" });
        if (isRestockAvailable(restock, jstDate())) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "すでに販売中の在庫は取り消せません" });
        }
        await db.deleteRestock(input.id);
        const product = (await db.listProducts()).find((p) => p.id === restock.productId);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "restock",
          detail: `${product ? productLabel(product) : `商品#${restock.productId}`}：${shortDate(restock.availableOn!)}から +${restock.amount}個 の予定を取消`,
        });
        return { success: true };
      }),
  }),

  // ===== Handover counter (受け渡し, server/handover.ts) =====
  // Anyone logged in: whoever staffs the counter is rarely the admin.
  // Individual taps aren't in the activity log (one per sale would bury it);
  // the sale records who handed it over and when (handedBy / handedAt).
  handover: router({
    queue: posAuthenticatedProcedure.query(() => handoverQueue()),
    complete: posAuthenticatedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const done = await db.markHandedOver(input.id, op.operatorId);
        handoverChanged();
        // Not an error when it was already done: two people at the counter
        // may tap the same order.
        return { success: true, already: !done };
      }),
    undo: posAuthenticatedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        if (!(await db.undoHandedOver(input.id))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "戻せる注文がありません" });
        }
        handoverChanged();
        return { success: true };
      }),
    // Everything waiting → handed over: sales typed in afterwards from the
    // paper record (runbook ch. 4), whose goods went out long ago.
    completeAll: posAuthenticatedProcedure.mutation(async ({ ctx }) => {
      const op = (ctx as any).posOperator as PosSessionPayload;
      const count = await db.markAllHandedOver(op.operatorId);
      handoverChanged();
      if (count > 0) await writeLog(op, "handover_all", `受け渡し待ち ${count}件 をまとめて「渡した」にした`);
      return { count };
    }),
  }),

  // ===== Activity Logs =====
  activityLog: router({
    // Admin-only, matching the UI (the 操作 tab only exists for the admin).
    // It used to be open to every register, and every register polled it
    // every 8 seconds — downloading a log nobody but the admin can open,
    // and one that grows with every sale. At festival scale that was about
    // a third of every device's traffic.
    list: posAdminProcedure.query(async () => {
      return db.listActivityLogs();
    }),
  }),

  // ===== Accounting (purchase expenses / profit deductions / loan repay) =====
  // Admin only on the server too, matching the UI (the 会計 tab is the
  // admin's). It used to be open to any logged-in register: anyone could
  // read the class's books or add expenses by calling the API directly.
  accounting: router({
    list: posAdminProcedure.query(async () => {
      return db.listAccountingEntries();
    }),
    settings: posAdminProcedure.query(async () => {
      const [eventName, groupName, loanAmount] = await Promise.all([
        db.getSetting(REPORT_KEYS.eventName),
        db.getSetting(REPORT_KEYS.groupName),
        db.getSetting(REPORT_KEYS.loanAmount),
      ]);
      return {
        eventName: eventName ?? "",
        // Until set, the shop's name from Render (POS_SHOP_NAME), if any.
        groupName: groupName ?? shopName(),
        loanAmount: loanAmount === null ? DEFAULT_LOAN_AMOUNT : Number(loanAmount) || 0,
      };
    }),
    saveSettings: posAdminProcedure
      .input(z.object({
        eventName: z.string().trim().max(30, "行事名が長すぎます"),
        groupName: z.string().trim().max(40, "団体名が長すぎます"),
        loanAmount: z.number().int("借入金は整数で入力してください").min(0, "借入金は0円以上にしてください").max(MAX_YEN, "借入金が大きすぎます"),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.setSetting(REPORT_KEYS.eventName, input.eventName);
        await db.setSetting(REPORT_KEYS.groupName, input.groupName);
        await db.setSetting(REPORT_KEYS.loanAmount, String(input.loanAmount));
        await writeLog((ctx as any).posOperator, "report_settings",
          `報告書の設定：行事名「${input.eventName || "なし"}」・団体名「${input.groupName || "なし"}」・借入金 ${yenText(input.loanAmount)}`);
        return { success: true };
      }),
    create: posAdminProcedure
      .input(z.object({
        category: z.enum(["purchase", "deduction", "loan_repay"]),
        label: z.string().trim().min(1, "項目名を入力してください").max(100, "項目名が長すぎます"),
        amount: z.number().int().positive("金額は1円以上で入力してください").max(MAX_YEN, "金額が大きすぎます"),
        note: z.string().max(255).optional(),
        receiptNo: z.string().max(50).optional(),
        quantity: z.number().int().positive().max(100_000).optional(),
        unitPrice: z.number().int().positive().max(MAX_YEN).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const id = await db.createAccountingEntry({
          category: input.category,
          label: input.label,
          amount: input.amount,
          note: input.note,
          receiptNo: input.receiptNo,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          operator: op.operatorId,
        });
        const actionMap = {
          purchase: "add_purchase",
          deduction: "add_deduction",
          loan_repay: "loan_repay",
        } as const;
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: actionMap[input.category],
          detail: `${input.label} ${input.amount.toLocaleString("ja-JP")}円`,
        });
        return { id };
      }),
    delete: posAdminProcedure
      .input(z.object({ id: z.number().int().positive(), category: z.enum(["purchase", "deduction", "loan_repay"]) }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        // What is logged comes from the stored entry, not from the request:
        // the category sent by the client used to decide the log line (a
        // deleted deduction could be logged as a purchase), and deleting an
        // entry that didn't exist still wrote "deleted" to the audit log.
        const entry = await db.getAccountingEntryById(input.id);
        if (!entry) {
          throw new TRPCError({ code: "NOT_FOUND", message: "会計記録が見つかりません" });
        }
        await db.deleteAccountingEntry(input.id);
        const deleteActionMap = {
          purchase: "delete_purchase",
          deduction: "delete_deduction",
          loan_repay: "delete_loan_repay",
        } as const;
        const label = { purchase: "仕入れ", deduction: "控除", loan_repay: "貸付金返済" }[entry.category as "purchase"] ?? entry.category;
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: deleteActionMap[entry.category as keyof typeof deleteActionMap] ?? "delete_purchase",
          detail: `${label}「${entry.label}」 ¥${entry.amount.toLocaleString("ja-JP")} を削除`,
        });
        return { success: true };
      }),
  }),

  // ===== Cash drawer (釣り銭・回収・締め) =====
  //
  // Any logged-in cashier can record these: collecting money and counting
  // the box are routine jobs, and the 会計係 is not necessarily the admin.
  // Every entry carries who made it and goes to the activity log, and
  // only the admin can delete one (a mistaken entry), like restock/void.
  cash: router({
    list: posAuthenticatedProcedure.query(async () => {
      const [events, threshold, managers] = await Promise.all([db.listCashEvents(), db.getSetting(COLLECT_THRESHOLD_KEY), cashManagers()]);
      return {
        events,
        collectThreshold: threshold === null ? DEFAULT_COLLECT_THRESHOLD : Number(threshold),
        managers,
      };
    }),

    // Who besides the admin may register the float, close and give it back.
    setManagers: posAdminProcedure
      .input(z.object({ memberIds: z.array(z.string().refine((v) => isMember(v), "不正な個人番号です")).max(40) }))
      .mutation(async ({ input, ctx }) => {
        const ids = Array.from(new Set(input.memberIds));
        await db.setSetting(CASH_MANAGERS_KEY, ids.join(","));
        await writeLog(
          (ctx as any).posOperator,
          "cash_managers",
          ids.length ? `会計係：${ids.map((id) => `${id} ${memberName(id)}`).join("、")}` : "会計係：なし（管理者のみ）"
        );
        return { managers: ids };
      }),

    setFloat: cashManagerProcedure
      .input(z.object({
        breakdown: breakdownInput,
        // Who provided the money (担任, 自分, 生徒会…) — the 返却 at the end is checked against this float.
        party: z.string().trim().max(50).optional(),
        note: z.string().max(255).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const amount = breakdownTotal(input.breakdown as Breakdown);
        if (amount <= 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "釣り銭の枚数を入力してください" });
        }
        // A float starts a new business day. Registering one while the
        // current day is still open would silently drop that day's earlier
        // sales out of the drawer's expected cash (they'd be before the new
        // float), so the count would come up short — close the day first.
        // A mistaken float is fixed by the admin deleting it, then
        // registering the right one.
        const [events, txs] = await Promise.all([db.listCashEvents(), db.listTransactions()]);
        const drawer = computeDrawer(events, txs);
        if (drawer.open && !drawer.closedBy) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "今日の釣り銭はすでに登録されています。締めてから次の日の釣り銭を登録してください（間違えた場合は管理者が記録を削除してから登録し直してください）",
          });
        }
        const id = await db.createCashEvent({
          kind: "float",
          amount,
          breakdown: input.breakdown,
          party: input.party || null,
          note: input.note || null,
          operator: op.operatorId,
        });
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_float",
          detail: `釣り銭 ${yenText(amount)} を登録${input.party ? `（用意：${input.party}）` : ""}`,
        });
        return { id, amount };
      }),

    collect: posAuthenticatedProcedure
      .input(z.object({ amount: z.number().int().positive().max(10_000_000), note: z.string().max(255).optional() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const [events, txs] = await Promise.all([db.listCashEvents(), db.listTransactions()]);
        const drawer = computeDrawer(events, txs);
        if (!drawer.open) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "先に釣り銭を登録してください" });
        }
        if (drawer.closedBy) {
          throw new TRPCError({ code: "CONFLICT", message: "締めた後は回収を記録できません（締めの数え直しで記録してください）" });
        }
        // Catches the extra-zero typo before it silently skews the
        // closing count; the float has to stay in the box, so only the
        // takings can go.
        if (input.amount > drawer.expected) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `レジにあるはずの現金（${yenText(drawer.expected)}）より多い金額です`,
          });
        }
        const id = await db.createCashEvent({
          kind: "collect",
          amount: input.amount,
          note: input.note || null,
          operator: op.operatorId,
        });
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_collect",
          detail: `本部へ ${yenText(input.amount)} を回収${input.note ? `（${input.note}）` : ""}`,
        });
        return { id };
      }),

    // Giving the float back to whoever provided it — usually after the
    // last 締め, once the sales have gone to 本部. It can't exceed the float
    // (nobody is paid back more than they lent) nor what should be in the
    // box. If the count came up short, the screen says so; covering the
    // gap (from the sales, say) is the class's decision, not the system's.
    returnFloat: cashManagerProcedure
      .input(z.object({
        amount: z.number().int().positive().max(10_000_000),
        party: z.string().trim().max(50).optional(),
        note: z.string().max(255).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const [events, txs] = await Promise.all([db.listCashEvents(), db.listTransactions()]);
        const drawer = computeDrawer(events, txs);
        if (!drawer.open) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "先に釣り銭を登録してください" });
        }
        const outstanding = drawer.float - drawer.returned;
        if (input.amount > outstanding) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `釣り銭として登録した額（${yenText(drawer.float)}${drawer.returned > 0 ? `、うち ${yenText(drawer.returned)} は返却済み` : ""}）より多い金額です`,
          });
        }
        if (input.amount > drawer.expected) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `レジにあるはずの現金（${yenText(drawer.expected)}）より多い金額です`,
          });
        }
        const party = input.party || drawer.floatParty || null;
        const id = await db.createCashEvent({
          kind: "return",
          amount: input.amount,
          party,
          note: input.note || null,
          operator: op.operatorId,
        });
        const rest = outstanding - input.amount;
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_return",
          detail: `釣り銭 ${yenText(input.amount)} を${party ? `${party}へ` : ""}返却（${rest === 0 ? "全額返却済み" : `残り ${yenText(rest)}`}）${input.note ? ` ${input.note}` : ""}`,
        });
        return { id, returned: drawer.returned + input.amount, float: drawer.float };
      }),

    // 両替 with 本部: notes out, coins in (or the other way), same total.
    // It doesn't change how much is in the box, only what — which is what
    // the coin estimate (and its "running low" warning) needs to know.
    exchange: posAuthenticatedProcedure
      .input(z.object({ out: breakdownInput, in: breakdownInput, note: z.string().max(255).optional() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const [events, txs] = await Promise.all([db.listCashEvents(), db.listTransactions()]);
        const drawer = computeDrawer(events, txs);
        if (!drawer.open) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "先に釣り銭を登録してください" });
        }
        if (drawer.closedBy) {
          throw new TRPCError({ code: "CONFLICT", message: "締めた後は両替を記録できません" });
        }
        const outTotal = breakdownTotal(input.out as Breakdown);
        const inTotal = breakdownTotal(input.in as Breakdown);
        if (outTotal <= 0 || inTotal <= 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "出したお金と受け取ったお金の両方を入力してください" });
        }
        if (outTotal !== inTotal) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `出したお金（${yenText(outTotal)}）と受け取ったお金（${yenText(inTotal)}）の合計が合っていません`,
          });
        }
        // Stored as the net change per denomination: − went out, + came in.
        const net: Record<string, number> = {};
        for (const d of DENOMINATIONS) {
          const n = ((input.in as Record<string, number>)[`${d}`] ?? 0) - ((input.out as Record<string, number>)[`${d}`] ?? 0);
          if (n !== 0) net[`${d}`] = n;
        }
        if (Object.keys(net).length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "同じお金どうしの両替になっています" });
        }
        const id = await db.createCashEvent({
          kind: "exchange",
          amount: outTotal,
          breakdown: net,
          note: input.note || null,
          operator: op.operatorId,
        });
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_exchange",
          detail: `両替（${yenText(outTotal)}）：${describeExchange(net)}${input.note ? ` ${input.note}` : ""}`,
        });
        return { id, amount: outTotal };
      }),

    // The closing count. The expected amount is computed here, from the
    // database, and frozen into the record — not taken from the client,
    // whose idea of the sales could be up to one poll stale.
    count: cashManagerProcedure
      .input(z.object({ breakdown: breakdownInput, note: z.string().max(255).optional() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const [events, txs] = await Promise.all([db.listCashEvents(), db.listTransactions()]);
        const drawer = computeDrawer(events, txs);
        if (!drawer.open) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "先に釣り銭を登録してください" });
        }
        // Once a day. Counting again would freeze a second "expected" next
        // to the first; a count that was wrong is deleted by the admin first.
        if (drawer.closedBy) {
          throw new TRPCError({ code: "CONFLICT", message: "今日はすでに締めています。数え直す場合は、管理者が締めの記録を削除してから締めてください" });
        }
        const counted = breakdownTotal(input.breakdown as Breakdown);
        const difference = counted - drawer.expected;
        const id = await db.createCashEvent({
          kind: "count",
          amount: counted,
          breakdown: input.breakdown,
          expected: drawer.expected,
          note: input.note || null,
          operator: op.operatorId,
        });
        const diffText = difference === 0 ? "差額なし" : `差額 ${difference > 0 ? "+" : "−"}${yenText(Math.abs(difference))}`;
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_count",
          detail: `締め：数えた現金 ${yenText(counted)}（あるべき ${yenText(drawer.expected)}、${diffText}）${input.note ? ` ${input.note}` : ""}`,
        });
        return { id, counted, expected: drawer.expected, difference };
      }),

    delete: posAdminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input, ctx }) => {
        const op = (ctx as any).posOperator as PosSessionPayload;
        const event = await db.getCashEventById(input.id);
        if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "記録が見つかりません" });
        await db.deleteCashEvent(input.id);
        const label = cashEventLabel(event.kind);
        await db.createActivityLog({
          operator: op.operatorId,
          operatorName: memberName(op.operatorId),
          action: "cash_delete",
          detail: `${label}の記録（${yenText(event.amount)}）を削除`,
        });
        return { success: true };
      }),

    setCollectThreshold: posAdminProcedure
      .input(z.object({ amount: z.number().int().min(0).max(10_000_000) }))
      .mutation(async ({ input }) => {
        await db.setSetting(COLLECT_THRESHOLD_KEY, String(input.amount));
        return { success: true };
      }),
  }),

  // ===== Practice (練習用の商品) =====
  // Rehearsal on the real system: add practice products, sell them like
  // anything else (register, handover, cash), then clean up — the practice
  // products and every sale containing one go, in one DB transaction
  // (db.cleanupPractice). Unlike transaction.delete this removes sales that
  // were never voided: they are rehearsal by construction (no real customer
  // buys a 練習 product), and leaving them would put the rehearsal in the
  // takings. Admin only, logged, and scoped to practice products — the
  // real goods' sales are untouched.
  practice: router({
    status: posAdminProcedure.query(() => db.practiceSummary()),
    seed: posAdminProcedure.mutation(async ({ ctx }) => {
      const r = await db.seedPracticeProducts(PRACTICE_PRODUCTS);
      if (r.created || r.adopted) {
        await writeLog((ctx as any).posOperator, "practice_seed",
          r.created ? `練習用の商品 ${r.created}件 を追加` : `練習用の商品 ${r.adopted}件 を練習用に指定`);
      }
      return r;
    }),
    cleanup: posAdminProcedure
      .input(z.object({ cashEventIds: z.array(z.number().int().positive()).max(500) }))
      .mutation(async ({ input, ctx }) => {
        const r = await db.cleanupPractice(input.cashEventIds);
        if (!r.products) throw new TRPCError({ code: "NOT_FOUND", message: "練習用の商品がありません" });
        handoverChanged();
        await writeLog((ctx as any).posOperator, "practice_cleanup",
          `練習を片付け（練習用の商品${r.products}件・会計${r.sales}件・補充${r.restocks}件・現金の記録${r.cashEvents}件を削除、今日の注文番号は次は${r.orderNo + 1}番から）`);
        return r;
      }),
  }),

  // ===== Reset All (Admin only) =====
  // Typed confirmation on the server too, not just a dialog on the screen.
  // The activity log goes with the practice data, but the reset itself is
  // the first line of the new log, and in Render's log.
  resetAll: posAdminProcedure
    .input(z.object({ confirm: z.literal(RESET_CONFIRM, { message: `確認のため「${RESET_CONFIRM}」と入力してください` }) }))
    .mutation(async ({ ctx }) => {
    const op = (ctx as any).posOperator as PosSessionPayload;
    // Wrapped in a single DB transaction (db.resetAllData) so a failure
    // partway through can't leave the shop with a half-wiped database.
    const [txCount, logCount] = await Promise.all([
      db.listTransactions().then((r) => r.length),
      db.listActivityLogs().then((r) => r.length),
    ]);
    // No sample products: a reset is how a shop clears its practice data
    // (or last year's), and sample たこ焼き among its own goods only confused.
    await db.resetAllData([]);
    handoverChanged();
    console.warn(`[Reset] all data reset by ${op.operatorId} (${txCount} sales, ${logCount} log entries)`);
    await writeLog(op, "reset_all", `全データリセット（取引${txCount}件・操作ログ${logCount}件を削除）`);
    return { success: true };
  }),
});

export type AppRouter = typeof appRouter;
