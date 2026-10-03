import * as db from "./db";
import { jstDate } from "@shared/stockSchedule";

/**
 * The handover counter (受け渡し). The register and the place the goods are
 * handed out are apart: the cashier takes the money and tells the customer
 * a number, and whoever is at the counter sees each sale appear — number
 * and goods — and taps 渡した when the customer has them.
 *
 * The counter's phone asks every 2 seconds, so an order shows up there
 * within a couple of seconds of 会計完了. That is far more often than the
 * 8-second poll of everything else, so the answer is kept in memory and
 * the database is only read again when something changed: a sale, a void,
 * a delete, a reset, or a tap here (handoverChanged). Single instance, like
 * the rate limiter; the 30-second limit on the kept answer covers anything
 * that changed the table behind this server's back.
 */

const KEEP_MS = 30_000;
const RECENT = 8;

let version = 0;
let kept: { version: number; at: number; data: HandoverQueue } | null = null;

export type HandoverOrder = {
  id: number;
  orderNo: number | null;
  items: { name: string; emoji: string; qty: number }[];
  createdAt: Date;
  handedAt: Date | null;
  handedBy: string | null;
};

export type HandoverQueue = {
  /** Waiting at the counter, oldest first. */
  pending: HandoverOrder[];
  /** Handed over in the last 15 minutes, newest first (to undo a wrong tap). */
  recent: HandoverOrder[];
};

/** Call after anything that changes which sales are waiting. */
export function handoverChanged(): void {
  version++;
}

function view(row: db.HandoverRow): HandoverOrder {
  const items = Array.isArray(row.items) ? (row.items as any[]) : [];
  return {
    id: row.id,
    orderNo: row.orderNo ?? null,
    items: items.map((it) => ({ name: String(it?.name ?? ""), emoji: String(it?.emoji ?? ""), qty: Number(it?.qty) || 0 })),
    createdAt: row.createdAt,
    handedAt: row.handedAt ?? null,
    handedBy: row.handedBy ?? null,
  };
}

export async function handoverQueue(): Promise<HandoverQueue> {
  const now = Date.now();
  if (kept && kept.version === version && now - kept.at < KEEP_MS) return kept.data;
  const v = version;
  const rows = await db.listHandoverOrders();
  // Today's only (Japan time): an order left waiting when day 1 closed
  // doesn't greet the counter on day 2.
  const today = jstDate();
  const todays = rows.filter((r) => jstDate(r.createdAt) === today);
  const data: HandoverQueue = {
    pending: todays.filter((r) => r.handoverPending).map(view),
    recent: todays
      .filter((r) => !r.handoverPending && r.handedAt)
      .sort((a, b) => new Date(b.handedAt!).getTime() - new Date(a.handedAt!).getTime())
      .slice(0, RECENT)
      .map(view),
  };
  // Kept under the version it was read at: if something changed meanwhile,
  // the next call reads again.
  kept = { version: v, at: now, data };
  return data;
}

/** Tests only. */
export function __resetHandoverCache(): void {
  kept = null;
  version++;
}
