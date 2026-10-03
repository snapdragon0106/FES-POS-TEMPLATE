import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { guardApi, hideApiWithoutSession, notFoundApi, registerEntry, requireLoginForApp } from "./gate";
import { createPosSessionToken } from "./posAuth";
import { registerServiceWorkerCleanup } from "./serviceWorker";
import { __resetRateLimits } from "./rateLimiter";

// A real HTTP server with the gate in front of a stand-in for the app's
// static files, so the redirects, cookies and status codes are the ones
// a browser actually gets.
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  registerServiceWorkerCleanup(app);
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", hideApiWithoutSession);
  registerEntry(app);
  app.use("/api/trpc", guardApi);
  app.get("/api/trpc/x", (_req, res) => res.json({ ok: true }));
  app.post("/api/trpc/x", (_req, res) => res.json({ ok: true }));
  app.use("/api", notFoundApi);
  app.use(requireLoginForApp);
  app.use((req, res) => res.status(200).send(`APP ${req.path}`));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => __resetRateLimits());

const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
const post = (code: string, headers: Record<string, string> = {}) =>
  fetch(base + "/", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ code }),
  });

describe("合言葉 gate in front of the app", () => {
  it("without the cookie, the app is never sent: pages go to the gate, files are 404", async () => {
    const root = await get("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("合言葉");
    const pos = await get("/pos", { headers: { accept: "text/html" } });
    expect(pos.status).toBe(302);
    expect(pos.headers.get("location")).toBe("/");
    expect((await get("/assets/index-abc.js")).status).toBe(404);
    expect((await get("/index.html")).status).toBe(404);
  });

  it("icons, the manifest and robots.txt stay public (a browser fetches the manifest without cookies)", async () => {
    for (const p of ["/icon-192.png", "/favicon-32x32.png", "/robots.txt", "/manifest.webmanifest", "/theme.css"]) {
      expect((await get(p)).status).toBe(200);
    }
    // The old workbox files are gone; nothing else is public.
    for (const p of ["/registerSW.js", "/workbox-abc123.js"]) {
      expect((await get(p)).status).toBe(404);
    }
  });

  it("/sw.js is public and only removes an old service worker: no cache, no fetch handler", async () => {
    const res = await get("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const js = await res.text();
    expect(js).toContain("skipWaiting");
    expect(js).toContain("caches.delete");
    expect(js).toContain("registration.unregister");
    expect(js).toContain("navigate");
    expect(js).not.toMatch(/addEventListener\(["']fetch/);
    expect(js).not.toMatch(/importScripts|precache/);
  });

  it("the gate page itself contains no app code and a strict CSP", async () => {
    const res = await get("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("合言葉");
    expect(html).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("the pages use the app's look: /theme.css, time-of-day tint, and dark mode from the pos_theme cookie", async () => {
    const light = await (await get("/")).text();
    expect(light).toMatch(/<link rel="stylesheet" href="\/theme\.css\?v=[0-9a-f]{10}">/);
    expect(light).toMatch(/<html lang="ja" data-daytime="(morning|day|evening|night)">/);
    expect(light).toContain('class="ws-card"');
    const dark = await (await get("/", { headers: { cookie: "pos_theme=dark" } })).text();
    expect(dark).toMatch(/<html lang="ja" class="dark" data-daytime=/);
    expect(dark).not.toContain("<script");
  });

  it("a wrong 合言葉 sets no cookie; the right one does, and then the app is served", async () => {
    const wrong = await post("nope");
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location")).toBe("/?e=wrong");
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await post("test-access-code");
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/");
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^pos_gate=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // The 合言葉 alone still doesn't get the app: next is the login page.
    const root = await get("/", { headers: { cookie: cookie.split(";")[0] } });
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("個人番号");
    expect((await get("/assets/index-abc.js", { headers: { cookie: cookie.split(";")[0] } })).status).toBe(404);
  });

  it("without a session, every API path looks like one that doesn't exist (except the health check)", async () => {
    const missing = await get("/api/no-such-thing");
    const body = await missing.text();
    expect(missing.status).toBe(404);
    for (const p of ["/api/login", "/api/gate", "/api/trpc/x", "/api/product-images/1"]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(body);
      expect(res.headers.get("location")).toBeNull();
    }
    expect((await get("/api/health")).status).toBe(200);

    // The 合言葉 alone doesn't open the API any more: nothing before login uses it.
    const right = await post("test-access-code");
    const gate = right.headers.get("set-cookie")!.split(";")[0];
    const gateOnly = await get("/api/trpc/x", { headers: { cookie: gate } });
    expect(gateOnly.status).toBe(404);
    expect(await gateOnly.text()).toBe(body);
    // A logged-in session does.
    const session = `pos_session=${await createPosSessionToken("3501", "テスト 生徒01", "salt:hash")}`;
    expect((await get("/api/trpc/x", { headers: { cookie: `${gate}; ${session}` } })).status).toBe(200);
    // The old page URLs are gone for everyone.
    expect((await get("/api/login", { headers: { cookie: `${gate}; ${session}` } })).status).toBe(404);
  });

  it("anything but GET/HEAD outside /api (except the form post to /) is the same 404 — never the app's HTML", async () => {
    const reference = await (await get("/api/no-such-thing")).text();
    const session = `pos_session=${await createPosSessionToken("3501", "テスト 生徒01", "salt:hash")}`;
    for (const cookie of ["", session]) {
      for (const [method, path] of [["PUT", "/"], ["DELETE", "/"], ["PATCH", "/pos"], ["OPTIONS", "/"], ["POST", "/pos"], ["POST", "/index.html"]]) {
        const res = await get(path, { method, headers: cookie ? { cookie } : {} });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text()).toBe(reference);
      }
    }
    // Files that aren't public answer the same way.
    const file = await get("/assets/index-abc.js");
    expect(file.status).toBe(404);
    expect(await file.text()).toBe(reference);
  });

  it("redirects carry nothing but the Location header (no framework text)", async () => {
    const page = await get("/pos", { headers: { accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
    expect(await page.text()).toBe("");
    const wrong = await post("nope");
    expect(wrong.headers.get("location")).toBe("/?e=wrong");
    expect(await wrong.text()).toBe("");
  });

  it("faking a new IP per attempt doesn't get around the limit", async () => {
    for (let i = 0; i < 30; i++) {
      await post(`guess-${i}`, { "x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i % 250}` });
    }
    const res = await post("test-access-code", { "x-forwarded-for": "10.9.9.9" });
    expect(res.headers.get("location")).toMatch(/e=limit/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the shop-wide lock doesn't keep out a device that has entered the 合言葉 before (e.g. after it was changed)", async () => {
    const first = await post("test-access-code");
    const device = first.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("pos_device="))!;
    expect(device).toBeTruthy();
    for (let i = 0; i < 30; i++) {
      await post(`guess-${i}`, { "x-forwarded-for": `10.5.${Math.floor(i / 250)}.${i % 250}` });
    }
    // A new device waits…
    expect((await post("test-access-code", { "x-forwarded-for": "10.6.6.6" })).headers.get("location")).toMatch(/e=limit/);
    // …a known one (its 30-day 合言葉 cookie gone, or the 合言葉 changed) gets in.
    const known = await post("test-access-code", { cookie: device });
    expect(known.headers.get("location")).toBe("/");
    expect(known.headers.getSetCookie().join(";")).toMatch(/pos_gate=/);
    // Its own wrong answers still have their limit.
    for (let i = 0; i < 5; i++) await post(`x-${i}`, { cookie: device });
    expect((await post("test-access-code", { cookie: device })).headers.get("location")).toMatch(/e=limit/);
  });

  it("the same sender is locked after 5 wrong answers", async () => {
    for (let i = 0; i < 5; i++) await post(`guess-${i}`, { "x-forwarded-for": "10.1.1.1" });
    const res = await post("test-access-code", { "x-forwarded-for": "10.1.1.1" });
    expect(res.headers.get("location")).toMatch(/e=limit/);
  });

  it("the API takes changes only as JSON from this site, and nothing is cached", async () => {
    const session = `pos_session=${await createPosSessionToken("3501", "テスト 生徒01", "salt:hash")}`;
    const send = (headers: Record<string, string>, body = "{}") =>
      get("/api/trpc/x", { method: "POST", headers: { cookie: session, ...headers }, body });
    expect((await send({ "content-type": "application/json", "sec-fetch-site": "same-origin" })).status).toBe(200);
    // A form from another site (multipart ran logout before), or text/plain.
    const form = new FormData();
    form.set("x", "1");
    expect((await get("/api/trpc/x", { method: "POST", headers: { cookie: session, "sec-fetch-site": "cross-site" }, body: form })).status).toBe(403);
    expect((await get("/api/trpc/x", { method: "POST", headers: { cookie: session, "sec-fetch-site": "same-origin" }, body: form })).status).toBe(403);
    expect((await send({ "content-type": "text/plain", "sec-fetch-site": "same-origin" })).status).toBe(403);
    // JSON, but from another site / same-site subdomain / Origin elsewhere.
    expect((await send({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ "content-type": "application/json", "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    const read = await get("/api/trpc/x", { headers: { cookie: session } });
    expect(read.headers.get("cache-control")).toBe("no-store");
  });
});
