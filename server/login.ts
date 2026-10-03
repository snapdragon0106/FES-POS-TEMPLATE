import type { Request, Response } from "express";
import { randomInt } from "crypto";
import * as db from "./db";
import { isAdmin, isMember, memberName } from "./roster";
import {
  createPosSessionToken,
  forgetPinCache,
  hashPin,
  isLegacyPlaintextPin,
  createGateToken,
  readDevice,
  rememberMemberOnDevice,
  setGateCookie,
  setPosSessionCookie,
  verifyPin,
  type DeviceInfo,
} from "./posAuth";
import { checkRateLimit, getClientIp, recordFailure, recordSuccess, type LimitPolicy } from "./rateLimiter";
import { ICONS, escapeHtml, isDark, pinField, redirect, sendPage as sendBarePage } from "./pages";
import { shopName } from "./shop";
import { TURNSTILE_MESSAGE, turnstileEnabled, turnstileErrorCode, turnstileWidget, verifyTurnstile } from "./turnstile";
import { WEAK_PIN_MESSAGE, isWeakPin } from "./pinPolicy";
import { recoveryCodeMatches, recoveryEnabled } from "./adminRecovery";

// Past the 合言葉, the page may say whose shop this is (POS_SHOP_NAME).
const sendPage: typeof sendBarePage = (res, status, html, opts = {}) =>
  sendBarePage(res, status, html, { ...opts, subtitle: shopName() || undefined });

/**
 * The login page, rendered and decided entirely by the server (see the
 * overview in server/gate.ts). Same steps as before — 個人番号, then the
 * PIN (or, the first time, choosing one) — but each step is a page the
 * server builds from what it knows, and a session cookie is the only thing
 * that opens the app. There is no "does this PIN exist?" or "did it
 * work?" answer for a client to read and act on.
 */

// ===== Limits on wrong PINs =====
//
// A 4-digit PIN is 10,000 combinations. Three limits, by where the guess
// comes from (the device cookie, server/posAuth.ts):
//  - this number on this device: 5 wrong → 5 minutes. Only this device:
//    it used to be the number everywhere, so anyone could type 5 wrong
//    PINs for the admin and lock the admin out of their own phone.
//  - this number, from every device that has never logged in as it:
//    10 wrong in an hour (5 for the admin) → an hour. A guesser can make
//    new devices at will (clear the cookies, fake an IP) but can't make
//    one that has logged in as the number.
//  - the whole shop, from such devices: 30 wrong in 15 minutes → 15
//    minutes. Guessing across all 40 numbers used to have no limit at all.
// So a guesser gets at most ~120 tries an hour shop-wide, and the member's
// own phone is never locked by someone else. Every wrong PIN is in the
// activity log (the admin sees how many in the app, POSApp.tsx), every
// lock too, and obvious PINs (1234…) can't be chosen (server/pinPolicy.ts).

const DEVICE_POLICY: LimitPolicy = { maxAttempts: 5, lockoutMs: 5 * 60_000 };
const NEW_DEVICE_POLICY: LimitPolicy = { maxAttempts: 10, lockoutMs: 60 * 60_000, windowMs: 60 * 60_000 };
const NEW_DEVICE_ADMIN_POLICY: LimitPolicy = { maxAttempts: 5, lockoutMs: 60 * 60_000, windowMs: 60 * 60_000 };
const SHOP_POLICY: LimitPolicy = { maxAttempts: 30, lockoutMs: 15 * 60_000, windowMs: 15 * 60_000 };
// First-login requests (each replaces the last): 5 an hour per number.
const REQUEST_POLICY: LimitPolicy = { maxAttempts: 5, lockoutMs: 60 * 60_000, windowMs: 60 * 60_000 };
// Wrong admin recovery codes, shop-wide.
const RECOVER_POLICY: LimitPolicy = { maxAttempts: 5, lockoutMs: 60 * 60_000, windowMs: 60 * 60_000 };
const RECOVER_KEY = "recover:*";

type Limit = { key: string; policy: LimitPolicy; locked: string };

