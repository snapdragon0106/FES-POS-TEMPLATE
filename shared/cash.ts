/**
 * The cash drawer: 釣り銭 (float), 回収 (money moved to the 本部 safe),
 * 締め (the end-of-day count), 返却 (the float going back to whoever
 * provided it) and 両替 (swapping notes for coins with 本部). One shared drawer for the whole shop — the
 * registers are phones, the money is in one box.
 *
 * Shared between the server (which freezes the expected amount into a
 * count record) and the screens (which show it live), so the figure on
 * the 売上 tab and the one saved at closing can never disagree.
 */

// Largest first — the order change is counted out in.
export const DENOMINATIONS = [10000, 5000, 1000, 500, 100, 50, 10, 5, 1] as const;
export type Denomination = (typeof DENOMINATIONS)[number];
/** Count per denomination, e.g. { "1000": 10, "100": 25 }. */
export type Breakdown = Partial<Record<`${Denomination}`, number>>;

export const DENOMINATION_LABEL: Record<Denomination, string> = {
  10000: "1万円札",
  5000: "5千円札",
  1000: "千円札",
  500: "500円玉",
  100: "100円玉",
  50: "50円玉",
  10: "10円玉",
  5: "5円玉",
  1: "1円玉",
};

export function breakdownTotal(b: Breakdown | null | undefined): number {
  if (!b) return 0;
  return DENOMINATIONS.reduce((sum, d) => sum + d * (b[`${d}`] ?? 0), 0);
}

export type CashEventKind = "float" | "collect" | "count" | "return" | "exchange";

export const CASH_EVENT_LABEL: Record<CashEventKind, string> = {
  float: "釣り銭",
  collect: "本部へ回収",
  count: "締め",
  return: "釣り銭を返却",
  exchange: "両替",
};

export function cashEventLabel(kind: string): string {
  return CASH_EVENT_LABEL[kind as CashEventKind] ?? kind;
}

export type CashEventLike = {
  id: number;
  kind: string;
  amount: number;
  createdAt: Date | string;
  /**
   * Count per denomination: what was put in (float), counted (count), or
   * for a 両替 the net change — negative for what went out, positive for
   * what came in.
   */
  breakdown?: unknown;
  /** Who provided the float (float) / who it was given back to (return). */
  party?: string | null;
};

export type TransactionLike = {
  total: number;
  voided?: boolean | null;
  paymentMethod?: string | null;
  createdAt: Date | string;
  /** Cash handed over by the customer, and the change given back. */
  received?: number | null;
  changeAmount?: number | null;
};

export type DrawerState = {
  /** No 釣り銭 registered yet: nothing to compare against. */
  open: boolean;
  /** When the current float was registered (the start of the business day). */
  since: Date | null;
  float: number;
  /** Who provided today's float, if it was written down. */
  floatParty: string | null;
  cashSales: number;
  collected: number;
  /** Float already given back to whoever provided it. */
  returned: number;
  /** What should physically be in the box right now. */
  expected: number;
  /** Money taken in since the float and not yet sent to 本部 (cash sales − collected). */
  takings: number;
  /** The count that closed this day, if any. */
  closedBy: CashEventLike | null;
  /**
   * Cash sales from the same calendar day that were rung up before the
   * float was registered — they are not in `expected`, and the screen
   * says so rather than letting the count come up short for no reason.
   */
  salesBeforeFloat: number;
};

const time = (d: Date | string) => new Date(d).getTime();

/** Cash sales only: cashless sales raise takings without a yen in the box. */
export function isCashSale(t: TransactionLike): boolean {
  return !t.voided && (t.paymentMethod ?? "cash") === "cash";
}

/**
 * The business day runs from the latest 釣り銭 registration. Everything
 * after it — cash sales, collections — is this day's; a count after it
 * closes the day. Registering the float again the next morning starts a
 * new day, so a two-day festival just repeats 釣り銭 → 締め each day.
 */
