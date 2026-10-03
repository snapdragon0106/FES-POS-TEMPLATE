import type {
  PaymentMethod,
  PaymentPresentation,
  PaymentStatus,
} from "@shared/paymentTypes";

/**
 * The contract every payment provider implements.
 *
 * The point of this file is that `server/routers.ts` never learns which
 * payment company we signed with. Adding PayPay / Stripe / Square later
 * means writing one file under `providers/`, registering it, and setting
 * an environment variable — no changes to the checkout flow, the DB
 * layer, or the UI.
 *
 * Money is always an integer number of yen. JPY has no minor unit, so
 * there is no cents/円 conversion anywhere in this codebase; if a
 * provider's API wants the smallest currency unit, convert inside that
 * provider only.
 */

export type PaymentAmount = number;

export type CreatePaymentInput = {
  /** Integer yen. Already recomputed from the product master by the caller. */
  amount: PaymentAmount;
  method: PaymentMethod;
  /**
   * Our own unique reference for this attempt. Pass it to the provider as
   * their idempotency / merchant-order key so that a retried request
   * cannot charge the customer twice.
   */
  orderRef: string;
  /** Human-readable summary shown in the provider's app: the shop's name (POS_SHOP_NAME). */
  description: string;
  items: { name: string; qty: number; unitPrice: PaymentAmount }[];
  /** Roster ID of the cashier, for the provider's metadata / our support. */
  operatorId: string;
};

export type ProviderPayment = {
  /** The provider's own id for this payment. Unique per provider. */
  providerPaymentId: string;
  status: PaymentStatus;
  amount: PaymentAmount;
  presentation: PaymentPresentation;
  /** When the provider's QR / session stops being valid, if it says. */
  expiresAt?: Date;
  /**
   * Whatever the provider sent back, stored verbatim for support and
   * reconciliation. Never rendered into the UI without escaping, and
   * never trusted for amounts — those come from `amount` above.
   */
  raw?: unknown;
};

export type PaymentWebhookEvent = {
  providerPaymentId: string;
  status: PaymentStatus;
  /**
   * Amount as the provider reports it. The caller compares this against
   * the amount we stored; a mismatch is treated as tampering and the
   * payment is not marked completed.
   */
  amount?: PaymentAmount;
  raw?: unknown;
};

export type ProviderCapabilities = {
  /** The provider POSTs status changes to /api/payments/webhook/<id>. */
  webhook: boolean;
  /** getPayment() actually asks the provider; false means it's a local read. */
  polling: boolean;
  /** cancelPayment() is implemented. */
  cancel: boolean;
  /**
   * True when there is no API to confirm against and the cashier decides
   * (a printed QR taped to the counter). Enables payment.confirmManual,
   * which is admin-gated precisely because it books money on trust.
   */
  manualConfirmation: boolean;
  /**
   * True for app-to-app terminal integrations (Airペイ, Square, stera,
   * PAYGATE …): the register launches the provider's app, the card
   * reader does the work, and the register reports the outcome back.
   * Enables payment.reportTerminalResult.
   */
  terminalReporting: boolean;
};

export interface PaymentProvider {
  /** Stable id used in env vars, the webhook URL and the DB. */
  readonly id: string;
  /** Japanese label shown in the admin UI. */
  readonly label: string;
  /** Cashless methods this provider can accept ("cash" is never listed). */
  readonly methods: readonly PaymentMethod[];
  readonly capabilities: ProviderCapabilities;

  /** Start a payment. Throws on provider/network failure. */
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;

  /**
   * Current state of a payment. For providers without polling this may
   * just echo what we already know — the caller treats the DB as the
   * source of truth in that case.
   */
  getPayment(providerPaymentId: string): Promise<ProviderPayment | null>;

  /** Abandon a pending payment. Only called when capabilities.cancel. */
  cancelPayment?(providerPaymentId: string): Promise<ProviderPayment>;

  /**
   * Verify a webhook's signature and parse it. MUST return null (never
   * throw, never guess) when the signature does not check out — the route
   * turns null into a 401 and changes nothing. Only called when
   * capabilities.webhook.
   *
   * `rawBody` is the untouched request body: signatures are computed over
   * exact bytes, so the webhook route deliberately skips JSON parsing.
   */
  verifyWebhook?(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<PaymentWebhookEvent | null>;
}

/** Thrown by providers for errors worth showing the cashier verbatim. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
