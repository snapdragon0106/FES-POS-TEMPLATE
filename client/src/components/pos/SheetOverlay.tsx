import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The layer every sheet (会計・釣り銭・商品・在庫) sits on: the whole screen,
 * dimmed and blurred, with the sheet centred on a PC and at the bottom on a
 * phone.
 *
 * Rendered into <body>. Inside the app a `position: fixed` element is not
 * fixed to the screen when an ancestor has a transform, filter or
 * backdrop-filter (the fade-in animations and glass panels all do): the
 * checkout sheet used to sit at the top of the register area, off-centre,
 * with the sidebar and cart left undimmed.
 *
 * The scrim is a sibling behind the sheet, not its parent. An element with
 * backdrop-filter only blurs what is inside its nearest ancestor that has a
 * filter of its own, so a sheet nested in a blurred scrim saw nothing to
 * blur and the products showed through it sharply.
 */
export default function SheetOverlay({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center items-end md:items-center md:p-6">
      {/* Past the screen edges: a blur samples beyond its box, and at the box's
          own edge it mirrors what is there, leaving a sharp strip. */}
      <div className="ws-scrim absolute -inset-12" aria-hidden="true" />
      {children}
    </div>,
    document.body
  );
}
