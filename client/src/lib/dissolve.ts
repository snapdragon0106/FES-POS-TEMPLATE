/**
 * HarmonyOS-style "dissolve" delete animation, driven imperatively on a real
 * DOM node (no framer-motion presence lifecycle to depend on).
 *
 * A deleted row scatters into small debris chips (real HarmonyOS uses an
 * actual particle system — ArkUI's Particle component — for this, not a
 * shader/mask trick, per https://developer.huawei.com/consumer/en/doc/harmonyos-references/ts-particle-animation)
 * while it fades and shrinks slightly, then collapses its own height — and
 * the flex gap after it, via a matching negative margin — so the rows below
 * glide up to fill the space via normal reflow.
 *
 * An earlier version faked the shatter with a CSS `mask-image` driven by an
 * SVG feTurbulence noise filter, animating mask-position/size. That reads
 * fine in a desktop browser but turned out to render as a total no-op on a
 * real Android WebView (a vivo device, confirmed via screen recording): the
 * card just faded/collapsed with no granular effect at all. CSS masking
 * layered on an SVG filter is a much narrower support surface than plain
 * transform/opacity, and debugging *why* a mask silently fails to rasterize
 * on a given WebView build isn't practical. The chips here use only
 * transform + opacity — the two properties every rendering engine
 * composites cheaply and correctly — so the effect is guaranteed to render
 * everywhere instead of merely "should."
 *
 * Usage: capture the row element synchronously from the click event, then run
 * this in parallel with the delete mutation so the animation overlaps the
 * network round-trip:
 *
 *   const row = (e.currentTarget as HTMLElement).closest(".ws-card");
 *   const del = mutation.mutateAsync({ id });
 *   if (row) await dissolveOut(row as HTMLElement);
 *   await del;
 *   utils.list.invalidate();
 */
/**
 * HarmonyOS's springMotion settle curve (response 0.55s, dampingFraction
 * 0.825 → stiffness 130 / damping 19, mass 1), baked to a CSS linear()
 * easing. Used for the swipe spring-back, where a cubic-bezier can't express
 * a real spring. Mirrors --spring-settle in index.css.
 */
export const SPRING_SETTLE =
  "linear(0,0.0062,0.0234,0.0494,0.0824,0.1207,0.163,0.208,0.2547,0.3023,0.3499,0.3972,0.4434,0.4883,0.5315,0.5729,0.6122,0.6493,0.6841,0.7167,0.747,0.7751,0.801,0.8247,0.8465,0.8663,0.8842,0.9004,0.915,0.928,0.9397,0.95,0.9591,0.9672,0.9742,0.9803,0.9856,0.9901,0.9939,0.9972,0.9999)";

const FRICTION = "cubic-bezier(0.2, 0, 0.2, 1)";

/** Debris-chip tones: mostly the app's danger/delete red, a few neutral
 * ones mixed in for depth — matches the red trash-button/void-badge colors
 * already used for destructive actions elsewhere in the app. */
const CHIP_COLORS = ["var(--ws-dg)", "var(--ws-dg)", "var(--ws-dg)", "var(--ws-ts)"];

/**
 * Spawns a burst of small debris chips over `rect` and animates each one
 * flying outward with its own randomized direction, distance, rotation and
 * duration — an actual particle scatter (matching how HarmonyOS itself
 * builds this effect) rather than a single shader-like transform. Chips
 * live in a `position: fixed` overlay appended to <body>, siblings of the
 * row rather than children of it, so they're free to fly past the row's
 * own bounds instead of being clipped by the `overflow: hidden` the height
 * collapse below needs. `biasX` (the swipe's last dx, if any) skews the
 * scatter to continue in the direction the row was already being dragged.
 */
