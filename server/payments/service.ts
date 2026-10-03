import { randomUUID } from "crypto";
import { shopName } from "../shop";
import { TRPCError } from "@trpc/server";
import {
  isCashless,
  isTerminalPaymentStatus,
  type PaymentMethod,
  type PaymentPresentation,
  type PaymentStatus,
} from "@shared/paymentTypes";
import type { TerminalResultReport } from "@shared/paymentTypes";
import type { Payment } from "../../drizzle/schema";
import * as db from "../db";
import {
  computeStock,
  findInsufficientStock,
  reservedQuantities,
  type StockSnapshot,
} from "../stock";
import { getEnabledCashlessMethods, getPaymentProvider } from "./registry";
import { PaymentProviderError, type PaymentWebhookEvent } from "./types";

/**
 * Everything the POS does with a payment, minus the tRPC plumbing.
 *
 * Two invariants are enforced here and nowhere else, so they can't drift:
 *
 *  1. The amount charged is always recomputed from the product master.
 *     The client sends a cart, never a price — otherwise a hand-crafted
 *     request could pay ¥1 for a ¥400 order.
 *  2. A transaction is only ever written for a payment whose status is
 *     "completed". Nothing books a sale on "pending" and hopes.
 */

export type PaymentView = {
  paymentId: number;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  presentation: PaymentPresentation;
  expiresAt: string | null;
  errorMessage: string | null;
  /** Slip / approval number, for matching against the 入金明細 later. */
  providerRef: string | null;
  /** Set once this payment has been turned into a sale. */
  transactionId: number | null;
};

export type CartLine = { product_id: number; qty: number };

function toView(payment: Payment, presentation: PaymentPresentation): PaymentView {
  return {
    paymentId: payment.id,
    method: payment.method as PaymentMethod,
    status: payment.status as PaymentStatus,
    amount: payment.amount,
    presentation,
    expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null,
    errorMessage: payment.errorMessage ?? null,
    providerRef: payment.providerRef ?? null,
    transactionId: payment.transactionId ?? null,
  };
}

/**
 * The presentation (QR payload, redirect URL, cashier instructions) comes
 * back from the provider at creation time and is not worth a second API
 * call later, so it is kept in rawPayload and read back out here.
 */
function presentationFrom(payment: Payment): PaymentPresentation {
  const raw = payment.rawPayload as { presentation?: PaymentPresentation } | null;
  return raw?.presentation ?? { kind: "manual" };
}

function requireProvider() {
  const provider = getPaymentProvider();
  if (!provider) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "キャッシュレス決済は現在有効化されていません（現金のみ）",
    });
  }
  return provider;
}

/**
 * Prices a cart from the products table, exactly the way
 * transaction.create does. Kept deliberately separate from the stock
 * check: this runs before the customer pays, when nothing is locked yet.
 */
export async function priceCart(
  items: CartLine[]
): Promise<{ total: number; lines: { name: string; qty: number; unitPrice: number }[] }> {
  if (items.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "カートが空です" });
  }
  const products = await db.listProducts();
  const productMap = new Map(products.map((p) => [p.id, p]));

  let total = 0;
  const lines = items.map((item) => {
    const product = productMap.get(item.product_id);
    if (!product) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `商品ID ${item.product_id} が見つかりません`,
      });
    }
    total += product.price * item.qty;
    return { name: product.name, qty: item.qty, unitPrice: product.price };
  });

  return { total, lines };
}

/** Current stock, with the units held by other in-flight payments removed. */
export async function stockSnapshot(excludePaymentId?: number): Promise<StockSnapshot> {
  const [products, transactions, restocks, openPayments] = await Promise.all([
    db.listProducts(),
    db.listTransactions(),
    db.listRestocks(),
    db.listOpenPayments(),
  ]);
  return computeStock({ products, transactions, restocks, openPayments, excludePaymentId });
}

/**
 * Stock check before taking money.
 *
 * The authoritative check still happens under row locks in
 * transaction.create — that does not move. But because an accepted
 * payment now reserves its cart (see server/stock.ts), this check and
 * that one look at the same numbers, so passing here and failing there
 * takes a genuinely concurrent checkout rather than merely a slow
 * customer.
 *
 * That matters more for cashless than it ever did for cash: telling
 * someone their たこ焼き sold out *after* their card was charged means a
 * refund, and a refund at a school festival means finding an adult with
 * access to the payment company's dashboard.
 */
