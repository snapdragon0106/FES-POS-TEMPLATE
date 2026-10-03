import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

// The member_pins table and the activity log, in memory.
// `pending`: first-login PINs not yet approved by an admin.
// `codes`: the request code of each waiting PIN.
const store = vi.hoisted(() => ({ pins: new Map<string, string>(), pending: new Set<string>(), codes: new Map<string, string>(), logs: [] as any[] }));
vi.mock("./db", () => ({
  getMemberPin: async (id: string) =>
    store.pins.has(id) ? { memberId: id, pin: store.pins.get(id), approved: !store.pending.has(id), requestCode: store.codes.get(id) ?? null } : undefined,
  listMemberPins: async () =>
    Array.from(store.pins.entries()).map(([memberId, pin]) => ({ memberId, pin, approved: !store.pending.has(memberId) })),
  upsertMemberPin: async (id: string, pin: string, approved = true, requestCode: string | null = null) => {
    store.pins.set(id, pin);
    if (approved) store.pending.delete(id);
    else store.pending.add(id);
    if (requestCode) store.codes.set(id, requestCode);
    else store.codes.delete(id);
  },
  createActivityLog: async (row: any) => { store.logs.push(row); },
}));

import { registerEntry, requireLoginForApp } from "./gate";
import { hashPin, verifyPin } from "./posAuth";
import { __resetRateLimits } from "./rateLimiter";
import { loginAlerts, maskName } from "./login";

// A real server: the 合言葉 page, the login page, and the gate in front of
// a stand-in for the app's files — so the test sees exactly what a
// browser gets, cookies and redirects included.
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
afterAll(() => server.close());
beforeEach(() => {
  __resetRateLimits();
  store.pins.clear();
  store.pending.clear();
  store.codes.clear();
  store.logs.length = 0;
  delete process.env.POS_ADMIN_RECOVERY_CODE;
});

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) ?? null;

/** A browser that has just entered the 合言葉: its gate and device cookies. */
async function gateCookie(): Promise<string> {
  const res = await fetch(base + "/", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: "test-access-code" }),
  });
  return `${cookieOf(res, "pos_gate")!}; ${cookieOf(res, "pos_device")!}`;
}

/** Only the 合言葉 cookie (a device that cleared the rest, or a script), claiming the given IP. */
async function bareGate(): Promise<string> {
  return (await gateCookie()).split("; ")[0];
}

/** A browser's cookies after a response (replacing ones it already had). */
function jar(cookie: string, res: Response): string {
  const map = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
  for (const c of res.headers.getSetCookie().map((x) => x.split(";")[0])) map.set(c.split("=")[0], c);
  return Array.from(map.values()).join("; ");
}

async function login(fields: Record<string, string>, cookie?: string, ip?: string) {
  const res = await fetch(base + "/", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie ?? (await gateCookie()), ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: new URLSearchParams(fields),
  });
  return { res, location: res.headers.get("location"), session: cookieOf(res, "pos_session") };
}

const page = async (path: string, cookie: string) =>
  (await fetch(base + path, { redirect: "manual", headers: { cookie, accept: "text/html" } }));

