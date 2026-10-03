// A checkout whose response is lost gets retried with the same key. It
// must never become two sales — sequential retries or racing duplicates.
import mysql from "mysql2/promise";
import { randomUUID } from "crypto";

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


const BASE = process.env.BASE;
const db = await mysql.createConnection({ host: "127.0.0.1", port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASS ?? "", database: process.env.DB_NAME ?? "fespos" });

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

const login = await fetch(`${BASE}/`, { method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: GATE },
  body: new URLSearchParams({ id: "3512", pin: "0000", pin2: "0000" }) });
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("pos_session="));

const [ins] = await db.execute("INSERT INTO products (name, emoji, price, cost, initialStock, threshold, displayOrder) VALUES (?,?,?,?,?,?,?)",
  [`重複テスト${Date.now()}`, "🧪", 300, 10, 1, 1, 999]);
const productId = ins.insertId;
const body = (key) => JSON.stringify({ json: {
  items: [{ product_id: productId, name: "x", emoji: "x", price: 300, cost: 10, qty: 1 }],
  total: 300, received: 500, changeAmount: 200, clientRequestId: key } });
const send = (key) => fetch(`${BASE}/api/trpc/transaction.create`, { method: "POST",
  headers: { "content-type": "application/json", cookie }, body: body(key) }).then((r) => r.json());

const rowsFor = async (key) => (await db.execute("SELECT id FROM transactions WHERE clientRequestId = ?", [key]))[0].length;

// 1) Lost response, then a retry. Stock is 1: the retry must NOT be told
//    "在庫不足" — the sale it is asking about succeeded.
const k1 = randomUUID();
const a = await send(k1), b = await send(k1);
console.log(`sequential retry: first=${JSON.stringify(a.result?.data?.json)} retry=${JSON.stringify(b.result?.data?.json ?? b.error?.json?.message)} rows=${await rowsFor(k1)}`);

// 2) Six copies of the same request racing (client timeout + retries).
await db.execute("UPDATE products SET initialStock = initialStock + 1 WHERE id = ?", [productId]);
const k2 = randomUUID();
const racing = await Promise.all(Array.from({ length: 6 }, () => send(k2)));
const ids = new Set(racing.map((r) => r.result?.data?.json?.id).filter(Boolean));
const errs = racing.filter((r) => r.error).map((r) => r.error.json.message);
console.log(`6 racing copies: distinct ids=${ids.size} rows=${await rowsFor(k2)} duplicatesFlagged=${racing.filter((r) => r.result?.data?.json?.duplicate).length} errors=${JSON.stringify(errs)}`);

// 3) A different key is a different sale (and here, out of stock).
const c = await send(randomUUID());
console.log(`new key, no stock left: ${c.error?.json?.message ?? "UNEXPECTED SUCCESS"}`);

// The retry is told the same order number as the sale it repeats.
const sameNo = a.result?.data?.json?.orderNo != null && a.result.data.json.orderNo === b.result?.data?.json?.orderNo
  && new Set(racing.map((r) => r.result?.data?.json?.orderNo)).size === 1;
console.log(`order number on retry: first=${a.result?.data?.json?.orderNo} retry=${b.result?.data?.json?.orderNo} racing=${JSON.stringify(Array.from(new Set(racing.map((r) => r.result?.data?.json?.orderNo))))}`);

const ok = (await rowsFor(k1)) === 1 && (await rowsFor(k2)) === 1 && ids.size === 1 && errs.length === 0 && sameNo;
console.log(ok ? "RESULT: idempotent" : "RESULT: FAILED");
await db.end();
