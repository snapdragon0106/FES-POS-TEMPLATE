import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { Request, Response } from "express";
import { TURNSTILE_CSP, TURNSTILE_SCRIPT } from "./turnstile";

/**
 * The pages a browser sees before it is allowed the app: the 合言葉 page
 * (server/gate.ts) and the login page (server/login.ts). Plain HTML forms
 * rendered by the server — none of our own script — so every decision
 * about who gets in is made here, from the cookies, and there is no
 * response a client could edit to let itself through. The one script a
 * page may carry is Cloudflare's Turnstile widget, when it is switched on
 * (server/turnstile.ts); it only adds a token to the form, which the
 * server checks with Cloudflare.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Icons (lucide, the app's icon set) inline: the pages load no script and
// no image besides the logo emoji.
const svg = (body: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  key: svg('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>'),
  back: svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
};

/**
 * A 4-digit PIN field drawn as the app's four PIN boxes, without script:
 * one real input over four decorative boxes, its characters spaced one
 * box apart (monospace, letter-spacing = box + gap - 1ch) so each dot
 * sits in its box.
 */
export function pinField(name: string, label: string, autofocus: boolean): string {
  return `<label class="field-label center hos-caption" for="${name}">${ICONS.key}${escapeHtml(label)}</label>
    <div class="pin">
      <div class="boxes" aria-hidden="true"><span class="ws-pin-box"></span><span class="ws-pin-box"></span><span class="ws-pin-box"></span><span class="ws-pin-box"></span></div>
      <input id="${name}" name="${name}" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required${autofocus ? " autofocus" : ""}>
    </div>`;
}

