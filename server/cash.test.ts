import { describe, expect, it } from "vitest";
import {
  awkwardCoinFor,
  breakdownTotal,
  changeToGive,
  computeCoins,
  computeDrawer,
  countOutChange,
  describeExchange,
  planChange,
  paymentMixFor,
  shouldCollect,
  type CashEventLike,
  type TransactionLike,
} from "@shared/cash";

const at = (hhmm: string, day = "2026-10-03") => new Date(`${day}T${hhmm}:00+09:00`);
const tx = (total: number, hhmm: string, extra: Partial<TransactionLike> = {}): TransactionLike => ({
  total,
  createdAt: at(hhmm),
  paymentMethod: "cash",
  voided: false,
  ...extra,
});
const ev = (id: number, kind: string, amount: number, hhmm: string, day?: string, extra: Partial<CashEventLike> = {}): CashEventLike => ({
  id,
  kind,
  amount,
  createdAt: at(hhmm, day),
  ...extra,
});
const cash = (total: number, received: number, hhmm: string): TransactionLike =>
  tx(total, hhmm, { received, changeAmount: received - total });

describe("computeDrawer", () => {
  it("is closed (nothing to compare) until a float is registered", () => {
    const d = computeDrawer([], [tx(400, "10:00")]);
    expect(d.open).toBe(false);
    expect(d.expected).toBe(0);
  });

  it("expected = float + cash sales since the float − collections", () => {
    const d = computeDrawer(
      [ev(1, "float", 15000, "09:00"), ev(2, "collect", 5000, "12:00")],
      [tx(400, "10:00"), tx(300, "11:00"), tx(250, "13:00")]
    );
    expect(d.float).toBe(15000);
    expect(d.cashSales).toBe(950);
    expect(d.collected).toBe(5000);
    expect(d.expected).toBe(15000 + 950 - 5000);
    expect(d.takings).toBe(950 - 5000);
  });

  it("ignores voided and cashless sales (no money in the box)", () => {
    const d = computeDrawer(
      [ev(1, "float", 10000, "09:00")],
      [tx(400, "10:00"), tx(400, "10:01", { voided: true }), tx(400, "10:02", { paymentMethod: "card" })]
    );
    expect(d.cashSales).toBe(400);
    expect(d.expected).toBe(10400);
  });

  it("starts a new day at the latest float, and reports sales rung up before it", () => {
    const events = [
      ev(1, "float", 10000, "09:00", "2026-10-03"),
      ev(2, "count", 30000, "17:00", "2026-10-03"),
      ev(3, "float", 12000, "09:30", "2026-10-04"),
    ];
    const txs = [
      { ...tx(20000, "12:00"), createdAt: at("12:00", "2026-10-03") },
      { ...tx(500, "09:10"), createdAt: at("09:10", "2026-10-04") },
      { ...tx(700, "10:00"), createdAt: at("10:00", "2026-10-04") },
    ];
    const d = computeDrawer(events, txs);
    expect(d.float).toBe(12000);
    expect(d.cashSales).toBe(700);
    expect(d.closedBy).toBeNull();
    expect(d.salesBeforeFloat).toBe(500);
  });

  it("a count after the float closes the day", () => {
    const d = computeDrawer([ev(1, "float", 10000, "09:00"), ev(2, "count", 10400, "17:00")], [tx(400, "10:00")]);
    expect(d.closedBy?.id).toBe(2);
  });
});

describe("shouldCollect", () => {
  const events = [ev(1, "float", 10000, "09:00")];
  it("nags once takings reach the threshold, not counting the float", () => {
    expect(shouldCollect(computeDrawer(events, [tx(29000, "10:00")]), 30000)).toBe(false);
    expect(shouldCollect(computeDrawer(events, [tx(30000, "10:00")]), 30000)).toBe(true);
  });
  it("stops after a collection, when closed, and when switched off (0)", () => {
    expect(shouldCollect(computeDrawer([...events, ev(2, "collect", 20000, "11:00")], [tx(30000, "10:00")]), 30000)).toBe(false);
    expect(shouldCollect(computeDrawer([...events, ev(2, "count", 40000, "17:00")], [tx(30000, "10:00")]), 30000)).toBe(false);
    expect(shouldCollect(computeDrawer(events, [tx(30000, "10:00")]), 0)).toBe(false);
  });
});

describe("awkwardCoinFor", () => {
  it("flags the coin a price forces the register to stock", () => {
    expect(awkwardCoinFor(400)).toBeNull();
    expect(awkwardCoinFor(350)).toBe(50);
    expect(awkwardCoinFor(120)).toBe(10);
    expect(awkwardCoinFor(305)).toBe(5);
    expect(awkwardCoinFor(301)).toBe(1);
  });
});

