import { createHash } from "crypto";
import type { Express } from "express";
import { TRPCError } from "@trpc/server";
import { getProductImage } from "./db";
import { verifyPosSession } from "./posAuth";

/**
 * Product photos.
 *
 * The register shrinks a photo to a small square before uploading it
 * (client/src/lib/productImage.ts), so a real upload is ~10–30 KB. The cap
 * below is the server's own guarantee rather than trust in that client:
 * every register downloads every photo, over festival Wi-Fi.
 */
export const MAX_IMAGE_BYTES = 200 * 1024;

// Only raster formats, each recognised by its leading bytes. SVG is
// deliberately absent: it can carry script, and these are served from our
// own origin.
const FORMATS: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) =>
    b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

const DATA_URL = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validates a `data:image/...;base64,...` upload and returns what gets
 * stored: the mime type, the base64 body, and a content hash that becomes
 * the image's cache key (products.imageHash).
 */
export function parseImageDataUrl(input: string): { mime: string; data: string; hash: string } {
  const m = DATA_URL.exec(input);
  if (!m) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "画像の形式が正しくありません" });
  }
  const [, mime, data] = m;
  const check = FORMATS[mime];
  if (!check) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "JPEG・PNG・WebPの画像のみ使えます" });
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "画像のサイズが大きすぎます" });
  }
  if (!check(bytes)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "画像の中身が形式と一致しません" });
  }
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { mime, data, hash };
}

/**
 * GET /api/product-images/:id?v=<hash>
 *
 * The URL carries the content hash (products.imageHash), so a response for
 * the current hash can be cached for good: a changed photo has a new hash
 * and therefore a new URL. Each phone downloads each photo once instead of
 * with every 8-second poll. A stale or missing `v` is answered but not
 * cached, so an old URL never pins an old photo.
 *
 * Requires a POS session like the rest of the API. `private` keeps shared
 * caches out of it; <img> requests carry the session cookie (same origin).
 */
export function registerProductImageRoute(app: Express): void {
  app.get("/api/product-images/:id", async (req, res) => {
    const session = await verifyPosSession(req);
    if (!session) {
      res.setHeader("Cache-Control", "no-store");
      res.status(401).end();
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).end();
      return;
    }
    try {
      const image = await getProductImage(id);
      if (!image || !FORMATS[image.mime]) {
        res.setHeader("Cache-Control", "no-store");
        res.status(404).end();
        return;
      }
      const current = typeof req.query.v === "string" && req.query.v === image.hash;
      res.setHeader("Content-Type", image.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", current ? "private, max-age=31536000, immutable" : "private, no-cache");
      if (image.hash) res.setHeader("ETag", `"${image.hash}"`);
      // send (not end) so Express answers a matching If-None-Match with 304.
      res.send(Buffer.from(image.data, "base64"));
    } catch (error) {
      console.error("[ProductImage] failed to load image:", error);
      res.setHeader("Cache-Control", "no-store");
      res.status(503).end();
    }
  });
}