export function computeDrawer(events: CashEventLike[], transactions: TransactionLike[]): DrawerState {
  const floats = events.filter((e) => e.kind === "float").sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  const current = floats[0];
  if (!current) {
    return {
      open: false, since: null, float: 0, floatParty: null, cashSales: 0, collected: 0, returned: 0,
      expected: 0, takings: 0, closedBy: null, salesBeforeFloat: 0,
    };
  }
  const start = time(current.createdAt);
  const cashSales = transactions
    .filter((t) => isCashSale(t) && time(t.createdAt) >= start)
    .reduce((s, t) => s + t.total, 0);
  const sumOf = (kind: CashEventKind) =>
    events.filter((e) => e.kind === kind && time(e.createdAt) >= start).reduce((s, e) => s + e.amount, 0);
  const collected = sumOf("collect");
  // A 両替 swaps notes for coins of the same total: it changes what is in
  // the box, not how much (computeCoins follows it).
  const returned = sumOf("return");
  const closedBy =
    events
      .filter((e) => e.kind === "count" && time(e.createdAt) >= start)
      .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id)[0] ?? null;

  const dayStart = new Date(start);
  dayStart.setHours(0, 0, 0, 0);
  const salesBeforeFloat = transactions
    .filter((t) => isCashSale(t) && time(t.createdAt) >= dayStart.getTime() && time(t.createdAt) < start)
    .reduce((s, t) => s + t.total, 0);

  const expected = current.amount + cashSales - collected - returned;
  return {
    open: true,
    since: new Date(current.createdAt),
    float: current.amount,
    floatParty: current.party ?? null,
    cashSales,
    collected,
    returned,
    expected,
    takings: cashSales - collected,
    closedBy,
    salesBeforeFloat,
  };
}

/** Default for 「本部へ回収」: remind once the box holds this much beyond the float. */
export const DEFAULT_COLLECT_THRESHOLD = 30000;

/**
 * Whether the register should nag about moving money to the 本部 safe.
 * Measured on takings (what came in), not the whole box: the float has
 * to stay, so it can't be "collected".
 */
export function shouldCollect(drawer: DrawerState, threshold: number): boolean {
  return drawer.open && !drawer.closedBy && threshold > 0 && drawer.takings >= threshold;
}

// ===== Pricing ================================================================

/**
 * The coin a price forces the register to stock, beyond 100円玉. Prices in
 * 100円 steps need nothing extra; 50円 steps need 50円玉; anything finer
 * needs 10円玉 (or 5円・1円) — slower to count out and one more thing to run
 * out of. Returns null when the price is fine.
 */
export function awkwardCoinFor(price: number): 50 | 10 | 5 | 1 | null {
  if (price % 100 === 0) return null;
  if (price % 50 === 0) return 50;
  if (price % 10 === 0) return 10;
  if (price % 5 === 0) return 5;
  return 1;
}

// ===== Change planning ========================================================

/**
 * Who comes to buy — it decides how people pay. On a 校内公開 day only
 * students come, knowing the shop in advance and mostly carrying coins;
 * on a 一般公開 day parents and outside visitors come, and more of them
 * hand over a 千円札 or break a 5千円/1万円札.
 */
export type Audience = "students" | "public";

export const AUDIENCE_LABEL: Record<Audience, string> = {
  students: "生徒だけ（校内公開）",
  public: "一般公開",
};

type PayKind = "exact" | "coin500" | "bill1000" | "bill5000" | "bill10000";

/**
 * How customers pay a sale they could pay exactly with a single coin (a
 * ¥100 item): the share paying the exact amount, with a 500円玉, or with a
 * note. Sales that take more pieces to pay exactly are paid exactly less
 * often (EXACT_DECAY). At the old fixed mix — 千円札 45% whatever the price —
 * a shop selling only ¥100 items was told to prepare ¥80,000–150,000 of
 * coins a day: every ¥100 sale was costed as a ¥900 hand-back.
 */
export const PAYMENT_MIX: Record<Audience, Record<PayKind, number>> = {
  students: { exact: 0.55, coin500: 0.25, bill1000: 0.2, bill5000: 0, bill10000: 0 },
  public: { exact: 0.45, coin500: 0.22, bill1000: 0.29, bill5000: 0.03, bill10000: 0.01 },
};

/** Each extra coin/note an exact payment needs makes paying exactly this much less likely. */
const EXACT_DECAY = 0.85;

export type ChangePlanInput = {
  /** Sellable products with how often each sells (weight; equal if unknown). */
  products: { name: string; price: number; weight: number }[];
  /** Expected sales for the day, in yen. */
  expectedSales: number;
  /** Who comes that day (default: 一般公開). */
  audience?: Audience;
  /**
   * What is already in the box at opening — the previous day's counted
   * cash, kept for the next morning. The plan is then what to add to it.
   */
  onHand?: Breakdown;
};

