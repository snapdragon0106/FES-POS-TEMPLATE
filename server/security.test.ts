import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

// The stored PIN per member, as the database would return it.
const pins = vi.hoisted(() => new Map<string, string>());
// Members whose first-login PIN still waits for an admin.
const unapproved = vi.hoisted(() => new Set<string>());
// revoked_sessions, as the database would keep it across a restart.
const ended = vi.hoisted(() => new Map<string, { jti: string; notAfter: number; expiresAt: number }>());
vi.mock("./db", () => ({
  getMemberPin: async (id: string) =>
    pins.has(id) ? { memberId: id, pin: pins.get(id), approved: !unapproved.has(id) } : undefined,
  revokeSession: async (jti: string, notAfter: number, expiresAt: number) => {
    const prev = ended.get(jti);
    ended.set(jti, { jti, notAfter: Math.min(notAfter, prev?.notAfter ?? Infinity), expiresAt });
  },
  getRevokedSession: async (jti: string) => ended.get(jti),
  listRevokedSessions: async () => Array.from(ended.values()),
}));

import { createGateToken, createPosSessionToken, forgetPinCache, renewPosSessionIfNeeded, revokePosSession, verifyGate, verifyPosSession } from "./posAuth";
import { __resetRosterCache, assertRosterConfigured, isAdmin, isMember, memberName } from "./roster";

const withCookie = (cookie: string) => ({ headers: { cookie } }) as unknown as Request;

describe("合言葉 gate cookie", () => {
  const original = process.env.POS_ACCESS_CODE;
  afterEach(() => {
    process.env.POS_ACCESS_CODE = original;
    __resetRosterCache();
  });

  it("accepts its own token and rejects a missing or tampered one", async () => {
    const token = await createGateToken();
    expect(await verifyGate(withCookie(`pos_gate=${token}`))).toBe(true);
    expect(await verifyGate(withCookie(""))).toBe(false);
    expect(await verifyGate(withCookie(`pos_gate=${token.slice(0, -2)}xx`))).toBe(false);
  });

  it("stops accepting old cookies once the 合言葉 is changed", async () => {
    const token = await createGateToken();
    process.env.POS_ACCESS_CODE = "a-new-code";
    __resetRosterCache();
    expect(await verifyGate(withCookie(`pos_gate=${token}`))).toBe(false);
  });
});

describe("roster from the environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    __resetRosterCache();
  });

  it("reads members and admins", () => {
    expect(isMember("3501")).toBe(true);
    expect(isMember("9999")).toBe(false);
    expect(memberName("3509")).toBe("テスト 生徒09");
    expect(isAdmin("3509")).toBe(true);
    expect(isAdmin("3501")).toBe(false);
  });

  it("refuses to start without the variables or with an admin outside the roster", () => {
    for (const change of [
      { POS_MEMBERS: undefined },
      { POS_MEMBERS: "not json" },
      { POS_ADMIN_IDS: "" },
      { POS_ADMIN_IDS: "9999" },
      { POS_ACCESS_CODE: "" },
    ]) {
      process.env = { ...saved };
      for (const [k, v] of Object.entries(change)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetRosterCache();
      expect(() => assertRosterConfigured()).toThrow();
    }
  });

  it("supports more than one admin", () => {
    process.env.POS_ADMIN_IDS = "3509, 3512";
    __resetRosterCache();
    expect(isAdmin("3512")).toBe(true);
  });
});

