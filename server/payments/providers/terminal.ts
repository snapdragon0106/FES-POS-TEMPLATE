import { randomUUID } from "crypto";
import type { PaymentMethod } from "@shared/paymentTypes";
import { isPaymentMethod } from "@shared/paymentTypes";
import type { CreatePaymentInput, PaymentProvider, ProviderPayment } from "../types";

/**
 * Generic app-to-app terminal provider.
 *
 * This is the shape most Japanese 決済代行 services actually take at a
 * counter — Airペイ, Square, stera pack, スマレジ・PAYGATE. There is no
 * server-side REST API for a third-party POS to call and no webhook to
 * receive. Instead:
 *
 *   1. the POS opens the provider's own app via a URL scheme, passing
 *      the amount and an order reference,
 *   2. the card reader takes the payment,
 *   3. the provider's app returns to the POS with the result.
 *
 * Because the whole exchange happens on the cashier's device, the result
 * arrives as a client report rather than a signed server callback — see
 * `terminalReporting` in types.ts for what that costs and how the rest of
 * the system compensates (a slip reference is mandatory, and every report
 * is attributed in the activity log).
 *
 * The URL template is configuration rather than code, so wiring up a real
 * service is an environment variable, not a new file — as long as its
 * scheme follows the usual "amount + order id + callback" pattern. Get
 * the exact parameter names from that provider's 連携仕様書; they are not
 * guessable and differ between services.
 */

export type TerminalProviderConfig = {
  /** Provider id. Kept as "terminal" unless a dedicated file is written. */
  id?: string;
  label?: string;
  methods?: readonly PaymentMethod[];
  /**
   * URL scheme template. These placeholders are substituted, each
   * URL-encoded:
   *   {amount}   … integer yen
   *   {orderRef} … our unique reference for this attempt
   *   {callback} … callbackUrl below
   * e.g. "examplepay://payment?amount={amount}&orderId={orderRef}&callback={callback}"
   */
  launchUrlTemplate: string;
  /** Where the provider's app should return. Usually this POS's origin. */
  callbackUrl?: string;
  instruction?: string;
};

const TERMINAL_METHODS: readonly PaymentMethod[] = ["credit", "transport_ic", "paypay", "other_qr"];

function buildLaunchUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{(amount|orderRef|callback)\}/g, (_match, key: string) =>
    encodeURIComponent(values[key] ?? "")
  );
}

export function parseMethodList(raw: string): PaymentMethod[] {
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = parsed.filter((m) => !isPaymentMethod(m));
  if (unknown.length > 0) {
    throw new Error(`未知の支払い方法が指定されています: ${unknown.join(", ")}`);
  }
  return parsed.filter(isPaymentMethod);
}

export function createTerminalProvider(config: TerminalProviderConfig): PaymentProvider {
  if (!config.launchUrlTemplate) {
    // Without this the register would show a "端末で支払う" button that
    // opens nothing, and the cashier would find out at the counter.
    throw new Error(
      "PAYMENT_TERMINAL_LAUNCH_URL が設定されていません（決済アプリを起動するURLスキームが必要です）"
    );
  }

  const methods = config.methods?.length ? config.methods : TERMINAL_METHODS;
  const instruction =
    config.instruction ??
    "決済アプリが開きます。カードまたは交通系ICをお預かりして読み取り、完了したらレジに戻ってきてください。";

  return {
    id: config.id ?? "terminal",
    label: config.label ?? "決済端末（アプリ連携）",
    methods,
    capabilities: {
      // No server API exists on this side of the integration: nothing
      // to receive, nothing to poll, nothing to cancel remotely. The
      // cashier cancels on the terminal itself.
      webhook: false,
      polling: false,
      cancel: true,
      manualConfirmation: false,
      terminalReporting: true,
    },

    async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
      const launchUrl = buildLaunchUrl(config.launchUrlTemplate, {
        amount: String(input.amount),
        orderRef: input.orderRef,
        callback: config.callbackUrl ?? "",
      });

      return {
        // Deliberately blank: the provider's id (if it returns one at
        // all) is only known once the reader reports back. Inventing a
        // placeholder here would make reconciliation against the
        // 入金明細 match on a value that means nothing.
        providerPaymentId: "",
        status: "pending",
        amount: input.amount,
        presentation: {
          kind: "terminal",
          launchUrl,
          message: instruction,
        },
        raw: { orderRef: input.orderRef, localRef: randomUUID() },
      };
    },

    // Nothing to ask — the terminal is the authority and it only speaks
    // to us through the report the register sends after the fact.
    async getPayment(): Promise<ProviderPayment | null> {
      return null;
    },

    async cancelPayment(providerPaymentId: string): Promise<ProviderPayment> {
      return {
        providerPaymentId,
        status: "canceled",
        amount: 0,
        presentation: { kind: "terminal" },
      };
    },
  };
}
