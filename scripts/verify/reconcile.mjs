// A whole business day through the real HTTP API against a real database,
// checked against a ledger this script keeps on its own. Every number the
// system shows — each sale's total and change, stock, the sales total, the
// drawer's expected cash, the closing difference — must match.
//
// Covers: random carts (incl. the same product on two lines), every way of
// paying cash, a retried checkout, out-of-stock refusals, voids (and a
// double void), deletes (live sale refused, voided ones allowed, bulk),
// restocks (admin only, unknown product refused), the float, a collection
// (and an oversized one), a 両替 (and an unbalanced one), a second float
// refused, 締め, the float given back after it (and too much refused), stock
// scheduled for tomorrow (not sellable today), the float / 締め / return
// being for the admin and the 会計係 only, and the audit log (written by
// the server, including each sale).
import mysql from "mysql2/promise";
import { randomUUID } from "crypto";

{
  const target = new URL(process.env.BASE ?? "http://localhost:3200");
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) {
    console.error(`Refusing to run against ${target.origin}: this script inserts test data. Local servers only.`);
    process.exit(1);
  }
}

const BASE = process.env.BASE ?? "http://localhost:3200";
const SALES = Number(process.env.SALES ?? 60);
let failures = 0;
const check = (ok, msg) => { console.log(ok ? "  OK  " : "  FAIL", msg); if (!ok) failures++; };

// ---- HTTP helpers (tRPC over superjson, and the login/gate forms) ----
async function form(path, fields, cookie = "") {
  const res = await fetch(BASE + path, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(fields),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]);
}
const GATE = (await form("/", { code: process.env.ACCESS_CODE ?? "" })).find((c) => c.startsWith("pos_gate="));
if (!GATE) throw new Error("wrong ACCESS_CODE");
async function login(id, pin) {
  const s = (await form("/", { id, pin, pin2: pin }, GATE)).find((c) => c.startsWith("pos_session="));
  if (!s) throw new Error(`login failed for ${id}`);
  return `${GATE}; ${s}`;
}
async function call(kind, path, input, cookie) {
  const url = kind === "query"
    ? `${BASE}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`
    : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, {
    method: kind === "query" ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie },
    body: kind === "query" ? undefined : JSON.stringify({ json: input ?? null }),
  });
  const body = await res.json();
  if (body.error) return { error: body.error.json.message, code: body.error.json.data?.code };
  return { data: body.result.data.json };
}
const q = (path, input, cookie) => call("query", path, input, cookie);
const q_ = q;
const m = (path, input, cookie) => call("mutation", path, input, cookie);

const ADMIN = await login(process.env.ADMIN_ID ?? "3509", process.env.ADMIN_PIN ?? "1234");
const CASHIER = await login(process.env.CASHIER_ID ?? "3512", process.env.CASHIER_PIN ?? "0000");

// Deterministic randomness, so a failure can be rerun exactly.
let seed = Number(process.env.SEED ?? 20260924);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- 0. The cashier is 会計係 for this run (float, 締め, return) ----
const managersBefore = (await q("cash.list", null, ADMIN)).data.managers;
const CASHIER_ID = process.env.CASHIER_ID ?? "3512";
await m("cash.setManagers", { memberIds: managersBefore.filter((x) => x !== CASHIER_ID) }, ADMIN);
check((await m("cash.setFloat", { breakdown: { "1000": 1 } }, CASHIER)).code === "FORBIDDEN", "a cashier who isn't 会計係 can't register the float");
check((await m("cash.count", { breakdown: { "1000": 1 } }, CASHIER)).code === "FORBIDDEN", "…nor close the day");
check((await m("cash.setManagers", { memberIds: [CASHIER_ID] }, CASHIER)).code === "FORBIDDEN", "…nor make themselves 会計係");
await m("cash.setManagers", { memberIds: [...managersBefore.filter((x) => x !== CASHIER_ID), CASHIER_ID] }, ADMIN);

