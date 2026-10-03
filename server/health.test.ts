import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ starting: false, fail: false }));
vi.mock("./db", () => ({
  isDbStarting: () => state.starting,
  getDb: async () => {
    if (state.fail) throw new Error("connect ETIMEDOUT");
    return { execute: async () => [] };
  },
}));

import { __resetHealthCache, registerHealthCheck } from "./health";
import { createGateToken } from "./posAuth";

// The details are for a browser that has entered the 合言葉 (every
// register); tests call with that cookie unless they say otherwise.
async function callHealth(withGate = true) {
  let handler: any;
  registerHealthCheck({ get: (_path: string, h: any) => { handler = h; } } as any);
  const res: any = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const cookie = withGate ? `pos_gate=${await createGateToken()}` : "";
  await handler({ headers: { cookie } }, res);
  return res;
}

describe("/api/health", () => {
  beforeEach(() => { state.starting = false; state.fail = false; __resetHealthCache(); });

  it("tells someone without the 合言葉 only ok / unavailable — no db, latency, commit or time", async () => {
    const ok = await callHealth(false);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toEqual({ status: "ok" });
    __resetHealthCache();
    state.fail = true;
    const down = await callHealth(false);
    expect(down.statusCode).toBe(503);
    expect(down.body).toEqual({ status: "unavailable" });
    expect(down.headers["Retry-After"]).toBeUndefined();
  });

  it("ok when the database answers", async () => {
    const res = await callHealth();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "ok" });
  });

  it("says starting (not error) while the first connection is still being set up", async () => {
    state.fail = true;
    state.starting = true;
    const res = await callHealth();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ status: "starting", db: "starting", server: "ok" });
  });

  it("answers repeated requests from a 5-second cache (no DB query per hit)", async () => {
    const first = await callHealth();
    state.fail = true; // would be an error if it hit the database again
    const second = await callHealth();
    expect(second.body).toEqual(first.body);
  });

  it("says error when the database is down after start-up", async () => {
    state.fail = true;
    const res = await callHealth();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", db: "error" });
  });
});