async function assertStockAvailable(items: CartLine[]): Promise<void> {
  const snapshot = await stockSnapshot();
  const shortName = findInsufficientStock(items, snapshot);
  if (shortName) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${shortName}の在庫が不足しています`,
    });
  }
}

/** Units held by in-flight payments, for the register's stock display. */
export async function getReservedStock(): Promise<Record<number, number>> {
  if (!getPaymentProvider()) return {};
  const openPayments = await db.listOpenPayments();
  return reservedQuantities(openPayments, Date.now());
}

/** Opens a payment with the provider and records it. */
export async function startPayment(params: {
  method: PaymentMethod;
  items: CartLine[];
  operatorId: string;
}): Promise<PaymentView> {
  const provider = requireProvider();

  if (!isCashless(params.method)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "現金の会計に決済の開始は不要です",
    });
  }
  if (!getEnabledCashlessMethods().includes(params.method)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "この支払い方法は利用できません",
    });
  }

  const { total, lines } = await priceCart(params.items);
  if (total <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "金額が不正です" });
  }
  await assertStockAvailable(params.items);

  const orderRef = randomUUID();

  let providerPayment;
  try {
    providerPayment = await provider.createPayment({
      amount: total,
      method: params.method,
      orderRef,
      description: shopName() || "FES POS",
      items: lines,
      operatorId: params.operatorId,
    });
  } catch (error) {
    const message =
      error instanceof PaymentProviderError
        ? error.message
        : "決済サービスに接続できませんでした。現金でお願いするか、もう一度お試しください。";
    console.error("[Payments] createPayment failed:", error);
    throw new TRPCError({ code: "BAD_GATEWAY", message });
  }

  // A provider that reports anything other than the amount we asked for
  // is either misconfigured or being spoofed. Either way, do not proceed.
  if (providerPayment.amount !== total) {
    console.error(
      `[Payments] amount mismatch from ${provider.id}: asked ${total}, got ${providerPayment.amount}`
    );
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "決済サービスから想定外の金額が返されました。処理を中止しました。",
    });
  }

  const paymentId = await db.createPayment({
    provider: provider.id,
    // Blank for terminal providers until the reader reports one back.
    providerPaymentId: providerPayment.providerPaymentId || null,
    method: params.method,
    status: providerPayment.status,
    amount: total,
    // Storing the cart is what reserves the stock while the customer
    // pays, and what transaction.create later checks the sale against.
    items: params.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
    orderRef,
    operator: params.operatorId,
    rawPayload: { presentation: providerPayment.presentation, raw: providerPayment.raw ?? null },
    expiresAt: providerPayment.expiresAt,
  });

  const stored = await db.getPaymentById(paymentId);
  if (!stored) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "決済の記録に失敗しました" });
  }
  return toView(stored, providerPayment.presentation);
}

/**
 * Current state of a payment, asking the provider when it supports
 * polling and the payment is still open.
 *
 * Polling exists because webhooks are unreliable in exactly the setting
 * this POS runs in: a phone on venue wifi behind whatever the school's
 * network does. The register asks; it does not sit waiting to be told.
 */
export async function getPaymentStatus(paymentId: number): Promise<PaymentView> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "決済が見つかりません" });
  }

  const provider = getPaymentProvider();
  const status = payment.status as PaymentStatus;

  // A null providerPaymentId means the provider has not given us an id to
  // ask about (terminal integrations never do), so there is nothing to
  // poll for — the DB is the only record.
  if (
    provider &&
    provider.id === payment.provider &&
    provider.capabilities.polling &&
    payment.providerPaymentId &&
    !isTerminalPaymentStatus(status)
  ) {
    try {
      const latest = await provider.getPayment(payment.providerPaymentId);
      if (latest && latest.status !== status) {
        // Same guard as the webhook path: a provider reporting a
        // different amount than we charged means something is wrong, and
        // "completed" is the one status we must not take on faith.
        if (latest.status === "completed" && latest.amount !== payment.amount) {
          console.error(
            `[Payments] polled amount mismatch on payment ${payment.id}: expected ${payment.amount}, got ${latest.amount}`
          );
          await db.settlePaymentStatus(payment.id, "failed", {
            errorMessage: "金額が一致しませんでした",
          });
        } else {
          await db.settlePaymentStatus(payment.id, latest.status, { rawPayload: {
            presentation: presentationFrom(payment),
            raw: latest.raw ?? null,
          } });
        }
        const refreshed = await db.getPaymentById(paymentId);
        if (refreshed) return toView(refreshed, presentationFrom(refreshed));
      }
    } catch (error) {
      // A polling failure is not a payment failure — keep showing the
      // last known state rather than scaring the cashier into taking
      // money twice.
      console.warn("[Payments] getPayment polling failed:", error);
    }
  }

  return toView(payment, presentationFrom(payment));
}

/**
 * Cashier-confirmed payment, for providers with no API to ask (a printed
 * QR on the counter). Admin-gated in the router: this books money purely
 * on someone's word, so it belongs in the audit log under a known name.
 */
export async function confirmManualPayment(paymentId: number): Promise<PaymentView> {
  const provider = requireProvider();
  if (!provider.capabilities.manualConfirmation) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "この決済プロバイダでは手動確認は使用できません",
    });
  }

  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "決済が見つかりません" });
  }
  const moved = await db.settlePaymentStatus(payment.id, "completed");
  if (!moved) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `この決済はすでに「${payment.status}」で確定しています`,
    });
  }

  const updated = await db.getPaymentById(paymentId);
  return toView(updated!, presentationFrom(updated!));
}

/**
 * Records the outcome of an app-to-app terminal payment.
 *
 * The trust model here is worth being explicit about, because it is
 * weaker than the webhook path and cannot be made stronger. With Airペイ /
 * Square / stera-style integrations there is no server API for us to ask
 * and no signed callback to verify: the provider's app tells the
 * cashier's device, and the device tells us. A logged-in operator could
 * in principle report an approval that never happened.
 *
 * What the design does about that:
 *
 *  - an approval must carry a slip reference (伝票番号 / 承認番号), so
 *    every such sale can be matched line-by-line against the payment
 *    company's 入金明細 at settlement time;
 *  - the operator who reported it is recorded in the activity log;
 *  - the reference is surfaced in the admin payment list and the CSV
 *    export, which is where that reconciliation actually happens.
 *
 * In other words the check is after the fact rather than at the moment of
 * sale — which is exactly how a paper-slip card terminal has always
 * worked in a shop.
 */
export async function reportTerminalResult(
  paymentId: number,
  report: TerminalResultReport
): Promise<PaymentView> {
  const provider = requireProvider();
  if (!provider.capabilities.terminalReporting) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "この決済プロバイダは端末連携に対応していません",
    });
  }

  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "決済が見つかりません" });
  }

  const providerRef = report.providerRef?.trim() ?? "";
  if (report.approved && !providerRef) {
    // Without this the sale is unverifiable forever: nothing links it to
    // a line in the payment company's settlement report.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "承認された決済には伝票番号（承認番号）が必要です",
    });
  }

  // Written before the status moves so that a payment can never reach
  // "completed" without its reference already stored alongside it.
  await db.updatePayment(payment.id, {
    ...(providerRef ? { providerRef } : {}),
    ...(report.providerPaymentId ? { providerPaymentId: report.providerPaymentId } : {}),
  });

  const moved = await db.settlePaymentStatus(
    payment.id,
    report.approved ? "completed" : "failed",
    report.approved ? undefined : { errorMessage: report.errorMessage || "決済端末で承認されませんでした" }
  );
  if (!moved) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `この決済はすでに「${payment.status}」で確定しています`,
    });
  }

  const updated = await db.getPaymentById(paymentId);
  return toView(updated!, presentationFrom(updated!));
}

/** Gives up on a pending payment (customer changed their mind, timeout…). */
export async function cancelPayment(paymentId: number): Promise<PaymentView> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "決済が見つかりません" });
  }
  if (payment.transactionId != null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "会計済みの決済は取り消せません（取引履歴から取消してください）",
    });
  }

  const provider = getPaymentProvider();
  if (provider && provider.id === payment.provider && provider.capabilities.cancel && provider.cancelPayment) {
    try {
      await provider.cancelPayment(payment.providerPaymentId ?? "");
    } catch (error) {
      // Still mark it cancelled locally: the register must be able to
      // move on. An orphaned pending payment at the provider expires by
      // itself, and admin.list surfaces it for reconciliation.
      console.warn("[Payments] provider cancel failed, cancelling locally:", error);
    }
  }

  await db.settlePaymentStatus(payment.id, "canceled");
  const updated = await db.getPaymentById(paymentId);
  return toView(updated!, presentationFrom(updated!));
}

/**
 * Applies a verified webhook event. The caller has already checked the
 * signature — this only decides whether the event may change our record.
 *
 * Returns what happened, so the route can answer 200 for "handled" and
 * for "ignored duplicate" alike: providers retry anything that isn't a
 * 2xx, and re-delivering an event we already processed is normal.
 */
export async function applyWebhookEvent(
  providerId: string,
  event: PaymentWebhookEvent
): Promise<{ handled: boolean; reason?: string }> {
  const payment = await db.getPaymentByProviderId(providerId, event.providerPaymentId);
  if (!payment) {
    return { handled: false, reason: "unknown payment" };
  }

  // The one thing a webhook must never be able to do is mark a payment
  // completed for a different amount than we charged.
  if (event.status === "completed" && event.amount !== undefined && event.amount !== payment.amount) {
    console.error(
      `[Payments] webhook amount mismatch on payment ${payment.id}: expected ${payment.amount}, got ${event.amount}`
    );
    await db.settlePaymentStatus(payment.id, "failed", {
      errorMessage: "Webhookの金額が一致しませんでした",
      rawPayload: { presentation: presentationFrom(payment), raw: event.raw ?? null },
    });
    return { handled: true, reason: "amount mismatch" };
  }

  const moved = await db.settlePaymentStatus(payment.id, event.status, {
    rawPayload: { presentation: presentationFrom(payment), raw: event.raw ?? null },
  });

  // Not moving is the expected outcome for a retried delivery of an event
  // we already applied, so it is a success from the provider's side.
  return { handled: true, reason: moved ? undefined : "already settled" };
}
