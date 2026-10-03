import { useMemo, useState } from "react";
import { X, Check, Loader2, AlertTriangle, ExternalLink, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessage";
import ProductIcon from "./ProductIcon";
import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHOD_STYLE,
  PAYMENT_STATUS_STYLE,
  isCashless,
  isTerminalPaymentStatus,
  type PaymentConfig,
  type PaymentMethod,
} from "@shared/paymentTypes";
import { DENOMINATIONS, DENOMINATION_LABEL, changeToGive, type CoinEstimate } from "@shared/cash";
import SheetOverlay from "./SheetOverlay";

const yen = (n: number) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

interface CartItem {
  id: number;
  name: string;
  emoji: string;
  imageHash?: string | null;
  price: number;
  qty: number;
}

export type ConfirmPayload = {
  received: number;
  paymentMethod: PaymentMethod;
  paymentId?: number;
};

interface Props {
  cartItems: CartItem[];
  cartTotal: number;
  paymentConfig?: PaymentConfig;
  isAdmin: boolean;
  onConfirm: (payload: ConfirmPayload) => void;
  onClose: () => void;
  submitting?: boolean;
  origin?: { x: number; y: number };
  /** Estimated contents of the box, to say which notes/coins to hand back. */
  coins?: CoinEstimate;
}

