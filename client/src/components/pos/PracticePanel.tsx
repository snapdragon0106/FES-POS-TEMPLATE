import { useState } from "react";
import { GraduationCap, Sparkles, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import { cashEventLabel } from "@shared/cash";
import SheetOverlay from "./SheetOverlay";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");
const time = (d: Date | string) =>
  new Date(d).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 練習用の商品 (admin, top of 商品管理): add the practice products for a
 * rehearsal, and afterwards clean up — the practice products, every sale
 * containing one, and the cash records chosen here (server: practice.*).
 */
export default function PracticePanel() {
  const status = trpc.practice.status.useQuery(undefined, { refetchInterval: 10_000 });
  const seed = trpc.practice.seed.useMutation();
  const cleanup = trpc.practice.cleanup.useMutation();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  // Cash records to delete with the practice (all ticked when the sheet opens).
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const data = status.data;
  const active = (data?.products.length ?? 0) > 0;
  const voided = data?.sales.filter((s) => s.voided).length ?? 0;

  const refreshAll = () => {
    utils.practice.status.invalidate();
    utils.product.list.invalidate();
    utils.transaction.list.invalidate();
    utils.restock.list.invalidate();
    utils.cash.list.invalidate();
    utils.handover.queue.invalidate();
    utils.activityLog.list.invalidate();
  };

  const handleSeed = async () => {
    try {
      const r = await seed.mutateAsync();
      toast.success(r.created ? `練習用の商品を${r.created}つ追加しました` : "練習用の商品を用意しました");
      refreshAll();
    } catch (e) {
      toast.error(getErrorMessage(e, "追加できませんでした"));
    }
  };

  const openCleanup = () => {
    setPicked(new Set((data?.cashEvents ?? []).map((e) => e.id)));
    setOpen(true);
  };

  const handleCleanup = async () => {
    try {
      const r = await cleanup.mutateAsync({ cashEventIds: Array.from(picked) });
      toast.success(`練習を片付けました（会計${r.sales}件・現金の記録${r.cashEvents}件を削除）。次の注文は${r.orderNo + 1}番からです`);
      setOpen(false);
      refreshAll();
    } catch (e) {
      toast.error(getErrorMessage(e, "片付けられませんでした"));
    }
  };

  if (!data) return null;

  return (
    <div className="ws-card p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="ws-icon-chip-sm flex-shrink-0" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>
          <GraduationCap size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="hos-subtitle">練習</div>
          {active ? (
            <div className="hos-caption mt-0.5">
              練習中：練習用の商品 {data.products.length}つ・練習の会計 {data.sales.length}件
              {voided ? `（うち取消 ${voided}件）` : ""}・練習を始めてからの現金の記録 {data.cashEvents.length}件。
              終わったら、店を開ける前に「練習を片付ける」を押してください。
            </div>
          ) : (
            <div className="hos-caption mt-0.5">
              レジ・受け渡し・釣り銭の操作を本番と同じ画面で練習できます。¥100の練習用の商品を3つ追加し、
              終わったら会計ごとまとめて消せます（本番の商品の売上・在庫には残りません）。
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end mt-3">
        {active ? (
          <button
            onClick={openCleanup}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "1px solid var(--ws-dg)", cursor: "pointer" }}
          >
            <Sparkles size={13} />練習を片付ける
          </button>
        ) : (
          <button
            onClick={handleSeed}
            disabled={seed.isPending}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer", opacity: seed.isPending ? 0.6 : 1 }}
          >
            {seed.isPending ? <Loader2 size={13} className="animate-spin" /> : <GraduationCap size={13} />}練習用の商品を追加
          </button>
        )}
      </div>

      {open && (
        <SheetOverlay>
          <div className="relative ws-sheet-pop ws-glass-sheet w-full md:max-w-md max-h-[92vh] overflow-y-auto rounded-t-[28px] md:rounded-[28px] p-6">
            <div className="w-9 h-1 rounded-full mx-auto mb-5 md:hidden" style={{ background: "var(--ws-bd)" }} />
            <h3 className="hos-subtitle mb-3">練習を片付ける</h3>
            <div className="hos-caption mb-1">消えるもの：</div>
            <ul className="hos-caption mb-3" style={{ paddingLeft: "1.2em", listStyle: "disc" }}>
              <li>練習用の商品 {data.products.length}つ（{data.products.map((p) => p.name).join("・")}）</li>
              <li>
                練習用の商品が1つでも入った会計 {data.sales.length}件（取消していないものも）
                {data.sales.length ? `・合計 ${yen(data.sales.filter((s) => !s.voided).reduce((a, s) => a + s.total, 0))}` : ""}
              </li>
              <li>下で選んだ現金の記録</li>
            </ul>
            <div className="hos-caption mb-1">
              練習を始めてからの現金の記録（釣り銭・回収・締め など）。<b>本物の釣り銭をもう登録していたら、そのチェックを外してください。</b>
            </div>
            {data.cashEvents.length ? (
              <div className="flex flex-col gap-1.5 mb-3">
                {data.cashEvents.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm" style={{ cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={picked.has(e.id)}
                      onChange={(ev) => {
                        const next = new Set(picked);
                        if (ev.target.checked) next.add(e.id);
                        else next.delete(e.id);
                        setPicked(next);
                      }}
                    />
                    <span className="font-bold">{cashEventLabel(e.kind)}</span>
                    <span className="font-number">{yen(e.amount)}</span>
                    <span className="hos-caption ml-auto">{time(e.createdAt)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="hos-caption mb-3">（ありません）</div>
            )}
            <div className="hos-caption mb-4">
              本番の商品だけの会計はそのまま残ります。今日の注文番号は、残っている会計の番号の続きに戻ります。
              操作ログは残ります。
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 py-2.5 text-sm font-bold"
                style={{ background: "var(--ws-s2)", color: "var(--ws-ts)", border: "none", cursor: "pointer" }}
              >
                キャンセル
              </button>
              <button
                onClick={handleCleanup}
                disabled={cleanup.isPending}
                className="flex-1 py-2.5 text-sm font-bold"
                style={{ background: "var(--ws-dg)", color: "#fff", border: "none", cursor: "pointer", opacity: cleanup.isPending ? 0.6 : 1 }}
              >
                片付ける
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}
    </div>
  );
}
