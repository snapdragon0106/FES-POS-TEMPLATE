import { createHash, timingSafeEqual } from "crypto";

/**
 * How the admin gets a PIN when there is no one to approve it: they forgot
 * it, or the database is new. There is a single admin, and a first-login
 * PIN only works once an admin approves it (server/login.ts) — so the admin
 * can't approve their own.
 *
 * It used to be that an admin's first-login PIN was approved on the spot
 * whenever no admin had an approved PIN, and the runbook's way back from a
 * forgotten admin PIN was to delete the admin's row. In that window,
 * whoever posted the admin's number first — anyone with the 合言葉 —
 * became the admin.
 *
 * Now: set POS_ADMIN_RECOVERY_CODE on Render (a long random string, known
 * only to whoever set it), and the login page offers 「管理者の復旧コード」:
 * the code plus a new PIN sets the admin's PIN, approved, replacing any
 * other. Remove the variable afterwards; unset, the form isn't there.
 * Wrong codes are limited shop-wide (server/login.ts).
 */

const MIN_LENGTH = 16;

function code(): string {
  return process.env.POS_ADMIN_RECOVERY_CODE?.trim() ?? "";
}

export function recoveryEnabled(): boolean {
  return code() !== "";
}

/** Throws at boot when the code is set but short enough to guess. */
export function assertRecoveryConfig(): void {
  const c = code();
  if (c && c.length < MIN_LENGTH) {
    throw new Error(`POS_ADMIN_RECOVERY_CODE must be at least ${MIN_LENGTH} characters (or unset).`);
  }
}

export function recoveryCodeMatches(input: string): boolean {
  const c = code();
  if (!c) return false;
  const digest = (s: string) => createHash("sha256").update(`fespos-recovery:${s}`).digest();
  return timingSafeEqual(digest(input.trim()), digest(c));
}