// ---- 0b. Close any day left open by earlier runs, then open ours ----
{
  const { data } = await q("cash.list", null, ADMIN);
  const floats = data.events.filter((e) => e.kind === "float");
  const last = floats.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id - a.id)[0];
  const closed = last && data.events.some((e) => e.kind === "count" && new Date(e.createdAt) >= new Date(last.createdAt));
  if (last && !closed) await m("cash.count", { breakdown: {}, note: "reconcile: close previous day" }, ADMIN);
}
await new Promise((r) => setTimeout(r, 1100)); // timestamps have 1s resolution: keep our day's events strictly after
const FLOAT = { "1000": 10, "500": 10, "100": 30 }; // ¥18,000
const floatRes = await m("cash.setFloat", { breakdown: FLOAT, party: "照合テストの担任" }, CASHIER);
check(floatRes.data?.amount === 18000, `float registered ¥${floatRes.data?.amount}`);
const again = await m("cash.setFloat", { breakdown: FLOAT }, CASHIER);
check(again.code === "CONFLICT", `second float while the day is open refused (${again.error})`);

// ---- 1. Products ----
const tag = Date.now().toString(36);
const spec = [
  { name: `照合A-${tag}`, price: 300, cost: 100, initialStock: 120 },
  { name: `照合B-${tag}`, price: 250, cost: 90, initialStock: 40 },
  { name: `照合C-${tag}`, price: 120, cost: 40, initialStock: 200 },
];
const products = [];
for (const p of spec) {
  const r = await m("product.create", { ...p, emoji: "🧪", threshold: 3, displayOrder: 900 }, ADMIN);
  products.push({ ...p, id: r.data.id });
}
const ids = new Set(products.map((p) => p.id));
const stock = Object.fromEntries(products.map((p) => [p.id, p.initialStock]));
const ledger = []; // { id, total, received, change, voided, deleted, items }

// ---- 2. Sales ----
let refusedOutOfStock = 0;
for (let i = 0; i < SALES; i++) {
  const lines = [];
  const n = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < n; k++) lines.push({ p: pick(products), qty: 1 + Math.floor(rand() * 3) });
  if (i === 3) lines.push({ p: lines[0].p, qty: 1 }); // same product on two lines
  const total = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  const want = {};
  lines.forEach((l) => (want[l.p.id] = (want[l.p.id] ?? 0) + l.qty));
  const enough = Object.entries(want).every(([id, qty]) => stock[id] >= qty);
  const received = pick([total, Math.ceil(total / 1000) * 1000, 5000, 10000].filter((v) => v >= total));
  const key = randomUUID();
  const input = {
    items: lines.map((l) => ({ product_id: l.p.id, name: "x", emoji: "x", price: 1, cost: 1, qty: l.qty })), // price/cost from the client must be ignored
    total: 1, received, changeAmount: 0, clientRequestId: key,
  };
  const who = i % 2 ? CASHIER : ADMIN;
  const r = await m("transaction.create", input, who);
  if (!enough) {
    check(r.code === "CONFLICT", `sale ${i}: out of stock refused`);
    refusedOutOfStock++;
    continue;
  }
  if (r.error) { check(false, `sale ${i}: ${r.error}`); continue; }
  Object.entries(want).forEach(([id, qty]) => (stock[id] -= qty));
  ledger.push({ id: r.data.id, total, received, change: received - total, voided: false, deleted: false, items: want });
  if (i === 5) {
    const retry = await m("transaction.create", input, who);
    check(retry.data?.duplicate === true && retry.data.id === r.data.id, "retried checkout returns the same sale (duplicate)");
  }
}
check(refusedOutOfStock > 0, `some sales hit the stock limit and were refused (${refusedOutOfStock})`);

// ---- 3. Voids and deletes ----
const live = () => ledger.filter((t) => !t.voided && !t.deleted);
const toVoid = live().slice(0, 5);
for (const t of toVoid) {
  const r = await m("transaction.void", { id: t.id }, ADMIN);
  check(!r.error, `void #${t.id}`);
  t.voided = true;
  Object.entries(t.items).forEach(([id, qty]) => (stock[id] += qty));
}
check((await m("transaction.void", { id: toVoid[0].id }, ADMIN)).code === "CONFLICT", "double void refused");
check((await m("transaction.void", { id: live()[0].id }, CASHIER)).code === "FORBIDDEN", "cashier can't void");
const liveDel = await m("transaction.delete", { id: live()[0].id }, ADMIN);
check(liveDel.code === "BAD_REQUEST", `deleting a live sale refused (${liveDel.error})`);
const mixed = await m("transaction.deleteMany", { ids: [toVoid[1].id, live()[0].id] }, ADMIN);
check(mixed.code === "BAD_REQUEST", "bulk delete with a live sale refused");
check(!(await m("transaction.delete", { id: toVoid[0].id }, ADMIN)).error, "deleting a voided sale allowed");
toVoid[0].deleted = true;
const bulk = await m("transaction.deleteMany", { ids: [toVoid[1].id, toVoid[2].id] }, ADMIN);
check(bulk.data?.count === 2, "bulk delete of voided sales");
toVoid[1].deleted = toVoid[2].deleted = true;

