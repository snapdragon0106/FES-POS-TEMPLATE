import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { accessCodeMatches } from "./roster";
import { createGateToken, ensureDevice, readDevice, setGateCookie, verifyGate, verifyPosSession } from "./posAuth";
import { checkRateLimit, getClientIp, recordFailure, recordSuccess } from "./rateLimiter";
import { ICONS, escapeHtml, isDark, isSameOriginPost, redirect, sendNotFound, sendPage } from "./pages";
import { handleLoginPost, sendLoginPage } from "./login";
import { TURNSTILE_MESSAGE, turnstileEnabled, turnstileErrorCode, turnstileWidget, verifyTurnstile } from "./turnstile";

/**
 * Who gets what, decided by the server from the cookies — never by the
 * app reading a response:
 *
 *   no 合言葉 cookie        → the 合言葉 page, and nothing else
 *   合言葉, not logged in   → the login page (server/login.ts)
 *   logged in (session)     → the app (HTML, JS/CSS bundle)
 *
 * All three are at "/" — the pages have no URL of their own, and before
 * logging in every /api/ path answers 404 (hideApiWithoutSession), so an
 * outsider finds nothing to look at beyond the 合言葉 form. (They used to
 * be /api/gate and /api/login, and the login URL was found from outside.)
 *
 * Before, the 合言葉 and login screens were part of the React app: every
 * visitor downloaded the whole app, and the app decided what to show from
 * responses like {"verified":false} or {"exists":false} — change one of
 * those to true in transit and the next screen appeared. Now a browser
 * that isn't logged in never receives the app at all.
 *
 * There is no service worker to answer "/" from a cache (see
 * server/serviceWorker.ts), so the server always decides.
 */

// Served to anyone: robots.txt, the icons (the 合言葉 page shows one, the
// browser asks for the favicon on its own), theme.css (the 合言葉 / login
// pages' look — colours and glass, minified with no comments at build
// time) and the manifest — a browser
// fetches the manifest without cookies, so behind the 合言葉 "Add to Home
// Screen" would get a 404. /sw.js is answered before this (server/serviceWorker.ts).
const PUBLIC_FILES = new Set([
  "/robots.txt",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  "/theme.css",
]);
const isPublicFile = (path: string) => PUBLIC_FILES.has(path);

type GateError = { kind: "wrong" } | { kind: "bot" } | { kind: "unavailable" } | { kind: "limit"; seconds: number };

// Per sender: 5 wrong answers → 5 minutes. Shop-wide: 30 wrong answers in
// 15 minutes → 10 minutes. The sender is the device cookie if there is one
// (server/posAuth.ts), else the IP from x-forwarded-for, which a script can
// fake on every request; the shop-wide limit it can't, so guessing the
// 合言葉 stays at a few hundred tries an hour at most.
// The shop-wide lock only holds back devices that have never entered the
// 合言葉: with it, anyone could type 30 wrong answers from fake IPs and
// keep every classmate out — including after the 合言葉 is changed, when
// everyone has to enter the new one. A device that has entered it before
// (it has the device cookie) keeps its own 5-in-5-minutes limit only.
const GLOBAL_KEY = "accesscode:*";
const GLOBAL_POLICY = { maxAttempts: 30, lockoutMs: 10 * 60 * 1000 };

function gateForm(error: GateError | null, widget: string): string {
  const message =
    error?.kind === "wrong"
      ? "合言葉が違います"
      : error?.kind === "bot" || error?.kind === "unavailable"
        ? TURNSTILE_MESSAGE[error.kind]
        : error?.kind === "limit"
          ? `試行回数が多すぎます。${error.seconds}秒後にもう一度お試しください`
          : "";
  return `<form class="ws-card" method="post" action="/">
    <label class="field-label hos-caption" for="code">${ICONS.shield}合言葉</label>
    <input id="code" name="code" type="text" class="ws-input big" placeholder="合言葉を入力" autocomplete="off" autofocus required maxlength="100">
    ${widget}
    <button class="btn" type="submit">入場する</button>
    ${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ""}
    <p class="hint hos-caption">クラスメンバーに共有された合言葉を入力してください</p>
  </form>`;
}

/** The 合言葉 page (shown at "/" to a browser without the gate cookie). */
export function sendGatePage(req: Request, res: Response): void {
  const e = req.query.e;
  const seconds = Number(req.query.s);
  const error: GateError | null =
    e === "wrong" || e === "bot" || e === "unavailable"
      ? { kind: e }
      : e === "limit" && Number.isInteger(seconds) && seconds > 0 && seconds <= 3600
        ? { kind: "limit", seconds }
        : null;
  sendPage(res, 200, gateForm(error, turnstileWidget("gate", isDark(req))), { turnstile: turnstileEnabled() });
}

