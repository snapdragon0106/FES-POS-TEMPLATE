import { useLayoutEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { Plus, Pencil, Trash2, RotateCcw, ImagePlus, X, Loader2, Package } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import { dissolveOut, dissolveRestore } from "@/lib/dissolve";
import SwipeToDelete from "./SwipeToDelete";
import ProductIcon from "./ProductIcon";
import { productImageUrl, resizeImageFile } from "@/lib/productImage";
import { awkwardCoinFor } from "@shared/cash";
import SheetOverlay from "./SheetOverlay";
import PracticePanel from "./PracticePanel";

// Why a price needs a coin beyond 100円玉, for the warning under the price.
const coinNote = (price: number): string | null => {
  const coin = awkwardCoinFor(price);
  if (!coin || price <= 0) return null;
  if (coin === 50) return "50円玉のお釣りが必要です（準備はしやすい値段です）";
  return `${coin}円玉のお釣りが必要になります。50円か100円単位にすると、釣り銭の準備もお釣りの受け渡しも楽になります`;
};

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

const EMPTY_FORM = { name: "", emoji: "📦", price: 0, cost: 0, initialStock: 0, threshold: 10, displayOrder: 0 };

interface Props {
  products: any[];
  operator: string;
  operatorName: string;
}

export default function ProductsTab({ products, operator, operatorName }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formOrigin, setFormOrigin] = useState({ x: 0, y: 0 });
  // On a PC the form grows out of the button that opened it. transform-origin
  // is measured from the sheet's own corner, not the screen, so the click
  // point is converted once the sheet is laid out (offsetLeft/Top ignore the
  // scale the animation starts from), before it is first painted.
  const sheetRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!showForm || !el) return;
    el.style.transformOrigin = `${formOrigin.x - el.offsetLeft}px ${formOrigin.y - el.offsetTop}px`;
  }, [showForm, formOrigin]);
  const [form, setForm] = useState(EMPTY_FORM);
  // The photo the product being edited already has (null: none).
  const [savedImageHash, setSavedImageHash] = useState<string | null>(null);
  // Pending photo change: undefined = leave as is, a data URL = replace,
  // null = remove (back to the emoji). Sent only when the form is saved.
  const [imageDraft, setImageDraft] = useState<string | null | undefined>(undefined);
  const [imageBusy, setImageBusy] = useState(false);
  // New products only: stock for later days (e.g. day 2's share), entered
  // together with the product. Each row becomes a dated restock.
  const [scheduleRows, setScheduleRows] = useState<{ date: string; qty: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createProduct = trpc.product.create.useMutation();
  const updateProduct = trpc.product.update.useMutation();
  const deleteProduct = trpc.product.delete.useMutation();
  const setProductImage = trpc.product.setImage.useMutation();
  const createRestock = trpc.restock.create.useMutation();
  const resetAll = trpc.resetAll.useMutation();
  const utils = trpc.useUtils();

  const openForm = (e: MouseEvent, p: any | null) => {
    setFormOrigin({ x: e.clientX, y: e.clientY });
    setEditId(p ? p.id : null);
    setForm(
      p
        ? {
            name: p.name,
            emoji: p.emoji,
            price: p.price,
            cost: p.cost,
            initialStock: p.initialStock,
            threshold: p.threshold,
            displayOrder: p.displayOrder,
          }
        : EMPTY_FORM
    );
    setSavedImageHash(p?.imageHash ?? null);
    setImageDraft(undefined);
    setScheduleRows([]);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditId(null);
    setImageDraft(undefined);
  };

  const handlePickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again still fires
    if (!file) return;
    setImageBusy(true);
    try {
      setImageDraft(await resizeImageFile(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "画像を読み込めませんでした");
    } finally {
      setImageBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.name || form.price <= 0) {
      toast.error("商品名と価格は必須です");
      return;
    }
    let savedId: number | null = null;
    try {
      if (editId) {
        await updateProduct.mutateAsync({ id: editId, ...form });
        savedId = editId;
      } else {
        savedId = (await createProduct.mutateAsync({ ...form })).id;
      }
    } catch (e) {
      toast.error(getErrorMessage(e, "操作に失敗しました"));
      return;
    }

    // The product is saved at this point; a failed photo upload must not
    // read as a failed save, or the next attempt would add it twice.
    let imageFailed = false;
    if (imageDraft !== undefined && savedId) {
      try {
        await setProductImage.mutateAsync({ id: savedId, image: imageDraft });
      } catch (e) {
        imageFailed = true;
        toast.error(`商品は保存しましたが、画像を保存できませんでした（${getErrorMessage(e, "不明なエラー")}）`);
      }
    }
    // Stock for later days, as dated restocks. Like the photo: the product
    // is saved whatever happens here.
    const rows = editId ? [] : scheduleRows.filter((r) => r.date && Number(r.qty) > 0);
    let scheduleFailed = false;
    for (const r of rows) {
      try {
        await createRestock.mutateAsync({ productId: savedId!, amount: Number(r.qty), availableOn: r.date });
      } catch (e) {
        scheduleFailed = true;
        toast.error(`商品は保存しましたが、${r.date} の在庫を登録できませんでした（${getErrorMessage(e, "不明なエラー")}）。「在庫」タブの「日付指定」で登録し直してください`);
      }
    }
    if (rows.length) utils.restock.list.invalidate();
    if (!imageFailed && !scheduleFailed) toast.success(editId ? "商品を更新しました" : "商品を追加しました");
    closeForm();
    setForm(EMPTY_FORM);
    utils.product.list.invalidate();
  };

  const handleEdit = (e: MouseEvent, p: any) => openForm(e, p);

  // Swipe-to-delete path: the swipe is the confirmation and SwipeToDelete
  // plays the shatter, so this only runs the mutation. The log/toast/invalidate
  // happen in onDeleted, after the animation, so the card isn't unmounted
  // mid-shatter.
  const handleSwipeDelete = async (p: any) => {
    await deleteProduct.mutateAsync({ id: p.id });
  };

  const handleDelete = async (p: any, ev: React.MouseEvent) => {
    const row = (ev.currentTarget as HTMLElement).closest(".ws-card") as HTMLElement | null;
    if (!confirm(`「${p.name}」を削除しますか？`)) return;
    try {
      const del = deleteProduct.mutateAsync({ id: p.id });
      if (row) await dissolveOut(row);
      await del;
      toast.success("商品を削除しました");
      utils.product.list.invalidate();
    } catch (e) {
      if (row) dissolveRestore(row);
      toast.error(getErrorMessage(e, "削除に失敗しました"));
    }
  };

  const handleReset = async () => {
    if (!confirm("全データ（取引・補充・商品・現金の記録・操作ログ）をリセットしますか？\nこの操作は取り消せません。")) return;
    const typed = prompt("確認のため「全データリセット」と入力してください");
    if (typed === null) return;
    try {
      await resetAll.mutateAsync({ confirm: typed.trim() as "全データリセット" });
      toast.success("全データをリセットしました");
      utils.product.list.invalidate();
      utils.transaction.list.invalidate();
      utils.restock.list.invalidate();
      utils.activityLog.list.invalidate();
    } catch (e) {
      toast.error(getErrorMessage(e, "リセットに失敗しました"));
    }
  };

  return (
    <div className="ws-fade">
      <div className="flex items-center justify-between mb-4">
        <h2 className="hos-title">商品管理</h2>
        <div className="flex gap-2">
          <button
            onClick={(e) => openForm(e, null)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            style={{ background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer" }}
          >
            <Plus size={13} />追加
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "1px solid var(--ws-dg)", cursor: "pointer" }}
          >
            <RotateCcw size={13} />リセット
          </button>
        </div>
      </div>

      <PracticePanel />

      {/* Product Form — HarmonyOS-style bottom sheet on mobile, centered on desktop */}
      {showForm && (
        <SheetOverlay>
          <div
            ref={sheetRef}
            className="relative ws-sheet-pop ws-glass-sheet w-full md:max-w-md max-h-[92vh] overflow-y-auto rounded-t-[28px] md:rounded-[28px] p-6"
          >
            <div className="w-9 h-1 rounded-full mx-auto mb-5 md:hidden" style={{ background: "var(--ws-bd)" }} />
            <h3 className="hos-subtitle mb-4">{editId ? "商品を編集" : "商品を追加"}</h3>
            <div className="flex flex-col gap-3">
              {/* Photo: shown instead of the emoji wherever the product appears. */}
              <div className="flex items-center gap-3">
                {(() => {
                  const previewSrc =
                    typeof imageDraft === "string"
                      ? imageDraft
                      : imageDraft === undefined && editId && savedImageHash
                        ? productImageUrl(editId, savedImageHash)
                        : null;
                  return (
                    <div
                      className="flex items-center justify-center overflow-hidden flex-shrink-0"
                      style={{ width: 64, height: 64, borderRadius: 18, background: "var(--ws-s2)", border: "1px solid var(--ws-bd)", fontSize: 28 }}
                    >
                      {imageBusy ? (
                        <Loader2 size={20} className="animate-spin" style={{ color: "var(--ws-ts)" }} />
                      ) : previewSrc ? (
                        <img src={previewSrc} alt="" className="w-full h-full object-cover" />
                      ) : (
                        form.emoji || <Package size={22} style={{ color: "var(--ws-ts)" }} />
                      )}
                    </div>
                  );
                })()}
                <div className="flex-1 min-w-0">
                  <label className="hos-caption mb-1 block">商品画像（任意）</label>
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={imageBusy}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold"
                      style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
                    >
                      <ImagePlus size={13} />
                      {typeof imageDraft === "string" || (imageDraft === undefined && savedImageHash) ? "画像を変更" : "画像を選ぶ"}
                    </button>
                    {(typeof imageDraft === "string" || (imageDraft === undefined && savedImageHash)) && (
                      <button
                        type="button"
                        onClick={() => setImageDraft(savedImageHash ? null : undefined)}
                        disabled={imageBusy}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold"
                        style={{ background: "var(--ws-dgs)", border: "1.5px solid var(--ws-dg)", color: "var(--ws-dg)", cursor: "pointer" }}
                      >
                        <X size={13} />画像を外す
                      </button>
                    )}
                  </div>
                  <div className="hos-caption mt-1">画像がないときは絵文字を表示します（どちらも無ければ箱のアイコン）</div>
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePickImage} className="hidden" />
              </div>
              <div className="flex gap-2">
                <div className="w-20">
                  <label className="hos-caption mb-1 block">絵文字（任意）</label>
                  <input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} className="ws-input text-center text-xl" />
                </div>
                <div className="flex-1">
                  <label className="hos-caption mb-1 block">商品名</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="ws-input" placeholder="商品名" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="hos-caption mb-1 block">販売価格</label>
                  <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className="ws-input font-number" />
                </div>
                <div>
                  <label className="hos-caption mb-1 block">原価</label>
                  <input type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} className="ws-input font-number" />
                </div>
              </div>
              {coinNote(form.price) && (
                <div
                  className="hos-caption -mt-1"
                  style={{ color: awkwardCoinFor(form.price) === 50 ? "var(--ws-ts)" : "var(--ws-warn)" }}
                >
                  {coinNote(form.price)}
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="hos-caption mb-1 block">初期在庫</label>
                  <input type="number" value={form.initialStock} onChange={(e) => setForm({ ...form, initialStock: Number(e.target.value) })} className="ws-input font-number" />
                </div>
                <div>
                  <label className="hos-caption mb-1 block">警告閾値</label>
                  <input type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} className="ws-input font-number" />
                </div>
                <div>
                  <label className="hos-caption mb-1 block">表示順</label>
                  <input type="number" value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })} className="ws-input font-number" />
                </div>
              </div>
              {editId ? (
                <div className="hos-caption">日付を指定した在庫（2日目の分など）は「在庫」タブの「日付指定」で追加・取消できます。</div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="hos-caption">日付を指定して追加する在庫（任意）</label>
                    <button
                      type="button"
                      onClick={() => setScheduleRows([...scheduleRows, { date: "", qty: "" }])}
                      className="hos-caption font-bold"
                      style={{ background: "none", border: "none", color: "var(--ws-ac)", cursor: "pointer", padding: 0 }}
                    >
                      ＋ 日付を追加
                    </button>
                  </div>
                  {scheduleRows.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 mb-1.5">
                      <input
                        type="date"
                        value={r.date}
                        onChange={(e) => setScheduleRows(scheduleRows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                        className="ws-input font-number flex-1"
                        aria-label="売り始める日"
                      />
                      <input
                        value={r.qty}
                        onChange={(e) => setScheduleRows(scheduleRows.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x)))}
                        inputMode="numeric"
                        placeholder="個数"
                        className="ws-input font-number"
                        style={{ width: 90 }}
                        aria-label="個数"
                      />
                      <button
                        type="button"
                        onClick={() => setScheduleRows(scheduleRows.filter((_, j) => j !== i))}
                        aria-label="この行を消す"
                        style={{ background: "none", border: "none", color: "var(--ws-td)", cursor: "pointer" }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="hos-caption">
                    初期在庫は今日から売る分です。2日目の分などは日付と個数を入れると、その日の0時からレジに出ます。
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={closeForm}
                className="flex-1 py-2.5 text-sm font-bold"
                style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-ts)", cursor: "pointer" }}
              >
                キャンセル
              </button>
              <button
                onClick={handleSubmit}
                disabled={imageBusy || createProduct.isPending || updateProduct.isPending || setProductImage.isPending}
                className="flex-1 py-2.5 text-sm font-bold"
                style={{
                  background: "var(--ws-ac)", color: "#fff", border: "none", cursor: "pointer",
                  opacity: imageBusy || createProduct.isPending || updateProduct.isPending || setProductImage.isPending ? 0.6 : 1,
                }}
              >
                {editId ? "更新" : "追加"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* Product List — icon-chip leading element + primary/secondary/tertiary hierarchy */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {products.map((p, i) => (
          <SwipeToDelete
            key={p.id}
            className={`ws-card ws-fade ws-stagger-${Math.min(i + 1, 8)} p-4 flex items-center gap-3.5`}
            onDelete={() => handleSwipeDelete(p)}
            onDeleted={() => {
              toast.success("商品を削除しました");
              utils.product.list.invalidate();
            }}
            onDeleteError={(err) =>
              toast.error(getErrorMessage(err, "削除に失敗しました"))
            }
          >
            <ProductIcon productId={p.id} emoji={p.emoji} imageHash={p.imageHash} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="hos-subtitle truncate">{p.name}</div>
                {p.practice && (
                  <span className="ws-badge flex-shrink-0" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>練習用</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="font-number text-[13px] font-extrabold" style={{ color: "var(--ws-ac)" }}>{yen(p.price)}</span>
                <span className="hos-caption">原価 {yen(p.cost)}</span>
                {(() => {
                  const coin = awkwardCoinFor(p.price);
                  return coin && coin !== 50 ? (
                    <span className="ws-badge" style={{ background: "var(--ws-wns)", color: "var(--ws-warn)" }}>{coin}円玉が必要</span>
                  ) : null;
                })()}
              </div>
              <div className="hos-caption mt-1">
                初期在庫 {p.initialStock} ・ 警告 {p.threshold}以下
              </div>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={(e) => handleEdit(e, p)}
                className="ws-icon-chip-sm"
                style={{ background: "var(--ws-s2)", color: "var(--ws-ts)", border: "none", cursor: "pointer" }}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={(e) => handleDelete(p, e)}
                className="ws-icon-chip-sm"
                style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: "pointer" }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </SwipeToDelete>
        ))}
      </div>
    </div>
  );
}
