import { randomUUID } from "crypto";
import type { PaymentMethod } from "@shared/paymentTypes";
import type { CreatePaymentInput, PaymentProvider, ProviderPayment } from "../types";

/**
 * "Manual" provider — no API, no key, no integration of any kind. The
 * payment happens outside this POS and a human confirms the result.
 *
 * Two real situations use this, and the second one matters more than it
 * first looks:
 *
 *  1. A printed PayPay / d払い store QR taped to the counter. The
 *     customer scans it, types the amount, and shows their "支払い完了"
 *     screen.
 *  2. **A 決済代行 terminal running standalone** — an Airペイ iPad, a
 *     Square reader, a stera terminal — sitting beside the register on
 *     its own. The card is charged over there and the cashier reads the
 *     approved slip. This is the fallback whenever app-to-app is not
 *     available: a different device, a different OS, or the provider's
 *     外部連携 simply not being open to us. Plenty of real shops run
 *     exactly like this.
 *
 * Everything downstream — the sale, the stock, the till reconciliation —
 * is identical to a fully integrated payment; only the confirmation is
 * human. Because of that, `confirmManual` is admin-only in the router and
 * lands in the activity log in a warning colour.
 */

const MANUAL_METHODS: readonly PaymentMethod[] = ["paypay", "other_qr", "credit", "transport_ic"];

export function createManualProvider(options?: {
  methods?: readonly PaymentMethod[];
  /** Shown to the cashier verbatim; override per shop if the QR differs. */
  instruction?: string;
}): PaymentProvider {
  const methods = options?.methods?.length ? options.methods : MANUAL_METHODS;
  const instruction =
    options?.instruction ??
    "レジ横のQRコード、または決済端末でお支払いいただき、「支払い完了」画面または承認済みの伝票を確認してから確定してください。";

  return {
    id: "manual",
    label: "手動確認（店頭QR・据置端末）",
    methods,
    capabilities: {
      webhook: false,
      polling: false,
      cancel: true,
      manualConfirmation: true,
      terminalReporting: false,
    },

    async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
      return {
        // Prefixed so a manual record is obvious at a glance in the DB
        // and can never collide with a real provider's id space.
        providerPaymentId: `manual_${randomUUID()}`,
        status: "pending",
        amount: input.amount,
        presentation: {
          kind: "manual",
          message: instruction,
        },
      };
    },

    // There is nothing to ask: the database row *is* the state of a
    // manual payment. Returning null tells the caller to keep using it.
    async getPayment(): Promise<ProviderPayment | null> {
      return null;
    },

    async cancelPayment(providerPaymentId: string): Promise<ProviderPayment> {
      return {
        providerPaymentId,
        status: "canceled",
        amount: 0,
        presentation: { kind: "manual" },
      };
    },
  };
}
