import { createHash } from "crypto";
import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { sendNotFound } from "../pages";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

/**
 * Content-Security-Policy for the app's HTML: scripts only from this
 * site (plus the one inline theme script in index.html, allowed by its
 * hash), fonts from Google Fonts, API calls only to this site, no
 * framing, no plugins. If someone ever managed to get markup into a
 * page, the browser still wouldn't run script from anywhere else.
 * Inline style attributes stay allowed: the React UI uses them throughout.
 */
function appCsp(indexHtml: string): string {
  const hashes = Array.from(indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // Only reached past requireGateForApp, so these are for gated browsers:
  // "private" keeps any shared cache from storing them for someone else.
  // The hashed bundle files never change; the HTML is re-checked each time.
  const indexPath = path.resolve(distPath, "index.html");
  const csp = fs.existsSync(indexPath) ? appCsp(fs.readFileSync(indexPath, "utf-8")) : null;

  app.use(
    express.static(distPath, {
      // No validators: Last-Modified was the build time (= when the site
      // was last deployed) on every file, and the ETag format names the
      // server. Caching is by Cache-Control instead — the hashed bundle is
      // immutable, the public files (icons, manifest) are cached for a day,
      // theme.css is fetched as /theme.css?v=<content hash>.
      etag: false,
      lastModified: false,
      acceptRanges: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "private, no-cache");
          if (csp) res.setHeader("Content-Security-Policy", csp);
        }
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        else if (filePath.endsWith(`${path.sep}theme.css`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "public, max-age=86400");
      },
    })
  );

  // Any other in-app path gets index.html (the app routes on the client).
  // GET/HEAD only — requireLoginForApp already turns everything else away,
  // this just makes sure the app's HTML can never be the answer to a POST.
  app.use("*", (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendNotFound(res);
    res.setHeader("Cache-Control", "private, no-cache");
    if (csp) res.setHeader("Content-Security-Policy", csp);
    res.sendFile(indexPath, { etag: false, lastModified: false, acceptRanges: false });
  });
}
