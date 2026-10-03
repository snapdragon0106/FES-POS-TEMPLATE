/**
 * Cashless payment — shared vocabulary between client and server.
 *
 * Nothing here talks to a payment company. This file only fixes the
 * *names* both sides agree on (which methods exist, which states a
 * payment can be in) so that plugging in a real provider later is a
 * server-side change, not a rename that ripples through the UI.
 *
 * Design rule for everything payment-related in this repo: cash must
 * keep behaving exactly as it did before cashless existed. "cash" is
 * therefore a first-class PaymentMethod and the default everywhere, so
 * a transaction that never mentions payment at all still means cash.
 */

export const PAYMENT_METHODS = [
  "cash",
  "paypay",
  "credit",
  "transport_ic",
  "other_qr",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEFAULT_PAYMENT_METHOD: PaymentMethod = "cash";

export const PAYMENT_METHOD_STYLE: Record<
  PaymentMethod,
  {
    /** Full label, used in dialogs and the history list. */
    label: string;
    /** Short label for tight spots (badges, CSV, segmented control). */
    short: string;
    emoji: string;
    /** CSS custom properties so badges follow the light/dark theme. */
    color: string;
    bg: string;
  }
> = {
  cash: { label: "現金", short: "現金", emoji: "💴", color: "var(--ws-sc)", bg: "var(--ws-scg)" },
  paypay: { label: "PayPay", short: "PayPay", emoji: "📱", color: "var(--ws-dg)", bg: "var(--ws-dgs)" },
  credit: { label: "クレジットカード", short: "カード", emoji: "💳", color: "var(--ws-ac)", bg: "var(--ws-s3)" },
  transport_ic: { label: "交通系IC", short: "IC", emoji: "🚃", color: "var(--ws-or)", bg: "var(--ws-org)" },
  other_qr: { label: "その他QR決済", short: "QR", emoji: "🔳", color: "var(--ws-warn)", bg: "var(--ws-wns)" },
};

/** Everything except cash needs a provider round-trip before the sale is real. */
export function isCashless(method: PaymentMethod): boolean {
  return method !== "cash";
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * Reads a transaction's stored payment method. Rows written before
 * cashless existed have no paymentMethod at all, and those sales were
 * cash by definition — so an absent value is not "unknown", it is cash.
 */
export function paymentMethodOf(value: unknown): PaymentMethod {
  return isPaymentMethod(value) ? value : DEFAULT_PAYMENT_METHOD;
}

/**
 * Payment lifecycle.
 *
 * - pending    … created at the provider, waiting for the customer to pay
 * - authorized … funds held but not captured (providers that separate the two)
 * - completed  … money is ours; only now may a transaction be recorded
 * - failed     … the provider rejected it
 * - canceled   … we or the customer gave up before it completed
 * - expired    … the provider's QR / session timed out
 * - refunded   … completed, then returned (mirrors a voided transaction)
 */
export const PAYMENT_STATUSES = [
  "pending",
  "authorized",
  "completed",
  "failed",
  "canceled",
  "expired",
  "refunded",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** States the provider will never move away from on its own. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "completed",
  "failed",
  "canceled",
  "expired",
  "refunded",
];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export const PAYMENT_STATUS_STYLE: Record<
  PaymentStatus,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "支払い待ち", color: "var(--ws-warn)", bg: "var(--ws-wns)" },
  authorized: { label: "承認済み", color: "var(--ws-ac)", bg: "var(--ws-s3)" },
  completed: { label: "支払い完了", color: "var(--ws-sc)", bg: "var(--ws-scg)" },
  failed: { label: "支払い失敗", color: "var(--ws-dg)", bg: "var(--ws-dgs)" },
  canceled: { label: "取消", color: "var(--ws-ts)", bg: "var(--ws-s3)" },
  expired: { label: "期限切れ", color: "var(--ws-ts)", bg: "var(--ws-s3)" },
  refunded: { label: "返金済み", color: "var(--ws-or)", bg: "var(--ws-org)" },
};

/**
 * How the cashier is supposed to get the customer to pay. Which one a
 * provider returns depends entirely on that provider's integration
 * style — and Japanese 決済代行 services split cleanly into two camps:
 *
 * - qr_code   … show `qrCodeData` to the customer to scan (server API)
 * - redirect  … open `redirectUrl` on a phone (server API)
 * - terminal  … a card/IC reader does the work. The POS hands off to the
 *               provider's own app via `launchUrl` (app-to-app) and is
 *               told the result afterwards. This is the Airペイ / Square /
 *               stera / PAYGATE shape: there is no server-side API for
 *               the POS to call, and therefore no webhook either.
 * - manual    … no integration at all: the payment happens on separate
 *               hardware or a printed QR, and the cashier confirms by eye
 */
export const PAYMENT_PRESENTATION_KINDS = ["qr_code", "redirect", "terminal", "manual"] as const;

export type PaymentPresentationKind = (typeof PAYMENT_PRESENTATION_KINDS)[number];

export type PaymentPresentation = {
  kind: PaymentPresentationKind;
  /** Payload to encode into a QR image (kind: "qr_code"). */
  qrCodeData?: string;
  /** URL to open, typically on the customer's phone (kind: "redirect"). */
  redirectUrl?: string;
  /** App deep link, when the provider offers one alongside the URL. */
  deepLink?: string;
  /**
   * URL scheme / intent that hands off to the payment app on the same
   * device (kind: "terminal"), with the amount already filled in.
   */
  launchUrl?: string;
  /** Japanese instruction shown to the cashier. Always safe to display. */
  message?: string;
};

/**
 * What the register reports back after a terminal payment.
 *
 * Unlike a webhook this is NOT cryptographically verifiable — it is the
 * cashier's own device saying the reader approved the payment. That is
 * unavoidable for terminal integrations (no server API exists to ask),
 * so the design compensates by demanding a slip reference and recording
 * who reported it, making every such sale checkable against the payment
 * company's own 入金明細 afterwards.
 */
export type TerminalResultReport = {
  approved: boolean;
  /** Slip / approval number printed on the receipt. Required when approved. */
  providerRef?: string;
  /** Provider's machine id for the payment, when the app returns one. */
  providerPaymentId?: string;
  /** Reason shown to the cashier when the reader declined. */
  errorMessage?: string;
};

/** Public (non-secret) description of what this deployment can accept. */
export type PaymentConfig = {
  /** false when no provider is configured — the UI then hides cashless entirely. */
  cashlessEnabled: boolean;
  /** Provider id, e.g. "manual" / "terminal" / "mock". null when cashless is off. */
  provider: string | null;
  providerLabel: string | null;
  /** Methods the cashier may choose. Always contains "cash". */
  methods: PaymentMethod[];
  /** True when the cashier confirms payment by eye rather than an API callback. */
  manualConfirmation: boolean;
  /**
   * True for app-to-app terminal providers: the register launches the
   * payment app and then reports the result back itself.
   */
  terminalReporting: boolean;
};