/** A 合言葉 submitted to "/" by a browser without the gate cookie. */
export async function handleGatePost(req: Request, res: Response): Promise<void> {
  const device = await readDevice(req);
  const rateLimitKey = device ? `accesscode:dev:${device.did}` : `accesscode:${getClientIp(req)}`;
  for (const key of device ? [rateLimitKey] : [rateLimitKey, GLOBAL_KEY]) {
    const limit = checkRateLimit(key);
    if (!limit.allowed) {
      redirect(res, 303, `/?e=limit&s=${limit.retryAfterSeconds}`);
      return;
    }
  }
  // A person in a real browser first (server/turnstile.ts), before the
  // 合言葉 is even looked at. Not counted as a wrong 合言葉: it says
  // nothing about the answer, and a flaky connection shouldn't lock anyone out.
  const human = await verifyTurnstile(req.body, "gate");
  if (!human.ok) {
    redirect(res, 303, `/?e=${turnstileErrorCode(human)}`);
    return;
  }
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (code && accessCodeMatches(code)) {
    recordSuccess(rateLimitKey);
    setGateCookie(res, req, await createGateToken());
    await ensureDevice(req, res);
    redirect(res, 303, "/");
    return;
  }
  recordFailure(rateLimitKey);
  // Devices that have been in before don't count toward (or wait for) the shop-wide lock.
  if (!device) recordFailure(GLOBAL_KEY, GLOBAL_POLICY);
  redirect(res, 303, "/?e=wrong");
}

/**
 * Both forms post to "/". Which one this is — 合言葉 or login — is
 * decided by the cookie, not by anything in the form.
 */
export function registerEntry(app: Express): void {
  // 8kb: the Turnstile token alone can be 2,048 characters.
  app.post("/", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isSameOriginPost(req)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    if (await verifyGate(req)) await handleLoginPost(req, res);
    else await handleGatePost(req, res);
  });
}

/** The same answer as for a path that doesn't exist (server/pages.ts). */
export function notFoundApi(_req: Request, res: Response): void {
  sendNotFound(res);
}

/**
 * In front of /api/* (all but the health check and payment webhooks):
 * without a logged-in session, every API path answers exactly like one
 * that doesn't exist. Nothing before login uses the API — the 合言葉 and
 * login pages are plain forms posting to "/" — so someone who has only
 * the 合言葉 (or nothing) can't even tell there is an API, let alone list
 * its procedures. (It used to open for the 合言葉 cookie alone.) The app
 * reads this 404 as "the session is gone" and goes back to "/" (main.tsx).
 */
export async function hideApiWithoutSession(req: Request, res: Response, next: NextFunction) {
  if (await verifyPosSession(req)) return next();
  sendNotFound(res);
}

/**
 * In front of /api/trpc (after hideApiWithoutSession): the API only for the
 * app itself. Every change (a POST) must be JSON from a page on this site.
 * tRPC also accepts multipart forms, so a form on another site could
 * otherwise run the procedures that take no input (logout, and once the
 * full reset) with the register's cookie. SameSite=Lax already stops that
 * today — onrender.com is on the Public Suffix List — but that would
 * change with a custom domain whose other subdomains someone else runs.
 * And no answer is kept by the browser or a proxy: they hold names and sales.
 */
export function guardApi(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST") {
    const json = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";
    // Browsers send Sec-Fetch-Site (or at least Origin) on every POST; a
    // request with neither isn't from a browser, so it carries no victim's cookie.
    const site = req.headers["sec-fetch-site"];
    const sameSite = typeof site === "string" ? site === "same-origin" : isSameOriginPost(req);
    if (!json || !sameSite) {
      res.status(403).type("application/json").send('{"error":"forbidden"}');
      return;
    }
  }
  next();
}

/**
 * In front of the static files / SPA fallback. The app — index.html, the
 * bundle, every in-app path — only for a logged-in session. Otherwise a
 * page request goes to the login page (合言葉 already entered) or the
 * 合言葉 page, and any other file is 404.
 */
export async function requireLoginForApp(req: Request, res: Response, next: NextFunction) {
  // The only non-GET request the site answers outside /api is the form
  // post to "/", handled before this (registerEntry). Anything else —
  // PUT /, POST /pos, OPTIONS … — used to fall through to the static
  // fallback and get the app's index.html, logged in or not.
  if (req.method !== "GET" && req.method !== "HEAD") return sendNotFound(res);
  if (req.path.startsWith("/api/") || isPublicFile(req.path)) return next();
  if (await verifyPosSession(req)) return next();
  res.setHeader("Cache-Control", "no-store");
  const accept = req.headers.accept ?? "";
  if (req.path === "/") {
    if (await verifyGate(req)) await sendLoginPage(req, res);
    else sendGatePage(req, res);
  } else if (accept.includes("text/html")) {
    redirect(res, 302, "/");
  } else {
    sendNotFound(res);
  }
}