export type ChangePlan = {
  /** Suggested count per denomination to put in the box before opening (on top of `onHand`, if given). */
  breakdown: Breakdown;
  total: number;
  /** Customers per day the plan was sized for. */
  customers: number;
  averageSale: number;
};

const RUNS = 400;
const PERCENTILE = 0.8;

// Handy amounts to ask the bank for / count into the box.
const ROUND_TO: Record<Denomination, number> = {
  10000: 1, 5000: 1, 1000: 5, 500: 5, 100: 10, 50: 10, 10: 10, 5: 5, 1: 5,
};

/** Deterministic PRNG so the same inputs always give the same plan. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function split(amount: number): number[] {
  const out: number[] = [];
  for (const d of DENOMINATIONS) {
    const n = Math.floor(amount / d);
    for (let i = 0; i < n; i++) out.push(d);
    amount -= n * d;
  }
  return out;
}

/**
 * The payment mix for one sale: the audience's mix, with the exact share
 * shrinking for every extra piece the exact amount takes (¥100 → 1 piece,
 * ¥300 → 3, ¥480 → 8) and what it loses going to the other ways to pay.
 */
export function paymentMixFor(total: number, audience: Audience): Record<PayKind, number> {
  const base = PAYMENT_MIX[audience];
  const exact = base.exact * Math.pow(EXACT_DECAY, Math.max(0, split(total).length - 1));
  const rest = 1 - base.exact;
  const scale = rest > 0 ? (1 - exact) / rest : 0;
  return {
    exact,
    coin500: base.coin500 * scale,
    bill1000: base.bill1000 * scale,
    bill5000: base.bill5000 * scale,
    bill10000: base.bill10000 * scale,
  };
}

/**
 * How much change to prepare, by denomination.
 *
 * Replays many simulated festival days: customers buy from the product
 * list (weighted by what actually sells), pay according to the day's
 * audience (paymentMixFor), and get change counted out of whatever the box
 * holds by then (what was on hand at opening and their own payments
 * included), largest first with smaller coins as a fallback. Whatever
 * change could not be made that way had to be added to the box before
 * opening. The plan is the simulated days around the 80th percentile of
 * that (by total value), rounded up to handy amounts: enough for 8 days in
 * 10 without a trip to 両替. (Higher percentiles mostly add 千円札 for the
 * rare customer breaking a 1万円札, and the float has to come out of the
 * class's own money.)
 */