function spawnChips(rect: DOMRect, biasX: number, reduceCount: boolean): HTMLDivElement {
  const layer = document.createElement("div");
  layer.style.cssText =
    `position: fixed; left: ${rect.left}px; top: ${rect.top}px; ` +
    `width: ${rect.width}px; height: ${rect.height}px; ` +
    `pointer-events: none; z-index: 2147483647; overflow: visible;`;
  document.body.appendChild(layer);

  const cols = reduceCount ? 4 : 7;
  const rows = reduceCount ? 3 : 4;
  const cellW = rect.width / cols;
  const cellH = rect.height / rows;
  // A hard left/right swipe keeps the scatter mostly continuing that way; a
  // plain (non-swiped) delete scatters in every direction.
  const biasAngle = biasX < 0 ? Math.PI : biasX > 0 ? 0 : null;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const chip = document.createElement("div");
      const size = 3 + Math.random() * 6;
      const x = c * cellW + Math.random() * cellW;
      const y = r * cellH + Math.random() * cellH;
      const startOpacity = 0.35 + Math.random() * 0.5;
      const color = CHIP_COLORS[Math.floor(Math.random() * CHIP_COLORS.length)];
      chip.style.cssText =
        `position: absolute; left: ${x}px; top: ${y}px; width: ${size}px; height: ${size}px; ` +
        `border-radius: ${Math.random() > 0.5 ? "50%" : "2px"}; background: ${color}; ` +
        `opacity: ${startOpacity};`;
      layer.appendChild(chip);

      const angle =
        (biasAngle ?? Math.random() * Math.PI * 2) + (Math.random() - 0.5) * Math.PI * 0.8;
      const dist = 36 + Math.random() * 90;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 16 - Math.random() * 26; // slight upward drift
      const rot = (Math.random() - 0.5) * 220;
      const dur = 380 + Math.random() * 260;
      const delay = Math.random() * 90;

      chip.animate(
        [
          { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: startOpacity, offset: 0 },
          {
            transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(0.25)`,
            opacity: 0,
            offset: 1,
          },
        ],
        { duration: dur, delay, easing: FRICTION, fill: "forwards" },
      );
    }
  }
  return layer;
}

const chipLayers = new WeakMap<HTMLElement, HTMLDivElement>();

export function dissolveOut(el: HTMLElement, opts?: { fromX?: number }): Promise<void> {
  const reduce =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // When the row was swiped away it is already offset horizontally; start the
  // shatter from there and let it drift a little further in the swipe
  // direction, so the gesture flows straight into the disintegration.
  const fromX = opts?.fromX ?? 0;
  const toX = fromX === 0 ? 0 : fromX - 24;

  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const height = rect.height;
  const parent = el.parentElement;
  const gap = parent
    ? parseFloat(getComputedStyle(parent).rowGap || getComputedStyle(parent).gap || "0") || 0
    : 0;

  // Freeze the box so the height + gap can collapse smoothly, and pull the row
  // out of interaction while it leaves.
  el.style.height = `${height}px`;
  el.style.flex = "0 0 auto";
  el.style.overflow = "hidden";
  el.style.pointerEvents = "none";
  el.style.willChange = "height, opacity, transform";

  const DURATION = reduce ? 200 : 560;
  const anims: Animation[] = [];

  if (!reduce) {
    const layer = spawnChips(rect, fromX, false);
    chipLayers.set(el, layer);
    anims.push(
      el.animate(
        [
          { transform: `translateX(${fromX}px) translateY(0) scale(1)`, offset: 0 },
          { transform: `translateX(${toX}px) translateY(-7px) scale(0.985)`, offset: 1 },
        ],
        { duration: DURATION, easing: FRICTION, fill: "forwards" },
      ),
    );
  }

  const collapse = el.animate(
    [
      { height: `${height}px`, marginBottom: cs.marginBottom, opacity: 1 },
      { height: "0px", marginBottom: `${-gap}px`, opacity: 0 },
    ],
    { duration: DURATION, easing: FRICTION, fill: "forwards" },
  );
  anims.push(collapse);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const layer = chipLayers.get(el);
      if (layer) {
        layer.remove();
        chipLayers.delete(el);
      }
      resolve();
    };
    collapse.finished.then(finish).catch(finish);
    // Safety net if a browser never resolves the animation promise.
    setTimeout(finish, DURATION + 250);
  });
}

/**
 * Undo the inline styles / animations dissolveOut applied, so a row can be
 * restored if the delete mutation ends up failing.
 */
export function dissolveRestore(el: HTMLElement): void {
  el.getAnimations().forEach((a) => a.cancel());
  const layer = chipLayers.get(el);
  if (layer) {
    layer.remove();
    chipLayers.delete(el);
  }
  for (const prop of [
    "height", "flex", "overflow", "pointer-events", "will-change", "opacity",
    "margin-bottom", "transform",
  ]) {
    el.style.removeProperty(prop);
  }
}
