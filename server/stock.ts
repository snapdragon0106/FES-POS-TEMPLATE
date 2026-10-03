import type { Payment, Product, Restock, Transaction } from "../drizzle/schema";
import { isRestockAvailable, jstDate } from "@shared/stockSchedule";

/**
 * Stock arithmetic, in one place.
 *
 * Stock is not a stored number — it is derived: initial + restocks −
 * sold. Cashless adds a fourth term, **reserved**, and that term is the
 * reason this file exists.
 *
 * A cash sale is instantaneous: the cashier takes the money and the
 * transaction is written in the same breath. A cashless one is not. The
 * customer taps a card, waits for the reader, or fumbles with a QR app —
 * anywhere from three seconds to a minute. During that window the items
 * are neither sold nor available: someone is in the middle of buying
 * them. Without modelling that, two registers happily sell the same last
 * たこ焼き, and the second customer pays for something that no longer
 * exists — a refund we cannot easily perform at a school festival.
 *
 * So an open payment holds its cart. The reservation disappears on its
 * own when the payment completes (it becomes a real sale), fails, is
 * cancelled, or simply ages out, which means nothing has to run on a
 * timer to clean up after an abandoned checkout.
 */

/**
 * How long an unfinished payment may hold stock.
 *
 * Long enough for a slow customer, short enough that a cashier who walks
 * away mid-payment doesn't strand inventory for the rest of the day. A
 * provider's own expiry is honoured when it is shorter, never when it is
 * longer.
 */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export type StockLine = { product_id: number; qty: number };

/** Reads a payment's stored cart, tolerating rows written before it existed. */
export function paymentLines(payment: Payment): StockLine[] {
  const raw = payment.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((line): line is StockLine =>
      !!line &&
      typeof line === "object" &&
      typeof (line as StockLine).product_id === "number" &&
      typeof (line as StockLine).qty === "number"
    )
    .map((line) => ({ product_id: line.product_id, qty: line.qty }));
}

/**
 * Whether this payment still holds its stock. Consumed payments (those
 * that already became a sale) never do — their items are counted as sold
 * instead, and counting both would subtract the same goods twice.
 */
export function isReservationActive(payment: Payment, now: number): boolean {
  if (payment.transactionId != null) return false;
  if (payment.status !== "pending" && payment.status !== "authorized") return false;

  const createdAt = payment.createdAt ? new Date(payment.createdAt).getTime() : now;
  const cap = createdAt + RESERVATION_TTL_MS;
  const providerExpiry = payment.expiresAt ? new Date(payment.expiresAt).getTime() : Infinity;
  return now < Math.min(cap, providerExpiry);
}

/**
 * Units currently held by in-flight payments, per product.
 *
 * `excludePaymentId` is for the checkout that is consuming a payment: its
 * own reservation must not count against it, or it would be blocked by
 * the very stock it reserved.
 */
export function reservedQuantities(
  openPayments: Payment[],
  now: number,
  excludePaymentId?: number
): Record<number, number> {
  const reserved: Record<number, number> = {};
  for (const payment of openPayments) {
    if (excludePaymentId != null && payment.id === excludePaymentId) continue;
    if (!isReservationActive(payment, now)) continue;
    for (const line of paymentLines(payment)) {
      reserved[line.product_id] = (reserved[line.product_id] ?? 0) + line.qty;
    }
  }
  return reserved;
}

export type StockSnapshot = {
  /** Units a new customer could buy right now. */
  available: Record<number, number>;
  /** Units held by other customers' in-flight payments. */
  reserved: Record<number, number>;
  names: Record<number, string>;
};

/**
 * The single definition of "how much is left", used by the pre-payment
 * check, the authoritative check inside the checkout transaction, and the
 * number the cashier sees. They must agree — a pre-check that is more
 * generous than the real one means taking money for goods the checkout
 * will then refuse.
 */
export function computeStock(input: {
  products: Product[];
  transactions: Transaction[];
  restocks: Restock[];
  openPayments?: Payment[];
  now?: number;
  excludePaymentId?: number;
}): StockSnapshot {
  const now = input.now ?? Date.now();
  const available: Record<number, number> = {};
  const names: Record<number, string> = {};

  for (const product of input.products) {
    available[product.id] = product.initialStock || 0;
    names[product.id] = product.name;
  }
  for (const transaction of input.transactions) {
    if (transaction.voided) continue;
    for (const line of (transaction.items as StockLine[]) || []) {
      if (available[line.product_id] != null) available[line.product_id] -= line.qty;
    }
  }
  // A restock scheduled for a later day is not stock yet (shared/stockSchedule.ts).
  const today = jstDate(now);
  for (const restock of input.restocks) {
    if (!isRestockAvailable(restock, today)) continue;
    if (available[restock.productId] != null) available[restock.productId] += restock.amount;
  }

  const reserved = reservedQuantities(input.openPayments ?? [], now, input.excludePaymentId);
  for (const [productId, qty] of Object.entries(reserved)) {
    const id = Number(productId);
    if (available[id] != null) available[id] -= qty;
  }

  return { available, reserved, names };
}

/** Collapses duplicate lines so two carts can be compared by content. */
function totalsByProduct(items: StockLine[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const item of items) {
    totals.set(item.product_id, (totals.get(item.product_id) ?? 0) + item.qty);
  }
  return totals;
}

/**
 * Whether two carts contain the same goods in the same quantities,
 * regardless of line ordering or how the lines were split.
 *
 * Used to check a cashless sale against the cart its payment was opened
 * for. Matching totals alone is not enough: two different carts can come
 * to the same yen figure, and recording the wrong one would take the
 * right amount of money off the wrong products' stock.
 */
export function sameCart(a: StockLine[], b: StockLine[]): boolean {
  const left = totalsByProduct(a);
  const right = totalsByProduct(b);
  if (left.size !== right.size) return false;
  for (const [productId, qty] of Array.from(left.entries())) {
    if (right.get(productId) !== qty) return false;
  }
  return true;
}

/**
 * Checks a cart against a snapshot, decrementing as it goes so that two
 * lines for the same product are validated against the running balance
 * rather than each against the same starting figure.
 *
 * Returns the name of the first product that doesn't fit, or null when
 * the whole cart does.
 */
export function findInsufficientStock(
  items: StockLine[],
  snapshot: StockSnapshot
): string | null {
  const remaining = { ...snapshot.available };
  for (const item of items) {
    if ((remaining[item.product_id] ?? 0) < item.qty) {
      return snapshot.names[item.product_id] ?? "商品";
    }
    remaining[item.product_id] -= item.qty;
  }
  return null;
}