function limitsFor(id: string, deviceKey: string, knownDevice: boolean): Limit[] {
  const limits: Limit[] = [
    { key: `login:${id}:${deviceKey}`, policy: DEVICE_POLICY, locked: "この端末からの入力を5分間停止" },
  ];
  if (!knownDevice) {
    limits.push(
      {
        key: `login:${id}:new`,
        policy: isAdmin(id) ? NEW_DEVICE_ADMIN_POLICY : NEW_DEVICE_POLICY,
        locked: "この番号へのPIN入力を、この番号でログインしたことのない端末から60分間停止",
      },
      { key: "login:*:new", policy: SHOP_POLICY, locked: "ログインしたことのない端末からのPIN入力を、店全体で15分間停止" }
    );
  }
  return limits;
}

function lockedFor(limits: { key: string }[]): number | null {
  let seconds = 0;
  for (const l of limits) {
    const r = checkRateLimit(l.key);
    if (!r.allowed) seconds = Math.max(seconds, r.retryAfterSeconds ?? 1);
  }
  return seconds > 0 ? seconds : null;
}

// Wrong PINs in the last hour, for the admin's warning (pin.alerts).
const ALERT_WINDOW_MS = 60 * 60_000;
const recentFailures: { at: number; id: string }[] = [];

export function loginAlerts(now = Date.now()): { failures: number; adminFailures: number; numbers: number } {
  while (recentFailures.length > 0 && now - recentFailures[0].at > ALERT_WINDOW_MS) recentFailures.shift();
  return {
    failures: recentFailures.length,
    adminFailures: recentFailures.filter((f) => isAdmin(f.id)).length,
    numbers: new Set(recentFailures.map((f) => f.id)).size,
  };
}

const log = (id: string, action: string, detail: string) =>
  db
    .createActivityLog({ operator: id, operatorName: memberName(id), action, detail })
    .catch((err) => console.error("[Login] activity log failed:", err));

const deviceLabel = (device: DeviceInfo | null) => (device ? `端末 ${device.did.slice(0, 6)}` : "端末不明");

async function wrongPin(id: string, device: DeviceInfo | null, knownDevice: boolean, limits: Limit[]): Promise<void> {
  recentFailures.push({ at: Date.now(), id });
  if (recentFailures.length > 1000) recentFailures.shift();
  const locked = limits.filter((l) => recordFailure(l.key, l.policy)).map((l) => l.locked);
  await log(id, "login_failed", `PINの誤り（${deviceLabel(device)}、${knownDevice ? "この番号でログインしたことのある端末" : "この番号で初めての端末"}）`);
  for (const what of locked) await log(id, "login_locked", `${what}（${deviceLabel(device)}）`);
}

/**
 * Shown for a number on the PIN page: enough for the member to see they
 * typed their own number, not enough to read the class list off it by
 * trying every number (they used to be shown in full).
 */
export function maskName(name: string): string {
  return name
    .split(/([\s　]+)/)
    .map((part) => (/^[\s　]+$/.test(part) || part === "" ? part : Array.from(part)[0] + "＊".repeat(Math.max(1, Array.from(part).length - 1))))
    .join("");
}

// The code a first-login request is approved with (pin.approve): letters
// that can't be mistaken for each other or for digits.
const CODE_LETTERS = "ACDEFHJKLMNPRTUVWXY";
const newRequestCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
const isRequestCode = (c: unknown): c is string => typeof c === "string" && /^[ACDEFHJKLMNPRTUVWXY]{4}$/.test(c);

type LoginError =
  | { kind: "id" }
  | { kind: "wrong" }
  | { kind: "format" }
  | { kind: "mismatch" }
  | { kind: "weak" }
  | { kind: "code" }
  | { kind: "pending" }
  | { kind: "bot" }
  | { kind: "unavailable" }
  | { kind: "limit"; seconds: number };

function errorText(e: LoginError | null): string {
  if (!e) return "";
  switch (e.kind) {
    case "id": return "不正な個人番号です";
    case "wrong": return "PINが違います";
    case "format": return "PINは4桁の数字で入力してください";
    case "mismatch": return "PINが一致しません";
    case "weak": return WEAK_PIN_MESSAGE;
    case "code": return "復旧コードが違います";
    case "pending": return "管理者の承認待ちです";
    case "bot": return TURNSTILE_MESSAGE.bot;
    case "unavailable": return TURNSTILE_MESSAGE.unavailable;
    case "limit": return `試行回数が多すぎます。${e.seconds}秒後に再試行してください`;
  }
}

