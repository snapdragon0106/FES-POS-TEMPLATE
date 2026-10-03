import "dotenv/config";
import express from "express";
import compression from "compression";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { assertRosterConfigured } from "../roster";
import { assertTurnstileConfig } from "../turnstile";
import { assertRecoveryConfig } from "../adminRecovery";
import { hashLegacyPins, loadRevocations } from "../posAuth";
import { getPaymentConfig, registerPaymentWebhook } from "../payments";
import { registerHealthCheck } from "../health";
import { getDb } from "../db";
import { guardApi, hideApiWithoutSession, notFoundApi, registerEntry, requireLoginForApp } from "../gate";
import { NOT_FOUND_BODY } from "../pages";
import { registerProductImageRoute } from "../productImage";
import { registerServiceWorkerCleanup } from "../serviceWorker";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Headers that keep the app from being embedded, sniffed or indexed.
 * - frame-ancestors / X-Frame-Options: no other site can load the
 *   register inside a frame (clickjacking a cashier into pressing 確定).
 * - X-Robots-Tag: search engines don't index any of it.
 * - Referrer-Policy same-origin: the app's URLs don't leak to other sites
 *   (Google Fonts). Not no-referrer: that makes browsers send
 *   "Origin: null" on our own form posts, which the login check refuses.
 * - HSTS: phones always use https after the first visit.
 */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }
  next();
}

async function startServer() {
  // Refuse to start without the roster / admin IDs / 合言葉 in the
  // environment (server/roster.ts). On Render a failed start leaves the
  // previous version serving, so a missing variable can't take the shop
  // down — it just keeps the old build live until it is set.
  assertRosterConfigured();
  // Both Turnstile keys or neither (server/turnstile.ts).
  assertTurnstileConfig();
  // The admin recovery code, if set, long enough (server/adminRecovery.ts).
  assertRecoveryConfig();

  const app = express();
  app.disable("x-powered-by");
  // No ETag on generated responses: their format (W/"len-hash") names the
  // framework, and nothing here is revalidated anyway (pages are no-store,
  // the bundle is immutable). Static files drop theirs in serveStatic.
  app.set("etag", false);
  const server = createServer(app);

  // Resolve the payment provider before anything can serve traffic: a
  // typo'd PAYMENT_PROVIDER throws here, at boot, instead of at a
  // register with a queue in front of it. Cash-only (the default) logs
  // nothing surprising and costs nothing.
  const paymentConfig = getPaymentConfig();
  console.log(
    paymentConfig.cashlessEnabled
      ? `[Payments] provider="${paymentConfig.provider}" methods=${paymentConfig.methods.join(",")}`
      : "[Payments] cashless disabled (cash only)"
  );

  // gzip every response. Each register polls the full sales list every 8
  // seconds; uncompressed that is ~700 KB per poll at 1,000 sales — about
  // 300 MB an hour per phone, enough to exhaust a student's data plan in a
  // day and to saturate festival Wi-Fi. JSON compresses ~25x. Only touches
  // responses, so it is safe ahead of the raw-body webhook route below.
  app.use(compression());
  app.use(securityHeaders);
  app.get("/robots.txt", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });
  // Public on purpose: removes the service worker older versions left on
  // phones, which otherwise keeps showing them the old app (server/serviceWorker.ts).
  registerServiceWorkerCleanup(app);

  // MUST come before express.json(): webhook signatures are verified over
  // the raw request bytes, and the JSON parser would consume them first.
  registerPaymentWebhook(app);

  registerHealthCheck(app);
  // Past this point, /api/* doesn't exist for anyone who isn't logged in
  // (server/gate.ts). The webhook and health check above stay reachable:
  // a payment provider and the runbook need them without a session.
  app.use("/api", hideApiWithoutSession);
  // The 合言葉 and login forms post to "/" — their own small form parser,
  // so they stay independent of the JSON body limit below.
  registerEntry(app);
  registerProductImageRoute(app);

  // Only JSON from this site, and nothing kept in caches (server/gate.ts).
  app.use("/api/trpc", guardApi);
  // The largest request is a product photo (≤200 KB, ~270 KB as base64).
  app.use(express.json({ limit: "1mb" }));
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // Unexpected failures (DB unreachable, a bug) reach the register only
      // as a generic message — see errorFormatter in trpc.ts — so this is
      // where the real cause is kept: Render's log. Expected, user-facing
      // errors (在庫不足, wrong PIN, …) are not logged; they are not faults.
      onError({ error, path }) {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error(`[tRPC] ${path ?? "(unknown)"} failed:`, error.cause ?? error);
        }
      },
    })
  );
  // Anything else under /api is not a page: answer 404 instead of letting
  // the SPA fallback below return the app's HTML for it.
  app.use("/api", notFoundApi);

  // The app itself (HTML, JS/CSS bundle, every in-app path) only for a
  // logged-in session; everyone else gets the 合言葉 or login page — see
  // server/gate.ts.
  app.use(requireLoginForApp);

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Nothing matched (only reachable if a route above passes a request on):
  // the same 404 as everywhere, not Express's "Cannot POST /x" page.
  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).setHeader("Cache-Control", "no-store");
    res.type("application/json").send(NOT_FOUND_BODY);
  });

  // Last stop for errors nothing else handled — a malformed URL ("/%"),
  // an oversized or broken form body, a bug. Express's default answer is
  // its own HTML error page, which says what the server runs on; this
  // answers like everything else: the one 404 for anything a visitor got
  // wrong, a bare 500 otherwise. The cause goes to Render's log.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    if (status >= 500) console.error(`[Server] ${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return res.end();
    res.setHeader("Cache-Control", "no-store");
    if (status < 500) res.status(404).type("application/json").send(NOT_FOUND_BODY);
    else res.status(500).type("application/json").send('{"error":"server error"}');
  });

 const port = parseInt(process.env.PORT || "3000");
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    // Connect and run the table checks now rather than on the first
    // request, so the first cashier after a deploy doesn't wait for them
    // and /api/health reports "starting" for as short a time as possible.
    // Then what needs the database once: sessions ended before the
    // restart stay ended, and PINs still in plain text get hashed.
    void getDb().then(async (db) => {
      if (!db) return;
      await loadRevocations();
      await hashLegacyPins();
    });
  });
}

startServer().catch((error) => {
  console.error(error);
  // Exit non-zero so Render marks the deploy as failed (and keeps the
  // previous version serving) instead of treating a quiet exit as normal.
  process.exit(1);
});
