/**
 * POS Session Authentication
 * 
 * Uses a signed JWT cookie (pos_session) to track the authenticated POS operator.
 * The operator ID is embedded in the token and verified server-side.
 */
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./_core/env";
import type { Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import { accessCodeFingerprint, isAdmin, isMember } from "./roster";
import { getMemberPin, getRevokedSession, listMemberPins, listRevokedSessions, revokeSession, upsertMemberPin } from "./db";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);
const PIN_KEY_LENGTH = 64;

/**
 * PIN hashing (scrypt via Node's built-in crypto — no extra dependency).
 * Stored format is "salt:hashHex". A bare 4-digit string is treated as a
 * legacy plaintext PIN from before this fix; verifyPin() still accepts
 * those and the caller re-saves the hashed form on a successful match, so
 * existing PINs keep working and migrate silently the next time someone
 * logs in.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(pin, salt, PIN_KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

export function isLegacyPlaintextPin(stored: string): boolean {
  return /^\d{4}$/.test(stored);
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (isLegacyPlaintextPin(stored)) {
    return stored === pin;
  }
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const derivedKey = (await scrypt(pin, salt, PIN_KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(hashHex, "hex");
  if (storedKey.length !== derivedKey.length) return false;
  return timingSafeEqual(derivedKey, storedKey);
}

const POS_COOKIE_NAME = "pos_session";
const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export type PosSessionPayload = {
  operatorId: string;
  operatorName: string;
  /** Expiry (seconds since epoch), PIN fingerprint, id and login time — for renewal. */
  exp?: number;
  pv?: string;
  jti?: string;
  auth?: number;
};

/**
 * However much a session is used, it ends this long after the PIN was
 * typed (renewal carries the login time along). Long enough for a
 * rehearsal a few days before and both festival days — renewal exists so a
 * register isn't thrown out mid-sale — short enough that a copied cookie
 * doesn't last for ever.
 */
const MAX_SESSION_AGE_MS = 7 * ONE_DAY_MS;

function getSecret() {
  return new TextEncoder().encode(ENV.cookieSecret + "_pos");
}

// ===== Ending sessions =====
//
// A session is a signed cookie, valid for a day by itself. Three things
// end one early, so a copied cookie stops working:
//  - logging out: the session's id (jti) is recorded as ended, at once.
//  - renewal: the replaced cookie stops working RENEWAL_GRACE_MS later
//    (other requests already on their way still carry it).
//  - the PIN changing: the session carries a fingerprint of the member's
//    stored PIN (pv), so an admin resetting or deleting a PIN — e.g. after
//    someone else learned it — ends every session opened with the old one.
// Ended sessions are kept in the database (revoked_sessions) as well as in
// memory. They used to be in memory only, and a restart — Render's free
// plan sleeps after 15 idle minutes — brought a logged-out cookie back.

const RENEWAL_GRACE_MS = 10 * 60 * 1000;
const revoked = new Map<string, { notAfter: number; expiresAt: number }>();
let revocationsLoaded = false;

function forgetExpiredRevocations(now: number) {
  revoked.forEach((r, jti) => { if (r.expiresAt <= now) revoked.delete(jti); });
}

/** Called once the database is up (server/_core/index.ts). */
export async function loadRevocations(): Promise<void> {
  try {
    for (const r of await listRevokedSessions(Date.now())) {
      revoked.set(r.jti, { notAfter: r.notAfter, expiresAt: r.expiresAt });
    }
    revocationsLoaded = true;
  } catch (err) {
    console.error("[Session] could not load ended sessions:", err);
  }
}

async function revocationOf(jti: string): Promise<{ notAfter: number } | undefined> {
  const hit = revoked.get(jti);
  if (hit || revocationsLoaded) return hit;
  // Before the list is loaded (the first seconds after a start), ask the
  // database about this one.
  try {
    const row = await getRevokedSession(jti);
    if (row) revoked.set(jti, { notAfter: row.notAfter, expiresAt: row.expiresAt });
    return row;
  } catch {
    return undefined;
  }
}

