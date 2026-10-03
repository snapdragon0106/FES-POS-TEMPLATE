import type { Express } from "express";
import { sql } from "drizzle-orm";
import { getDb, isDbStarting } from "./db";
import { verifyGate } from "./posAuth";

/**
 * GET /api/health — a URL anyone can open on a phone during an incident to
 * tell the three failure modes apart in one glance:
 *
 *   - page doesn't load at all / Render error page → the server is down
 *   - {"db":"starting"}                             → just (re)started, still connecting;
 *                                                     wait a minute and reload
 *   - {"db":"error"}                                → the server is up, TiDB isn't
 *   - {"status":"ok"}                               → both are fine; the problem
 *                                                     is the device or the venue network
 *
 * `commit` is the deployed git commit (Render sets RENDER_GIT_COMMIT), so
 * after pushing a fix you can see whether it is actually live yet.
 *
 * Deliberately says nothing more specific than ok/error, and only to a
 * browser that has the 合言葉 cookie (see registerHealthCheck); error
 * details go to the server log instead.
 */

const DB_TIMEOUT_MS = 5000;

// How long after the server process starts a slow first connection is
// reported as "starting" instead of "error". Setting up the tables takes
// seconds, more when TiDB has to wake from idle; past this window a
// database that still isn't answering is a real problem.
const STARTUP_GRACE_SECONDS = 180;

// The page is public, so it must not become a way for anyone on the
// internet to make the server query TiDB (and spend its free quota) as
// fast as they can send requests: one real check per 5 seconds, shared.
const CACHE_MS = 5000;
let cached: { at: number; status: number; body: Record<string, unknown> } | null = null;

/** Tests only. */
export function __resetHealthCache(): void {
  cached = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function check(): Promise<{ status: number; body: Record<string, unknown> }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const commit = (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || "unknown";
  const started = Date.now();
  let result: { status: number; body: Record<string, unknown> };
  try {
    const db = await withTimeout(getDb(), DB_TIMEOUT_MS);
    if (!db) throw new Error("DATABASE_URL is not configured");
    await withTimeout(db.execute(sql`SELECT 1`), DB_TIMEOUT_MS);
    result = {
      status: 200,
      body: { status: "ok", server: "ok", db: "ok", dbLatencyMs: Date.now() - started, commit, time: new Date().toISOString() },
    };
  } catch (error) {
    if (isDbStarting() && process.uptime() < STARTUP_GRACE_SECONDS) {
      result = { status: 503, body: { status: "starting", server: "ok", db: "starting", commit, time: new Date().toISOString() } };
    } else {
      console.error("[Health] database check failed:", error);
      result = { status: 503, body: { status: "degraded", server: "ok", db: "error", commit, time: new Date().toISOString() } };
    }
  }
  cached = { at: Date.now(), ...result };
  return result;
}

/**
 * The details (db, latency, deployed commit, server time) only for a
 * browser that has entered the 合言葉 — every register and the admins'
 * phones. Anyone else gets the bare verdict: 200 {"status":"ok"} or 503
 * {"status":"unavailable"}, enough for an uptime check and nothing about
 * what runs behind it or when it was deployed.
 */
export function registerHealthCheck(app: Express): void {
  app.get("/api/health", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const { status, body } = await check();
    if (!(await verifyGate(req))) {
      res.status(status).json({ status: status === 200 ? "ok" : "unavailable" });
      return;
    }
    if (body.status === "starting") res.setHeader("Retry-After", "30");
    res.status(status).json(body);
  });
}
