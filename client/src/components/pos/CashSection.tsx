import { useEffect, useMemo, useState } from "react";
import { Wallet, Landmark, ClipboardCheck, Coins, Trash2, AlertTriangle, Calculator, ArrowLeftRight, HandCoins, CheckCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import { useMembers } from "@/lib/members";
import {
  DENOMINATIONS,
  DENOMINATION_LABEL,
  awkwardCoinFor,
  breakdownTotal,
  cashEventLabel,
  describeExchange,
  planChange,
  shouldCollect,
  AUDIENCE_LABEL,
  PAYMENT_MIX,
  type Audience,
  type Breakdown,
  type CoinEstimate,
  type Denomination,
  type DrawerState,
} from "@shared/cash";
import DenominationInput from "./DenominationInput";
import SheetOverlay from "./SheetOverlay";

/** A coin estimate's non-zero counts as a breakdown. */
const toBreakdown = (box: Record<Denomination, number>): Breakdown =>
  Object.fromEntries(DENOMINATIONS.filter((d) => box[d] > 0).map((d) => [`${d}`, box[d]])) as Breakdown;
const addBreakdowns = (a: Breakdown, b: Breakdown): Breakdown =>
  Object.fromEntries(
    DENOMINATIONS.map((d) => [`${d}`, (a[`${d}`] ?? 0) + (b[`${d}`] ?? 0)]).filter(([, n]) => (n as number) > 0)
  ) as Breakdown;
const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");
const signedYen = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + yen(Math.abs(n));
const hhmm = (d: Date | string) =>
  new Date(d).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });

type Sheet = null | "float" | "collect" | "count" | "return" | "exchange";

// What a 両替 swaps: notes for coins or back (5円・1円 never come up at 100円 prices).
const EXCHANGE_DENOMINATIONS: readonly Denomination[] = [10000, 5000, 1000, 500, 100, 50, 10];

interface Props {
  drawer: DrawerState;
  coins: CoinEstimate;
  events: any[];
  collectThreshold: number;
  products: any[];
  transactions: any[];
  isAdmin: boolean;
  /** Admin or 会計係: may register the float, close the day and give the float back (server-checked too). */
  canManageCash: boolean;
}

/**
 * The 売上 tab's cash section: the drawer (釣り銭・回収・締め) and the
 * change planner. Two cards, one sheet for entering amounts.
 */