export default function CheckoutModal({
  cartItems,
  cartTotal,
  paymentConfig,
  isAdmin,
  onConfirm,
  onClose,
  submitting,
  origin,
  coins,
}: Props) {
  const [received, setReceived] = useState("");
  const [method, setMethod] = useState<PaymentMethod>(DEFAULT_PAYMENT_METHOD);
  const [paymentId, setPaymentId] = useState<number | null>(null);
  // Slip / approval number from the card reader's receipt. Required
  // before a terminal payment can be reported as approved — it is the
  // only thing tying this sale to a line in the payment company's 入金明細.
  const [slipRef, setSlipRef] = useState("");

  // Whole yen only: the field accepts digits alone, so the change shown is
  // exactly the change the server records (it floors any fraction; showing
  // a rounded figure could hand over ¥1 more than was booked).
  const rec = Math.floor(Number(received)) || 0;
  const enough = rec >= cartTotal;
  const changeAmt = rec - cartTotal;
  // Which notes and coins make up the change, counted out of what the box
  // should hold once the customer's money is in it (largest first, smaller
  // coins when a larger one has run out) — so a new cashier doesn't have
  // to work out ¥900 at the counter, and a shortage shows before it bites.
  const give = useMemo(() => changeToGive(coins, rec, cartTotal), [coins, rec, cartTotal]);

  const cashless = isCashless(method);
  const methods = paymentConfig?.methods ?? [DEFAULT_PAYMENT_METHOD];
  const showMethodPicker = (paymentConfig?.cashlessEnabled ?? false) && methods.length > 1;

  const createIntent = trpc.payment.createIntent.useMutation();
  const cancelPayment = trpc.payment.cancel.useMutation();
  const confirmManual = trpc.payment.confirmManual.useMutation();
  const reportTerminal = trpc.payment.reportTerminalResult.useMutation();

  // Polls while the customer is paying. Webhooks are the fast path, but
  // this POS runs on venue wifi — the register asks rather than waiting
  // to be told. Polling stops as soon as the payment reaches a state it
  // will never leave.
  const paymentQuery = trpc.payment.get.useQuery(
    { paymentId: paymentId ?? 0 },
    {
      enabled: paymentId != null,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        if (status && isTerminalPaymentStatus(status)) return false;
        return 2000;
      },
    }
  );

  const payment = paymentQuery.data;
  const paid = payment?.status === "completed";
  const paymentFailed = payment != null && isTerminalPaymentStatus(payment.status) && !paid;

  const busy =
    submitting ||
    createIntent.isPending ||
    cancelPayment.isPending ||
    confirmManual.isPending ||
    reportTerminal.isPending;

  const isTerminal = payment?.presentation.kind === "terminal";

  const handleStartPayment = async () => {
    try {
      const intent = await createIntent.mutateAsync({
        method,
        items: cartItems.map((it) => ({ product_id: it.id, qty: it.qty })),
      });
      setPaymentId(intent.paymentId);
    } catch (e) {
      toast.error(getErrorMessage(e, "決済を開始できませんでした"));
    }
  };

  const handleCancelPayment = async () => {
    if (paymentId == null) return;
    try {
      await cancelPayment.mutateAsync({ paymentId });
      setPaymentId(null);
      setSlipRef("");
      toast.success("決済を取り消しました");
    } catch (e) {
      toast.error(getErrorMessage(e, "決済を取り消せませんでした"));
    }
  };

  // Hands off to the payment company's own app. Whether it comes back to
  // us automatically depends on that provider supporting a return URL —
  // many do not, so the cashier reporting the result below is the path
  // that always works.
  const handleLaunchTerminal = () => {
    const launchUrl = payment?.presentation.launchUrl;
    if (!launchUrl) return;
    window.location.href = launchUrl;
  };

  const handleReportTerminal = async (approved: boolean) => {
    if (paymentId == null) return;
    if (approved && !slipRef.trim()) {
      toast.error("伝票番号（承認番号）を入力してください");
      return;
    }
    if (!approved && !confirm("この決済を「失敗」として記録しますか？")) return;
    try {
      await reportTerminal.mutateAsync({
        paymentId,
        approved,
        providerRef: approved ? slipRef.trim() : undefined,
        errorMessage: approved ? undefined : "決済端末で承認されませんでした",
      });
      await paymentQuery.refetch();
    } catch (e) {
      toast.error(getErrorMessage(e, "決済結果を記録できませんでした"));
    }
  };

  const handleConfirmManual = async () => {
    if (paymentId == null) return;
    if (!confirm("お客様の「支払い完了」画面を確認しましたか？\n確認せずに確定すると、入金のない売上が記録されます。")) return;
    try {
      await confirmManual.mutateAsync({ paymentId });
      await paymentQuery.refetch();
    } catch (e) {
      toast.error(getErrorMessage(e, "決済を確定できませんでした"));
    }
  };

  // Closing with money already taken but no sale recorded is the one way
  // this screen can lose a transaction, so it needs saying out loud
  // rather than silently discarding the payment.
  const handleClose = () => {
    if (paid) {
      if (!confirm("お客様の支払いは完了しています。\n会計を記録せずに閉じると、この入金は売上に反映されません。\n本当に閉じますか？")) return;
      onClose();
      return;
    }
    if (paymentId != null && payment && !isTerminalPaymentStatus(payment.status)) {
      void handleCancelPayment();
    }
    onClose();
  };

  const handleSwitchMethod = (next: PaymentMethod) => {
    // A payment in flight belongs to the method that opened it; switching
    // away has to abandon it rather than leave it hanging at the provider.
    if (paymentId != null && !paid) void handleCancelPayment();
    if (paid) return;
    setMethod(next);
    setPaymentId(null);
    setSlipRef("");
  };

  const canConfirm = cashless ? paid && !busy : enough && !busy;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(
      cashless
        ? { received: cartTotal, paymentMethod: method, paymentId: paymentId ?? undefined }
        : { received: rec, paymentMethod: DEFAULT_PAYMENT_METHOD }
    );
  };

  return (
    <SheetOverlay>
      <div
        className="relative ws-sheet-pop ws-glass-sheet w-full md:max-w-[30rem] max-h-[92vh] overflow-y-auto rounded-t-[28px] md:rounded-[28px] p-6"
        style={{
          transformOrigin: origin ? `${origin.x}px ${origin.y}px` : "center",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-extrabold" style={{ color: "var(--ws-tx)", fontFamily: "var(--font-heading)" }}>
            お会計
          </h3>
          <button
            onClick={handleClose}
            className="flex items-center justify-center rounded-lg p-[7px]"
            style={{ border: "1.5px solid var(--ws-bd)", background: "transparent", color: "var(--ws-ts)", cursor: "pointer" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Items */}
        <div className="rounded-[10px] p-3.5 mb-4" style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)" }}>
          {cartItems.map((it) => (
            <div key={it.id} className="flex justify-between text-[13px] py-0.5">
              <span style={{ color: "var(--ws-ts)" }}>
                <ProductIcon productId={it.id} emoji={it.emoji} imageHash={it.imageHash} size="xs" /> {it.name} ×{it.qty}
              </span>
              <span className="font-number font-bold" style={{ color: "var(--ws-tx)" }}>
                {yen(it.price * it.qty)}
              </span>
            </div>
          ))}
        </div>

        {/* Payment method picker — hidden entirely when this deployment
            is cash only, so the cash flow looks exactly as it always did. */}
        {showMethodPicker && (
          <div className="mb-4">
            <label className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>支払い方法</label>
            <div className="grid grid-cols-3 gap-[7px] mt-2">
              {methods.map((m) => {
                const style = PAYMENT_METHOD_STYLE[m];
                const active = m === method;
                return (
                  <button
                    key={m}
                    onClick={() => handleSwitchMethod(m)}
                    disabled={busy || (paid && m !== method)}
                    className="flex items-center justify-center gap-1 rounded-lg py-2.5 text-[11px] font-bold"
                    style={{
                      background: active ? style.bg : "var(--ws-s3)",
                      color: active ? style.color : "var(--ws-ts)",
                      border: active ? `1.5px solid ${style.color}` : "1.5px solid var(--ws-bd)",
                      cursor: busy || (paid && m !== method) ? "not-allowed" : "pointer",
                      opacity: paid && m !== method ? 0.4 : 1,
                    }}
                  >
                    <span>{style.emoji}</span>
                    {style.short}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Total */}
        <div className="rounded-xl p-4 mb-4" style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)" }}>
          <div className="flex justify-between items-end" style={{ marginBottom: cashless ? 0 : "0.875rem" }}>
            <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>合計</span>
            <span className="font-number" style={{ fontSize: 40, fontWeight: 800, color: "var(--ws-tx)", letterSpacing: "-1.5px" }}>
              {yen(cartTotal)}
            </span>
          </div>

          {/* Cash: amount received + quick buttons (unchanged) */}
          {!cashless && (
            <>
              <label className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>預かり金額</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={received}
                onChange={(e) => setReceived(e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, ""))}
                placeholder="0"
                className="ws-input font-number mt-2"
                style={{ fontSize: 30, fontWeight: 800, textAlign: "right", padding: "13px 16px" }}
                autoFocus
              />
              <div className="grid grid-cols-4 gap-[7px] mt-2.5">
                <button
                  onClick={() => setReceived(String(cartTotal))}
                  className="flex items-center justify-center rounded-lg py-2 text-[11px] font-bold"
                  style={{ background: "var(--ws-sc)", color: "#fff", border: "none", cursor: "pointer" }}
                >
                  ちょうど
                </button>
                {[1000, 5000, 10000].map((v) => (
                  <button
                    key={v}
                    onClick={() => setReceived(String(v))}
                    className="flex items-center justify-center rounded-lg py-2 text-[11px] font-bold font-number"
                    style={{ background: "var(--ws-s3)", border: "1.5px solid var(--ws-bd)", color: "var(--ws-ts)", cursor: "pointer" }}
                  >
                    {yen(v)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Cash: change due */}
        {!cashless && (
          <div className="flex justify-between items-end mb-4">
            <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>お釣り</span>
            {enough ? (
              <span className="font-number" style={{ fontSize: 42, fontWeight: 800, color: "var(--ws-sc)", letterSpacing: "-1.5px" }}>
                {yen(changeAmt)}
              </span>
            ) : (
              <span className="font-number text-base font-bold" style={{ color: "var(--ws-dg)" }}>
                不足 {yen(cartTotal - rec)}
              </span>
            )}
          </div>
        )}
        {!cashless && enough && changeAmt > 0 && (
          <div className="-mt-2 mb-4">
            <div className="flex flex-wrap justify-end gap-1.5" aria-label="お釣りの渡し方">
              {DENOMINATIONS.filter((d) => give.given[`${d}`]).map((d) => (
                <span
                  key={d}
                  className="px-2.5 py-1 rounded-full text-[12px] font-bold"
                  style={{ background: "var(--ws-scg)", color: "var(--ws-sc)" }}
                >
                  {DENOMINATION_LABEL[d]} <span className="font-number">×{give.given[`${d}`]}</span>
                </span>
              ))}
            </div>
            {give.short > 0 && (
              <p className="flex items-start justify-end gap-1 text-[11px] font-bold mt-1.5 text-right" style={{ color: "var(--ws-dg)" }}>
                <AlertTriangle size={12} className="flex-shrink-0 mt-px" />
                レジの中の硬貨では {yen(give.short)} 分足りない見込みです。本部で両替してください。
              </p>
            )}
          </div>
        )}

        {/* Cashless flow */}
        {cashless && (
          <div className="mb-4">
            {paymentId == null ? (
              <button
                onClick={handleStartPayment}
                disabled={busy}
                className="w-full flex items-center justify-center gap-1.5 rounded-[10px] font-bold text-[15px]"
                style={{
                  background: PAYMENT_METHOD_STYLE[method].bg,
                  color: PAYMENT_METHOD_STYLE[method].color,
                  border: `1.5px solid ${PAYMENT_METHOD_STYLE[method].color}`,
                  padding: 15,
                  opacity: busy ? 0.5 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {createIntent.isPending ? <Loader2 size={18} className="animate-spin" /> : <span>{PAYMENT_METHOD_STYLE[method].emoji}</span>}
                {PAYMENT_METHOD_STYLE[method].label}で支払う
              </button>
            ) : (
              <div className="rounded-xl p-4" style={{ background: "var(--ws-s2)", border: "1.5px solid var(--ws-bd)" }}>
                {/* Status */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold" style={{ color: "var(--ws-ts)" }}>決済状況</span>
                  {payment ? (
                    <span
                      className="ws-badge"
                      style={{
                        background: PAYMENT_STATUS_STYLE[payment.status].bg,
                        color: PAYMENT_STATUS_STYLE[payment.status].color,
                      }}
                    >
                      {PAYMENT_STATUS_STYLE[payment.status].label}
                    </span>
                  ) : (
                    <Loader2 size={14} className="animate-spin" style={{ color: "var(--ws-ts)" }} />
                  )}
                </div>

                {/* Cashier instructions from the provider */}
                {payment?.presentation.message && (
                  <p className="text-[12px] leading-relaxed mb-3" style={{ color: "var(--ws-ts)" }}>
                    {payment.presentation.message}
                  </p>
                )}

                {/* Where the customer actually pays. A QR image would need
                    an extra dependency, so the payload is shown as
                    selectable text until a provider that needs it is
                    wired up — see docs/cashless-payment.md. */}
                {payment?.presentation.redirectUrl && (
                  <a
                    href={payment.presentation.redirectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full flex items-center justify-center gap-1.5 rounded-[10px] font-bold text-[13px] mb-2"
                    style={{ background: "var(--ws-s3)", color: "var(--ws-ac)", border: "1.5px solid var(--ws-bd)", padding: 11, textDecoration: "none" }}
                  >
                    <ExternalLink size={15} />
                    決済ページを開く
                  </a>
                )}
                {payment?.presentation.qrCodeData && (
                  <div
                    className="rounded-lg p-2.5 mb-2 text-[10px] break-all font-mono"
                    style={{ background: "var(--ws-s3)", color: "var(--ws-ts)", border: "1px solid var(--ws-bd)", userSelect: "all" }}
                  >
                    {payment.presentation.qrCodeData}
                  </div>
                )}

                {/* App-to-app terminal (Airペイ / Square / stera 型).
                    There is no server API to ask, so the register hands
                    off to the payment app and then records what the
                    reader decided. The slip number is mandatory on
                    approval so the sale can be matched against the
                    payment company's 入金明細 at settlement. */}
                {isTerminal && !isTerminalPaymentStatus(payment?.status ?? "pending") && (
                  <div className="mt-1">
                    {payment?.presentation.launchUrl && (
                      <button
                        onClick={handleLaunchTerminal}
                        className="w-full flex items-center justify-center gap-1.5 rounded-[10px] font-bold text-[13px] mb-2.5"
                        style={{ background: "var(--ws-ac)", color: "#fff", border: "none", padding: 12, cursor: "pointer" }}
                      >
                        <ExternalLink size={15} />
                        決済アプリを開く
                      </button>
                    )}
                    <label className="text-[11px] font-bold" style={{ color: "var(--ws-ts)" }}>
                      伝票番号（承認番号）
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={slipRef}
                      onChange={(e) => setSlipRef(e.target.value)}
                      placeholder="レシートに印字された番号"
                      className="ws-input mt-1.5"
                      style={{ fontSize: 15, padding: "10px 12px" }}
                    />
                    <div className="flex gap-2 mt-2.5">
                      <button
                        onClick={() => handleReportTerminal(true)}
                        disabled={busy}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-bold"
                        style={{ background: "var(--ws-sc)", color: "#fff", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}
                      >
                        <Check size={14} />
                        承認された
                      </button>
                      <button
                        onClick={() => handleReportTerminal(false)}
                        disabled={busy}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-bold"
                        style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}
                      >
                        <X size={14} />
                        失敗した
                      </button>
                    </div>
                  </div>
                )}

                {paid && (
                  <div className="mb-1">
                    <div className="flex items-center gap-2 text-[13px] font-bold" style={{ color: "var(--ws-sc)" }}>
                      <Check size={16} />
                      支払いを確認しました
                    </div>
                    {payment?.providerRef && (
                      <div className="hos-caption mt-1">伝票番号 {payment.providerRef}</div>
                    )}
                  </div>
                )}

                {paymentFailed && (
                  <div className="flex items-center gap-2 text-[13px] font-bold mb-1" style={{ color: "var(--ws-dg)" }}>
                    <AlertTriangle size={16} />
                    {payment?.errorMessage || "決済は完了しませんでした"}
                  </div>
                )}

                {/* Actions while a payment is open. Terminal providers
                    have their own approved/failed pair above, so only the
                    cancel button is relevant here for them. */}
                {!isTerminalPaymentStatus(payment?.status ?? "pending") && (
                  <div className="flex gap-2 mt-3">
                    {paymentConfig?.manualConfirmation && isAdmin && (
                      <button
                        onClick={handleConfirmManual}
                        disabled={busy}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-bold"
                        style={{ background: "var(--ws-sc)", color: "#fff", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}
                      >
                        <Check size={14} />
                        支払い確認済み
                      </button>
                    )}
                    <button
                      onClick={handleCancelPayment}
                      disabled={busy}
                      className="flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-bold"
                      style={{ background: "var(--ws-dgs)", color: "var(--ws-dg)", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}
                    >
                      <X size={14} />
                      決済を取消
                    </button>
                  </div>
                )}

                {/* A failed/expired payment is a dead end — offer a retry
                    rather than making the cashier close and re-open. */}
                {paymentFailed && (
                  <button
                    onClick={() => {
                      setPaymentId(null);
                      setSlipRef("");
                    }}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[12px] font-bold mt-3"
                    style={{ background: "var(--ws-s3)", color: "var(--ws-tx)", border: "1.5px solid var(--ws-bd)", cursor: "pointer" }}
                  >
                    <RotateCcw size={14} />
                    もう一度試す
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          className="w-full flex items-center justify-center gap-1.5 rounded-[10px] font-bold text-[15px]"
          style={{
            background: "var(--ws-sc)",
            color: "#fff",
            padding: 15,
            opacity: canConfirm ? 1 : 0.4,
            cursor: canConfirm ? "pointer" : "not-allowed",
            border: "none",
          }}
        >
          <Check size={18} />
          {submitting ? "処理中..." : cashless && !paid ? "支払い待ち..." : "会計を確定する"}
        </button>
      </div>
    </SheetOverlay>
  );
}
