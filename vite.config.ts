import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { transform } from "esbuild";
import { defineConfig, type Plugin } from "vite";

// The Manus build plugins are gone: vite-plugin-manus-runtime inlined an
// editor bridge script into every production page, jsx-loc stamped every
// element with its source file and line (data-loc="client/src/…:76"), and
// the debug collector served its script from client/public/__manus__.
// None of it is needed outside Manus's editor, and all of it was public.
// No service worker any more (server/serviceWorker.ts explains why): the
// manifest for "Add to Home Screen" is a plain file in client/public.
// Production builds ship no comments in anything served as-is: the app's
// index.html (its HTML comments and the inline theme script's notes) and
// client/public/theme.css, which is public — the 合言葉 page links it — and
// whose comments named files and design decisions. The JS/CSS bundles are
// already minified by Vite. (The CSP hash of the inline script is computed
// by the server from the built file, so minifying it here is safe.)
function stripComments(): Plugin {
  let outDir = "";
  return {
    name: "fes-pos-strip-comments",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        html = html.replace(/<!--[\s\S]*?-->\s*/g, "");
        const inline = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
        for (const m of inline) {
          const { code } = await transform(m[1], { loader: "js", minify: true });
          html = html.replace(m[0], `<script>${code.trim()}</script>`);
        }
        return html;
      },
    },
    async closeBundle() {
      const file = path.resolve(outDir, "theme.css");
      if (!fs.existsSync(file)) return;
      const { code } = await transform(fs.readFileSync(file, "utf-8"), { loader: "css", minify: true, legalComments: "none" });
      fs.writeFileSync(file, code);
    },
  };
}

const plugins = [
  react(),
  tailwindcss(),
  stripComments(),
];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