// ---- 3b. Handover counter (受け渡し) ----
{
  const q = (await q_("handover.queue", null, CASHIER)).data;
  const waiting = new Set(q.pending.map((o) => o.id));
  const live = ledger.filter((t) => !t.voided && !t.deleted);
  check(live.every((t) => waiting.has(t.id)), `every live sale is waiting at the counter (${live.length})`);
  check(ledger.filter((t) => t.voided).every((t) => !waiting.has(t.id)), "voided sales are not");
  const nos = q.pending.map((o) => o.orderNo);
  check(nos.every((n) => Number.isInteger(n)) && new Set(nos).size === nos.length, "each waiting order has its own number");
  const first = live[0];
  check((await m("handover.complete", { id: first.id }, CASHIER)).data?.already === false, "渡した");
  check((await m("handover.complete", { id: first.id }, ADMIN)).data?.already === true, "a second 渡した is not an error");
  const after = (await q_("handover.queue", null, CASHIER)).data;
  check(!after.pending.some((o) => o.id === first.id) && after.recent[0]?.id === first.id, "handed-over order moves to the recent list");
  check(!(await m("handover.undo", { id: first.id }, CASHIER)).error, "戻す");
  check((await q_("handover.queue", null, CASHIER)).data.pending.some((o) => o.id === first.id), "…and it is waiting again");
}

// ---- 4. Restocks ----
check((await m("restock.create", { productId: products[1].id, amount: 5 }, CASHIER)).code === "FORBIDDEN", "cashier can't restock");
check((await m("restock.create", { productId: 99999999, amount: 5 }, ADMIN)).code === "NOT_FOUND", "restock of an unknown product refused");
check(!(await m("restock.create", { productId: products[1].id, amount: 5 }, ADMIN)).error, "restock +5");
stock[products[1].id] += 5;

// Stock for a later day: entered now, not for sale until 0:00 (Japan time)
// that day. Selling more than today's stock must still be refused.
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(Date.now() + 86_400_000);
const later = await m("restock.create", { productId: products[2].id, amount: 1000, availableOn: tomorrow }, ADMIN);
check(later.data?.availableOn === tomorrow, `restock +1000 scheduled for ${tomorrow}`);
{
  const qty = stock[products[2].id] + 1;
  const r = await m("transaction.create", {
    items: [{ product_id: products[2].id, name: "x", emoji: "x", price: 1, cost: 1, qty }],
    total: 1, received: qty * products[2].price, changeAmount: 0, clientRequestId: randomUUID(),
  }, CASHIER);
  check(!!r.error && r.error.includes("不足"), `a sale needing tomorrow's stock is refused today (${r.error})`);
}

// ---- 5. Collection ----
const expectedBefore = 18000 + live().reduce((s, t) => s + t.total, 0);
check((await m("cash.collect", { amount: expectedBefore * 10 }, CASHIER)).error?.includes("より多い"), "oversized collection refused");
const COLLECT = 5000;
check(!(await m("cash.collect", { amount: COLLECT, note: "reconcile" }, CASHIER)).error, `collected ¥${COLLECT}`);

// 両替: notes out, coins in, same total — the drawer's total must not move.
check((await m("cash.exchange", { out: { "1000": 2 }, in: { "100": 19 } }, CASHIER)).error?.includes("合っていません"), "unbalanced 両替 refused");
check(!(await m("cash.exchange", { out: { "1000": 2 }, in: { "100": 20 }, note: "reconcile" }, CASHIER)).error, "両替 ¥2,000 recorded");

