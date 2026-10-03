import { useState, type CSSProperties } from "react";
import { Package } from "lucide-react";
import { productImageUrl } from "@/lib/productImage";

type Size = "xs" | "sm" | "md" | "lg";

interface Props {
  productId: number;
  emoji: string;
  imageHash?: string | null;
  /**
   * xs: inline in a line of text · sm: .ws-icon-chip-sm (34px) ·
   * md: .ws-icon-chip (44px) · lg: register tile — 44px chip for an emoji,
   * a 56px rounded square for a photo so it is big enough to recognise.
   */
  size?: Size;
  className?: string;
  style?: CSSProperties;
}

/**
 * A product's photo when it has one, otherwise its emoji — in the same
 * chip the emoji always sat in, so rows keep their layout either way.
 * If the photo fails to load (offline, deleted meanwhile) it falls back to
 * the emoji rather than a broken-image icon.
 */
export default function ProductIcon({ productId, emoji, imageHash, size = "md", className = "", style }: Props) {
  const [failedHash, setFailedHash] = useState<string | null>(null);
  const showImage = !!imageHash && failedHash !== imageHash;

  if (size === "xs") {
    if (!showImage) return <span className={className} style={style}>{emoji || "📦"}</span>;
    return (
      <img
        src={productImageUrl(productId, imageHash!)}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailedHash(imageHash!)}
        className={`inline-block align-[-4px] object-cover ${className}`}
        style={{ width: 18, height: 18, borderRadius: 5, ...style }}
      />
    );
  }

  const chipClass = size === "sm" ? "ws-icon-chip-sm" : "ws-icon-chip";
  const photoBox: CSSProperties =
    showImage && size === "lg" ? { width: 56, height: 56, borderRadius: 16 } : {};

  return (
    <div
      className={`${chipClass} overflow-hidden ${className}`}
      style={{ background: "var(--ws-s2)", ...photoBox, ...style }}
    >
      {showImage ? (
        <img
          src={productImageUrl(productId, imageHash!)}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setFailedHash(imageHash!)}
          className="w-full h-full object-cover"
        />
      ) : emoji ? (
        emoji
      ) : (
        // No photo and no emoji (both optional): a plain box.
        <Package size={size === "sm" ? 15 : 19} style={{ color: "var(--ws-ts)" }} />
      )}
    </div>
  );
}