// Layout for these two pages only; the look (colours, glass, background,
// type, inputs, PIN boxes) is /theme.css, the same file the app uses.
// (No comments inside: this text is sent to every visitor.)
//
// Narrow phones (360px wide is common on Android) get less margin so the
// card's inside stays at least 300px, the width Cloudflare's Turnstile
// widget needs. It was 267px there: the widget stuck out, and focusing the
// PIN scrolled the card sideways, pushing everything left (.ws-card is
// overflow: clip now, which can't be scrolled at all). The PIN input is
// 286px — wide enough that the 4th digit's letter-spacing doesn't scroll it,
// narrow enough to stay inside the card.
const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font-family: var(--font-body); color: var(--ws-tx); }
  main { width: 100%; max-width: 380px; }
  .brand { text-align: center; margin-bottom: 28px; }
  .logo { width: 56px; height: 56px; font-size: 26px; margin: 0 auto 12px;
          background: radial-gradient(circle at 32% 28%, var(--ws-secc) 0%, var(--ws-secc-deep) 100%); color: var(--ws-onsecc); }
  .brand h1 { font-size: 20px; margin: 0; }
  .brand p { margin: 4px 0 0; }
  form.ws-card, div.ws-card { display: block; padding: 28px; }
  .field-label { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
  .field-label.center { justify-content: center; margin-bottom: 12px; }
  .field-label + .field-label, .pin + .field-label, .ws-input + .field-label { margin-top: 20px; }
  .big { font-family: var(--font-body); font-size: 20px; font-weight: 700; text-align: center; padding: 14px 16px; }
  .num { font-family: var(--font-display); font-size: 32px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .num::placeholder { font-size: 20px; font-weight: 700; }
  .btn { width: 100%; margin-top: 14px; padding: 14px; border: none; border-radius: 9999px; background: var(--ws-ac); color: #fff;
         font-family: var(--font-body); font-weight: 700; font-size: 15px; cursor: pointer;
         transition: transform 0.2s var(--ease-spring), opacity 0.25s var(--ease-smooth); }
  .btn:active { transform: scale(0.96); }
  .pin + .btn { margin-top: 20px; }
  .back { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ws-ts); text-decoration: none; margin-bottom: 16px; }
  .who { text-align: center; font-family: var(--font-heading); font-weight: 600; font-size: 13px; margin: 0 0 20px; }
  .note { text-align: center; font-size: 11px; font-weight: 700; color: var(--ws-ac); margin: -14px 0 20px; line-height: 1.6; }
  .note.warn { color: var(--ws-warn); }
  .code { text-align: center; font-family: var(--font-heading); font-size: 32px; font-weight: 800; letter-spacing: 8px; margin: 2px 0 8px; color: var(--ws-tx); }
  .hint a { color: var(--ws-ac); font-weight: 700; }
  .err { text-align: center; font-size: 12px; font-weight: 700; color: var(--ws-dg); margin: 12px 0 0; line-height: 1.6; }
  .hint { text-align: center; margin: 10px 0 0; }
  .pin { position: relative; width: 246px; height: 54px; margin: 0 auto; }
  .pin .boxes { position: absolute; inset: 0; display: flex; gap: 10px; pointer-events: none; }
  .pin .ws-pin-box { flex: none; }
  .pin:focus-within .ws-pin-box { border-color: var(--ws-ac); box-shadow: 0 0 0 3px var(--ws-ach); }
  .pin input { position: absolute; top: 0; left: 0; height: 54px; width: 286px; margin: 0; border: 0; outline: none; background: transparent;
               color: var(--ws-ac); caret-color: transparent; font: 700 26px/54px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
               letter-spacing: calc(64px - 1ch); padding: 0 0 0 calc((54px - 1ch) / 2); }
  @media (max-width: 400px) { body { padding: 16px 12px; } form.ws-card, div.ws-card { padding: 22px 18px; } }
`;

// Cache-buster for /theme.css: a hash of its content, so it changes exactly
// when the file does. (It used to be the server's start time, which told
// anyone who opened the 合言葉 page when the site was last deployed.)
let themeVersion: string | null = null;
function getThemeVersion(): string {
  if (themeVersion) return themeVersion;
  const candidates = [
    path.resolve(import.meta.dirname, "public", "theme.css"), // production: dist/index.js next to dist/public
    path.resolve(process.cwd(), "client", "public", "theme.css"), // dev and tests
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  themeVersion = file ? createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 10) : "0";
  return themeVersion;
}

/** Same buckets as the app's inline script in index.html, on Japan time. */
function daytime(): string {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Tokyo" }).format(new Date()));
  return h < 6 ? "night" : h < 11 ? "morning" : h < 17 ? "day" : h < 21 ? "evening" : "night";
}

/** The app's light/dark choice lives in localStorage; it mirrors it into this cookie for these pages. */
export function isDark(req: Request | undefined): boolean {
  return /(?:^|;\s*)pos_theme=dark(?:;|$)/.test(req?.headers.cookie ?? "");
}

// Only on a page that carries the widget: with Turnstile off, the pages don't mention it.
const TURNSTILE_STYLE = `
  .cf-turnstile { margin-top: 20px; min-height: 65px; }
  .cf-turnstile + .btn { margin-top: 12px; }
  @media (max-width: 339px) { .cf-turnstile { margin-left: -18px; margin-right: -18px; } }
`;

/** `subtitle`: the line under the title (the shop's name on the login page). */
type PageOptions = { turnstile?: boolean; subtitle?: string };

/** A complete page: title block + the form body given. */
export function renderPage(formHtml: string, req?: Request, opts: PageOptions = {}): string {
  return `<!doctype html>
<html lang="ja"${isDark(req) ? ' class="dark"' : ""} data-daytime="${daytime()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#051733">
<title>FES POS</title>
<link rel="icon" type="image/png" href="/favicon-32x32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/theme.css?v=${getThemeVersion()}">
<style>${STYLE}${opts.turnstile ? TURNSTILE_STYLE : ""}</style>${opts.turnstile ? `\n${TURNSTILE_SCRIPT}` : ""}
</head>
<body>
<main class="ws-fade">
  <div class="brand">
    <div class="ws-icon-chip logo" aria-hidden="true">🏪</div>
    <h1 class="hos-title">FES POS</h1>
    <p class="hos-caption">${escapeHtml(opts.subtitle || "文化祭 物販管理システム")}</p>
  </div>
  ${formHtml}
</main>
</body>
</html>`;
}

/**
 * Sends a page. `turnstile` when the form carries the widget: only then may
 * the page load a script, and only Cloudflare's (plus its frame).
 */
export function sendPage(res: Response, status: number, formHtml: string, opts: PageOptions = {}): void {
  res.setHeader("Cache-Control", "no-store");
  // None of our own script; styles only from here and Google Fonts.
  const turnstile = opts.turnstile ? ` script-src ${TURNSTILE_CSP.script}; frame-src ${TURNSTILE_CSP.frame};` : "";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none';${turnstile} style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
  );
  res.status(status).type("html").send(renderPage(formHtml, res.req, opts));
}

/**
 * A redirect with nothing in it but the Location header. Express's own
 * res.redirect() adds a body ("Found. Redirecting to /") that says which
 * framework is answering; this says nothing.
 */
export function redirect(res: Response, status: 302 | 303, location: string): void {
  res.status(status).setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

/**
 * The one answer for anything that isn't there (or isn't for this
 * visitor): the same status, type and body whatever the path, method or
 * reason, so the answers don't map out how the site is built. JSON because
 * the app reads a 404 from /api as "the session is gone" (main.tsx).
 */
export const NOT_FOUND_BODY = '{"error":"not found"}';
export function sendNotFound(res: Response): void {
  res.status(404).setHeader("Cache-Control", "no-store");
  res.type("application/json").send(NOT_FOUND_BODY);
}

/**
 * Form posts must come from this site's own pages. The cookies are
 * SameSite=Lax (not sent on another site's POST) already; this is the
 * second lock on the same door.
 *
 * Sec-Fetch-Site is set by the browser itself and can't be changed by a
 * page, so it is checked first. Origin is the fallback for browsers that
 * don't send it. (With Referrer-Policy: no-referrer, browsers send
 * "Origin: null" even for a same-site form — which is why the policy is
 * same-origin, see securityHeaders in _core/index.ts.)
 */
export function isSameOriginPost(req: Request): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (!origin) return true; // very old browsers omit both headers
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // "null" and garbage
  }
}