async function revoke(jti: string, notAfter: number, expiresAt: number): Promise<void> {
  forgetExpiredRevocations(Date.now());
  const prev = revoked.get(jti);
  revoked.set(jti, { notAfter: Math.min(notAfter, prev?.notAfter ?? Infinity), expiresAt });
  try {
    await revokeSession(jti, notAfter, expiresAt);
  } catch (err) {
    // Still ended in memory until the next restart.
    console.error("[Session] could not save an ended session:", err);
  }
}

/** Fingerprint of a stored PIN hash; changes whenever the PIN does. */
export function pinFingerprint(storedPin: string): string {
  return createHash("sha256").update(`fespos-pin:${storedPin}`).digest("hex").slice(0, 16);
}

// Per-request PIN lookups are cached briefly: every poll is several API
// calls, and the database is on a free quota.
const PIN_CACHE_MS = 30_000;
const pinCache = new Map<string, { at: number; fingerprint: string | null }>();

async function currentPinFingerprint(memberId: string): Promise<string | null | undefined> {
  const hit = pinCache.get(memberId);
  if (hit && Date.now() - hit.at < PIN_CACHE_MS) return hit.fingerprint;
  try {
    const row = await getMemberPin(memberId);
    // A PIN still waiting for an admin's approval opens no session.
    const fingerprint = row && row.approved ? pinFingerprint(row.pin) : null;
    pinCache.set(memberId, { at: Date.now(), fingerprint });
    return fingerprint;
  } catch {
    // Database unreachable: nothing else works either, and throwing every
    // register back to the login screen on a blip would only add to the
    // confusion. Fall back to the last known value, if any.
    return hit?.fingerprint;
  }
}

/** Call after a PIN is set, reset or deleted so the change applies at once. */
export function forgetPinCache(memberId: string): void {
  pinCache.delete(memberId);
}

export async function createPosSessionToken(operatorId: string, operatorName: string, storedPin: string): Promise<string> {
  return signSession(operatorId, operatorName, pinFingerprint(storedPin), Math.floor(Date.now() / 1000));
}

/** `auth`: when the PIN was typed (seconds), carried unchanged through renewals. */
function signSession(operatorId: string, operatorName: string, pv: string, auth: number): Promise<string> {
  const secret = getSecret();
  const expirationSeconds = Math.min(
    Math.floor((Date.now() + ONE_DAY_MS) / 1000),
    auth + MAX_SESSION_AGE_MS / 1000
  );
  return new SignJWT({ operatorId, operatorName, pv, auth })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(randomBytes(16).toString("hex"))
    .setExpirationTime(expirationSeconds)
    .sign(secret);
}

/**
 * Sliding expiry: a session in use is re-issued once it has less than half
 * its day left. Without this, a register that logged in at 16:00 the day
 * before (at the rehearsal, say) was thrown back to the login screen at
 * 16:00 on festival day, mid-sale, cart and all. A phone left unused for a
 * whole day still has to log in again. The new cookie carries the same PIN
 * fingerprint, so a PIN reset still ends it, and the same login time, so
 * it can't be renewed past MAX_SESSION_AGE_MS. The cookie it replaces
 * stops working shortly after.
 */
export async function renewPosSessionIfNeeded(req: Request, res: Response, session: PosSessionPayload): Promise<void> {
  if (!session.exp || !session.pv || !session.jti || !session.auth) return;
  if (session.exp * 1000 - Date.now() > ONE_DAY_MS / 2) return;
  // At the age limit: nothing longer to give.
  if ((session.auth * 1000 + MAX_SESSION_AGE_MS) - session.exp * 1000 < 60_000) return;
  setPosSessionCookie(res, req, await signSession(session.operatorId, session.operatorName, session.pv, session.auth));
  await revoke(session.jti, Date.now() + RENEWAL_GRACE_MS, session.exp * 1000);
}