export function planChange(input: ChangePlanInput): ChangePlan | null {
  const products = input.products.filter((p) => p.price > 0);
  if (products.length === 0 || input.expectedSales <= 0) return null;
  const audience = input.audience ?? "public";
  const onHand = toCoinBox(input.onHand);
  const weightSum = products.reduce((s, p) => s + Math.max(p.weight, 0), 0);
  const weights = products.map((p) => (weightSum > 0 ? Math.max(p.weight, 0) / weightSum : 1 / products.length));

  const rand = mulberry32(
    products.reduce((h, p) => (h * 31 + p.price) >>> 0, 7) ^ input.expectedSales
  );
  const pickProduct = () => {
    let r = rand();
    for (let i = 0; i < products.length; i++) {
      r -= weights[i];
      if (r <= 0) return products[i];
    }
    return products[products.length - 1];
  };
  const cartTotal = () => {
    const r = rand();
    const items = r < 0.7 ? 1 : r < 0.95 ? 2 : 3;
    let t = 0;
    for (let i = 0; i < items; i++) t += pickProduct().price;
    return t;
  };

  // Average sale, to turn expected sales into a number of customers.
  let sample = 0;
  for (let i = 0; i < 2000; i++) sample += cartTotal();
  const averageSale = sample / 2000;
  const customers = Math.max(1, Math.round(input.expectedSales / averageSale));

  const runs: Record<number, number>[] = [];

  for (let run = 0; run < RUNS; run++) {
    const box: CoinBox = { ...onHand };
    const float: Record<number, number> = {};
    for (const d of DENOMINATIONS) float[d] = 0;

    for (let c = 0; c < customers; c++) {
      const total = cartTotal();
      const mix = paymentMixFor(total, audience);
      let r = rand();
      let kind: PayKind = "bill1000";
      for (const k of Object.keys(mix) as PayKind[]) { r -= mix[k]; if (r <= 0) { kind = k; break; } }

      let paid: number[];
      if (kind === "exact") paid = split(total);
      else if (kind === "coin500" && total <= 500) paid = [500];
      else if (kind === "bill5000" && total < 5000) paid = [5000];
      else if (kind === "bill10000" && total < 10000) paid = [10000];
      else paid = new Array(Math.ceil(total / 1000)).fill(1000);
      for (const d of paid) box[d as Denomination] += 1;

      // Count the change out of what the box actually holds, largest
      // first, falling back to smaller coins when a larger one has run
      // out. Whatever still can't be made is what had to be added before
      // opening — booked as if it had been there.
      const { given, short } = countOutChange(box, paid.reduce((s, d) => s + d, 0) - total);
      for (const d of DENOMINATIONS) box[d] -= given[`${d}`] ?? 0;
      for (const d of split(short)) float[d] += 1;
    }
    runs.push(float);
  }

  // Coherent days, not each coin's own worst case: those happen on
  // different days, and adding them up overstated the float by half.
  // Averaging the days around the percentile (rather than taking one)
  // keeps the mix from jumping around between similar inputs.
  const value = (f: Record<number, number>) => DENOMINATIONS.reduce((s, d) => s + d * f[d], 0);
  runs.sort((a, b) => value(a) - value(b));
  const band = runs.slice(Math.floor(runs.length * (PERCENTILE - 0.05)), Math.ceil(runs.length * (PERCENTILE + 0.05)));
  const breakdown: Breakdown = {};
  for (const d of DENOMINATIONS) {
    const avg = band.reduce((s, f) => s + f[d], 0) / band.length;
    if (avg > 0.2) breakdown[`${d}`] = Math.ceil(avg / ROUND_TO[d]) * ROUND_TO[d];
  }
  return { breakdown, total: breakdownTotal(breakdown), customers, averageSale: Math.round(averageSale) };
}

// ===== What is in the box, coin by coin ======================================

export type CoinBox = Record<Denomination, number>;

const emptyBox = (): CoinBox => Object.fromEntries(DENOMINATIONS.map((d) => [d, 0])) as CoinBox;

/** A stored breakdown (JSON from the database) as counts; anything malformed counts as nothing. */
export function toCoinBox(b: unknown): CoinBox {
  const box = emptyBox();
  if (b && typeof b === "object") {
    for (const d of DENOMINATIONS) {
      const n = Number((b as Record<string, unknown>)[`${d}`]);
      if (Number.isInteger(n)) box[d] = n;
    }
  }
  return box;
}

/** The notes and coins an amount most likely came as (fewest pieces). */
export function paymentPieces(amount: number): Breakdown {
  const out: Breakdown = {};
  for (const d of split(Math.max(0, Math.floor(amount))) as Denomination[]) out[`${d}`] = (out[`${d}`] ?? 0) + 1;
  return out;
}

/**
 * Count `amount` out of what the box holds: largest first, falling back to
 * smaller coins when a larger one has run out — how change is actually
 * handed over. `short` is what could not be made from the box at all.
 * Does not change `box`.
 */
export function countOutChange(box: CoinBox, amount: number): { given: Breakdown; short: number } {
  const given: Breakdown = {};
  let left = Math.max(0, Math.floor(amount));
  for (const d of DENOMINATIONS) {
    const n = Math.min(Math.floor(left / d), Math.max(0, box[d]));
    if (n > 0) given[`${d}`] = n;
    left -= n * d;
  }
  return { given, short: left };
}

const addTo = (box: CoinBox, b: Breakdown | CoinBox, sign: 1 | -1) => {
  for (const d of DENOMINATIONS) {
    const n = (b as Record<string, number | undefined>)[`${d}`] ?? 0;
    box[d] = Math.max(0, box[d] + sign * n);
  }
};

export type LowCoin = { denomination: Denomination; count: number; prepared: number };

export type CoinEstimate = {
  /** False before any float, or when the float was saved without its breakdown. */
  known: boolean;
  /** Estimated count of each note/coin in the box right now. */
  box: CoinBox;
  /** The day's float, by denomination: what "running low" is measured against. */
  prepared: CoinBox;
  /** Coins/notes used for change that are down to a fifth of what was prepared (open day only). */
  low: LowCoin[];
};

