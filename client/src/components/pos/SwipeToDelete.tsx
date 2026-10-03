import { useRef, type CSSProperties, type ReactNode } from "react";
import { dissolveOut, dissolveRestore, SPRING_SETTLE } from "@/lib/dissolve";

interface Props {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Tap handler — suppressed when the tap turned out to be a swipe. */
  onClick?: () => void;
  /**
   * Commit the deletion. This must do ONLY the mutation — no toast, no
   * query invalidation — because invalidating here would let React unmount
   * the row while it is still shattering. Throwing restores the row.
   */
  onDelete: () => Promise<void>;
  /**
   * Runs after both the mutation and the shatter have finished. Do the toast
   * and the query invalidation here so the row is not pulled out mid-animation.
   */
  onDeleted?: () => void;
  /** Report a failed delete to the user; the row is restored automatically. */
  onDeleteError?: (err: unknown) => void;
  disabled?: boolean;
  /** Fraction of the row width the finger must travel to commit (default 0.4). */
  commitFraction?: number;
  /**
   * Whether a fast flick may commit on a shorter travel. Turn this OFF for
   * destructive-and-unrecoverable rows (e.g. sales records) so only a long,
   * deliberate drag can delete.
   */
  allowFlick?: boolean;
}

/** A fast left flick commits even on a short travel (px per ms). */
const FLICK_VELOCITY = -0.6;
const FLICK_MIN_TRAVEL = -32;
/** Movement before we decide this is a horizontal swipe vs a vertical scroll. */
const DECIDE_SLOP = 8;
/**
 * Velocity is measured across this window rather than from the last single
 * pointermove. A one-frame sample stays high even when the finger has clearly
 * stopped, which made a deliberate "drag then hold then release" read as a
 * flick and permanently delete a row the user meant to cancel.
 */
const VELOCITY_WINDOW_MS = 80;

type Sample = { x: number; t: number };

/**
 * Swipe-to-delete for touch devices, in the style of dismissing a phone
 * notification: the row tracks your finger (HarmonyOS's "跟手" follow phase),
 * and releasing past the threshold hands off to the dissolve — so the row
 * shatters into granular pieces and the list closes up behind it. Releasing
 * short of the threshold springs back using HarmonyOS's settle curve.
 *
 * Only touch pointers are tracked, so mouse users on desktop keep using the
 * trash button (which asks for confirmation) and never trigger this by
 * dragging. `touch-action: pan-y` lets the browser keep vertical scrolling
 * while horizontal movement comes to us.
 */
