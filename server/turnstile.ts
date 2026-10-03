/**
 * Cloudflare Turnstile on the two forms an outsider can reach: the 合言葉
 * form and the PIN form. It is a check that the form was filled in by a
 * person in a real browser, on top of the rate limits (server/rateLimiter.ts):
 * those cap how fast anyone can guess, this makes a script pay for every
 * single guess.
 *
 * Off unless both keys are set (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY,
 * Render's Environment). Off, the pages are exactly as before — no
 * Cloudflare script, same CSP. Setting only one key refuses to start
 * (server/_core/env.ts), so a half-done setup is caught at deploy time.
 *
 * On, the page loads Cloudflare's script, which draws the widget and puts
 * a token in the form (cf-turnstile-response). The server asks Cloudflare
 * whether the token is genuine (siteverify) before it even looks at the
 * 合言葉 or PIN. Tokens are single-use and expire after 5 minutes.
 *
 * If Cloudflare can't be reached, the form is refused (fail closed): an
 * answer we couldn't check is not a yes. Phones already logged in are not
 * affected — Turnstile is only at login, and a session renews itself while
 * in use. To switch it off in an emergency, delete the two keys on Render
 * (docs/runbook).
 */

const SCRIPT_ORIGIN = "https://challenges.cloudflare.com";
const SITEVERIFY_URL = `${SCRIPT_ORIGIN}/turnstile/v0/siteverify`;
// Cloudflare's tokens are at most 2048 characters.
const MAX_TOKEN_LENGTH = 2048;
const VERIFY_TIMEOUT_MS = 8000;

/** Which form a token was made for (the widget's data-action), so one can't stand in for the other. */
export type TurnstileAction = "gate" | "login";

type Keys = { siteKey: string; secretKey: string };

function keys(): Keys | null {
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  return siteKey && secretKey ? { siteKey, secretKey } : null;
}

export function turnstileEnabled(): boolean {
  return keys() !== null;
}

/** Throws when only one of the two keys is set (checked at boot). */
export function assertTurnstileConfig(): void {
  const site = !!process.env.TURNSTILE_SITE_KEY?.trim();
  const secret = !!process.env.TURNSTILE_SECRET_KEY?.trim();
  if (site !== secret) {
    throw new Error(
      "Turnstile is half configured: set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither."
    );
  }
}

/**
 * The widget for a form, or "" when Turnstile is off. The script tag comes
 * with the page (server/pages.ts). Light or dark like the page (the app's
 * own setting, not the phone's).
 */
export function turnstileWidget(action: TurnstileAction, dark: boolean): string {
  const k = keys();
  if (!k) return "";
  const attr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<div class="cf-turnstile" data-sitekey="${attr(k.siteKey)}" data-action="${action}" data-language="ja" data-theme="${dark ? "dark" : "light"}" data-size="flexible"></div>`;
}

/** Script tag and the CSP additions a page with the widget needs. */
export const TURNSTILE_SCRIPT = `<script src="${SCRIPT_ORIGIN}/turnstile/v0/api.js" async defer></script>`;
export const TURNSTILE_CSP = { script: SCRIPT_ORIGIN, frame: SCRIPT_ORIGIN };

export type TurnstileResult =
  | { ok: true }
  /** No token, a token that isn't genuine, expired, reused, or made for another form. */
  | { ok: false; reason: "failed" }
  /** Cloudflare didn't answer (network, timeout, 5xx). */
  | { ok: false; reason: "unavailable" };

/** What the pages say when the check didn't pass. */
export const TURNSTILE_MESSAGE = {
  bot: "確認が完了しませんでした。画面の確認が済んでから、もう一度お試しください",
  unavailable: "確認サービスにつながりませんでした。少し待ってからもう一度お試しください",
} as const;

/** The ?e= code a failed check redirects with. */
export const turnstileErrorCode = (r: Exclude<TurnstileResult, { ok: true }>) => (r.reason === "unavailable" ? "unavailable" : "bot");

/**
 * Asks Cloudflare whether the token from a form is genuine and was made for
 * this form. Always ok when Turnstile is off.
 */
export async function verifyTurnstile(body: unknown, action: TurnstileAction): Promise<TurnstileResult> {
  const k = keys();
  if (!k) return { ok: true };
  const token = (body as Record<string, unknown> | undefined)?.["cf-turnstile-response"];
  // Nothing to ask Cloudflare about: don't spend a request on it.
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "failed" };

  let data: { success?: unknown; action?: unknown; "error-codes"?: unknown };
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: k.secretKey, response: token }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[Turnstile] siteverify answered ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    data = await res.json();
  } catch (err) {
    console.error("[Turnstile] siteverify unreachable:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "unavailable" };
  }

  if (data.success !== true) {
    console.warn("[Turnstile] rejected:", JSON.stringify(data["error-codes"] ?? []));
    return { ok: false, reason: "failed" };
  }
  // Cloudflare's test keys answer without an action; a real key always
  // echoes the widget's data-action.
  if (typeof data.action === "string" && data.action !== "" && data.action !== action) {
    console.warn(`[Turnstile] token made for "${data.action}", used on "${action}"`);
    return { ok: false, reason: "failed" };
  }
  return { ok: true };
}