// ---- 6. Compare everything with the ledger ----
const txs = (await q("transaction.list", null, ADMIN)).data.filter((t) => t.items.some((it) => ids.has(it.product_id)));
const byId = new Map(txs.map((t) => [t.id, t]));
const priceOf = Object.fromEntries(products.map((p) => [p.id, p.price]));

let lineOk = true, deletedGone = true, voidOk = true;
for (const t of ledger) {
  const row = byId.get(t.id);
  if (t.deleted) { if (row) deletedGone = false; continue; }
  if (!row) { lineOk = false; continue; }
  const sum = row.items.reduce((s, it) => s + it.price * it.qty, 0);
  const pricesFromMaster = row.items.every((it) => it.price === priceOf[it.product_id]);
  if (row.total !== t.total || sum !== row.total || row.received !== t.received || row.changeAmount !== t.change ||
      row.changeAmount !== row.received - row.total || !pricesFromMaster || row.paymentMethod !== "cash") lineOk = false;
  if (!!row.voided !== t.voided) voidOk = false;
}
check(lineOk, `every sale: total = Σ(price×qty) from the product master, change = received − total (${ledger.length} sales)`);
check(voidOk, "void flags match");
check(deletedGone, "deleted sales are gone");
check(txs.length === ledger.filter((t) => !t.deleted).length, `no extra sales recorded (retry not double-counted): ${txs.length}`);

const salesTotal = txs.filter((t) => !t.voided).reduce((s, t) => s + t.total, 0);
const ledgerTotal = live().reduce((s, t) => s + t.total, 0);
check(salesTotal === ledgerTotal, `sales total (売上/会計報告の計算) ¥${salesTotal} = ledger ¥${ledgerTotal}`);

const [allProducts, restocks] = await Promise.all([q("product.list", null, ADMIN), q("restock.list", null, ADMIN)]);
const shown = {};
for (const p of allProducts.data.filter((p) => ids.has(p.id))) shown[p.id] = p.initialStock;
for (const t of txs) if (!t.voided) for (const it of t.items) if (shown[it.product_id] != null) shown[it.product_id] -= it.qty;
const todayJst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(Date.now());
for (const r of restocks.data) if (shown[r.productId] != null && (!r.availableOn || r.availableOn <= todayJst)) shown[r.productId] += r.amount;
check(products.every((p) => shown[p.id] === stock[p.id] && stock[p.id] >= 0),
  `stock = ledger for every product (${products.map((p) => `${shown[p.id]}/${stock[p.id]}`).join(", ")}), none negative`);

// Drawer: what the 売上 tab shows, recomputed from the API like the screen does.
const cash = (await q("cash.list", null, ADMIN)).data;
const myFloat = cash.events.filter((e) => e.kind === "float").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id - a.id)[0];
const since = new Date(myFloat.createdAt).getTime();
const allTx = (await q("transaction.list", null, ADMIN)).data;
const cashSince = allTx.filter((t) => !t.voided && t.paymentMethod === "cash" && new Date(t.createdAt).getTime() >= since).reduce((s, t) => s + t.total, 0);
const collected = cash.events.filter((e) => e.kind === "collect" && new Date(e.createdAt).getTime() >= since).reduce((s, e) => s + e.amount, 0);
const drawerExpected = myFloat.amount + cashSince - collected;
const ledgerDrawer = 18000 + ledgerTotal - COLLECT;
check(drawerExpected === ledgerDrawer, `drawer expected ¥${drawerExpected} = float + cash sales − collected ¥${ledgerDrawer}`);

// 締め with exactly the ledger's cash: difference 0, frozen by the server.
const breakdown = {};
let left = ledgerDrawer;
for (const d of [10000, 5000, 1000, 500, 100, 50, 10, 5, 1]) { const n = Math.floor(left / d); if (n) breakdown[d] = n; left -= n * d; }
const count = await m("cash.count", { breakdown, note: "reconcile" }, CASHIER);
check(count.data?.expected === ledgerDrawer && count.data?.difference === 0, `締め: counted ¥${count.data?.counted}, expected ¥${count.data?.expected}, difference ${count.data?.difference}`);
check((await m("cash.collect", { amount: 100 }, CASHIER)).code === "CONFLICT", "no collection after 締め");

