/**
 * Cashless payments. See docs/cashless-payment.md for how to plug in a
 * real provider; the short version is: write one file under `providers/`,
 * add it to the switch in `registry.ts`, set PAYMENT_PROVIDER.
 */
export type {
  CreatePaymentInput,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderCapabilities,
  ProviderPayment,
} from "./types";
export { PaymentProviderError } from "./types";

export {
  getEnabledCashlessMethods,
  getPaymentConfig,
  getPaymentProvider,
  resetPaymentProviderCache,
} from "./registry";

export {
  applyWebhookEvent,
  cancelPayment,
  confirmManualPayment,
  getPaymentStatus,
  getReservedStock,
  priceCart,
  reportTerminalResult,
  startPayment,
  stockSnapshot,
  type PaymentView,
} from "./service";

export { registerPaymentWebhook } from "./webhookRoute";
