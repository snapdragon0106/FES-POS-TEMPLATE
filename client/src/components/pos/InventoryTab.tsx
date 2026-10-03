import { useState } from "react";
import { AlertTriangle, PackagePlus, CalendarPlus, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import ProductIcon from "./ProductIcon";
import { shortDate } from "@shared/stockSchedule";
import SheetOverlay from "./SheetOverlay";

interface Props {
  products: any[];
  getStock: (id: number) => number;
  initialMap: Record<number, number>;
  /** Every restock, including ones scheduled for a later day. */
  restocks: any[];
  /** Today (Japan time, YYYY-MM-DD). */
  today: string;
  isAdmin: boolean;
  operator: string;
  operatorName: string;
}

export default function InventoryTab({ products, getStock, initialMap, restocks, today, isAdmin, operator, operatorName }: Props) {
  const createRestock = trpc.restock.create.useMutation();
  const cancelScheduled = trpc.restock.cancelScheduled.useMutation();
  const utils = trpc.useUtils();
  // Adding stock for a later day: which product, the day, how many.
  const [scheduleFor, setScheduleFor] = useState<any | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleQty, setScheduleQty] = useState("");

  // Stock entered for a later day, per product, earliest first.
  const scheduledOf = (productId: number) =>
    restocks
      .filter((r) => r.productId === productId && r.availableOn && r.availableOn > today)
      .sort((a, b) => (a.availableOn < b.availableOn ? -1 : a.availableOn > b.availableOn ? 1 : a.id - b.id));

  const openSchedule = (p: any) => {
    const tomorrow = new Date(`${today}T00:00:00+09:00`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    setScheduleDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(tomorrow));
    setScheduleQty("");
    setScheduleFor(p);
  };

  const submitSchedule = async () => {
    const qty = Number(scheduleQty);
    if (!Number.isInteger(qty) || qty <= 0) { toast.error("個数を入力してください"); return; }
    if (!scheduleDate) { toast.error("日付を選んでください"); return; }
    try {
      const r = await createRestock.mutateAsync({ productId: scheduleFor.id, amount: qty, availableOn: scheduleDate });
      if (r.availableOn) {
        toast.success(`${shortDate(r.availableOn)}から +${qty}個 を登録しました`);
      } else {
        // Today: on sale at once, like the +10/+50 buttons.
        toast.success("補充しました");
      }
      setScheduleFor(null);
      utils.restock.list.invalidate();
      utils.activityLog.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "登録に失敗しました"));
    }
  };

  const handleCancel = async (p: any, r: any) => {
    if (!confirm(`${p.name}の「${shortDate(r.availableOn)}から +${r.amount}個」を取り消しますか？`)) return;
    try {
      await cancelScheduled.mutateAsync({ id: r.id });
      toast.success("予定を取り消しました");
      utils.restock.list.invalidate();
      utils.activityLog.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "取り消せませんでした"));
    }
  };

  const handleRestock = async (productId: number, amount: number) => {
    try {
      await createRestock.mutateAsync({ productId, amount });
      const product = products.find((p) => p.id === productId);
      toast.success("補充しました");
      utils.restock.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "補充に失敗しました"));
    }
  };

  return (
    <div className="ws-fade">
      <h2 className="hos-title mb-4">在庫管理</h2>
      {/* HarmonyOS repeated-layout grid: single column on phones, two columns
          from the md breakpoint up, per the responsive grid guideline. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {products.map((p, i) => {
          const s = getStock(p.id);
          const inBase = initialMap[p.id] || p.initialStock || 1;
          const out = s <= 0;
          const low = s > 0 && s <= (p.threshold || 0);
          const pct = Math.max(0, Math.min(100, Math.round((s / inBase) * 100)));
          const dotColor = out ? "var(--ws-dg)" : low ? "var(--ws-warn)" : "var(--ws-sc)";
          return (
            <div key={p.id} className={`ws-card ws-fade ws-stagger-${Math.min(i + 1, 8)} flex items-center gap-3.5 p-4`}>
              <ProductIcon productId={p.id} emoji={p.emoji} imageHash={p.imageHash} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="ws-dot" style={{ background: dotColor }} />
                  <span className="hos-subtitle truncate min-w-0">{p.name}</span>
                </div>
                {/* Progress bar */}
                <div className="h-[5px] rounded-full overflow-hidden mb-1.5" style={{ background: "var(--ws-s3)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: pct + "%", background: dotColor }}
                  />
                </div>
                {/* The status badge sits on this line, not beside the name: on a
                    360px phone the name, the badge and the buttons didn't fit
                    on one line and the badge broke into one character a line. */}
                <div className="hos-caption flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="whitespace-nowrap">
                    残 <span className="font-number font-bold" style={{ color: "var(--ws-tx)" }}>{s}</span> / {inBase}
                  </span>
                  {out && (
                    <span className="ws-badge whitespace-nowrap" style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)" }}>
                      <AlertTriangle size={10} />在庫切れ
                    </span>
                  )}
                  {low && (
                    <span className="ws-badge whitespace-nowrap" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>
                      <AlertTriangle size={10} />残りわずか
                    </span>
                  )}
                  <span className="whitespace-nowrap">警告 {p.threshold || 0}以下</span>
                </div>
                {scheduledOf(p.id).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {scheduledOf(p.id).map((r) => (
                      <span
                        key={r.id}
                        className="ws-badge"
                        style={{ background: "var(--ws-ach)", color: "var(--ws-ac)" }}
                        title="この日の0時から売れる在庫に加わります"
                      >
                        {shortDate(r.availableOn)}から +{r.amount}
                        {isAdmin && (
                          <button
                            onClick={() => handleCancel(p, r)}
                            aria-label={`${shortDate(r.availableOn)}からの予定を取り消す`}
                            style={{ background: "none", border: "none", padding: 0, marginLeft: 2, cursor: "pointer", color: "inherit", display: "flex" }}
                          >
                            <X size={11} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {isAdmin && (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => handleRestock(p.id, 10)}
                    className="flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-bold"
                    style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer" }}
                  >
                    <PackagePlus size={11} />+10
                  </button>
                  <button
                    onClick={() => handleRestock(p.id, 50)}
                    className="flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-bold"
                    style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-ts)", cursor: "pointer" }}
                  >
                    +50
                  </button>
                  <button
                    onClick={() => openSchedule(p)}
                    className="flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] font-bold"
                    style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-ts)", cursor: "pointer" }}
                    title="日付を指定して、その日から売る在庫を追加"
                  >
                    <CalendarPlus size={11} />日付指定
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {scheduleFor && (
        <SheetOverlay>
          <div className="relative ws-sheet-pop ws-glass-sheet w-full md:max-w-md rounded-t-[28px] md:rounded-[28px] p-6">
            <div className="w-9 h-1 rounded-full mx-auto mb-5 md:hidden" style={{ background: "var(--ws-bd)" }} />
            <h3 className="hos-subtitle mb-1">日付を指定して在庫を追加</h3>
            <p className="hos-caption mb-4">
              {scheduleFor.emoji} {scheduleFor.name}：選んだ日の0時から売れる在庫に加わります。それまではレジに出ません。
              前の日の売れ残りはそのまま持ち越されます。
            </p>
            <label className="hos-caption mb-1 block">売り始める日</label>
            <input
              type="date"
              value={scheduleDate}
              min={today}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="ws-input font-number mb-3"
            />
            <label className="hos-caption mb-1 block">個数</label>
            <input
              value={scheduleQty}
              onChange={(e) => setScheduleQty(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder="例：80"
              className="ws-input font-number text-lg mb-4"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => setScheduleFor(null)}
                className="flex-1 py-2.5 text-[13px] font-bold"
                style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
              >
                キャンセル
              </button>
              <button
                onClick={submitSchedule}
                disabled={createRestock.isPending}
                className="flex-1 py-2.5 text-[13px] font-bold"
                style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer", opacity: createRestock.isPending ? 0.6 : 1 }}
              >
                登録する
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}
    </div>
  );
}
