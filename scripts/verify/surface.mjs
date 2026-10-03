// What someone with no cookies can learn from the server: every path,
// method and header variant below is sent without cookies, and the
// distinct answers are listed. Read-only — it never submits a 合言葉
// (that would count towards the rate limit), so it is safe to point at
// production too:  BASE=https://<your-service>.onrender.com node scripts/verify/surface.mjs
//
// The expected result: the 合言葉 page at "/", a redirect to "/" for other
// pages, the public files (icons, robots.txt, manifest, theme.css, the
// self-removing sw.js), a bare status from /api/health, and one identical
// 404 for everything else — no app code, no framework error pages, no
// validators or timestamps that say what runs the site or when it was
// deployed.
import { createHash } from "crypto";

const BASE = process.env.BASE ?? "http://localhost:3200";
const PATHS = [
  "/", "/?id=3501", "/?e=wrong", "/index.html", "/pos", "/admin", "/login", "/favicon.ico",
  "/robots.txt", "/sw.js", "/registerSW.js", "/workbox-abc.js", "/manifest.webmanifest", "/theme.css",
  "/favicon-32x32.png", "/icon-192.png", "/apple-touch-icon.png",
  "/assets/", "/assets/index.js", "/assets/index.css",
  "/api", "/api/", "/api/health", "/api/trpc", "/api/trpc/posSession.me", "/api/trpc/product.list",
  "/api/trpc/nope", "/api/product-images/1", "/api/payments/webhook/mock", "/api/login", "/api/gate",
  "/.env", "/.git/config", "/package.json", "/server/db.ts", "/src/main.tsx", "/@vite/client",
  "/node_modules/", "/%", "/%2e%2e/%2e%2e/etc/passwd", "/.well-known/security.txt", "/sitemap.xml",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
// Things that must never reach someone without cookies.
const LEAKS = [/assets\/index-[\w-]+\.(js|css)/, /<script/i, /Cannot (GET|POST|PUT|DELETE|PATCH)/, /<pre>/, /\bat .+\.(js|ts):\d+/,
  /No procedure found/i, /TRPC/, /express/i, /server\/[\w/]+\.ts/, /client\/src/, /\/\*[\s\S]*?\*\//];
// The one script a page may carry: Cloudflare Turnstile's, when it is on
// (server/turnstile.ts). Removed before looking, so any other <script still counts.
const TURNSTILE_TAG = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
const HEADERS_OF_INTEREST = ["etag", "last-modified", "x-powered-by", "allow", "accept-ranges", "set-cookie"];

const seen = new Map();
let leaks = 0;
for (const path of PATHS) {
  for (const method of METHODS) {
    for (const accept of ["text/html", "*/*"]) {
      if (method === "POST" && path.split("?")[0] === "/") continue; // the 合言葉 form: not probed (rate limit)
      let res;
      try {
        res = await fetch(BASE + path, { method, redirect: "manual", headers: { accept } });
      } catch (e) {
        console.log(`  ERR  ${method} ${path}: ${e.message}`);
        continue;
      }
      const body = method === "HEAD" ? "" : await res.text();
      const type = (res.headers.get("content-type") ?? "").split(";")[0];
      const extra = HEADERS_OF_INTEREST.filter((h) => res.headers.get(h)).map((h) => `${h}=${res.headers.get(h).slice(0, 40)}`);
      const location = res.headers.get("location");
      const hash = createHash("sha1").update(body).digest("hex").slice(0, 8);
      const scanned = body.split(TURNSTILE_TAG).join("");
      const found = LEAKS.filter((re) => re.test(scanned) && !(path === "/sw.js" && re.source === "\\/\\*[\\s\\S]*?\\*\\/")).map(String);
      const key = `${res.status} ${type || "-"} ${location ? "→ " + location : ""} body:${hash} ${extra.join(" ")}`;
      if (!seen.has(key)) seen.set(key, { examples: [], body: body.replace(/\s+/g, " ").slice(0, 90), found });
      const entry = seen.get(key);
      if (entry.examples.length < 6) entry.examples.push(`${method} ${path}${accept === "*/*" ? " (no html)" : ""}`);
      else entry.more = (entry.more ?? 0) + 1;
      if (found.length) leaks++;
    }
  }
}
for (const [key, v] of seen) {
  console.log(`\n${v.found.length ? "LEAK " : "     "}${key}`);
  console.log(`       e.g. ${v.examples.join(", ")}${v.more ? ` (+${v.more} more)` : ""}`);
  if (v.body) console.log(`       body: ${v.body}`);
  if (v.found.length) console.log(`       matched: ${v.found.join(" ")}`);
}
console.log(`\n${seen.size} distinct answers; ${leaks ? `${leaks} responses LEAK something` : "no leaks found"}`);
process.exit(leaks ? 1 : 0);