export default function SwipeToDelete({
  children,
  className = "",
  style,
  onClick,
  onDelete,
  onDeleted,
  onDeleteError,
  disabled = false,
  commitFraction = 0.4,
  allowFlick = true,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const latestDxRef = useRef(0);
  const g = useRef({
    active: false,
    decided: false,
    tracking: false,
    committing: false,
    /** Set on release after a real swipe so the trailing click isn't a tap. */
    justSwiped: false,
    startX: 0,
    startY: 0,
    /** clientX at the moment `decided` flips true — see onPointerMove. */
    trackStartX: 0,
    dx: 0,
    samples: [] as Sample[],
    pointerId: -1,
  });

  /** Velocity (px/ms) over the recent window; 0 if the finger has stopped. */
  const releaseVelocity = (): number => {
    const s = g.current.samples;
    if (s.length < 2) return 0;
    const newest = s[s.length - 1];
    // Finger has been still for a while → not a flick, whatever the last
    // frame-pair happened to measure.
    if (performance.now() - newest.t > VELOCITY_WINDOW_MS) return 0;
    let oldest = s[0];
    for (let i = s.length - 1; i >= 0; i--) {
      oldest = s[i];
      if (newest.t - s[i].t >= VELOCITY_WINDOW_MS) break;
    }
    const dt = newest.t - oldest.t;
    if (dt <= 0) return 0;
    return (newest.x - oldest.x) / dt;
  };

  // Queues at most one style write per animation frame, always painting the
  // *latest* dx (multiple pointermove events can land within one frame on
  // high-report-rate touch digitizers). Coalescing avoids redundant style
  // writes; it does not by itself fix lag — see the transition:none note in
  // onPointerMove for the actual cause of stickiness.
  const schedulePaint = () => {
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = ref.current;
      if (!el) return;
      const dx = latestDxRef.current;
      el.style.transform = `translateX(${dx}px)`;
      // Fade a little as it travels so releasing reads as "this is going away".
      const width = el.offsetWidth || 1;
      const progress = Math.min(1, Math.abs(dx) / (width * commitFraction));
      el.style.opacity = String(1 - progress * 0.3);
    });
  };

  const cancelPendingPaint = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  const clearVisual = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "";
    el.style.opacity = "";
    el.style.willChange = "";
    // Restore the row's normal CSS transition/animation (disabled for the
    // drag itself — see onPointerMove) now that the gesture is fully
    // resolved.
    el.style.transition = "";
    el.style.animation = "";
  };

  const springBack = (fromX: number) => {
    const el = ref.current;
    if (!el) return;
    const anim = el.animate(
      [
        { transform: `translateX(${fromX}px)`, opacity: el.style.opacity || "1" },
        { transform: "translateX(0px)", opacity: "1" },
      ],
      { duration: 440, easing: SPRING_SETTLE, fill: "forwards" },
    );
    anim.finished
      .then(() => {
        anim.cancel();
        clearVisual();
      })
      .catch(() => clearVisual());
  };

  const reset = () => {
    g.current.active = false;
    g.current.decided = false;
    g.current.tracking = false;
    g.current.pointerId = -1;
    g.current.samples = [];
    // Prevent a frame that was queued from the last pointermove from firing
    // AFTER we've handed off to springBack()/dissolveOut() — a stray write
    // at that point would stomp the WAAPI animation's transform mid-flight.
    cancelPendingPaint();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Touch only — desktop mouse keeps the confirm-dialog trash button.
    if (disabled || g.current.committing || e.pointerType !== "touch") return;
    if (g.current.active) return; // ignore secondary fingers
    g.current = {
      ...g.current,
      active: true,
      decided: false,
      tracking: false,
      justSwiped: false,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      samples: [{ x: e.clientX, t: performance.now() }],
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s.active || e.pointerId !== s.pointerId) return;

    // Only used to decide whether this gesture is a horizontal swipe (vs. a
    // vertical scroll) — never to paint. Painting from this would make the
    // row jump straight to wherever the finger already was once the slop
    // distance was crossed, instead of starting from 0 and growing with the
    // finger — see the trackStartX comment below for why that jump happened.
    const slopDx = e.clientX - s.startX;
    const slopDy = e.clientY - s.startY;

    if (!s.decided) {
      if (Math.abs(slopDx) < DECIDE_SLOP && Math.abs(slopDy) < DECIDE_SLOP) return;
      s.decided = true;
      // Require a clearly horizontal intent so vertical scrolling still wins.
      s.tracking = Math.abs(slopDx) > Math.abs(slopDy);
      if (!s.tracking) {
        s.active = false;
        return;
      }
      // Re-zero here rather than at the original pointerdown: dx below is
      // measured from this point on, so the very first painted frame is 0,
      // not whatever distance had already accumulated crossing DECIDE_SLOP.
      // Without this, the row sat completely still through the slop
      // distance and then snapped straight to that offset in one frame the
      // instant tracking began — the "doesn't move, then suddenly jumps"
      // catch the swipe was reported to have, as opposed to smoothly
      // gaining speed from the first pixel of horizontal movement.
      s.trackStartX = e.clientX;
      ref.current?.setPointerCapture?.(e.pointerId);
      if (ref.current) {
        ref.current.style.willChange = "transform, opacity";
        // .ws-card declares `transition: transform 0.3s ...` for its hover
        // lift. Left in place, every one of these drag-driven transform
        // writes would re-trigger that 300ms ease, so the row perpetually
        // chases a stale eased position instead of sitting under the finger
        // — exactly the "not smooth, doesn't stick to the finger" symptom.
        // An inline style always wins over the class rule, so this fully
        // disables it for the duration of the drag; clearVisual() restores
        // it once the gesture resolves (both WAAPI animations used for
        // spring-back and the shatter are independent of this property, so
        // disabling it here doesn't affect them).
        ref.current.style.transition = "none";
        // Every row also carries .ws-fade, a one-shot mount animation
        // (`animation: ws-fade-in 0.45s ... both`) that ends by asserting
        // transform: none. Per the CSS cascade, a running (or
        // fill-mode-held) animation's keyframe output OUTRANKS inline
        // styles for the same property — a different, higher-priority
        // bucket than specificity, so it wasn't something an inline
        // transition:none could ever fix. In practice that pinned every
        // drag-time `el.style.transform` write from schedulePaint() to a
        // no-op: the row sat frozen under the finger for the entire
        // gesture, and only the WAAPI-driven springBack()/dissolveOut() at
        // release — which sit in a still-higher cascade bucket — could
        // ever actually move it, producing a dead drag followed by one
        // sudden jump-and-bounce on release. Canceling the animation (not
        // just overriding its value) is what actually frees the property;
        // clearVisual() restores it once the gesture resolves.
        ref.current.style.animation = "none";
      }
    }
    if (!s.tracking) return;

    s.samples.push({ x: e.clientX, t: performance.now() });
    if (s.samples.length > 8) s.samples.shift();

    const dx = e.clientX - s.trackStartX;
    // Leftward is the delete direction; rightward gets rubber-band resistance.
    s.dx = dx > 0 ? dx * 0.25 : dx;
    latestDxRef.current = s.dx;
    schedulePaint();
  };

  const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s.active || e.pointerId !== s.pointerId) return;
    const el = ref.current;
    const wasTracking = s.tracking;
    const dx = s.dx;
    const vx = releaseVelocity();
    // Flush the exact release position synchronously before reset() cancels
    // the pending rAF paint below. Without this, a pointermove that landed
    // right before pointerup could have queued a frame for `dx` that never
    // actually painted — leaving the DOM a frame behind the value
    // springBack()/dissolveOut() are about to seed their first keyframe
    // with, so the handoff "snaps" that last frame's worth of distance
    // instead of continuing smoothly. Small (one frame), but exactly the
    // kind of thing that reads as "still a slight catch at the end."
    if (wasTracking && el) el.style.transform = `translateX(${dx}px)`;
    reset();
    if (wasTracking) g.current.justSwiped = true;

    if (!wasTracking || !el) return;

    const width = el.offsetWidth || 1;
    const past = dx < -width * commitFraction;
    const flicked = allowFlick && vx < FLICK_VELOCITY && dx < FLICK_MIN_TRAVEL;

    if (!past && !flicked) {
      springBack(dx);
      return;
    }

    // Commit: hand the swipe straight off to the shatter, then delete.
    g.current.committing = true;
    el.style.opacity = "";
    try {
      // Start the mutation so it overlaps the animation, but only report
      // success / refresh the list once BOTH have finished — invalidating
      // earlier lets React unmount the row mid-shatter.
      const del = onDelete();
      await dissolveOut(el, { fromX: dx });
      await del;
      onDeleted?.();
    } catch (err) {
      dissolveRestore(el);
      clearVisual();
      onDeleteError?.(err);
    } finally {
      g.current.committing = false;
    }
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = g.current;
    if (!s.active || e.pointerId !== s.pointerId) return;
    const dx = s.dx;
    const wasTracking = s.tracking;
    // Same flush as onPointerUp — see the comment there.
    if (wasTracking && ref.current) ref.current.style.transform = `translateX(${dx}px)`;
    reset();
    if (wasTracking) {
      g.current.justSwiped = true;
      springBack(dx);
    }
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{ touchAction: "pan-y", ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // A swipe must not also register as a tap (e.g. row selection). The
      // click fires after pointerup, by which point tracking has been reset,
      // so the release sets justSwiped and we consume it here.
      onClick={() => {
        if (g.current.justSwiped || g.current.tracking || g.current.committing) {
          g.current.justSwiped = false;
          return;
        }
        onClick?.();
      }}
    >
      {children}
    </div>
  );
}