describe("planChange", () => {
  const products = (prices: number[]) => prices.map((price, i) => ({ name: `p${i}`, price, weight: 1 }));

  it("never asks for coins the prices can't require", () => {
    const plan = planChange({ products: products([300, 400, 500]), expectedSales: 30000 })!;
    expect(plan.breakdown["50"]).toBeUndefined();
    expect(plan.breakdown["10"]).toBeUndefined();
    expect(plan.breakdown["100"]).toBeGreaterThan(0);
    expect(plan.breakdown["1000"]).toBeGreaterThan(0);
    expect(plan.total).toBe(breakdownTotal(plan.breakdown));
  });

  it("asks for 10円玉 when a price ends in 10円", () => {
    const plan = planChange({ products: products([120, 400]), expectedSales: 30000 })!;
    expect(plan.breakdown["10"]).toBeGreaterThan(0);
  });

  it("is deterministic and grows with expected sales", () => {
    const a = planChange({ products: products([300, 400]), expectedSales: 30000 })!;
    const b = planChange({ products: products([300, 400]), expectedSales: 30000 })!;
    const c = planChange({ products: products([300, 400]), expectedSales: 100000 })!;
    expect(a).toEqual(b);
    expect(c.total).toBeGreaterThan(a.total);
  });

  it("returns null with nothing to plan for", () => {
    expect(planChange({ products: [], expectedSales: 30000 })).toBeNull();
    expect(planChange({ products: products([300]), expectedSales: 0 })).toBeNull();
  });

  it("sizes a ¥100 shop by who comes: students need coins only, and far fewer", () => {
    const shop = products([100, 100, 100]);
    const students = planChange({ products: shop, expectedSales: 19000, audience: "students" })!;
    const pub = planChange({ products: shop, expectedSales: 19000, audience: "public" })!;
    // Students don't break 5千円/1万円札, so no notes are ever handed back.
    expect(students.breakdown["1000"]).toBeUndefined();
    expect(students.breakdown["5000"]).toBeUndefined();
    expect(students.breakdown["100"]).toBeGreaterThan(0);
    expect(pub.total).toBeGreaterThan(students.total);
    // The old fixed mix (千円札 45% at any price) asked for ¥86,500 here.
    expect(students.total).toBeLessThan(30000);
  });

  it("pays exactly less often when the exact amount takes more coins", () => {
    const one = paymentMixFor(100, "public");
    const many = paymentMixFor(480, "public");
    expect(many.exact).toBeLessThan(one.exact);
    for (const mix of [one, many]) {
      expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    }
  });

  it("counts what is already in the box: only the rest has to be added", () => {
    const shop = products([100, 200]);
    const fresh = planChange({ products: shop, expectedSales: 36000, audience: "public" })!;
    const topUp = planChange({ products: shop, expectedSales: 36000, audience: "public", onHand: { "100": 120, "500": 12, "1000": 27 } })!;
    expect(topUp.total).toBeLessThan(fresh.total);
    const plenty = planChange({ products: shop, expectedSales: 36000, audience: "public", onHand: { "100": 2000, "500": 400, "1000": 200 } })!;
    expect(plenty.total).toBe(0);
    expect(plenty.breakdown).toEqual({});
  });
});

describe("returning the float", () => {
  it("a 返却 leaves the box and is reported separately; takings (sales not yet sent to 本部) are unchanged", () => {
    const d = computeDrawer(
      [ev(1, "float", 10000, "09:00", undefined, { party: "担任" }), ev(2, "collect", 3000, "15:00"), ev(3, "return", 10000, "17:10")],
      [tx(1000, "10:00"), tx(2000, "11:00")]
    );
    expect(d.floatParty).toBe("担任");
    expect(d.returned).toBe(10000);
    expect(d.expected).toBe(10000 + 3000 - 3000 - 10000);
    expect(d.takings).toBe(0);
  });

  it("a 両替 changes what is in the box, not how much", () => {
    const d = computeDrawer(
      [ev(1, "float", 10000, "09:00"), ev(2, "exchange", 5000, "12:00", undefined, { breakdown: { "1000": -5, "100": 50 } })],
      [tx(400, "10:00")]
    );
    expect(d.expected).toBe(10400);
  });
});

