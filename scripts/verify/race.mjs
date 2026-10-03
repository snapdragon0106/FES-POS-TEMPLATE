// End-to-end oversell check: several registers (separate PIN sessions)
// all try to sell the same scarce product at the same instant, through the
// real HTTP API of a real server backed by a real database.
import mysql from "mysql2/promise";

// Writes test products and sales into whatever database the server uses.
// Refuse anything but a local server, so this can never be pointed at the
// real festival data by accident.
{
  const target = new URL(process.env.BASE ?? "http://localhost:3200");
  if (!["localhost", "127.0.0.1"].includes(target.hostname)) {
    console.error(`Refusing to run against ${target.origin}: this script inserts test data. Local servers only.`);
    process.exit(1);
  }
}


const BASE = process.env.BASE ?? "http://localhost:3200";
const DB = {
  host: "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER ?? "fespos",
  password: process.env.DB_PASS ?? "fespos_demo_pw",
  database: process.env.DB_NAME ?? "fespos",
};
const STOCK = Number(process.env.STOCK ?? 5);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 24);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
// Login is behind the 合言葉 (server/gate.ts): pass it first, like a browser.
async function passGate() {
  const code = process.env.ACCESS_CODE;
  if (!code) throw new Error("Set ACCESS_CODE to the server's POS_ACCESS_CODE");
  const res = await fetch(`${process.env.BASE ?? "http://localhost:3200"}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code }),
  });
  const gate = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("pos_gate="));
  if (!gate) throw new Error("wrong ACCESS_CODE (the gate set no cookie)");
  return gate;
}
const GATE = await passGate();

const REGISTERS = [["3501", "0000"], ["3509", "1234"], ["3512", "0000"], ["3527", "0000"]];

async function trpc(path, input, cookie) {
  const res = await fetch(`${BASE}/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function login([id, pin]) {
  // Logging in is a form on the server's login page (server/login.ts).
  const res = await fetch(`${BASE}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: GATE },
    body: new URLSearchParams({ id, pin, pin2: pin }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("pos_session="));
  if (!cookie) throw new Error(`login failed for ${id}: ${res.status} ${res.headers.get("location")}`);
  return cookie;
}

const db = await mysql.createConnection(DB);
const sessions = await Promise.all(REGISTERS.map(login));

let totalOversold = 0;
for (let round = 1; round <= ROUNDS; round++) {
  const [ins] = await db.execute(
    "INSERT INTO products (name, emoji, price, cost, initialStock, threshold, displayOrder) VALUES (?,?,?,?,?,?,?)",
    [`競合テスト${Date.now()}`, "🧪", 100, 10, STOCK, 1, 999]
  );
  const productId = ins.insertId;

  const item = { product_id: productId, name: "x", emoji: "x", price: 100, cost: 10, qty: 1 };
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, (_, i) =>
      trpc("transaction.create",
        { items: [item], total: 100, received: 100, changeAmount: 0 },
        sessions[i % sessions.length])
    )
  );

  const ok = results.filter((r) => r.body?.result).length;
  const reasons = {};
  for (const r of results) {
    if (r.body?.error) {
      const m = r.body.error.json?.message ?? "?";
      const key = m.includes("在庫") ? "在庫不足で拒否" : m.slice(0, 60);
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }

  const [rows] = await db.execute("SELECT items FROM transactions WHERE voided = 0");
  let sold = 0;
  for (const { items } of rows) {
    const list = typeof items === "string" ? JSON.parse(items) : items;
    for (const it of list) if (it.product_id === productId) sold += it.qty;
  }
  const remaining = STOCK - sold;
  const oversold = Math.max(0, sold - STOCK);
  totalOversold += oversold;
  console.log(
    `round ${round}: stock=${STOCK} attempts=${ATTEMPTS} succeeded=${ok} soldInDB=${sold} remaining=${remaining}` +
      (oversold ? `  <<< OVERSOLD by ${oversold}` : "  ok") +
      `  rejected=${JSON.stringify(reasons)}`
  );
}
console.log(totalOversold ? `RESULT: OVERSOLD (${totalOversold} units across ${ROUNDS} rounds)` : "RESULT: no overselling");

// Checkouts for different products don't wait on each other's product
// locks — only on the order-number counter. Fire a batch at once, one
// product each, and check every sale got its own number.
{
  const PARALLEL = 16;
  const ids = [];
  for (let i = 0; i < PARALLEL; i++) {
    const [ins] = await db.execute(
      "INSERT INTO products (name, emoji, price, cost, initialStock, threshold, displayOrder) VALUES (?,?,?,?,?,?,?)",
      [`番号テスト${Date.now()}-${i}`, "🧪", 100, 10, 5, 1, 999]
    );
    ids.push(ins.insertId);
  }
  const res = await Promise.all(ids.map((pid, i) =>
    trpc("transaction.create",
      { items: [{ product_id: pid, name: "x", emoji: "x", price: 100, cost: 10, qty: 1 }], total: 100, received: 100, changeAmount: 0 },
      sessions[i % sessions.length])));
  const nos = res.map((r) => r.body?.result?.data?.json?.orderNo);
  const distinct = new Set(nos.filter((n) => n != null)).size;
  console.log(`parallel checkouts on different products: ${PARALLEL} sent, ${nos.filter((n) => n != null).length} sold, ${distinct} distinct order numbers ${JSON.stringify(nos)}`);
  await db.execute(`DELETE FROM products WHERE id IN (${ids.join(",")})`);
}

// Order numbers (受け渡し): handed out under one counter lock, so the
// racing checkouts above must each have got their own — no number twice in a day.
const [dupNos] = await db.execute(
  "SELECT orderNo, COUNT(*) AS n FROM transactions WHERE orderNo IS NOT NULL AND createdAt >= NOW() - INTERVAL 1 DAY GROUP BY DATE(CONVERT_TZ(createdAt, @@session.time_zone, '+09:00')), orderNo HAVING n > 1"
);
console.log(dupNos.length ? `RESULT: ORDER NUMBER USED TWICE ${JSON.stringify(dupNos)}` : "RESULT: order numbers unique");
if (totalOversold || dupNos.length) process.exitCode = 1;
await db.end();
