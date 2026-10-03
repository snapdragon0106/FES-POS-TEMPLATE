// Practice (練習) through the real HTTP API against a real database: add the
// practice products, rehearse (practice-only sales, a void, a mixed cart
// with a real product, real sales in between, a restock, cash records),
// then clean up — including while practice checkouts are still arriving.
// Afterwards nothing of the rehearsal may remain in the takings, the real
// product's stock, the handover queue or today's order numbers, and the
// real sales must be untouched.
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
const db = await mysql.createConnection({ host: "127.0.0.1", port: Number(process.env.DB_PORT ?? 4000),
  user: process.env.DB_USER ?? "root", password: process.env.DB_PASS ?? "", database: process.env.DB_NAME ?? "fespos" });
let failures = 0;
const check = (ok, msg) => { console.log(ok ? "  OK  " : "  FAIL", msg); if (!ok) failures++; };

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
const m = (path, input, cookie) => call("mutation", path, input, cookie);

const ADMIN = await login(process.env.ADMIN_ID ?? "3509", process.env.ADMIN_PIN ?? "1234");
const CASHIER = await login(process.env.CASHIER_ID ?? "3512", process.env.CASHIER_PIN ?? "0000");

// Leftovers from an earlier run.
if ((await q("practice.status", null, ADMIN)).data.products.length) await m("practice.cleanup", { cashEventIds: [] }, ADMIN);

// A real product.
const real = { name: `本番テスト-${Date.now().toString(36)}`, emoji: "🥤", price: 100, cost: 46, initialStock: 50, threshold: 5, displayOrder: 900 };
real.id = (await m("product.create", real, ADMIN)).data.id;

const sell = (lines, cookie = CASHIER) => {
  const total = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  return m("transaction.create", {
    items: lines.map((l) => ({ product_id: l.p.id, name: l.p.name, emoji: l.p.emoji, price: l.p.price, cost: l.p.cost, qty: l.qty })),
    total, received: Math.ceil(total / 1000) * 1000 || 1000, changeAmount: (Math.ceil(total / 1000) * 1000 || 1000) - total,
    clientRequestId: randomUUID(),
  }, cookie);
};

check((await m("practice.seed", null, CASHIER)).code === "FORBIDDEN", "a cashier can't add practice products");
const seeded = await m("practice.seed", null, ADMIN);
check(seeded.data?.created === 3, `seed added ${seeded.data?.created} practice products`);
check((await m("practice.seed", null, ADMIN)).data?.created === 0, "pressing it again adds none");
const all = (await q("product.list", null, CASHIER)).data;
const practice = all.filter((p) => p.practice);
check(practice.length === 3 && practice.every((p) => p.name.startsWith("【練習】")), "3 practice products, flagged, on the product list");
const [drink, snack, few] = practice;

// Rehearsal, with real sales before, between and after.
const a = await sell([{ p: real, qty: 2 }]);
const p1 = await sell([{ p: drink, qty: 1 }]);
const p2 = await sell([{ p: snack, qty: 2 }, { p: drink, qty: 1 }]);
const p3 = await sell([{ p: few, qty: 3 }]);
const out = await sell([{ p: few, qty: 1 }]);
check(!!out.error, `practice 残りわずか sells out (${out.error})`);
await m("transaction.void", { id: p1.data.id }, ADMIN);
const mixed = await sell([{ p: real, qty: 1 }, { p: drink, qty: 1 }]);
const b = await sell([{ p: real, qty: 3 }]);
const p4 = await sell([{ p: snack, qty: 1 }]);
await m("restock.create", { productId: drink.id, amount: 10 }, ADMIN);
check([a, p1, p2, p3, mixed, b, p4].every((r) => r.data?.id), "all rehearsal sales recorded");
const bNo = b.data.orderNo;
check(p4.data.orderNo === bNo + 1, `order numbers run on through practice (${a.data.orderNo}, …, real ${bNo}, practice ${p4.data.orderNo})`);
const queue = (await q("handover.queue", null, CASHIER)).data;
check(queue.pending.some((o) => o.id === p2.data.id), "practice orders show at the handover counter");

