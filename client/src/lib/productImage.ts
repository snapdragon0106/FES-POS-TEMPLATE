/**
 * Turns a photo picked on a phone (often several MB) into a small square
 * image before it is uploaded. Every register downloads every product
 * photo, so what gets stored is what all of them pay for over festival
 * Wi-Fi — a 256px square is ~10–30 KB and still sharp at the largest size
 * the register shows it (56px on a 3x screen = 168px).
 *
 * The server re-checks format and size (server/productImage.ts); this is
 * only where the shrinking happens.
 */

const OUTPUT_SIZE = 256;
// Past this the phone may run out of memory decoding it; no real product
// photo is anywhere near.
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

/**
 * Center-crops `file` to a square, scales it to 256px and returns a data
 * URL (WebP where the browser can encode it, JPEG otherwise). Throws an
 * Error with a Japanese message suitable for a toast.
 */
export async function resizeImageFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選んでください");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("画像のファイルが大きすぎます");
  }
  const url = URL.createObjectURL(file);
  try {
    let img: HTMLImageElement;
    try {
      img = await loadImage(url);
    } catch {
      // e.g. HEIC on a desktop browser that can't decode it.
      throw new Error("この画像は読み込めませんでした。JPEGかPNGの画像を選んでください");
    }
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error("この画像は読み込めませんでした");
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を処理できませんでした");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    // Older Safari can't encode WebP and silently returns PNG instead,
    // which would be several times larger — use JPEG there. JPEG has no
    // transparency, so paint white under the picture first.
    const webp = canvas.toDataURL("image/webp", 0.82);
    if (webp.startsWith("data:image/webp")) return webp;
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Cacheable URL for a product's photo; changes whenever the photo does. */
export function productImageUrl(productId: number, imageHash: string): string {
  return `/api/product-images/${productId}?v=${encodeURIComponent(imageHash)}`;
}