/**
 * An estimate of what is in the box, note by note: the day's float, then
 * in time order every cash sale (the customer's money in, as the fewest
 * pieces that make the amount received; the change out, counted as
 * countOutChange would), 回収 and 返却 (largest notes first — bills go to
 * 本部, coins stay for change), 両替 (exactly as recorded), and a 締め
 * (the counted breakdown replaces the estimate).
 *
 * An estimate, not a count: a customer paying ¥1,000 as two 500円玉 is
 * booked as a 千円札. It is for noticing a coin running out in time, and
 * for suggesting how to hand over change; the 締め is still the truth.
 */
export function computeCoins(events: CashEventLike[], transactions: TransactionLike[]): CoinEstimate {
  const floats = events.filter((e) => e.kind === "float").sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  const current = floats[0];
  const hasBreakdown = !!current && !!current.breakdown && typeof current.breakdown === "object";
  if (!current || !hasBreakdown) return { known: false, box: emptyBox(), prepared: emptyBox(), low: [] };

  const start = time(current.createdAt);
  const prepared = toCoinBox(current.breakdown);
  const box = { ...prepared };

  type Step = { at: number; order: number; seq: number; run: () => void };
  const steps: Step[] = [];
  for (const t of transactions) {
    if (!isCashSale(t) || time(t.createdAt) < start) continue;
    steps.push({
      at: time(t.createdAt),
      order: 0,
      seq: 0,
      run: () => {
        const received = t.received ?? t.total;
        addTo(box, paymentPieces(received), 1);
        const change = t.changeAmount ?? received - t.total;
        if (change > 0) addTo(box, countOutChange(box, change).given, -1);
      },
    });
  }
  let closed = false;
  for (const e of events) {
    if (e.id === current.id || time(e.createdAt) < start) continue;
    steps.push({
      at: time(e.createdAt),
      order: 1,
      seq: e.id,
      run: () => {
        if (e.kind === "collect" || e.kind === "return") addTo(box, countOutChange(box, e.amount).given, -1);
        else if (e.kind === "exchange") addTo(box, toCoinBox(e.breakdown), 1);
        else if (e.kind === "count") {
          Object.assign(box, emptyBox());
          addTo(box, toCoinBox(e.breakdown), 1);
          closed = true;
        }
      },
    });
  }
  // Same-second entries in the order they were recorded (a 締め and the 返却 right after it).
  steps.sort((a, b) => a.at - b.at || a.order - b.order || a.seq - b.seq).forEach((s) => s.run());

  const low: LowCoin[] = closed
    ? []
    : DENOMINATIONS.filter((d) => d < 10000 && prepared[d] > 0)
        .filter((d) => box[d] <= Math.max(2, Math.floor(prepared[d] * 0.2)))
        .map((d) => ({ denomination: d, count: box[d], prepared: prepared[d] }));
  return { known: true, box, prepared, low };
}

/**
 * How to hand back the change for a cash sale: counted out of the box as
 * it will be once the customer's money is in it. Without an estimate
 * (no float yet) it is simply the fewest pieces.
 */
export function changeToGive(estimate: CoinEstimate | null | undefined, received: number, total: number): { given: Breakdown; short: number } {
  const change = received - total;
  if (change <= 0) return { given: {}, short: 0 };
  if (!estimate?.known) return { given: paymentPieces(change), short: 0 };
  const box = { ...estimate.box };
  addTo(box, paymentPieces(received), 1);
  return countOutChange(box, change);
}

/** "千円札5枚" style list of a breakdown's non-zero entries (counts taken as positive). */
export function describeBreakdown(b: Breakdown | CoinBox, sign: 1 | -1 = 1): string {
  return DENOMINATIONS.map((d) => ({ d, n: sign * ((b as Record<string, number | undefined>)[`${d}`] ?? 0) }))
    .filter((x) => x.n > 0)
    .map((x) => `${DENOMINATION_LABEL[x.d]}${x.n}枚`)
    .join("・");
}

/** A 両替 record's net breakdown as "千円札5枚 → 100円玉50枚". */
export function describeExchange(net: unknown): string {
  const box = toCoinBox(net);
  return `${describeBreakdown(box, -1) || "?"} → ${describeBreakdown(box, 1) || "?"}`;
}
