import { useState, useCallback, useRef, useEffect } from "react";
import { AlertTriangle, Plus, Minus, Trash2, Receipt, Coins, Landmark } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { orderLabel, type TransactionItem } from "@shared/posTypes";
import { PAYMENT_METHOD_STYLE, isCashless } from "@shared/paymentTypes";
import CheckoutModal, { type ConfirmPayload } from "./CheckoutModal";
import { DENOMINATION_LABEL, type CoinEstimate } from "@shared/cash";
import ProductIcon from "./ProductIcon";
import { getErrorMessage, isConnectionError } from "@/lib/errorMessage";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

/** Idempotency key for one checkout attempt (see transactions.clientRequestId). */
function newCheckoutId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface CartItem {
  id: number;
  name: string;
  emoji: string;
  imageHash?: string | null;
  price: number;
  cost: number;
  qty: number;
}

interface Props {
  products: any[];
  getStock: (id: number) => number;
  operator: string;
  operatorName: string;
  isAdmin: boolean;
  onSync: () => void;
  /** Takings in the drawer when it is time to move money to 本部; else null. */
  collectReminder?: number | null;
  /** Estimated notes/coins in the box: the low-coin warning and the change breakdown at checkout. */
  coins?: CoinEstimate;
}

export default function POSRegister({ products, getStock, operator, operatorName, isAdmin, onSync, collectReminder, coins }: Props) {
  const [cart, setCart] = useState<Record<number, CartItem>>({});
  const [showCheckout, setShowCheckout] = useState(false);
  // The last sale's order number, kept on screen in case the customer
  // didn't catch it (the toast goes away).
  const [lastOrderNo, setLastOrderNo] = useState<number | null>(null);

  const createTx = trpc.transaction.create.useMutation();
  const utils = trpc.useUtils();
  const submittingRef = useRef(false);

  // One key per sale, reused by every retry of it until the server has
  // confirmed it. If a confirm press reaches the server but its response
  // is lost on bad Wi-Fi, the cashier's second press carries the same key
  // and the server answers with the sale it already recorded instead of
  // booking another one. Any change to the cart makes it a different sale,
  // so the key is dropped then.
  const checkoutIdRef = useRef<string | null>(null);
  useEffect(() => {
    checkoutIdRef.current = null;
  }, [cart]);

  // Which payment methods this deployment accepts. Fetched here rather
  // than inside the modal so it is already warm when the cashier opens
  // checkout; it only changes when the server restarts with different
  // environment variables.
  const paymentConfigQuery = trpc.payment.config.useQuery(undefined, { staleTime: Infinity });

  const cartItems = Object.values(cart).filter((c) => c.qty > 0);
  const cartTotal = cartItems.reduce((s, it) => s + it.price * it.qty, 0);
  const cartCount = cartItems.reduce((s, it) => s + it.qty, 0);

  const addToCart = (p: any) => {
    const stock = getStock(p.id);
    const current = cart[p.id]?.qty || 0;
    if (current >= stock) {
      toast.error("在庫が不足しています");
      return;
    }
    setCart((prev) => ({
      ...prev,
      [p.id]: {
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        imageHash: p.imageHash,
        price: p.price,
        cost: p.cost,
        qty: current + 1,
      },
    }));
  };

  const changeQty = (id: number, delta: number) => {
    setCart((prev) => {
      const item = prev[id];
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      if (delta > 0) {
        const stock = getStock(id);
        if (newQty > stock) {
          toast.error("在庫が不足しています");
          return prev;
        }
      }
      return { ...prev, [id]: { ...item, qty: newQty } };
    });
  };

  const removeFromCart = (id: number) => {
    setCart((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleCheckoutConfirm = async ({ received, paymentMethod, paymentId }: ConfirmPayload) => {
    if (submittingRef.current) return; // prevent double submission (double-tap)
    submittingRef.current = true;
    const items: TransactionItem[] = cartItems.map((it) => ({
      product_id: it.id,
      name: it.name,
      emoji: it.emoji,
      price: it.price,
      cost: it.cost,
      qty: it.qty,
    }));

    if (!checkoutIdRef.current) checkoutIdRef.current = newCheckoutId();

    try {
      const result = await createTx.mutateAsync({
        items,
        total: cartTotal,
        received,
        changeAmount: received - cartTotal,
        paymentMethod,
        paymentId,
        clientRequestId: checkoutIdRef.current,
      });
      // The log line is written by the server (transaction.create).
      const methodLabel = PAYMENT_METHOD_STYLE[paymentMethod].label;
      setCart({});
      setShowCheckout(false);
      checkoutIdRef.current = null;
      // The order number, for the customer to say at the handover counter
      // (受け渡し), where the goods have just appeared under it.
      const no = orderLabel(result.orderNo);
      const tell = no ? { description: `お客さんに「${no}」と伝えてください`, duration: 8000 } : { duration: 6000 };
      if (result.duplicate) {
        // The earlier press had gone through; its answer was just lost.
        toast.success(`会計完了！${no ? ` ${no}` : ""}（先ほどの送信で記録済みでした。二重には記録されていません）`, tell);
      } else {
        toast.success(`会計完了！${no ? ` ${no}` : ""}${isCashless(paymentMethod) ? `（${methodLabel}）` : ""}`, tell);
      }
      setLastOrderNo(result.orderNo ?? null);
      utils.transaction.list.invalidate();
      utils.handover.queue.invalidate();
      // The payment just stopped reserving its stock (it became a sale),
      // so refresh the reservation map rather than waiting out the poll
      // and showing this register's own items as still held.
      if (isCashless(paymentMethod)) utils.payment.reservedStock.invalidate();
    } catch (e) {
      if (isConnectionError(e)) {
        // Outcome unknown: the sale may or may not have been recorded. The
        // key is kept, so pressing again is the correct and safe thing.
        toast.error(
          "通信が途切れました。会計が記録されたか分からないため、カートはそのままで、もう一度「会計を確定する」を押してください（二重には記録されません）。",
          { duration: 12000 }
        );
      } else {
        toast.error(getErrorMessage(e, "会計に失敗しました"));
      }
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <div className="ws-fade">
      <h2 className="hos-title mb-4">
        レジ
      </h2>

      {/* Too much cash in one box is a theft and loss risk on a crowded
          festival floor. Shown on every register once the takings pass
          the threshold (売上タブで設定), until a 回収 is recorded. */}
      {collectReminder != null && (
        <div
          role="status"
          className="flex items-start gap-2 p-3 mb-3 rounded-2xl text-[13px] font-bold"
          style={{ background: "var(--ws-wns)", color: "var(--ws-warn)", border: "1.5px solid var(--ws-warn)" }}
        >
          <Landmark size={16} className="flex-shrink-0 mt-0.5" />
          <span>
            レジに売上が {yen(collectReminder)} たまっています。本部の金庫へ移して、「売上」タブの「本部へ回収」で記録してください。
          </span>
        </div>
      )}

      {/* Change running out: shown on every register while a coin (or 千円札)
          prepared for change is down to a fifth of the float, by the
          estimate in shared/cash.ts computeCoins. Better to hear it now
          than from a customer waiting for ¥900. */}
      {coins && coins.low.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 p-3 mb-3 rounded-2xl text-[13px] font-bold"
          style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "1.5px solid var(--ws-dg)" }}
        >
          <Coins size={16} className="flex-shrink-0 mt-0.5" />
          <span>
            お釣り用の{coins.low.map((l) => `${DENOMINATION_LABEL[l.denomination]}（残り約${l.count}枚）`).join("・")}が少なくなっています。
            本部で両替して、「売上」タブの「両替」で記録してください。
          </span>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        {/* Product Grid */}
        <div className="flex-1">
          {products.length === 0 && (
            // A new shop (or one just reset) has nothing to sell yet.
            <div className="ws-card p-5 mb-3 hos-body" style={{ color: "var(--ws-ts)" }}>
              {isAdmin
                ? "商品がまだありません。「商品」タブの「追加」から、売る商品を登録してください。"
                : "商品がまだありません。管理者が商品を登録すると、ここに表示されます。"}
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 md:gap-3">
            {products.map((p) => {
              const s = getStock(p.id);
              const out = s <= 0;
              const low = s > 0 && s <= (p.threshold || 0);
              const inCart = (cart[p.id]?.qty || 0) > 0;
              return (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  disabled={out}
                  className={`ws-card ws-card-interactive ${inCart ? "ws-card-active" : ""} text-left relative w-full`}
                  style={{
                    padding: 18,
                    opacity: out ? 0.3 : 1,
                    filter: out ? "grayscale(1)" : "none",
                    cursor: out ? "not-allowed" : "pointer",
                    borderWidth: "1.5px",
                  }}
                >
                  <span
                    className="ws-badge absolute top-2.5 right-2.5 text-[10px]"
                    style={{
                      background: out ? "var(--ws-dgs)" : low ? "var(--ws-wns)" : "var(--ws-s3)",
                      color: out ? "var(--ws-dg)" : low ? "var(--ws-warn)" : "var(--ws-ts)",
                    }}
                  >
                    {out ? "売切" : "残" + s}
                  </span>
                  <ProductIcon productId={p.id} emoji={p.emoji} imageHash={p.imageHash} size="lg" className="mb-2.5" />
                  <div
                    className="hos-subtitle leading-tight mb-1 flex items-center gap-1"
                    style={{ fontSize: 13, color: low ? "var(--ws-warn)" : "var(--ws-tx)" }}
                  >
                    {p.name}
                    {low && <AlertTriangle size={11} style={{ color: "var(--ws-warn)", flexShrink: 0 }} />}
                  </div>
                  <div className="font-number text-lg font-extrabold" style={{ color: "var(--ws-ac)" }}>
                    {yen(p.price)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Cart Panel */}
        <div className="md:w-[320px]">
          <div className="ws-card p-5 md:sticky md:top-4" style={{ borderWidth: "1.5px" }}>
            <div className="flex items-center mb-4 pb-3.5" style={{ borderBottom: "1.5px solid var(--ws-bd)" }}>
              <Receipt size={15} style={{ color: "var(--ws-or)", marginRight: 8 }} />
              <span className="font-bold text-[13px]" style={{ color: "var(--ws-tx)", fontFamily: "var(--font-heading)" }}>
                カート
              </span>
              {lastOrderNo && (
                <span className="ws-badge ml-auto" title="直前の会計の番号" style={{ background: "var(--ws-ach)", color: "var(--ws-ac)" }}>
                  前回 {orderLabel(lastOrderNo)}
                </span>
              )}
              <span className={`ws-badge ${lastOrderNo ? "ml-1.5" : "ml-auto"}`} style={{ background: "var(--ws-s3)", color: "var(--ws-ts)" }}>
                {cartCount}点
              </span>
            </div>

            {cartItems.length === 0 ? (
              <div className="text-center py-7 text-xs leading-relaxed" style={{ color: "var(--ws-td)" }}>
                商品をタップして追加
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 mb-4 max-h-[280px] overflow-y-auto">
                {cartItems.map((it) => (
                  <div key={it.id} className="flex items-center gap-2 text-xs">
                    <ProductIcon productId={it.id} emoji={it.emoji} imageHash={it.imageHash} size="sm" style={{ fontSize: 13 }} />
                    <span className="flex-1 font-semibold truncate" style={{ color: "var(--ws-tx)" }}>
                      {it.name}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => changeQty(it.id, -1)}
                        className="w-6 h-6 flex items-center justify-center rounded-md"
                        style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
                      >
                        <Minus size={11} />
                      </button>
                      <span className="w-5 text-center font-bold font-number" style={{ color: "var(--ws-tx)" }}>
                        {it.qty}
                      </span>
                      <button
                        onClick={() => changeQty(it.id, 1)}
                        className="w-6 h-6 flex items-center justify-center rounded-md"
                        style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-tx)", cursor: "pointer" }}
                      >
                        <Plus size={11} />
                      </button>
                    </div>
                    <span className="font-number w-[62px] text-right font-bold" style={{ color: "var(--ws-tx)" }}>
                      {yen(it.price * it.qty)}
                    </span>
                    <button onClick={() => removeFromCart(it.id)} style={{ color: "var(--ws-td)", cursor: "pointer", background: "none", border: "none" }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <hr className="ws-sep mb-3.5" />
            <div className="flex justify-between items-end mb-3.5">
              <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>合計</span>
              <span
                className="font-number font-extrabold"
                style={{ fontSize: 36, color: cartCount ? "var(--ws-tx)" : "var(--ws-td)", letterSpacing: "-1px" }}
              >
                {yen(cartTotal)}
              </span>
            </div>
            <button
              onClick={() => setShowCheckout(true)}
              disabled={!cartCount}
              className="w-full flex items-center justify-center gap-1.5 rounded-[10px] font-bold text-sm"
              style={{
                background: "var(--ws-sc)",
                color: "#fff",
                padding: "14px",
                opacity: cartCount ? 1 : 0.4,
                cursor: cartCount ? "pointer" : "not-allowed",
                border: "none",
              }}
            >
              <Coins size={17} />
              会計へ進む
            </button>
          </div>
        </div>
      </div>

      {/* Checkout Modal */}
      {showCheckout && (
        <CheckoutModal
          cartItems={cartItems}
          cartTotal={cartTotal}
          paymentConfig={paymentConfigQuery.data}
          isAdmin={isAdmin}
          coins={coins}
          onConfirm={handleCheckoutConfirm}
          onClose={() => setShowCheckout(false)}
          submitting={createTx.isPending}
        />
      )}
    </div>
  );
}
