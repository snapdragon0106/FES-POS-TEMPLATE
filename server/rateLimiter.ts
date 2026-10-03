/**
 * Minimal in-memory attempt limiter for PIN/access-code brute-force
 * protection. There is no server-side throttling at all today: a script
 * can try all 10,000 four-digit PIN combinations against any of the 40
 * fixed operator IDs (including the admin ID) with nothing to stop it.
 *
 * This is intentionally simple: an in-memory Map, not a DB table or Redis.
 * It resets on every server restart and does not coordinate across
 * multiple server instances — acceptable for this app's actual footprint
 * (a single Express process for a one-evening school festival), not a
 * general-purpose solution. If this app ever runs behind multiple
 * instances, this needs to move to a shared store.
 */
import type { Request } from "express";

type Bucket = { failures: number; lockedUntil: number; lastFailure: number };

const buckets = new Map<string, Bucket>();

/**
 * maxAttempts failures, each within windowMs of the one before, lock the
 * key for lockoutMs. windowMs defaults to 15 minutes.
 */
export type LimitPolicy = { maxAttempts: number; lockoutMs: number; windowMs?: number };

const DEFAULT_POLICY: LimitPolicy = { maxAttempts: 5, lockoutMs: 5 * 60 * 1000 };

// Failures older than this no longer count toward a lockout.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
// Longest window any policy uses: idle keys younger than this are kept.
const MAX_WINDOW_MS = 60 * 60 * 1000;
// Keys can come from a header the client controls (x-forwarded-for), so
// the map must not grow without bound: past this size, forget idle keys.
const MAX_KEYS = 10_000;

function prune(now: number) {
  if (buckets.size < MAX_KEYS) return;
  buckets.forEach((b, key) => {
    if (b.lockedUntil <= now && now - b.lastFailure > MAX_WINDOW_MS) buckets.delete(key);
  });
  // Still full (a flood of fresh keys): drop the oldest half.
  if (buckets.size >= MAX_KEYS) {
    const keys = Array.from(buckets.keys());
    for (const key of keys.slice(0, Math.floor(keys.length / 2))) buckets.delete(key);
  }
}

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const b = buckets.get(key);
  if (!b || b.lockedUntil <= Date.now()) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((b.lockedUntil - Date.now()) / 1000) };
}

/** Counts a failure. True when this one locked the key. */
export function recordFailure(key: string, policy: LimitPolicy = DEFAULT_POLICY): boolean {
  const now = Date.now();
  prune(now);
  const b = buckets.get(key) || { failures: 0, lockedUntil: 0, lastFailure: 0 };
  if (now - b.lastFailure > (policy.windowMs ?? FAILURE_WINDOW_MS)) b.failures = 0;
  b.failures += 1;
  b.lastFailure = now;
  let locked = false;
  if (b.failures >= policy.maxAttempts) {
    b.lockedUntil = now + policy.lockoutMs;
    b.failures = 0;
    locked = true;
  }
  buckets.set(key, b);
  return locked;
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Tests only. */
export function __resetRateLimits(): void {
  buckets.clear();
}

/**
 * Render (and most reverse-proxy hosts) sits in front of the app, so
 * req.socket.remoteAddress alone would just be the proxy's address.
 * x-forwarded-for's first entry is the original client IP — but the
 * client can also write that header itself, so a per-IP limit alone can
 * be dodged by sending a new fake IP every time. Anything that guards a
 * secret must also have a limit that doesn't depend on the IP (see the
 * shop-wide 合言葉 limit in server/gate.ts).
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}
