import { Minus, Plus } from "lucide-react";
import { DENOMINATIONS, DENOMINATION_LABEL, breakdownTotal, type Breakdown, type Denomination } from "@shared/cash";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

interface Props {
  value: Breakdown;
  onChange: (next: Breakdown) => void;
  /** Denominations to show; defaults to all of them. */
  denominations?: readonly Denomination[];
}

/**
 * Count-per-denomination entry — the way money is actually counted
 * (千円札が何枚、100円玉が何枚…), with the total worked out for you.
 */
export default function DenominationInput({ value, onChange, denominations = DENOMINATIONS }: Props) {
  const set = (d: Denomination, n: number) => {
    const next = { ...value };
    if (n > 0) next[`${d}`] = Math.min(n, 10000);
    else delete next[`${d}`];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {denominations.map((d) => {
        const n = value[`${d}`] ?? 0;
        return (
          <div key={d} className="flex items-center gap-2">
            <span className="text-[13px] font-bold w-[72px] flex-shrink-0" style={{ color: "var(--ws-tx)" }}>
              {DENOMINATION_LABEL[d]}
            </span>
            <button
              type="button"
              onClick={() => set(d, n - 1)}
              className="w-8 h-8 flex items-center justify-center rounded-lg flex-shrink-0"
              style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
              aria-label={`${DENOMINATION_LABEL[d]}を1枚減らす`}
            >
              <Minus size={12} />
            </button>
            <input
              value={n || ""}
              onChange={(e) => set(d, Number(e.target.value.replace(/\D/g, "")) || 0)}
              inputMode="numeric"
              placeholder="0"
              className="ws-input font-number text-center text-sm"
              style={{ width: 64, padding: "6px 4px" }}
              aria-label={`${DENOMINATION_LABEL[d]}の枚数`}
            />
            <button
              type="button"
              onClick={() => set(d, n + 1)}
              className="w-8 h-8 flex items-center justify-center rounded-lg flex-shrink-0"
              style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
              aria-label={`${DENOMINATION_LABEL[d]}を1枚増やす`}
            >
              <Plus size={12} />
            </button>
            <span className="font-number text-[13px] ml-auto" style={{ color: n ? "var(--ws-tx)" : "var(--ws-td)" }}>
              {yen(d * n)}
            </span>
          </div>
        );
      })}
      <div className="flex items-center justify-between mt-1.5 pt-2" style={{ borderTop: "1.5px solid var(--ws-bd)" }}>
        <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>合計</span>
        <span className="font-number font-extrabold text-lg" style={{ color: "var(--ws-tx)" }}>{yen(breakdownTotal(value))}</span>
      </div>
    </div>
  );
}