const errorHtml = (e: LoginError | null) =>
  e ? `<p class="err" role="alert">${escapeHtml(errorText(e))}</p>` : "";

function idForm(error: LoginError | null): string {
  return `<form class="ws-card" method="get" action="/">
    <label class="field-label hos-caption" for="id">${ICONS.lock}個人番号</label>
    <input id="id" name="id" type="text" class="ws-input num big" inputmode="numeric" pattern="[0-9]*" placeholder="個人番号" autocomplete="off" autofocus required maxlength="10">
    <button class="btn" type="submit">次へ</button>
    ${errorHtml(error)}
    <p class="hint hos-caption">自分の個人番号（4桁）で入室してください</p>
  </form>`;
}

type PinState = "none" | "pending" | "approved";

const who = (id: string) => `<p class="who">${escapeHtml(id)} - ${escapeHtml(maskName(memberName(id)))}</p>`;
const recoverLink = (id: string) =>
  recoveryEnabled()
    ? `<p class="hint hos-caption"><a href="/?id=${encodeURIComponent(id)}&amp;recover=1">管理者の復旧コードを使う</a><br>（管理者が最初にPINを決めるとき・PINを忘れたとき）</p>`
    : "";

function pinForm(id: string, state: PinState, error: LoginError | null, widget: string): string {
  const approved = state === "approved";
  return `<form class="ws-card" method="post" action="/">
    <a class="back" href="/">${ICONS.back}番号を変更</a>
    ${who(id)}
    ${state === "none" ? `<p class="note">初回ログイン — 使用するPINを設定してください<br>設定後、管理者の承認で使えるようになります</p>` : ""}
    ${state === "pending" ? `<p class="note warn">この番号には承認待ちのPIN申請があります。<br>自分で申請した場合は、申請コードを管理者に見せて承認してもらってください。コードが分からなくなったら、もう一度PINを設定すると新しいコードが出ます（前の申請は取り消されます）。<br>自分で申請していない場合は、すぐ管理者に伝えてください</p>` : ""}
    <input type="hidden" name="id" value="${escapeHtml(id)}">
    ${approved ? pinField("pin", "PINコード", true) : pinField("pin", "新しいPIN（4桁）", true) + pinField("pin2", "PINの確認", false)}
    ${widget}
    <button class="btn" type="submit">${approved ? "入室する" : "PINを設定する"}</button>
    ${errorHtml(error)}
    ${recoverLink(id)}
  </form>`;
}

/** After a first-login request: the code the admin approves it with. */
function requestedCard(id: string, code: string): string {
  return `<div class="ws-card">
    <a class="back" href="/">${ICONS.back}番号を変更</a>
    ${who(id)}
    <p class="note">PINの登録を申請しました。<br>この画面を管理者に見せて、承認してもらってください</p>
    <p class="field-label center hos-caption">申請コード</p>
    <p class="code">${escapeHtml(code)}</p>
    <p class="hint hos-caption">承認されたら、<a href="/?id=${encodeURIComponent(id)}">このPINで入室</a>できます</p>
  </div>`;
}

function recoverForm(id: string, error: LoginError | null, widget: string): string {
  return `<form class="ws-card" method="post" action="/">
    <a class="back" href="/?id=${encodeURIComponent(id)}">${ICONS.back}戻る</a>
    ${who(id)}
    <p class="note warn">管理者のPINを、復旧コードで設定し直します</p>
    <input type="hidden" name="id" value="${escapeHtml(id)}">
    <input type="hidden" name="recover" value="1">
    <label class="field-label hos-caption" for="code">${ICONS.shield}復旧コード</label>
    <input id="code" name="code" type="password" class="ws-input" autocomplete="off" required maxlength="200" autofocus>
    ${pinField("pin", "新しいPIN（4桁）", false)}
    ${pinField("pin2", "PINの確認", false)}
    ${widget}
    <button class="btn" type="submit">PINを設定する</button>
    ${errorHtml(error)}
  </form>`;
}

