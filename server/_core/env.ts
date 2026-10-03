// JWT_SECRET signs every POS session token (server/posAuth.ts getSecret()).
// If it were ever unset, the signing key would silently collapse to a
// short fixed string that's plainly visible in this public repository —
// letting anyone forge a valid admin session offline with no PIN at all.
// Failing loudly at boot is far better than an app that "works" on a
// guessable key: this is confirmed set in the Render deployment already,
// so this check should never actually fire there.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET is missing or too short (must be at least 32 characters). " +
    "It signs every POS session token — refusing to start with a weak or " +
    "absent value rather than silently falling back to an insecure default."
  );
}

export const ENV = {
  cookieSecret: process.env.JWT_SECRET,
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // ===== Cashless payments (server/payments/) =====
  // Empty = cash only, which is the default and keeps the POS behaving
  // exactly as it did before cashless support existed. See
  // docs/cashless-payment.md for the full list of accepted values.
  paymentProvider: process.env.PAYMENT_PROVIDER ?? "",
  // Optional comma-separated subset of the provider's methods, e.g.
  // "paypay,transport_ic". Empty means "everything the provider offers".
  paymentMethods: process.env.PAYMENT_METHODS ?? "",
  // Shared secret the provider signs its webhooks with. Without it the
  // webhook endpoint refuses every request rather than trusting unsigned
  // callbacks — an unauthenticated "payment completed" POST would
  // otherwise let anyone mark a sale as paid.
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? "",

  // ===== PAYMENT_PROVIDER=terminal only (app-to-app card readers) =====
  // URL scheme that opens the payment company's app with the amount
  // filled in. Get the exact parameter names from that company's
  // 連携仕様書 — they differ per service and cannot be guessed.
  paymentTerminalLaunchUrl: process.env.PAYMENT_TERMINAL_LAUNCH_URL ?? "",
  paymentTerminalCallbackUrl: process.env.PAYMENT_TERMINAL_CALLBACK_URL ?? "",
  paymentTerminalLabel: process.env.PAYMENT_TERMINAL_LABEL ?? "",
};
