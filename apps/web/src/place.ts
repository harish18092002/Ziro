// Where a tooltip goes, apart from the page: tested on its own. All numbers are viewport pixels.

/** What the tooltip points at: a horizontal position and the target's top and bottom edges. */
export interface TipAnchor {
  x: number;
  top: number;
  bottom: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Placement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * Above the anchor when it fits, below when only that fits, otherwise on the roomier side; centred on `x` and
 * then pushed back inside the viewport, `margin` from every edge, so it is never cut off.
 */
export function placeTip(
  anchor: TipAnchor,
  tip: Size,
  view: Size,
  gap = 10,
  margin = 8,
): Placement {
  const roomAbove = anchor.top - gap - margin;
  const roomBelow = view.height - anchor.bottom - gap - margin;
  const side = tip.height <= roomAbove || roomAbove >= roomBelow ? 'above' : 'below';
  const top = side === 'above' ? anchor.top - gap - tip.height : anchor.bottom + gap;
  return {
    left: Math.round(
      clamp(anchor.x - tip.width / 2, margin, Math.max(margin, view.width - margin - tip.width)),
    ),
    top: Math.round(clamp(top, margin, Math.max(margin, view.height - margin - tip.height))),
    side,
  };
}