describe("login page (server-rendered)", () => {
  it("needs the 合言葉 first: without it, / is the 合言葉 page and a login post is just a wrong 合言葉", async () => {
    const res = await fetch(base + "/?id=3501", { redirect: "manual", headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("合言葉");
    expect(html).not.toContain("テスト 生徒01");
    const post = await login({ id: "3501", pin: "1234", pin2: "1234" }, "");
    expect(post.session).toBeNull();
    expect(post.location).toBe("/?e=wrong");
    expect(store.pins.has("3501")).toBe(false);
  });

  it("after the 合言葉, / is the login page (no redirect, no URL of its own) — the app is still not sent", async () => {
    const gate = await gateCookie();
    const root = await page("/", gate);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("個人番号");
    expect((await fetch(base + "/assets/index.js", { headers: { cookie: gate } })).status).toBe(404);
  });

  it("step 2 is decided by the server: set-PIN form for a new member, PIN form otherwise", async () => {
    const gate = await gateCookie();
    const first = await (await page("/?id=3501", gate)).text();
    // The name only in part: trying every number doesn't give the class list.
    expect(first).toContain("3501 - テ＊＊ 生＊＊＊");
    expect(first).not.toContain("テスト");
    expect(first).not.toContain("生徒01");
    expect(first).toContain('name="pin2"');
    expect(first).not.toContain("<script");
    store.pins.set("3501", await hashPin("1234"));
    const again = await (await page("/?id=3501", gate)).text();
    expect(again).not.toContain('name="pin2"');
    expect(again).toContain("入室する");
  });

  it("an ID outside the roster is refused", async () => {
    const gate = await gateCookie();
    expect(await (await page("/?id=9999", gate)).text()).toContain("不正な個人番号です");
    const r = await login({ id: "9999", pin: "1234" });
    expect(r.session).toBeNull();
    expect(r.location).toBe("/?e=id");
  });

  it("the right PIN opens a session, and the session opens the app", async () => {
    store.pins.set("3509", await hashPin("1234"));
    const gate = await gateCookie();
    const r = await login({ id: "3509", pin: "1234" }, gate);
    expect(r.res.status).toBe(303);
    expect(r.location).toBe("/");
    expect(r.session).toMatch(/^pos_session=/);
    expect(r.res.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
    const app = await page("/", `${gate}; ${r.session}`);
    expect(app.status).toBe(200);
    expect(await app.text()).toBe("APP /");
    expect(store.logs.at(-1)).toMatchObject({ operator: "3509", action: "login", operatorName: "テスト 生徒09" });
  });

  it("a wrong PIN opens nothing", async () => {
    store.pins.set("3509", await hashPin("1234"));
    const r = await login({ id: "3509", pin: "9999" });
    expect(r.session).toBeNull();
    expect(r.location).toBe("/?id=3509&e=wrong");
  });

  it("first login stores the PIN hashed, needs it typed twice, and opens nothing until an admin approves it by its code", async () => {
    store.pins.set("3509", await hashPin("4827")); // an admin already exists
    const mismatch = await login({ id: "3501", pin: "5739", pin2: "5730" });
    expect(mismatch.session).toBeNull();
    expect(mismatch.location).toContain("e=mismatch");
    expect(store.pins.has("3501")).toBe(false);

    const gate = await gateCookie();
    const first = await login({ id: "3501", pin: "5739", pin2: "5739" }, gate);
    expect(first.session).toBeNull();
    expect(first.location).toMatch(/^\/\?id=3501&e=pending&c=[A-Z]{4}$/);
    const code = first.location!.slice(-4);
    expect(store.codes.get("3501")).toBe(code);
    const stored = store.pins.get("3501")!;
    expect(stored).not.toBe("5739");
    await expect(verifyPin("5739", stored)).resolves.toBe(true);
    expect(store.pending.has("3501")).toBe(true);
    expect(store.logs.at(-1)).toMatchObject({ operator: "3501", action: "pin_request" });
    // The code is shown to the device that asked, to show the admin.
    const shown = await (await page(first.location!, gate)).text();
    expect(shown).toContain("申請コード");
    expect(shown).toContain(`>${code}<`);

    // Waiting: the page says so, and asking again replaces the request
    // (and its code) — the admin approves only the code on the member's screen.
    const waiting = await (await page("/?id=3501", gate)).text();
    expect(waiting).toContain("承認待ち");
    expect(waiting).toContain('name="pin2"');
    const noConfirm = await login({ id: "3501", pin: "5739" });
    expect(noConfirm.session).toBeNull();
    const again = await login({ id: "3501", pin: "3857", pin2: "3857" });
    expect(again.location).toMatch(/e=pending&c=[A-Z]{4}$/);
    await expect(verifyPin("3857", store.pins.get("3501")!)).resolves.toBe(true);
    expect(store.codes.get("3501")).toBe(again.location!.slice(-4));
    expect(store.pending.has("3501")).toBe(true);

    // Approved: now it works.
    store.pending.delete("3501");
    const ok = await login({ id: "3501", pin: "3857" });
    expect(ok.session).toMatch(/^pos_session=/);
  });

  it("an obvious PIN can't be chosen", async () => {
    for (const pin of ["1234", "0000", "1111", "9876", "1212", "2580", "2008"]) {
      const r = await login({ id: "3501", pin, pin2: pin });
      expect(r.location).toBe("/?id=3501&e=weak");
    }
    expect(store.pins.has("3501")).toBe(false);
    expect(await (await page("/?id=3501&e=weak", await gateCookie())).text()).toContain("推測されやすいPIN");
  });

  it("someone who knows only the 合言葉 and a number can't get in as a classmate who never logged in", async () => {
    store.pins.set("3509", await hashPin("4827"));
    const gate = await gateCookie();
    const r = await login({ id: "3512", pin: "3857", pin2: "3857" }, gate);
    expect(r.session).toBeNull();
    // Not even by going straight to the app with whatever cookies came back.
    const app = await page("/", jar(gate, r.res));
    expect(await app.text()).not.toBe("APP /");
  });

  it("no exception for the admin: with no admin PIN, whoever posts the admin's number first gets nothing", async () => {
    const r = await login({ id: "3509", pin: "3857", pin2: "3857" });
    expect(r.session).toBeNull();
    expect(r.location).toMatch(/e=pending/);
    expect(store.pending.has("3509")).toBe(true);
  });

  it("an existing PIN can't be overwritten by posting the first-login form", async () => {
    store.pins.set("3509", await hashPin("1234"));
    const r = await login({ id: "3509", pin: "0000", pin2: "0000" });
    expect(r.session).toBeNull();
    await expect(verifyPin("1234", store.pins.get("3509")!)).resolves.toBe(true);
  });

  it("accepts a legacy plaintext PIN and migrates it to a hash", async () => {
    store.pins.set("3501", "1234");
    const r = await login({ id: "3501", pin: "1234" });
    expect(r.session).toMatch(/^pos_session=/);
    expect(store.pins.get("3501")).not.toBe("1234");
  });

  it("a PIN that isn't 4 digits is refused before anything else", async () => {
    const r = await login({ id: "3501", pin: "12a4", pin2: "12a4" });
    expect(r.location).toContain("e=format");
    expect(store.pins.has("3501")).toBe(false);
  });

  it("5 wrong PINs lock that number on that device, even with the right one", async () => {
    store.pins.set("3509", await hashPin("1234"));
    const gate = await gateCookie();
    for (let i = 0; i < 5; i++) await login({ id: "3509", pin: "0000" }, gate);
    const r = await login({ id: "3509", pin: "1234" }, gate);
    expect(r.session).toBeNull();
    expect(r.location).toMatch(/e=limit&s=\d+/);
  });

  it("someone else's wrong PINs don't lock the admin out of their own phone", async () => {
    store.pins.set("3509", await hashPin("4827"));
    // The admin's phone has logged in before.
    let phone = await gateCookie();
    const first = await login({ id: "3509", pin: "4827" }, phone);
    phone = jar(phone, first.res).split("; ").filter((c) => !c.startsWith("pos_session=")).join("; ");
    // Another device (and scripts without a device cookie, faking IPs) type wrong PINs for the admin.
    const other = await gateCookie();
    for (let i = 0; i < 6; i++) await login({ id: "3509", pin: "0000" }, other);
    const bare = await bareGate();
    for (let i = 0; i < 6; i++) await login({ id: "3509", pin: "0000" }, bare, `10.0.0.${i}`);
    expect((await login({ id: "3509", pin: "4827" }, other)).location).toMatch(/e=limit/);
    // The number is now closed to devices that never logged in as it…
    expect((await login({ id: "3509", pin: "4827" }, await gateCookie())).location).toMatch(/e=limit/);
    // …but the admin's own phone still gets in.
    const mine = await login({ id: "3509", pin: "4827" }, phone);
    expect(mine.session).toMatch(/^pos_session=/);
  });

  it("guessing from ever-new devices is capped per number (10 an hour) and shop-wide (30 per 15 minutes)", async () => {
    store.pins.set("3501", await hashPin("4827"));
    const bare = await bareGate();
    for (let i = 0; i < 10; i++) {
      const r = await login({ id: "3501", pin: String(5000 + i) }, bare, `10.1.0.${i}`);
      expect(r.location).toBe("/?id=3501&e=wrong");
    }
    expect((await login({ id: "3501", pin: "4827" }, bare, "10.1.1.1")).location).toMatch(/e=limit/);
    // Spread over other numbers: the shop-wide cap.
    let wrong = 10;
    for (let n = 2; wrong < 30; n++) {
      const id = `35${String(n).padStart(2, "0")}`;
      store.pins.set(id, "salt:none");
      for (let i = 0; i < 5 && wrong < 30; i++, wrong++) await login({ id, pin: "4827" }, bare, `10.2.${n}.${i}`);
    }
    store.pins.set("3520", await hashPin("4827"));
    expect((await login({ id: "3520", pin: "4827" }, bare, "10.3.0.1")).location).toMatch(/e=limit/);
    // Every wrong PIN, and every lock, is in the log, and counted for the admin.
    expect(store.logs.filter((l) => l.action === "login_failed")).toHaveLength(30);
    expect(store.logs.filter((l) => l.action === "login_locked").map((l) => l.detail).join("\n")).toMatch(/店全体/);
    expect(loginAlerts().failures).toBeGreaterThanOrEqual(30);
  });

  it("accepts a same-site form (Sec-Fetch-Site) and rejects a cross-site or Origin: null one", async () => {
    const gate = await gateCookie();
    const post = (headers: Record<string, string>) =>
      fetch(base + "/", {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: gate, ...headers },
        body: new URLSearchParams({ id: "3501", pin: "1234", pin2: "1234" }),
      });
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect(store.pins.has("3501")).toBe(false);
    expect((await post({ "sec-fetch-site": "same-origin", origin: "null" })).status).toBe(303);
  });

  it("rejects a form posted from another site", async () => {
    const res = await fetch(base + "/", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: await gateCookie() },
      body: new URLSearchParams({ id: "3501", pin: "1234", pin2: "1234" }),
    });
    expect(res.status).toBe(403);
    expect(store.pins.has("3501")).toBe(false);
  });

  describe("admin recovery code", () => {
    const CODE = "correct-horse-battery-staple";

    it("off unless POS_ADMIN_RECOVERY_CODE is set: no link, and the form isn't there", async () => {
      store.pins.set("3509", await hashPin("4827"));
      const gate = await gateCookie();
      expect(await (await page("/?id=3509", gate)).text()).not.toContain("復旧コード");
      expect(await (await page("/?id=3509&recover=1", gate)).text()).not.toContain('name="recover"');
      const r = await login({ id: "3509", recover: "1", code: CODE, pin: "3857", pin2: "3857" }, gate);
      expect(r.session).toBeNull();
      await expect(verifyPin("4827", store.pins.get("3509")!)).resolves.toBe(true);
    });

    it("sets the admin's PIN, approved, replacing the old one — and logs it", async () => {
      process.env.POS_ADMIN_RECOVERY_CODE = CODE;
      store.pins.set("3509", await hashPin("4827"));
      const gate = await gateCookie();
      // On every number's page, so it doesn't point out the admin.
      expect(await (await page("/?id=3501", gate)).text()).toContain("管理者の復旧コードを使う");
      expect(await (await page("/?id=3509&recover=1", gate)).text()).toContain('name="recover"');
      const r = await login({ id: "3509", recover: "1", code: CODE, pin: "3857", pin2: "3857" }, gate);
      expect(r.session).toMatch(/^pos_session=/);
      await expect(verifyPin("3857", store.pins.get("3509")!)).resolves.toBe(true);
      expect(store.pending.has("3509")).toBe(false);
      expect(store.logs.some((l) => l.action === "admin_recover" && l.operator === "3509")).toBe(true);
    });

    it("wrong code, or a non-admin number, sets nothing; 5 wrong codes close it for an hour for everyone", async () => {
      process.env.POS_ADMIN_RECOVERY_CODE = CODE;
      const nonAdmin = await login({ id: "3501", recover: "1", code: CODE, pin: "3857", pin2: "3857" });
      expect(nonAdmin.location).toBe("/?id=3501&e=code&recover=1");
      expect(store.pins.has("3501")).toBe(false);
      const bare = await bareGate();
      for (let i = 0; i < 4; i++) {
        const r = await login({ id: "3509", recover: "1", code: `guess-${i}-xxxxxxxxxx`, pin: "3857", pin2: "3857" }, bare, `10.9.0.${i}`);
        expect(r.location).toBe("/?id=3509&e=code&recover=1");
      }
      const locked = await login({ id: "3509", recover: "1", code: CODE, pin: "3857", pin2: "3857" }, await gateCookie());
      expect(locked.session).toBeNull();
      expect(locked.location).toMatch(/e=limit/);
      expect(store.logs.filter((l) => l.action === "admin_recover_failed")).toHaveLength(5);
    });

    it("refuses to start with a short code", async () => {
      const { assertRecoveryConfig } = await import("./adminRecovery");
      process.env.POS_ADMIN_RECOVERY_CODE = "short";
      expect(() => assertRecoveryConfig()).toThrow();
      process.env.POS_ADMIN_RECOVERY_CODE = CODE;
      expect(() => assertRecoveryConfig()).not.toThrow();
    });
  });

  it("maskName keeps the first letter of each part", () => {
    expect(maskName("山田 太郎")).toBe("山＊ 太＊");
    expect(maskName("佐藤　花")).toBe("佐＊　花＊");
  });

  it("the wait shown can't be set to anything from the URL", async () => {
    const gate = await gateCookie();
    expect(await (await page("/?id=3501&e=limit&s=99999999", gate)).text()).not.toContain("99999999");
    expect(await (await page("/?id=3501&e=limit&s=1.5", gate)).text()).not.toContain("試行回数");
  });
});