export default function CashSection({ drawer, coins, events, collectThreshold, products, transactions, isAdmin, canManageCash }: Props) {
  const { nameOf } = useMembers();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [breakdown, setBreakdown] = useState<Breakdown>({});
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [party, setParty] = useState("");
  const [exOut, setExOut] = useState<Breakdown>({});
  const [exIn, setExIn] = useState<Breakdown>({});

  const utils = trpc.useUtils();
  const setFloat = trpc.cash.setFloat.useMutation();
  const collect = trpc.cash.collect.useMutation();
  const count = trpc.cash.count.useMutation();
  const returnFloat = trpc.cash.returnFloat.useMutation();
  const exchange = trpc.cash.exchange.useMutation();
  const del = trpc.cash.delete.useMutation();
  const setThreshold = trpc.cash.setCollectThreshold.useMutation();
  const busy = setFloat.isPending || collect.isPending || count.isPending || returnFloat.isPending || exchange.isPending;

  // Whoever provided the last float — the same money usually comes back
  // the next morning, so day 2 starts with the same name filled in.
  const lastParty = useMemo(() => events.find((e) => e.kind === "float" && e.party)?.party ?? "", [events]);
  const outstanding = Math.max(0, drawer.float - drawer.returned);

  const open = (s: Sheet, prefill: Breakdown = {}) => {
    setBreakdown(prefill);
    setAmount(s === "return" ? String(Math.max(0, Math.min(outstanding, drawer.expected))) : "");
    setNote("");
    setParty(s === "float" ? lastParty : s === "return" ? drawer.floatParty ?? "" : "");
    setExOut({});
    setExIn({});
    setSheet(s);
  };
  const refresh = () => {
    utils.cash.list.invalidate();
    utils.activityLog.list.invalidate();
  };

  const submit = async () => {
    try {
      if (sheet === "float") {
        const r = await setFloat.mutateAsync({ breakdown: breakdown as Record<string, number>, party: party.trim() || undefined, note: note || undefined });
        toast.success(`釣り銭 ${yen(r.amount)} を登録しました`);
      } else if (sheet === "return") {
        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) { toast.error("返した金額を入力してください"); return; }
        const r = await returnFloat.mutateAsync({ amount: n, party: party.trim() || undefined, note: note || undefined });
        if (r.returned >= r.float) toast.success(`釣り銭 ${yen(r.float)} を全額返却しました`);
        else toast.success(`${yen(n)} の返却を記録しました（残り ${yen(r.float - r.returned)}）`);
      } else if (sheet === "exchange") {
        const r = await exchange.mutateAsync({ out: exOut as Record<string, number>, in: exIn as Record<string, number>, note: note || undefined });
        toast.success(`${yen(r.amount)} の両替を記録しました`);
      } else if (sheet === "collect") {
        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) { toast.error("回収した金額を入力してください"); return; }
        await collect.mutateAsync({ amount: n, note: note || undefined });
        toast.success(`本部へ ${yen(n)} の回収を記録しました`);
      } else if (sheet === "count") {
        const r = await count.mutateAsync({ breakdown: breakdown as Record<string, number>, note: note || undefined });
        if (r.difference === 0) toast.success("締めました。現金はぴったり合っています");
        else toast.warning(`締めました。差額 ${signedYen(r.difference)} を記録しました`);
      }
      setSheet(null);
      refresh();
    } catch (e) {
      toast.error(getErrorMessage(e, "記録できませんでした"));
    }
  };

  const handleDelete = async (e: any) => {
    const label = cashEventLabel(e.kind);
    if (!confirm(`${hhmm(e.createdAt)} の${label}の記録（${yen(e.amount)}）を削除しますか？`)) return;
    try {
      await del.mutateAsync({ id: e.id });
      toast.success("記録を削除しました");
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, "削除できませんでした"));
    }
  };

  const managerOnly = (
    <p className="hos-caption">釣り銭の登録・締め・釣り銭の返却は、管理者か会計係（管理者がPIN管理で指定）が行います。</p>
  );

  const handleThreshold = async () => {
    const input = prompt("回収のお知らせを出す金額（レジに入った売上がこの額を超えたら）\n0にするとお知らせを出しません", String(collectThreshold));
    if (input === null) return;
    const n = Number(input.replace(/[^\d]/g, ""));
    if (!Number.isInteger(n) || n < 0) { toast.error("金額を正しく入力してください"); return; }
    try {
      await setThreshold.mutateAsync({ amount: n });
      toast.success(n ? `${yen(n)} を超えたらお知らせします` : "回収のお知らせをオフにしました");
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, "変更できませんでした"));
    }
  };

  // Entries of the current business day (from the latest float on).
  const todays = useMemo(() => {
    if (!drawer.since) return [];
    const since = drawer.since.getTime();
    return events.filter((e) => new Date(e.createdAt).getTime() >= since);
  }, [events, drawer.since]);

  const closed = drawer.closedBy as any;
  const collectNow = shouldCollect(drawer, collectThreshold);
  const countedPreview = breakdownTotal(breakdown);
  const exOutTotal = breakdownTotal(exOut);
  const exInTotal = breakdownTotal(exIn);
  const fullyReturned = drawer.float > 0 && outstanding === 0;

  return (
    <>
      {/* ===== The drawer ===== */}
      <div className="ws-card p-5 mb-3">
        <div className="flex items-center gap-2 mb-3">
          <Wallet size={16} style={{ color: "var(--ws-sc)" }} />
          <h3 className="hos-subtitle">レジの現金</h3>
        </div>

        {!drawer.open ? (
          <div className="flex flex-col gap-3">
            <p className="hos-body">
              開店前に、レジに入れた釣り銭を登録してください。レジにあるはずの現金をいつでも確認でき、閉店後の締めで現金と照らし合わせられます。
            </p>
            {canManageCash ? (
              <button onClick={() => open("float")} style={primaryBtn}>
                <Coins size={15} />釣り銭を登録
              </button>
            ) : managerOnly}
          </div>
        ) : closed ? (
          <div className="flex flex-col gap-3">
            <div className="hos-caption">{hhmm(closed.createdAt)} に締めました</div>
            <div className="grid grid-cols-3 gap-2">
              <Figure label="数えた現金" value={yen(closed.amount)} />
              <Figure label="あるべき現金" value={yen(closed.expected ?? 0)} />
              <Figure
                label="差額"
                value={signedYen(closed.amount - (closed.expected ?? 0))}
                color={closed.amount === closed.expected ? "var(--ws-sc)" : "var(--ws-dg)"}
              />
            </div>
            {closed.note && <div className="hos-caption">メモ：{closed.note}</div>}
            {closed.amount !== closed.expected && (
              <p className="hos-caption">
                差額は無理に合わせず、このまま報告してください。原因（おつりの渡し間違い、打ち忘れなど）が分かったらメモに残すと次に役立ちます。
              </p>
            )}
            <ReturnStatus drawer={drawer} closedShort={closed.amount < (closed.expected ?? 0)} />
            {!canManageCash ? managerOnly : <div className={fullyReturned ? "" : "grid grid-cols-2 gap-2"}>
              {!fullyReturned && (
                <button onClick={() => open("return")} style={primaryBtn}>
                  <HandCoins size={15} />釣り銭を返す
                </button>
              )}
              <button onClick={() => open("float")} style={{ ...secondaryBtn, width: "100%" }}>
                <Coins size={15} />次の日の釣り銭を登録
              </button>
            </div>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <div className="hos-caption mb-0.5">レジにあるはずの現金</div>
              <div className="font-number font-extrabold" style={{ fontSize: 30, color: "var(--ws-tx)" }}>{yen(drawer.expected)}</div>
            </div>
            <div className="flex flex-col gap-1 text-[13px]">
              <Line label={`釣り銭（${hhmm(drawer.since!)} 登録）`} value={yen(drawer.float)} />
              <Line label="＋ 現金での売上" value={yen(drawer.cashSales)} />
              {drawer.collected > 0 && <Line label="− 本部へ回収" value={yen(drawer.collected)} />}
              {drawer.returned > 0 && <Line label="− 釣り銭を返却" value={yen(drawer.returned)} />}
            </div>
            <CoinPanel coins={coins} />
            {drawer.salesBeforeFloat > 0 && (
              <p className="hos-caption" style={{ color: "var(--ws-warn)" }}>
                釣り銭の登録より前の現金売上 {yen(drawer.salesBeforeFloat)} は含まれていません。
              </p>
            )}
            {collectNow && (
              <div className="flex items-start gap-2 p-3 rounded-xl text-[13px] font-bold" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>
                <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                売上が {yen(drawer.takings)} たまっています。本部の金庫へ移して「本部へ回収」で記録してください。
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => open("collect")} style={secondaryBtn}>
                <Landmark size={15} />本部へ回収
              </button>
              <button onClick={() => open("exchange")} style={secondaryBtn}>
                <ArrowLeftRight size={15} />両替
              </button>
              {canManageCash && (
                <button onClick={() => open("count")} style={primaryBtn}>
                  <ClipboardCheck size={15} />締め（現金を数える）
                </button>
              )}
              {canManageCash && (
                <button onClick={() => open("return")} disabled={outstanding === 0} style={{ ...secondaryBtn, opacity: outstanding === 0 ? 0.5 : 1 }}>
                  <HandCoins size={15} />釣り銭を返す
                </button>
              )}
            </div>
            {!canManageCash && managerOnly}
          </div>
        )}

        {todays.length > 0 && (
          <div className="mt-4 pt-3" style={{ borderTop: "1.5px solid var(--ws-bd)" }}>
            <div className="hos-caption mb-1.5">今日の記録</div>
            <div className="flex flex-col gap-1">
              {todays.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[13px]">
                  <span className="font-number w-11 flex-shrink-0" style={{ color: "var(--ws-ts)" }}>{hhmm(e.createdAt)}</span>
                  <span className="font-bold flex-shrink-0" style={{ color: "var(--ws-tx)" }}>
                    {cashEventLabel(e.kind)}
                  </span>
                  <span className="truncate flex-1 min-w-0" style={{ color: "var(--ws-ts)" }}>
                    {nameOf(e.operator) || e.operator}
                    {e.kind === "float" && e.party ? `・用意：${e.party}` : ""}
                    {e.kind === "return" && e.party ? `・${e.party}へ` : ""}
                    {e.kind === "exchange" ? `・${describeExchange(e.breakdown)}` : ""}
                    {e.note ? `・${e.note}` : ""}
                  </span>
                  <span className="font-number font-bold" style={{ color: "var(--ws-tx)" }}>{yen(e.amount)}</span>
                  {isAdmin && (
                    <button
                      onClick={() => handleDelete(e)}
                      className="ws-icon-chip-sm"
                      style={{ width: 26, height: 26, background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}
                      aria-label="この記録を削除"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {isAdmin && (
          <button onClick={handleThreshold} className="hos-caption mt-3 underline" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            回収のお知らせ：{collectThreshold ? `売上が ${yen(collectThreshold)} を超えたら` : "オフ"}（変更）
          </button>
        )}
      </div>

      <ChangePlanCard
        products={products}
        transactions={transactions}
        canUse={canManageCash && (!drawer.open || !!closed)}
        onHand={closed && coins.known ? toBreakdown(coins.box) : null}
        onUse={(b) => open("float", b)}
      />

      {/* ===== Entry sheet ===== */}
      {sheet && (
        <SheetOverlay>
          <div className="relative ws-sheet-pop ws-glass-sheet w-full md:max-w-md max-h-[92vh] overflow-y-auto rounded-t-[28px] md:rounded-[28px] p-6">
            <div className="w-9 h-1 rounded-full mx-auto mb-5 md:hidden" style={{ background: "var(--ws-bd)" }} />
            <h3 className="hos-subtitle mb-1">
              {sheet === "float"
                ? "釣り銭を登録"
                : sheet === "collect"
                  ? "本部へ回収"
                  : sheet === "return"
                    ? "釣り銭を返す"
                    : sheet === "exchange"
                      ? "両替を記録"
                      : "締め（現金を数える）"}
            </h3>
            <p className="hos-caption mb-4">
              {sheet === "float"
                ? "レジに入れた釣り銭を、種類ごとの枚数で入れてください。"
                : sheet === "collect"
                  ? "レジから本部の金庫へ移した金額を入れてください。釣り銭は残したままにします。"
                  : sheet === "return"
                    ? `釣り銭を用意してくれた人へ返した金額を入れてください。文化祭の最後の締めの後に使います（釣り銭 ${yen(drawer.float)}、返却済み ${yen(drawer.returned)}）。`
                    : sheet === "exchange"
                      ? "本部などで両替したお金を記録します。レジの合計額は変わらず、硬貨の残り枚数の計算に使います。"
                      : "レジの中の現金を全部数えて、種類ごとの枚数を入れてください。"}
            </p>

            {sheet === "collect" || sheet === "return" ? (
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder="金額（例：20000）"
                className="ws-input font-number text-lg mb-3"
                autoFocus
              />
            ) : sheet === "exchange" ? (
              <div className="flex flex-col gap-3 mb-3">
                <div>
                  <div className="hos-caption mb-1.5 font-bold">レジから出したお金</div>
                  <DenominationInput value={exOut} onChange={setExOut} denominations={EXCHANGE_DENOMINATIONS} />
                </div>
                <div>
                  <div className="hos-caption mb-1.5 font-bold">代わりに受け取ったお金</div>
                  <DenominationInput value={exIn} onChange={setExIn} denominations={EXCHANGE_DENOMINATIONS} />
                </div>
                {(exOutTotal > 0 || exInTotal > 0) && exOutTotal !== exInTotal && (
                  <p className="hos-caption font-bold" style={{ color: "var(--ws-dg)" }}>
                    出したお金 {yen(exOutTotal)} と受け取ったお金 {yen(exInTotal)} が合っていません
                  </p>
                )}
              </div>
            ) : (
              <div className="mb-3">
                <DenominationInput value={breakdown} onChange={setBreakdown} />
              </div>
            )}

            {sheet === "count" && countedPreview > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-3">
                <Figure label="数えた現金" value={yen(countedPreview)} />
                <Figure label="あるべき現金" value={yen(drawer.expected)} />
                <Figure
                  label="差額"
                  value={signedYen(countedPreview - drawer.expected)}
                  color={countedPreview === drawer.expected ? "var(--ws-sc)" : "var(--ws-dg)"}
                />
              </div>
            )}

            {(sheet === "float" || sheet === "return") && (
              <input
                value={party}
                onChange={(e) => setParty(e.target.value)}
                maxLength={50}
                placeholder={sheet === "float" ? "釣り銭を用意した人（例：担任の先生）" : "返した相手（例：担任の先生）"}
                className="ws-input text-sm mb-2"
              />
            )}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={255}
              placeholder={sheet === "count" ? "メモ（差額の理由が分かれば）" : "メモ（任意）"}
              className="ws-input text-sm mb-4"
            />

            <div className="flex gap-2">
              <button onClick={() => setSheet(null)} style={{ ...secondaryBtn, flex: 1 }}>キャンセル</button>
              {(() => {
                const blocked = busy || (sheet === "exchange" && (exOutTotal === 0 || exOutTotal !== exInTotal));
                return (
                  <button onClick={submit} disabled={blocked} style={{ ...primaryBtn, flex: 1, opacity: blocked ? 0.6 : 1 }}>
                    {sheet === "count" ? "締める" : sheet === "return" ? "返却を記録" : "記録する"}
                  </button>
                );
              })()}
            </div>
          </div>
        </SheetOverlay>
      )}
    </>
  );
}

// ===== Change planner =====

function ChangePlanCard({ products, transactions, canUse, onHand, onUse }: {
  products: any[];
  transactions: any[];
  canUse: boolean;
  /** What is in the box after the 締め (the count, less any 返却 since) — what the next morning can start from. */
  onHand: Breakdown | null;
  onUse: (b: Breakdown) => void;
}) {
  // Default: the best day so far, rounded up to ¥10,000; ¥30,000 before any sales.
  const suggested = useMemo(() => {
    const byDay = new Map<string, number>();
    transactions.forEach((t: any) => {
      if (t.voided) return;
      const day = new Date(t.createdAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
      byDay.set(day, (byDay.get(day) ?? 0) + t.total);
    });
    const best = Math.max(0, ...Array.from(byDay.values()));
    return best >= 10000 ? Math.ceil(best / 10000) * 10000 : 30000;
  }, [transactions]);

  const [input, setInput] = useState<string>("");
  const [sales, setSales] = useState(0);
  useEffect(() => {
    const n = Number(input) || suggested;
    const t = setTimeout(() => setSales(n), 400); // don't re-simulate on every keystroke
    return () => clearTimeout(t);
  }, [input, suggested]);

  // Who comes that day decides how people pay. Remembered on this device
  // only — a convenience, the default is fine when storage is unavailable.
  const [audience, setAudienceState] = useState<Audience>(() => {
    try {
      return localStorage.getItem("pos_change_audience") === "students" ? "students" : "public";
    } catch {
      return "public";
    }
  });
  const setAudience = (a: Audience) => {
    setAudienceState(a);
    try { localStorage.setItem("pos_change_audience", a); } catch { /* ignore */ }
  };

  // After a 締め the counted cash can stay in the box for the next day;
  // the plan is then what to add to it.
  const onHandTotal = breakdownTotal(onHand);
  const [keepOnHand, setKeepOnHand] = useState(true);
  const carryKey = onHandTotal > 0 && keepOnHand ? JSON.stringify(onHand) : "";
  const carry = useMemo<Breakdown | null>(() => (carryKey ? JSON.parse(carryKey) : null), [carryKey]);

  // What sells, so the simulated customers buy like real ones. Equal
  // weights until there are sales to go on.
  const weighted = useMemo(() => {
    const sold = new Map<number, number>();
    transactions.forEach((t: any) => {
      if (t.voided || !Array.isArray(t.items)) return;
      (t.items as any[]).forEach((it) => sold.set(it.product_id, (sold.get(it.product_id) ?? 0) + it.qty));
    });
    const anySales = sold.size > 0;
    return products.map((p) => ({ name: p.name, price: p.price, weight: anySales ? (sold.get(p.id) ?? 0) + 0.5 : 1 }));
  }, [products, transactions]);

  const plan = useMemo(
    () => (sales > 0 ? planChange({ products: weighted, expectedSales: sales, audience, onHand: carry ?? undefined }) : null),
    [weighted, sales, audience, carry]
  );
  const mix = PAYMENT_MIX[audience];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const mixText = [
    `ちょうど${pct(mix.exact)}`,
    `500円玉${pct(mix.coin500)}`,
    `千円札${pct(mix.bill1000)}`,
    ...(mix.bill5000 + mix.bill10000 > 0 ? [`5千円札・1万円札${pct(mix.bill5000 + mix.bill10000)}`] : []),
  ].join("・");
  const registerWith = plan && carry ? addBreakdowns(carry, plan.breakdown) : plan?.breakdown ?? {};
  const awkward = products
    .map((p) => ({ p, coin: awkwardCoinFor(p.price) }))
    .filter((x) => x.coin === 10 || x.coin === 5 || x.coin === 1);

  return (
    <div className="ws-card p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Calculator size={16} style={{ color: "var(--ws-ac)" }} />
        <h3 className="hos-subtitle">釣り銭の準備額の目安</h3>
      </div>
      <p className="hos-caption mb-3">商品の値段から、途中で両替に走らずに済むお釣りの量を計算します。</p>

      <label className="hos-caption mb-1 block">来るお客さん</label>
      <div className="flex gap-2 mb-3">
        {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => (
          <button
            key={a}
            onClick={() => setAudience(a)}
            aria-pressed={audience === a}
            style={{
              ...btnBase,
              flex: 1,
              background: audience === a ? "var(--ws-ac)" : "var(--ws-s2)",
              color: audience === a ? "#fff" : "var(--ws-tx)",
              border: audience === a ? "1.5px solid var(--ws-ac)" : "1.5px solid var(--ws-bd)",
            }}
          >
            {AUDIENCE_LABEL[a]}
          </button>
        ))}
      </div>

      <label className="hos-caption mb-1 block">1日の売上の見込み</label>
      <div className="flex items-center gap-2 mb-4">
        <span className="font-bold" style={{ color: "var(--ws-tx)" }}>¥</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder={String(suggested)}
          className="ws-input font-number"
          style={{ maxWidth: 160 }}
        />
      </div>

      {onHandTotal > 0 && (
        <label className="flex items-start gap-2 mb-4 text-[13px] cursor-pointer" style={{ color: "var(--ws-tx)" }}>
          <input type="checkbox" checked={keepOnHand} onChange={(e) => setKeepOnHand(e.target.checked)} className="mt-0.5" />
          <span>箱に残っているお金（約{yen(onHandTotal)}）をそのまま使う</span>
        </label>
      )}

      {plan ? (
        <>
          <div className="hos-caption mb-1">{carry ? "箱のお金に足す分" : "用意する釣り銭"}</div>
          {plan.total > 0 ? (
            <div className="flex flex-col gap-1 mb-2">
              {DENOMINATIONS.filter((d) => plan.breakdown[`${d}`]).map((d) => (
                <div key={d} className="flex items-center text-[13px]">
                  <span className="font-bold w-[80px]" style={{ color: "var(--ws-tx)" }}>{DENOMINATION_LABEL[d]}</span>
                  <span className="font-number">{plan.breakdown[`${d}`]}枚</span>
                  <span className="font-number ml-auto" style={{ color: "var(--ws-ts)" }}>{yen(d * (plan.breakdown[`${d}`] ?? 0))}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="hos-body mb-2">箱のお金だけで足りる見込みです。</p>
          )}
          <div className="flex items-center justify-between pt-2 mb-2" style={{ borderTop: "1.5px solid var(--ws-bd)" }}>
            <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>{carry ? "足す分の合計" : "釣り銭の合計"}</span>
            <span className="font-number font-extrabold text-lg" style={{ color: "var(--ws-tx)" }}>{yen(plan.total)}</span>
          </div>
          {carry && (
            <div className="flex items-center justify-between mb-2 text-[13px]">
              <span style={{ color: "var(--ws-ts)" }}>釣り銭として登録する額（箱のお金＋足す分）</span>
              <span className="font-number font-bold" style={{ color: "var(--ws-tx)" }}>{yen(breakdownTotal(registerWith))}</span>
            </div>
          )}
          <p className="hos-caption mb-3">
            お客さん約{plan.customers}人（1人平均 {yen(plan.averageSale)}）。{AUDIENCE_LABEL[audience]}の日は、¥100のように硬貨1枚で払える会計なら{mixText}で払うと仮定しました（硬貨がたくさん要る値段ほど、ちょうど払う人は減ります）。何百日分も試して、10日のうち8日は両替なしで足りる量にしてあります。途中で千円札を100円玉に両替できるなら、少なめに始めても回せます。
          </p>
          {canUse && (
            <button onClick={() => onUse(registerWith)} style={secondaryBtn}>
              <Coins size={15} />{carry ? "箱のお金＋足す分で釣り銭を登録" : "この枚数で釣り銭を登録"}
            </button>
          )}
        </>
      ) : (
        <div className="hos-body">商品を登録すると計算できます。</div>
      )}

      {awkward.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-xl text-[13px] mt-3" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <span>
            {awkward.map((x) => `${x.p.name}（${yen(x.p.price)}）`).join("、")}
            のために{awkward.some((x) => x.coin !== 10) ? "1円・5円・10円玉" : "10円玉"}が必要です。50円か100円単位の値段にすると、準備もお釣りの受け渡しも楽になります。
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * What should be in the box, note by note — an estimate from the float,
 * each sale's money in and change out, 回収, 両替 and 返却. Coins down to a
 * fifth of what was prepared are marked (the register shows a warning too).
 */
function CoinPanel({ coins }: { coins: CoinEstimate }) {
  if (!coins.known) return null;
  const lowSet = new Set(coins.low.map((l) => l.denomination));
  const shown = DENOMINATIONS.filter((d) => coins.box[d] > 0 || coins.prepared[d] > 0);
  if (shown.length === 0) return null;
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)" }}>
      <div className="hos-caption mb-1.5">箱の中のお金（推定）</div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((d) => {
          const low = lowSet.has(d);
          return (
            <span
              key={d}
              className="px-2 py-0.5 rounded-full text-[12px] font-bold"
              style={{ background: low ? "var(--ws-dgs)" : "var(--ws-s3)", color: low ? "var(--ws-dg)" : "var(--ws-tx)" }}
            >
              {DENOMINATION_LABEL[d]} <span className="font-number">{coins.box[d]}</span>枚
            </span>
          );
        })}
      </div>
      <p className="hos-caption mt-1.5">
        {coins.low.length > 0
          ? "赤いものはお釣り用に少なくなっています。本部で両替したら「両替」で記録してください。"
          : "会計の預かり金額とお釣りから計算した目安です。締めで数えた枚数に置き換わります。"}
      </p>
    </div>
  );
}

/** After the 締め: has the float gone back to whoever provided it? */
function ReturnStatus({ drawer, closedShort }: { drawer: DrawerState; closedShort: boolean }) {
  if (drawer.float <= 0) return null;
  const outstanding = Math.max(0, drawer.float - drawer.returned);
  const who = drawer.floatParty ? `${drawer.floatParty}へ` : "用意した人へ";
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="hos-caption">釣り銭の返却（{who}）</span>
        {outstanding === 0 ? (
          <span className="flex items-center gap-1 text-[13px] font-bold" style={{ color: "var(--ws-sc)" }}>
            <CheckCircle2 size={14} />全額返却済み
          </span>
        ) : (
          <span className="font-number text-[13px] font-bold" style={{ color: "var(--ws-tx)" }}>
            {yen(drawer.returned)} / {yen(drawer.float)}
          </span>
        )}
      </div>
      {outstanding > 0 && (
        <p className="hos-caption mt-1">
          文化祭の最後の日は、締めの後に釣り銭 {yen(outstanding)} を返して「釣り銭を返す」で記録してください。次の日も同じお金を使うなら、返さずに次の日の釣り銭として登録します。
          {closedShort && " 現金が足りなかったので、全額を返すには不足分をどう補うか（売上から出すなど）をクラスで決めてください。"}
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl p-2.5" style={{ background: "var(--ws-s2)", border: "1px solid var(--ws-bd)" }}>
      <div className="hos-caption">{label}</div>
      <div className="font-number font-extrabold text-[15px]" style={{ color: color ?? "var(--ws-tx)" }}>{value}</div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--ws-ts)" }}>{label}</span>
      <span className="font-number font-bold" style={{ color: "var(--ws-tx)" }}>{value}</span>
    </div>
  );
}

const btnBase = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "10px 12px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 14,
  cursor: "pointer",
} as const;
const primaryBtn = { ...btnBase, background: "var(--ws-ac)", color: "#fff", border: "none" };
const secondaryBtn = { ...btnBase, background: "var(--ws-s2)", color: "var(--ws-tx)", border: "1.5px solid var(--ws-bd)" };
