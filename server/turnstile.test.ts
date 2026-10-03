import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

// member_pins and the activity log, in memory (as in login.test.ts).
const store = vi.hoisted(() => ({ pins: new Map<string, string>(), logs: [] as any[] }));
vi.mock("./db", () => ({
  getMemberPin: async (id: string) => (store.pins.has(id) ? { memberId: id, pin: store.pins.get(id), approved: true } : undefined),
  listMemberPins: async () => Array.from(store.pins.entries()).map(([memberId, pin]) => ({ memberId, pin, approved: true })),
  upsertMemberPin: async (id: string, pin: string) => { store.pins.set(id, pin); },
  createActivityLog: async (row: any) => { store.logs.push(row); },
}));

import { registerEntry, requireLoginForApp } from "./gate";
import { hashPin } from "./posAuth";
import { __resetRateLimits } from "./rateLimiter";
import { assertTurnstileConfig } from "./turnstile";

// Cloudflare's siteverify, faked: every other request (the test talking
// to its own server) goes through the real fetch.
type Mode = "pass" | "fail" | "down" | "500" | { action: string };
let mode: Mode = "pass";
const calls: URLSearchParams[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://challenges.cloudflare.com/")) return realFetch(input, init);
  calls.push(new URLSearchParams(String(init?.body)));
  if (mode === "down") throw new TypeError("fetch failed");
  if (mode === "500") return new Response("oops", { status: 500 });
  const body =
    mode === "pass" ? { success: true, action: "" }
    : mode === "fail" ? { success: false, "error-codes": ["invalid-input-response"] }
    : { success: true, action: mode.action };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
});

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  registerEntry(app);
  app.use(requireLoginForApp);
  app.use((req, res) => res.status(200).send(`APP ${req.path}`));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  __resetRateLimits();
  store.pins.clear();
  store.logs.length = 0;
  calls.length = 0;
  mode = "pass";
  process.env.TURNSTILE_SITE_KEY = "0x4AAAAAAA-test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "0x4AAAAAAA-test-secret";
});
afterEach(() => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) ?? null;
const post = (fields: Record<string, string>, cookie = "") =>
  fetch(base + "/", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

describe("Turnstile off (no keys): nothing changes", () => {
  it("no widget, no script, the old CSP, and Cloudflare is never asked", async () => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const res = await fetch(base + "/");
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("cf-turnstile");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    const ok = await post({ code: "test-access-code" });
    expect(ok.headers.get("location")).toBe("/");
    expect(cookieOf(ok, "pos_gate")).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses to start with only one of the two keys", () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(() => assertTurnstileConfig()).toThrow(/half configured/);
    delete process.env.TURNSTILE_SITE_KEY;
    expect(() => assertTurnstileConfig()).not.toThrow();
  });
});

