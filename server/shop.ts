/**
 * The shop's own name (e.g. "経高祭 3年5組"), from POS_SHOP_NAME on Render.
 * Optional: the system is reused by other classes and later years, so the
 * name isn't written in the code. Shown on the login page (only after the
 * 合言葉 — the first page stays anonymous), used as the default 団体名 on
 * the 収支報告, and as the payment description in a cashless provider's app.
 */
export function shopName(): string {
  return (process.env.POS_SHOP_NAME ?? "").trim().slice(0, 40);
}