function parseError(req: Request): LoginError | null {
  const e = req.query.e;
  const s = Number(req.query.s);
  if (e === "id" || e === "wrong" || e === "format" || e === "mismatch" || e === "weak" || e === "code" || e === "pending" || e === "bot" || e === "unavailable") return { kind: e };
  // Only what the server would send (a lock lasts at most an hour).
  if (e === "limit" && Number.isInteger(s) && s > 0 && s <= 3600) return { kind: "limit", seconds: s };
  return null;
}

const back = (res: Response, id: string | null, e: string, extra = "") =>
  redirect(res, 303, `/?${id ? `id=${encodeURIComponent(id)}&` : ""}e=${e}${extra}`);

const serverError = (id: string) => `<form class="ws-card"><p class="err">サーバーでエラーが発生しました。少し待ってからもう一度お試しください。</p>
      <p class="hint"><a class="back" href="/${id ? `?id=${encodeURIComponent(id)}` : ""}">← 戻る</a></p></form>`;

/**
 * The login page, shown at "/" to a browser that has the 合言葉 cookie but
 * no session (server/gate.ts decides that).
 */
export async function sendLoginPage(req: Request, res: Response): Promise<void> {
  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  const error = parseError(req);
  if (!id) {
    sendPage(res, 200, idForm(error));
    return;
  }
  if (!isMember(id)) {
    sendPage(res, 200, idForm({ kind: "id" }));
    return;
  }
  const widget = turnstileWidget("login", isDark(req));
  // Offered on every number's page, so the page doesn't say which is the admin's.
  if (req.query.recover === "1" && recoveryEnabled()) {
    sendPage(res, 200, recoverForm(id, error, widget), { turnstile: turnstileEnabled() });
    return;
  }
  if (error?.kind === "pending" && isRequestCode(req.query.c)) {
    sendPage(res, 200, requestedCard(id, req.query.c));
    return;
  }
  let state: PinState;
  try {
    const row = await db.getMemberPin(id);
    state = !row ? "none" : row.approved ? "approved" : "pending";
  } catch (err) {
    console.error("[Login] PIN lookup failed:", err);
    sendPage(res, 503, serverError(""));
    return;
  }
  sendPage(res, 200, pinForm(id, state, error, widget), { turnstile: turnstileEnabled() });
}

/** Opens the session: cookies, device, log. */
async function logIn(req: Request, res: Response, id: string, storedPin: string, device: DeviceInfo | null, detail: string): Promise<void> {
  forgetPinCache(id);
  const name = memberName(id);
  setPosSessionCookie(res, req, await createPosSessionToken(id, name, storedPin));
  // A fresh 30 days on the 合言葉 too, so it can't run out under a
  // register that is in use.
  setGateCookie(res, req, await createGateToken());
  await rememberMemberOnDevice(req, res, id, device);
  await log(id, "login", detail);
  redirect(res, 303, "/");
}

/**
 * A login form posted to "/" by a browser that has the 合言葉 cookie
 * (server/gate.ts checks the origin and the cookie before calling this).
 */
