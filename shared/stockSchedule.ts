/**
 * Stock that goes on sale on a later day: a restock can carry the date
 * (Japan time) from which it counts — e.g. the 2日目 share of the goods,
 * entered before the festival, joining the stock at 0:00 on day 2 with
 * nobody having to press 補充 that morning. Until then it is a plan, not
 * stock: no register can sell it, the server refuses a checkout that
 * would need it. What day 1 doesn't sell simply carries over.
 *
 * Shared because the server (computeStock, which checkouts are checked
 * against) and the screens (the number the cashier sees) must draw the
 * line at the same moment.
 */

/** "YYYY-MM-DD" of a moment, in Japan time (the festival's clock). */
export function jstDate(at: Date | number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Whether a restock counts as stock on `today` (a jstDate). No date = from the moment it was entered. */
export function isRestockAvailable(restock: { availableOn?: string | null }, today: string): boolean {
  return !restock.availableOn || restock.availableOn <= today;
}

/** "10/4" for a "2026-10-04". */
export function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** The latest date a restock may be scheduled for, counted from today. */
export const MAX_SCHEDULE_DAYS = 60;