describe("computeCoins (what is in the box, note by note)", () => {
  const float = ev(1, "float", 4000, "09:00", undefined, { breakdown: { "500": 4, "100": 20 } });

  it("follows each sale: the customer's money in, the change out of what is there", () => {
    // ¥300 paid with a 千円札: change ¥700 = 500円玉1 + 100円玉2.
    const c = computeCoins([float], [cash(300, 1000, "10:00")]);
    expect(c.known).toBe(true);
    expect(c.box[1000]).toBe(1);
    expect(c.box[500]).toBe(3);
    expect(c.box[100]).toBe(18);
    // Exact coins go in, nothing comes out.
    const c2 = computeCoins([float], [cash(300, 1000, "10:00"), cash(200, 200, "10:05")]);
    expect(c2.box[100]).toBe(20);
  });

  it("falls back to smaller coins once a larger one runs out", () => {
    const onlyHundreds = ev(1, "float", 1000, "09:00", undefined, { breakdown: { "100": 10 } });
    const c = computeCoins([onlyHundreds], [cash(500, 1000, "10:00")]);
    expect(c.box[100]).toBe(5); // ¥500 change as five 100円玉
  });

  it("ignores voided and cashless sales and anything before the float", () => {
    const c = computeCoins(
      [float],
      [cash(300, 1000, "08:00"), { ...cash(300, 1000, "10:00"), voided: true }, { ...cash(300, 300, "10:01"), paymentMethod: "card" }]
    );
    expect(c.box).toMatchObject({ 1000: 0, 500: 4, 100: 20 });
  });

  it("回収 and 返却 take the largest notes first; 両替 is applied exactly; a 締め replaces the estimate", () => {
    const events = [
      float,
      ev(2, "collect", 1000, "12:00"),
      ev(3, "exchange", 500, "12:30", undefined, { breakdown: { "500": -1, "100": 5 } }),
    ];
    const c = computeCoins(events, [cash(300, 1000, "10:00")]);
    expect(c.box).toMatchObject({ 1000: 0, 500: 2, 100: 23 });
    const counted = computeCoins([...events, ev(4, "count", 3300, "17:00", undefined, { breakdown: { "500": 2, "100": 23 } })], [cash(300, 1000, "10:00")]);
    expect(counted.box).toMatchObject({ 500: 2, 100: 23 });
    expect(counted.low).toEqual([]); // closed: no warnings
  });

  it("applies a 締め and the 返却 recorded in the same second in the order they were made", () => {
    const counted = { "1000": 1, "500": 4, "100": 20 };
    // Listed newest first, as the server returns them.
    const events = [ev(3, "return", 1000, "17:00"), ev(2, "count", 5000, "17:00", undefined, { breakdown: counted }), float];
    const c = computeCoins(events, []);
    expect(c.box).toMatchObject({ 1000: 0, 500: 4, 100: 20 });
  });

  it("warns when a coin prepared for change is down to a fifth of the float", () => {
    // Four customers pay ¥100 with a 千円札: ¥900 change each = 500円玉1 + 100円玉4.
    const sales = Array.from({ length: 4 }, (_, i) => cash(100, 1000, `10:0${i}`));
    const c = computeCoins([float], sales);
    expect(c.box[500]).toBe(0);
    expect(c.box[100]).toBe(4);
    expect(c.low.map((l) => l.denomination)).toEqual([500, 100]);
    expect(c.low[1]).toEqual({ denomination: 100, count: 4, prepared: 20 });
  });

  it("is unknown before a float (and so warns about nothing)", () => {
    expect(computeCoins([], [cash(300, 1000, "10:00")])).toMatchObject({ known: false, low: [] });
  });
});

describe("change to hand back", () => {
  it("counts it out of the box, including the money just received", () => {
    const box = computeCoins([ev(1, "float", 1000, "09:00", undefined, { breakdown: { "100": 10 } })], []);
    expect(changeToGive(box, 1000, 100)).toEqual({ given: { "100": 9 }, short: 0 });
    // Paid with a 500円玉 for ¥100: ¥400 back.
    expect(changeToGive(box, 500, 100)).toEqual({ given: { "100": 4 }, short: 0 });
  });

  it("says how much cannot be made from the box", () => {
    const empty = computeCoins([ev(1, "float", 1000, "09:00", undefined, { breakdown: { "1000": 1 } })], []);
    expect(changeToGive(empty, 1000, 300)).toEqual({ given: {}, short: 700 });
  });

  it("without an estimate, is just the fewest pieces", () => {
    expect(changeToGive(null, 1000, 100)).toEqual({ given: { "500": 1, "100": 4 }, short: 0 });
    expect(changeToGive(null, 300, 300)).toEqual({ given: {}, short: 0 });
  });

  it("countOutChange never hands out more than there is", () => {
    const r = countOutChange({ 10000: 0, 5000: 0, 1000: 0, 500: 1, 100: 2, 50: 0, 10: 0, 5: 0, 1: 0 }, 900);
    expect(r).toEqual({ given: { "500": 1, "100": 2 }, short: 200 });
  });

  it("describes a 両替 the way people say it", () => {
    expect(describeExchange({ "1000": -5, "100": 50 })).toBe("千円札5枚 → 100円玉50枚");
  });
});
