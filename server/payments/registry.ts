import { DEFAULT_PAYMENT_METHOD, isPaymentMethod } from "@shared/paymentTypes";
import type { PaymentConfig, PaymentMethod } from "@shared/paymentTypes";
import { ENV } from "../_core/env";
import type { PaymentProvider } from "./types";
import { createManualProvider } from "./providers/manual";
import { createMockProvider } from "./providers/mock";
import { createTerminalProvider } from "./providers/terminal";

/**
 * Chooses the payment provider from the environment, once per boot.
 *
 * Adding a real provider is three lines here plus one file under
 * `providers/`; nothing else in the codebase needs to know it exists.
 *
 * PAYMENT_PROVIDER unset (the default, and what production runs today)
 * means cash only — every cashless code path stays dormant and the UI
 * doesn't even render the method picker.
 */

const KNOWN_PROVIDERS = ["manual", "terminal", "mock"] as const;

function build(id: string): PaymentProvider | null {
  switch (id) {
    case "manual":
      return createManualProvider();
    case "terminal":
      return createTerminalProvider({
        label: ENV.paymentTerminalLabel || undefined,
        launchUrlTemplate: ENV.paymentTerminalLaunchUrl,
        callbackUrl: ENV.paymentTerminalCallbackUrl || undefined,
      });
    case "mock":
      return createMockProvider({ webhookSecret: ENV.paymentWebhookSecret });
    default:
      return null;
  }
}

let resolved: { provider: PaymentProvider | null } | null = null;

export function getPaymentProvider(): PaymentProvider | null {
  if (resolved) return resolved.provider;

  const id = ENV.paymentProvider.trim();
  if (!id) {
    resolved = { provider: null };
    return null;
  }

  // A typo in PAYMENT_PROVIDER would otherwise silently fall back to
  // cash-only — the shop would find out mid-festival, at the register,
  // with a queue waiting. Fail at boot instead, same reasoning as the
  // JWT_SECRET check in _core/env.ts.
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(id)) {
    throw new Error(
      `PAYMENT_PROVIDER="${id}" は未知の決済プロバイダです。` +
        `使用可能: ${KNOWN_PROVIDERS.join(", ")}（未設定なら現金のみ）`
    );
  }

  // The mock provider reports payments as completed without any money
  // changing hands. On a system that handles real sales, that is a
  // silent till shortage waiting to happen.
  if (id === "mock" && ENV.isProduction) {
    throw new Error(
      "PAYMENT_PROVIDER=mock は本番環境では使用できません（実際には入金されていない決済を「完了」として記録してしまいます）"
    );
  }

  const provider = build(id);
  resolved = { provider };
  return provider;
}

/**
 * Cashless methods the cashier may actually pick: what the provider
 * supports, optionally narrowed by PAYMENT_METHODS. Never includes cash —
 * cash needs no provider and is added separately by getPaymentConfig.
 */
export function getEnabledCashlessMethods(): PaymentMethod[] {
  const provider = getPaymentProvider();
  if (!provider) return [];

  const supported = provider.methods.filter((m) => m !== DEFAULT_PAYMENT_METHOD);

  const requested = ENV.paymentMethods
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) return [...supported];

  const unknown = requested.filter((m) => !isPaymentMethod(m));
  if (unknown.length > 0) {
    throw new Error(
      `PAYMENT_METHODS に未知の支払い方法が含まれています: ${unknown.join(", ")}`
    );
  }

  // Intersection, keeping the provider's ordering so the UI is stable.
  return supported.filter((m) => requested.includes(m));
}

/** Non-secret summary handed to the client so it can build the UI. */
export function getPaymentConfig(): PaymentConfig {
  const provider = getPaymentProvider();
  const cashless = getEnabledCashlessMethods();
  return {
    cashlessEnabled: !!provider && cashless.length > 0,
    provider: provider?.id ?? null,
    providerLabel: provider?.label ?? null,
    // Cash is always offered, even with a provider configured: card
    // readers fail, phones run out of battery, and the shop must never
    // be unable to take money.
    methods: [DEFAULT_PAYMENT_METHOD, ...cashless],
    manualConfirmation: provider?.capabilities.manualConfirmation ?? false,
    terminalReporting: provider?.capabilities.terminalReporting ?? false,
  };
}

/** Test-only: forget the memoized provider so env changes take effect. */
export function resetPaymentProviderCache(): void {
  resolved = null;
}