/** Logout: make this request's session unusable even if the cookie was copied. */
export async function revokePosSession(req: Request): Promise<void> {
  const token = extractPosToken(req);
  if (!token) return;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (typeof payload.jti === "string" && typeof payload.exp === "number") {
      await revoke(payload.jti, Date.now(), payload.exp * 1000);
    }
  } catch {
    // Invalid or expired already: nothing to revoke.
  }
}

/**
 * Extracts the POS session token from the "pos_session" cookie. The token
 * is never carried client-side outside this httpOnly cookie (no header
 * fallback) — see main.tsx/POSApp.tsx for the client side of this.
 */
function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  return parseCookieHeader(cookieHeader)[name] || null;
}

function extractPosToken(req: Request): string | null {
  return readCookie(req, POS_COOKIE_NAME);
}

export async function verifyPosSession(req: Request): Promise<PosSessionPayload | null> {
  const token = extractPosToken(req);
  if (!token) return null;
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const { operatorId, operatorName, pv } = payload as Record<string, unknown>;
    if (typeof operatorId !== "string" || !operatorId) return null;
    // Issued before sessions could be ended (no jti/pv).
    if (typeof payload.jti !== "string" || typeof pv !== "string") return null;
    // Logged out, or replaced by a renewal a while ago.
    const ended = await revocationOf(payload.jti);
    if (ended && Date.now() >= ended.notAfter) return null;
    // Login time: sessions from before it was recorded count from their
    // own issue (a day before expiry).
    const auth = typeof payload.auth === "number" ? payload.auth : (payload.exp ?? 0) - ONE_DAY_MS / 1000;
    if (Date.now() - auth * 1000 > MAX_SESSION_AGE_MS) return null;
    // Defense in depth: a valid signature alone shouldn't be enough to act
    // as an operator who was never actually validated against the roster.
    // Re-checking the roster here on every request means a leaked signing
    // key isn't by itself sufficient to mint a session for an ID outside
    // the real class roster (POS_MEMBERS) — and someone removed from the
    // roster loses access on their next request.
    if (!isMember(operatorId)) return null;
    // The PIN this session was opened with must still be the member's PIN.
    const current = await currentPinFingerprint(operatorId);
    if (current !== undefined && current !== pv) return null;
    return { operatorId, operatorName: (operatorName as string) || "", exp: payload.exp, pv, jti: payload.jti, auth };
  } catch {
    return null;
  }
}

/**
 * SameSite=Lax: the app is only ever used as its own top-level page (the
 * browser, the home-screen PWA, and the Android WebView all load
 * <service>.onrender.com itself). It used to be SameSite=None for Manus's
 * cross-site preview iframe, which also meant any other website a
 * cashier happened to open could send requests that carried the
 * register's session. Secure outside plain-http localhost.
 */
function cookieOptions(req: Request, maxAge: number) {
  const local = req.hostname === "localhost" || req.hostname === "127.0.0.1";
  return { httpOnly: true, path: "/", sameSite: "lax" as const, secure: !local, maxAge };
}

export function setPosSessionCookie(res: Response, req: Request, token: string) {
  res.cookie(POS_COOKIE_NAME, token, cookieOptions(req, ONE_DAY_MS));
}

export function clearPosSessionCookie(res: Response, req: Request) {
  res.clearCookie(POS_COOKIE_NAME, { ...cookieOptions(req, 0), maxAge: undefined });
}

export function isAdminOperator(operatorId: string): boolean {
  return isAdmin(operatorId);
}

// ===== 合言葉 gate =====
//
// The 合言葉 used to be checked only in the browser (a localStorage flag),
// so the login API itself was open to anyone who called it directly —
// including setting the first PIN for a classmate who hadn't logged in
// yet. Passing the 合言葉 now earns an httpOnly cookie, and every
// pre-login endpoint (PIN check, name lookup, login) requires it.

const GATE_COOKIE_NAME = "pos_gate";
const GATE_DAYS = 30;