// Cash: one record from before practice began (never practice), one during.
const [old] = await db.execute("INSERT INTO cash_events (kind, amount, operator, createdAt) VALUES ('collect', 1, '3509', NOW() - INTERVAL 2 DAY)");
const [during] = await db.execute("INSERT INTO cash_events (kind, amount, operator) VALUES ('collect', 2, '3509')");
const status = (await q("practice.status", null, ADMIN)).data;
check(status.sales.length === 5, `status counts the 5 sales containing practice products (${status.sales.length})`);
check(status.cashEvents.some((e) => e.id === during.insertId) && !status.cashEvents.some((e) => e.id === old.insertId),
  "status offers cash records since practice began, not older ones");
check((await m("practice.cleanup", { cashEventIds: [] }, CASHIER)).code === "FORBIDDEN", "a cashier can't clean up");

// Clean up while 8 practice checkouts race it.
const racing = Array.from({ length: 8 }, (_, i) => sell([{ p: i % 2 ? drink : snack, qty: 1 }]));
const done = await m("practice.cleanup", { cashEventIds: [old.insertId, during.insertId] }, ADMIN);
const raced = await Promise.all(racing);
console.log(`  cleanup: ${JSON.stringify(done.data)}; racing checkouts: ${raced.filter((r) => r.data).length} recorded before, ${raced.filter((r) => r.error).length} refused (${[...new Set(raced.filter((r) => r.error).map((r) => r.error))].join(" / ")})`);
check(done.data?.products === 3, "cleanup removed the 3 practice products");

const ids = new Set(practice.map((p) => p.id));
const [txs] = await db.execute("SELECT id, items, orderNo, voided FROM transactions");
check(!txs.some((t) => (typeof t.items === "string" ? JSON.parse(t.items) : t.items).some((it) => ids.has(it.product_id))),
  "no sale containing a practice product remains (incl. the racing ones and the mixed cart)");
check(txs.some((t) => t.id === a.data.id) && txs.some((t) => t.id === b.data.id), "the real sales are untouched");
const [[{ n: rs }]] = await db.execute(`SELECT COUNT(*) n FROM restocks WHERE productId IN (${[...ids].join(",")})`);
check(rs === 0, "practice restocks removed");
const [cash] = await db.execute("SELECT id FROM cash_events WHERE id IN (?, ?)", [old.insertId, during.insertId]);
check(cash.length === 1 && cash[0].id === old.insertId, "the chosen cash record from practice is gone; the older one was kept although it was sent too");
const left = (await q("product.list", null, CASHIER)).data.find((p) => p.id === real.id);
const stockReal = real.initialStock - 2 - 3;
const realSold = txs.filter((t) => !t.voided).flatMap((t) => (typeof t.items === "string" ? JSON.parse(t.items) : t.items)).filter((it) => it.product_id === real.id).reduce((s, it) => s + it.qty, 0);
check(left && left.initialStock - realSold === stockReal, `real product stock back to ${stockReal} (the mixed cart's 1 returned)`);
const queueAfter = (await q("handover.queue", null, CASHIER)).data;
check(![...queueAfter.pending, ...queueAfter.recent].some((o) => [p2, p3, p4, mixed].some((r) => r.data.id === o.id)), "practice orders gone from the handover counter");
const next = await sell([{ p: real, qty: 1 }]);
check(next.data?.orderNo === bNo + 1, `the next real customer is ${next.data?.orderNo}番 (after the last real ${bNo}番, practice numbers freed)`);
const [logs] = await db.execute("SELECT action, detail FROM activity_logs WHERE action LIKE 'practice_%' ORDER BY id DESC LIMIT 1");
check(logs[0]?.action === "practice_cleanup", `logged: ${logs[0]?.detail}`);
check((await m("practice.cleanup", { cashEventIds: [] }, ADMIN)).code === "NOT_FOUND", "cleanup with nothing to clean is refused");

// The pre-practice record was inserted just for this check.
await db.execute("DELETE FROM cash_events WHERE id = ?", [old.insertId]);
console.log(failures ? `RESULT: ${failures} FAILED` : "RESULT: practice cleanup is complete and exact");
await db.end();
process.exit(failures ? 1 : 0);