// Giving the float back after the 締め (the end of the festival): never more
// than was lent; in two parts; then nothing left to return. The drawer
// drops by exactly what went back.
check((await m("cash.returnFloat", { amount: 18001 }, CASHIER)).error?.includes("より多い"), "returning more than the float refused");
check(!(await m("cash.returnFloat", { amount: 8000 }, CASHIER)).error, "returned ¥8,000 of the float");
const back = await m("cash.returnFloat", { amount: 10000, note: "reconcile" }, CASHIER);
check(back.data?.returned === 18000 && back.data?.float === 18000, `float returned in full (${back.data?.returned}/${back.data?.float})`);
check((await m("cash.returnFloat", { amount: 1 }, CASHIER)).error?.includes("返却済み"), "nothing more to return");
{
  const after = (await q("cash.list", null, ADMIN)).data.events;
  const returned = after.filter((e) => e.kind === "return" && new Date(e.createdAt).getTime() >= since).reduce((s, e) => s + e.amount, 0);
  const party = after.find((e) => e.kind === "return" && new Date(e.createdAt).getTime() >= since)?.party;
  check(returned === 18000 && party === "照合テストの担任", `returns recorded ¥${returned} to ${party}`);
  const exchanged = after.filter((e) => e.kind === "exchange" && new Date(e.createdAt).getTime() >= since);
  check(exchanged.length === 1 && exchanged[0].amount === 2000 && exchanged[0].breakdown["1000"] === -2 && exchanged[0].breakdown["100"] === 20,
    "両替 stored as the net change (千円札 −2, 100円玉 +20)");
  const expectedNow = myFloat.amount + cashSince - collected - returned;
  check(expectedNow === ledgerDrawer - 18000, `drawer after the return ¥${expectedNow} = ledger − float ¥${ledgerDrawer - 18000}`);
}

// Audit log: every server-side action left its line.
const logs = (await q("activityLog.list", null, ADMIN)).data;
const recent = logs.filter((l) => new Date(l.createdAt).getTime() >= since - 2000);
const has = (action, text) => recent.some((l) => l.action === action && (!text || l.detail.includes(text)));
check(toVoid.every((t) => has("void_tx", `#${t.id}`)), "every void logged");
check(has("delete_tx", `#${toVoid[0].id}`) && has("delete_tx", "2件"), "deletes logged (single and bulk)");
check(has("cash_float", "用意：照合テストの担任") && has("cash_collect") && has("cash_count", "差額なし"), "float (with who provided it), collection and 締め logged");
{
  // One line per sale (the retry is not a second sale), with the booked total — not the ¥1 the client sent.
  // Only from our day's float on (other scripts' sales just before don't count).
  const lines = recent.filter((l) => l.action === "checkout" && new Date(l.createdAt).getTime() >= since).map((l) => l.detail);
  const expectedLines = ledger.map((t) => `合計¥${t.total.toLocaleString("ja-JP")} (`);
  check(lines.length === ledger.length && expectedLines.every((e) => lines.some((d) => d.startsWith(e))), `every sale logged once by the server (${lines.length}/${ledger.length})`);
}
check(has("restock") && has("cash_managers"), "restocks and the 会計係 change logged");
check((await m("activityLog.create", { action: "reset_all", detail: "fake" }, CASHIER)).code === "NOT_FOUND", "no API to write the log directly");
check(has("cash_exchange", "千円札2枚 → 100円玉20枚") && has("cash_return", "残り ¥10,000") && has("cash_return", "全額返却済み"), "両替 and both returns logged");

// Cashier can't read the admin's data.
check((await q("activityLog.list", null, CASHIER)).code === "FORBIDDEN", "cashier can't read the audit log");
check((await q("accounting.list", null, CASHIER)).code === "FORBIDDEN", "cashier can't read the accounts");

// Back to the 会計係 there were before this run.
await m("cash.setManagers", { memberIds: managersBefore }, ADMIN);

// Clean up the test products (their sales stay, as sales always do).
for (const p of products) await m("product.delete", { id: p.id }, ADMIN);

console.log(failures ? `\n${failures} FAILED` : "\nRESULT: every figure reconciles");
process.exit(failures ? 1 : 0);