export async function createGateToken(): Promise<string> {
  return new SignJWT({ gate: accessCodeFingerprint() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + GATE_DAYS * 86400)
    .sign(getSecret());
}

/** True when the request carries a valid gate cookie for the current 合言葉. */
export async function verifyGate(req: Request): Promise<boolean> {
  const token = readCookie(req, GATE_COOKIE_NAME);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    return payload.gate === accessCodeFingerprint();
  } catch {
    return false;
  }
}

export function setGateCookie(res: Response, req: Request, token: string) {
  res.cookie(GATE_COOKIE_NAME, token, cookieOptions(req, GATE_DAYS * ONE_DAY_MS));
}

// ===== This device =====
//
// A long-lived cookie naming the device (a random id) and the members who
// have logged in on it. It opens nothing by itself; it only tells the
// login limits apart (server/login.ts, server/gate.ts):
//  - wrong PINs lock that number on this device, not everywhere, so
//    someone typing wrong PINs on purpose can't lock a classmate (or the
//    admin) out of their own phone;
//  - the stricter limits for a number, and the shop-wide ones, apply to
//    devices that have never logged in as it — where a guesser would be.
// Outlives the 合言葉 cookie (and a change of 合言葉) on purpose.

const DEVICE_COOKIE_NAME = "pos_device";
const DEVICE_DAYS = 400; // the most a browser keeps a cookie
const MAX_DEVICE_MEMBERS = 8;

export type DeviceInfo = { did: string; ids: string[] };

export async function readDevice(req: Request): Promise<DeviceInfo | null> {
  const token = readCookie(req, DEVICE_COOKIE_NAME);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    const { did, ids } = payload as Record<string, unknown>;
    if (typeof did !== "string" || !/^[0-9a-f]{32}$/.test(did) || !Array.isArray(ids)) return null;
    return { did, ids: ids.filter((x): x is string => typeof x === "string") };
  } catch {
    return null;
  }
}

async function setDeviceCookie(res: Response, req: Request, device: DeviceInfo): Promise<void> {
  const token = await new SignJWT({ did: device.did, ids: device.ids })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + DEVICE_DAYS * 86400)
    .sign(getSecret());
  res.cookie(DEVICE_COOKIE_NAME, token, cookieOptions(req, DEVICE_DAYS * ONE_DAY_MS));
}

/** Gives a device its id if it has none yet (after the 合言葉). */
export async function ensureDevice(req: Request, res: Response): Promise<DeviceInfo> {
  const device = await readDevice(req);
  if (device) return device;
  const fresh = { did: randomBytes(16).toString("hex"), ids: [] };
  await setDeviceCookie(res, req, fresh);
  return fresh;
}

/**
 * Notes that this member logged in on this device. Also called for every
 * logged-in request whose device cookie doesn't list them yet, so phones
 * logged in before this cookie existed pick it up without logging out.
 */
export async function rememberMemberOnDevice(req: Request, res: Response, memberId: string, known?: DeviceInfo | null): Promise<void> {
  const device = known === undefined ? await readDevice(req) : known;
  if (device?.ids[0] === memberId) return;
  const ids = [memberId, ...(device?.ids ?? []).filter((x) => x !== memberId)].slice(0, MAX_DEVICE_MEMBERS);
  await setDeviceCookie(res, req, { did: device?.did ?? randomBytes(16).toString("hex"), ids });
}

// ===== PINs stored in plain text =====
//
// PINs from before hashing are accepted and re-saved hashed at the owner's
// next login (verifyPin). This does the rest at start-up, so none stay in
// the database in plain text waiting for a login that may never come.
export async function hashLegacyPins(): Promise<void> {
  try {
    const rows = (await listMemberPins()).filter((r) => isLegacyPlaintextPin(r.pin));
    for (const r of rows) {
      await upsertMemberPin(r.memberId, await hashPin(r.pin), r.approved, r.requestCode ?? null);
      forgetPinCache(r.memberId);
    }
    if (rows.length > 0) console.log(`[Migration] hashed ${rows.length} PIN(s) stored in plain text.`);
  } catch (err) {
    console.error("[Migration] could not hash plain-text PINs:", err);
  }
}

export { POS_COOKIE_NAME };