describe("ending sessions", () => {
  const req = (token: string) => withCookie(`pos_session=${token}`);

  it("a session stops working after logout, even if the cookie was copied", async () => {
    pins.set("3501", "salt:hash-a");
    const token = await createPosSessionToken("3501", "テスト 生徒01", "salt:hash-a");
    expect(await verifyPosSession(req(token))).toMatchObject({ operatorId: "3501" });
    await revokePosSession(req(token));
    expect(await verifyPosSession(req(token))).toBeNull();
  });

  it("a PIN waiting for approval carries no session, even a correctly signed one", async () => {
    pins.set("3503", "salt:waiting");
    unapproved.add("3503");
    forgetPinCache("3503");
    const token = await createPosSessionToken("3503", "テスト 生徒03", "salt:waiting");
    expect(await verifyPosSession(req(token))).toBeNull();
    unapproved.delete("3503");
    forgetPinCache("3503");
    expect(await verifyPosSession(req(token))).toMatchObject({ operatorId: "3503" });
  });

  it("changing or deleting the PIN ends sessions opened with the old one", async () => {
    pins.set("3502", "salt:old");
    const token = await createPosSessionToken("3502", "テスト 生徒02", "salt:old");
    expect(await verifyPosSession(req(token))).not.toBeNull();
    pins.set("3502", "salt:new");
    forgetPinCache("3502");
    expect(await verifyPosSession(req(token))).toBeNull();
    pins.delete("3502");
    forgetPinCache("3502");
    expect(await verifyPosSession(req(token))).toBeNull();
  });

  it("refuses sessions from before this change (no session id / PIN fingerprint)", async () => {
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ operatorId: "3501", operatorName: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET + "_pos"));
    expect(await verifyPosSession(req(legacy))).toBeNull();
  });

  it("a gate cookie is not a session and a session is not a gate cookie", async () => {
    pins.set("3501", "salt:hash-a");
    const gate = await createGateToken();
    expect(await verifyPosSession(req(gate))).toBeNull();
    const session = await createPosSessionToken("3501", "テスト 生徒01", "salt:hash-a");
    expect(await verifyGate(withCookie(`pos_gate=${session}`))).toBe(false);
  });
});

describe("sliding session expiry", () => {
  afterEach(() => vi.useRealTimers());

  const sign = async (claims: Record<string, unknown>, expSeconds: number) => {
    const { SignJWT } = await import("jose");
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setJti(Math.random().toString(16).slice(2).padEnd(16, "0"))
      .setExpirationTime(expSeconds)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET + "_pos"));
  };

  it("re-issues the cookie only when less than half the day is left, keeping the PIN fingerprint and login time", async () => {
    const setCookie = vi.fn();
    const res = { cookie: setCookie } as any;
    const reqStub = { hostname: "localhost" } as any;
    const now = Math.floor(Date.now() / 1000);
    const base = { operatorId: "3501", operatorName: "x", pv: "abc", jti: "j-renew-1", auth: now - 3600 };
    await renewPosSessionIfNeeded(reqStub, res, { ...base, exp: now + 20 * 3600 });
    expect(setCookie).not.toHaveBeenCalled();
    await renewPosSessionIfNeeded(reqStub, res, { ...base, exp: now + 2 * 3600 });
    expect(setCookie).toHaveBeenCalledTimes(1);
    const [name, token] = setCookie.mock.calls[0];
    expect(name).toBe("pos_session");
    const { decodeJwt } = await import("jose");
    const payload = decodeJwt(token);
    expect(payload.pv).toBe("abc");
    expect(payload.auth).toBe(now - 3600);
    expect(payload.exp! - now).toBeGreaterThan(23 * 3600);
  });

  it("the cookie a renewal replaced stops working 10 minutes later", async () => {
    pins.set("3504", "salt:renew");
    forgetPinCache("3504");
    const { pinFingerprint } = await import("./posAuth");
    const now = Math.floor(Date.now() / 1000);
    const old = await sign({ operatorId: "3504", operatorName: "x", pv: pinFingerprint("salt:renew"), auth: now - 13 * 3600 }, now + 11 * 3600);
    const session = await verifyPosSession(withCookie(`pos_session=${old}`));
    expect(session).not.toBeNull();
    const setCookie = vi.fn();
    await renewPosSessionIfNeeded({ hostname: "localhost" } as any, { cookie: setCookie } as any, session!);
    const renewed = setCookie.mock.calls[0][1];
    // Requests already on their way with the old cookie still go through…
    expect(await verifyPosSession(withCookie(`pos_session=${old}`))).not.toBeNull();
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
    // …but not after the grace. The new one does.
    expect(await verifyPosSession(withCookie(`pos_session=${old}`))).toBeNull();
    expect(await verifyPosSession(withCookie(`pos_session=${renewed}`))).toMatchObject({ operatorId: "3504" });
  });

  it("a session can't be kept alive for more than 7 days after the PIN was typed", async () => {
    pins.set("3505", "salt:age");
    forgetPinCache("3505");
    const { pinFingerprint } = await import("./posAuth");
    const now = Math.floor(Date.now() / 1000);
    const pv = pinFingerprint("salt:age");
    const young = await sign({ operatorId: "3505", operatorName: "x", pv, auth: now - 6 * 86400 }, now + 3600);
    const tooOld = await sign({ operatorId: "3505", operatorName: "x", pv, auth: now - 7 * 86400 - 60 }, now + 3600);
    expect(await verifyPosSession(withCookie(`pos_session=${young}`))).not.toBeNull();
    expect(await verifyPosSession(withCookie(`pos_session=${tooOld}`))).toBeNull();
    // Renewing near the limit gives no more than what is left.
    const setCookie = vi.fn();
    const near = await verifyPosSession(withCookie(`pos_session=${young}`));
    await renewPosSessionIfNeeded({ hostname: "localhost" } as any, { cookie: setCookie } as any, near!);
    const { decodeJwt } = await import("jose");
    expect(decodeJwt(setCookie.mock.calls[0][1]).exp).toBeLessThanOrEqual(now - 6 * 86400 + 7 * 86400);
  });
});

