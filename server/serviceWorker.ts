import type { Express } from "express";

/**
 * FES POS has no service worker any more. This is what /sw.js answers
 * instead: a worker whose only job is to remove the one an older version
 * installed, then get out of the way.
 *
 * Why: until the login moved to the server, the app shipped a service
 * worker (vite-plugin-pwa) that kept a copy of the whole app — HTML
 * included — and answered every page load from it. On a phone that had
 * opened the app back then, that copy kept showing the old 合言葉 screen,
 * which calls APIs that no longer exist ("通信エラーが発生しました"), and
 * the server's own pages never got a chance to load. It could not update
 * itself either: installing the newer worker meant downloading the app's
 * JS/CSS, which the server only sends to a logged-in browser (server/gate.ts),
 * so every install failed and the old copy stayed in charge.
 *
 * A browser re-fetches /sw.js on every page load of a site with a worker
 * installed, so this reaches every such phone the next time it opens the
 * site: it installs without downloading anything, deletes every cache the
 * old worker kept (including the old bundle), unregisters, and reloads
 * the open pages — which then come from the server like on any other
 * browser. It has no fetch handler, so while it exists every request goes
 * to the network.
 *
 * The app no longer registers a worker at all: pages always come from the
 * server (who gets which page is decided per request from the cookies),
 * the hashed JS/CSS are cached by the browser for a year anyway, and a
 * register can't work offline. The manifest (client/public) is all that
 * "Add to Home Screen" needs.
 *
 * Must stay public and uncached: a phone with the old worker has no
 * cookies that would let it through, and it has to see this exact script.
 */
// Served as-is to anyone, so no comments inside the script itself.
export const CLEANUP_SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: "window" });
    windows.forEach((client) => client.navigate(client.url).catch(() => undefined));
  })());
});
`;

export function registerServiceWorkerCleanup(app: Express): void {
  app.get("/sw.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript").send(CLEANUP_SERVICE_WORKER);
  });
}
