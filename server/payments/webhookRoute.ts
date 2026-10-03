import express, { type Express } from "express";
import { getPaymentProvider } from "./registry";
import { applyWebhookEvent } from "./service";

/**
 * POST /api/payments/webhook/:provider
 *
 * Where a payment provider tells us a payment settled. Three things about
 * this endpoint are deliberate:
 *
 *  1. It is registered BEFORE the global express.json() middleware and
 *     uses express.raw(). Signatures are computed over the exact bytes
 *     the provider sent; parsing and re-serialising JSON changes those
 *     bytes (key order, spacing, unicode escapes) and breaks verification
 *     in ways that are miserable to debug.
 *  2. It is unauthenticated by necessity — the provider has no POS
 *     session — so the signature IS the authentication. No signature
 *     support, or no configured secret, means the endpoint refuses
 *     everything rather than trusting a bare POST that claims a sale was
 *     paid.
 *  3. It answers 200 for events it has already applied. Providers retry
 *     on any non-2xx, and a duplicate delivery is normal traffic, not an
 *     error.
 */
export function registerPaymentWebhook(app: Express): void {
  app.post(
    "/api/payments/webhook/:provider",
    // Checked before reading the body: with no provider configured (the
    // default) anyone could otherwise make the server buffer a megabyte
    // per request just to be told 404.
    (req, res, next) => {
      const provider = getPaymentProvider();
      if (!provider || provider.id !== req.params.provider || !provider.capabilities.webhook || !provider.verifyWebhook) {
        res.status(404).json({ error: "not found" });
        return;
      }
      next();
    },
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req, res) => {
      const requestedProvider = req.params.provider;
      const provider = getPaymentProvider();

      // Same generic reply for "no provider", "wrong provider" and "this
      // provider has no webhooks": an unauthenticated caller learns
      // nothing about how this deployment is configured.
      if (!provider || provider.id !== requestedProvider || !provider.capabilities.webhook || !provider.verifyWebhook) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      if (rawBody.length === 0) {
        res.status(400).json({ error: "empty body" });
        return;
      }

      let event;
      try {
        event = await provider.verifyWebhook(rawBody, req.headers);
      } catch (error) {
        // A provider that throws here is a bug in that provider, not a
        // reason to accept an unverified event.
        console.error(`[Payments] webhook verification threw for ${provider.id}:`, error);
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      if (!event) {
        console.warn(`[Payments] rejected an unverified webhook for ${provider.id}`);
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      try {
        const result = await applyWebhookEvent(provider.id, event);
        if (!result.handled) {
          // 404 rather than 200: the provider should stop retrying an
          // event for a payment this deployment has never heard of.
          res.status(404).json({ error: result.reason ?? "unknown payment" });
          return;
        }
        res.status(200).json({ ok: true });
      } catch (error) {
        console.error("[Payments] failed to apply webhook event:", error);
        // 500 asks the provider to retry — the event was genuine, we just
        // could not record it (e.g. the database blinked).
        res.status(500).json({ error: "internal error" });
      }
    }
  );
}