describe("ended sessions survive a restart", () => {
  it("a logged-out cookie stays refused after the server restarts (memory lost, database kept)", async () => {
    pins.set("3506", "salt:restart");
    const token = await createPosSessionToken("3506", "テスト 生徒06", "salt:restart");
    const req = withCookie(`pos_session=${token}`);
    await revokePosSession(req);
    expect(await verifyPosSession(req)).toBeNull();
    // A fresh process: nothing in memory, the list not loaded yet.
    vi.resetModules();
    const fresh = await import("./posAuth");
    expect(await fresh.verifyPosSession(req)).toBeNull();
    await fresh.loadRevocations();
    expect(await fresh.verifyPosSession(req)).toBeNull();
    // A session that wasn't logged out still works after the restart.
    const other = await fresh.createPosSessionToken("3506", "テスト 生徒06", "salt:restart");
    expect(await fresh.verifyPosSession(withCookie(`pos_session=${other}`))).toMatchObject({ operatorId: "3506" });
  });
});

describe("device cookie", () => {
  it("names the device and who logged in on it, and is neither a session nor a gate cookie", async () => {
    const { ensureDevice, readDevice, rememberMemberOnDevice } = await import("./posAuth");
    const jar: Record<string, string> = {};
    const res = { cookie: (n: string, v: string) => { jar[n] = v; } } as any;
    const req = () => ({ hostname: "localhost", headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") } }) as any;
    const device = await ensureDevice(req(), res);
    expect(device.ids).toEqual([]);
    expect((await readDevice(req()))?.did).toBe(device.did);
    await rememberMemberOnDevice(req(), res, "3501");
    await rememberMemberOnDevice(req(), res, "3502");
    expect(await readDevice(req())).toEqual({ did: device.did, ids: ["3502", "3501"] });
    const token = jar.pos_device;
    pins.set("3501", "salt:hash-a");
    expect(await verifyPosSession(withCookie(`pos_session=${token}`))).toBeNull();
    expect(await verifyGate(withCookie(`pos_gate=${token}`))).toBe(false);
    const session = await createPosSessionToken("3501", "x", "salt:hash-a");
    expect(await readDevice(withCookie(`pos_device=${session}`))).toBeNull();
  });
});