describe("Turnstile on the 合言葉 form", () => {
  it("shows the widget for this form, loads only Cloudflare's script, and the CSP allows exactly that", async () => {
    const res = await fetch(base + "/", { headers: { cookie: "pos_theme=dark" } });
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile" data-sitekey="0x4AAAAAAA-test-site-key" data-action="gate"');
    expect(html).toContain('data-theme="dark"');
    expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>']);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src https://challenges.cloudflare.com;");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com;");
    expect(html).not.toContain("0x4AAAAAAA-test-secret");
  });

  it("the right 合言葉 without a token opens nothing, and Cloudflare isn't asked about nothing", async () => {
    const res = await post({ code: "test-access-code" });
    expect(res.headers.get("location")).toBe("/?e=bot");
    expect(cookieOf(res, "pos_gate")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a token Cloudflare rejects opens nothing; the secret and token are what was asked about", async () => {
    mode = "fail";
    const res = await post({ code: "test-access-code", "cf-turnstile-response": TOKEN });
    expect(res.headers.get("location")).toBe("/?e=bot");
    expect(cookieOf(res, "pos_gate")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].get("secret")).toBe("0x4AAAAAAA-test-secret");
    expect(calls[0].get("response")).toBe(TOKEN);
  });

  it("a token made for the login form doesn't pass the 合言葉 form", async () => {
    mode = { action: "login" };
    const res = await post({ code: "test-access-code", "cf-turnstile-response": TOKEN });
    expect(res.headers.get("location")).toBe("/?e=bot");
    expect(cookieOf(res, "pos_gate")).toBeNull();
  });

  it("Cloudflare unreachable or failing: refused (fail closed) with its own message", async () => {
    for (const m of ["down", "500"] as const) {
      mode = m;
      const res = await post({ code: "test-access-code", "cf-turnstile-response": TOKEN });
      expect(res.headers.get("location")).toBe("/?e=unavailable");
      expect(cookieOf(res, "pos_gate")).toBeNull();
    }
    const page = await (await fetch(base + "/?e=unavailable")).text();
    expect(page).toContain("確認サービスにつながりませんでした");
    expect(await (await fetch(base + "/?e=bot")).text()).toContain("確認が完了しませんでした");
  });

  it("a genuine token lets the 合言葉 be checked: right opens, wrong is still wrong", async () => {
    const wrong = await post({ code: "nope", "cf-turnstile-response": TOKEN });
    expect(wrong.headers.get("location")).toBe("/?e=wrong");
    const ok = await post({ code: "test-access-code", "cf-turnstile-response": TOKEN });
    expect(ok.headers.get("location")).toBe("/");
    expect(cookieOf(ok, "pos_gate")).not.toBeNull();
  });

  it("failed checks don't count as wrong answers (a bad connection can't lock anyone out)", async () => {
    mode = "fail";
    for (let i = 0; i < 8; i++) await post({ code: "nope", "cf-turnstile-response": TOKEN });
    mode = "pass";
    const ok = await post({ code: "test-access-code", "cf-turnstile-response": TOKEN });
    expect(ok.headers.get("location")).toBe("/");
  });
});

describe("Turnstile on the PIN form", () => {
  async function gate(): Promise<string> {
    return cookieOf(await post({ code: "test-access-code", "cf-turnstile-response": TOKEN }), "pos_gate")!;
  }

  it("the PIN form carries the widget for login; the 個人番号 step (a GET form) doesn't need one", async () => {
    const cookie = await gate();
    const idStep = await (await fetch(base + "/", { headers: { cookie } })).text();
    expect(idStep).not.toContain("cf-turnstile");
    const pinStep = await (await fetch(base + "/?id=3501", { headers: { cookie } })).text();
    expect(pinStep).toContain('data-action="login"');
    expect(pinStep).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
  });

  it("the right PIN without a genuine token opens no session and isn't counted as a wrong PIN", async () => {
    store.pins.set("3501", await hashPin("1234"));
    const cookie = await gate();
    calls.length = 0;
    const none = await post({ id: "3501", pin: "1234" }, cookie);
    expect(none.headers.get("location")).toBe("/?id=3501&e=bot");
    expect(cookieOf(none, "pos_session")).toBeNull();
    mode = "fail";
    for (let i = 0; i < 6; i++) {
      const r = await post({ id: "3501", pin: "1234", "cf-turnstile-response": TOKEN }, cookie);
      expect(r.headers.get("location")).toBe("/?id=3501&e=bot");
    }
    mode = { action: "gate" };
    expect((await post({ id: "3501", pin: "1234", "cf-turnstile-response": TOKEN }, cookie)).headers.get("location")).toBe("/?id=3501&e=bot");
    mode = "down";
    expect((await post({ id: "3501", pin: "1234", "cf-turnstile-response": TOKEN }, cookie)).headers.get("location")).toBe("/?id=3501&e=unavailable");

    mode = "pass";
    const ok = await post({ id: "3501", pin: "1234", "cf-turnstile-response": TOKEN }, cookie);
    expect(ok.headers.get("location")).toBe("/");
    expect(cookieOf(ok, "pos_session")).not.toBeNull();
  });

  it("the message is shown on the PIN form", async () => {
    const cookie = await gate();
    const html = await (await fetch(base + "/?id=3501&e=bot", { headers: { cookie } })).text();
    expect(html).toContain("確認が完了しませんでした");
  });
});