export async function handleLoginPost(req: Request, res: Response): Promise<void> {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
  const pin2 = typeof req.body?.pin2 === "string" ? req.body.pin2 : null;
  if (!isMember(id)) return back(res, null, "id");

  const device = await readDevice(req);
  // No device cookie (cleared, or a script): the claimed IP, which can be
  // faked — the per-number and shop-wide limits below still apply.
  const deviceKey = device?.did ?? `ip:${getClientIp(req)}`;
  const knownDevice = !!device?.ids.includes(id);
  if (req.body?.recover === "1") return handleRecovery(req, res, id, pin, pin2, device, deviceKey);

  const limits = limitsFor(id, deviceKey, knownDevice);
  const wait = lockedFor(limits);
  if (wait) return back(res, id, "limit", `&s=${wait}`);
  if (!/^\d{4}$/.test(pin)) return back(res, id, "format");
  // A person in a real browser (server/turnstile.ts) before the PIN is
  // checked. Not counted as a wrong PIN.
  const human = await verifyTurnstile(req.body, "login");
  if (!human.ok) return back(res, id, turnstileErrorCode(human));

  try {
    // Whether this is a first login is decided here, from the database —
    // never from which form the browser says it filled in.
    const existing = await db.getMemberPin(id);
    if (existing?.approved) {
      if (!(await verifyPin(pin, existing.pin))) {
        await wrongPin(id, device, knownDevice, limits);
        return back(res, id, "wrong");
      }
      recordSuccess(limits[0].key);
      let storedPin = existing.pin;
      // Silently migrate a legacy plaintext PIN to a hashed one.
      if (isLegacyPlaintextPin(existing.pin)) {
        storedPin = await hashPin(pin);
        await db.upsertMemberPin(id, storedPin, true);
      }
      return logIn(req, res, id, storedPin, device, "ログイン");
    }

    // First login, or asking again while a request waits. Typed twice so
    // a slip doesn't lock them out of their own account. Knowing the
    // 合言葉 and a classmate's number is not proof of being that classmate
    // — the numbers are consecutive, so anyone could claim everyone who
    // hadn't logged in yet. So the PIN opens nothing until an admin
    // approves it (PIN tab), with the request code shown only here, on the
    // device that asked: the admin types it in from that person's screen,
    // so a request someone else made under their number can't be approved
    // by mistake. A new request replaces the waiting one (and its code).
    // No exception for the admin: that was how the first person to post
    // the admin's number became the admin (see server/adminRecovery.ts).
    const requestKey = `pinreq:${id}`;
    const requestWait = lockedFor([{ key: requestKey }]);
    if (requestWait) return back(res, id, "limit", `&s=${requestWait}`);
    if (pin2 !== pin) return back(res, id, "mismatch");
    if (isWeakPin(pin)) return back(res, id, "weak");
    const code = newRequestCode();
    await db.upsertMemberPin(id, await hashPin(pin), false, code);
    forgetPinCache(id);
    recordFailure(requestKey, REQUEST_POLICY);
    await log(id, "pin_request", `${existing ? "PIN登録の申請をやり直し" : "初回PIN設定"}（管理者の承認待ち、${deviceLabel(device)}）`);
    return back(res, id, "pending", `&c=${code}`);
  } catch (err) {
    console.error("[Login] failed:", err);
    sendPage(res, 503, serverError(id));
  }
}

/** The admin recovery form (server/adminRecovery.ts). */
async function handleRecovery(
  req: Request, res: Response, id: string, pin: string, pin2: string | null, device: DeviceInfo | null, deviceKey: string
): Promise<void> {
  const again = "&recover=1";
  if (!recoveryEnabled()) return redirect(res, 303, `/?id=${encodeURIComponent(id)}`);
  const limits = [{ key: RECOVER_KEY }, { key: `recover:${deviceKey}` }];
  const wait = lockedFor(limits);
  if (wait) return back(res, id, "limit", `&s=${wait}${again}`);
  if (!/^\d{4}$/.test(pin)) return back(res, id, "format", again);
  if (pin2 !== pin) return back(res, id, "mismatch", again);
  if (isWeakPin(pin)) return back(res, id, "weak", again);
  const human = await verifyTurnstile(req.body, "login");
  if (!human.ok) return back(res, id, turnstileErrorCode(human), again);

  const code = typeof req.body?.code === "string" ? req.body.code : "";
  // The same answer for a non-admin number: the page doesn't tell which is the admin's.
  if (!recoveryCodeMatches(code) || !isAdmin(id)) {
    recordFailure(RECOVER_KEY, RECOVER_POLICY);
    recordFailure(`recover:${deviceKey}`);
    await log(id, "admin_recover_failed", `復旧コードの誤り（${deviceLabel(device)}）`);
    return back(res, id, "code", again);
  }
  try {
    const storedPin = await hashPin(pin);
    // Approved, replacing whatever was there: the admin's sessions opened
    // with the old PIN end (its fingerprint no longer matches).
    await db.upsertMemberPin(id, storedPin, true);
    recordSuccess(`recover:${deviceKey}`);
    await log(id, "admin_recover", `復旧コードで管理者のPINを設定（${deviceLabel(device)}）。Renderの POS_ADMIN_RECOVERY_CODE を削除してください`);
    await logIn(req, res, id, storedPin, device, "ログイン（復旧コード）");
  } catch (err) {
    console.error("[Login] recovery failed:", err);
    sendPage(res, 503, serverError(id));
  }
}
