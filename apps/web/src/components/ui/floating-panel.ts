import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/*
 * Shared behaviour of the small floating panels anchored to a control (select
 * menu, date picker): open / closing / closed phases (a short exit animation,
 * then unmount), close on a pointer press outside, and a placement that keeps
 * the panel inside the viewport (aligned to the right edge of the control when
 * it would overflow on the right, above the control when there is no room
 * below). The placement is measured when the panel opens and again while it is
 * open, on scroll, resize and when the panel changes size. The panel is
 * positioned absolutely inside the control's wrapper, so its ancestors must not
 * clip overflow. Sticky bars marked with `data-floating-inset` (the portal
 * header) stay on top of it and count as the top edge of the free space.
 */

export type PanelPhase = "closed" | "open" | "closing";
export interface PanelPlacement {
  alignEnd: boolean;
  above: boolean;
  /** Horizontal correction (px, <= 0) when neither edge alignment fits a narrow viewport. */
  shiftX: number;
}

/** Exit animation length (ms); the panel is unmounted afterwards. */
export const PANEL_EXIT_MS = 120;
const VIEWPORT_MARGIN = 8;
/** Distance between the control and the panel (mt-2 / mb-2). */
const PANEL_GAP = 8;
const DEFAULT_PLACEMENT: PanelPlacement = { alignEnd: false, above: false, shiftX: 0 };

export interface PlacementInput {
  /** Viewport rectangle of the control's wrapper. */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** Untransformed size of the panel. */
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Bottom edge of the sticky bars covering the top of the viewport (0 when none). */
  topInset: number;
  current: PanelPlacement;
}

/**
 * Where the panel goes. Vertically it stays on its current side while it fits
 * there (no flipping back and forth while scrolling), switches side when only
 * the other one fits, and otherwise keeps its side. Horizontally it is
 * left-aligned, right-aligned when that overflows, or slid left just enough
 * when neither edge fits.
 */
export function computePlacement({ anchor, panel, viewport, topInset, current }: PlacementInput): PanelPlacement {
  const fitsBelow = anchor.bottom + PANEL_GAP + panel.height <= viewport.height - VIEWPORT_MARGIN;
  const fitsAbove = anchor.top - PANEL_GAP - panel.height >= Math.max(0, topInset) + VIEWPORT_MARGIN;
  const above = current.above ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;

  const overflowsRight = anchor.left + panel.width > viewport.width - VIEWPORT_MARGIN;
  const alignEnd = overflowsRight && anchor.right - panel.width >= VIEWPORT_MARGIN;
  const shiftX =
    overflowsRight && !alignEnd
      ? Math.round(Math.min(0, Math.max(VIEWPORT_MARGIN - anchor.left, viewport.width - VIEWPORT_MARGIN - (anchor.left + panel.width))))
      : 0;
  return { alignEnd, above, shiftX };
}

const samePlacement = (a: PanelPlacement, b: PanelPlacement) => a.alignEnd === b.alignEnd && a.above === b.above && a.shiftX === b.shiftX;

function stickyTopInset(): number {
  let inset = 0;
  document.querySelectorAll<HTMLElement>("[data-floating-inset]").forEach((element) => {
    inset = Math.max(inset, element.getBoundingClientRect().bottom);
  });
  return inset;
}

export function useFloatingPanel<T extends HTMLElement>() {
  const [phase, setPhase] = useState<PanelPhase>("closed");
  const [placement, setPlacement] = useState<PanelPlacement>(DEFAULT_PLACEMENT);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<T>(null);

  const open = useCallback(() => {
    setPlacement(DEFAULT_PLACEMENT);
    setPhase("open");
  }, []);
  const close = useCallback(() => setPhase((current) => (current === "open" ? "closing" : current)), []);

  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("closed"), PANEL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "open") return;
    const onPointerDown = (event: Event) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [phase, close]);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const root = rootRef.current;
    if (!panel || !root) return;
    // offsetWidth / offsetHeight ignore the scale of the opening animation.
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    if (size.width === 0 && size.height === 0) return;
    const anchor = root.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    setPlacement((current) => {
      const next = computePlacement({ anchor, panel: size, viewport, topInset: stickyTopInset(), current });
      return samePlacement(current, next) ? current : next;
    });
  }, []);

  // First measure once it is rendered with the default placement (below, left-aligned), before it is painted.
  useLayoutEffect(() => {
    if (phase === "open") measure();
  }, [phase, measure]);

  // While open: follow scroll (of the page or any scrolling ancestor), resize and the panel's own size changes.
  useEffect(() => {
    if (phase !== "open") return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const onScroll = (event: Event) => {
      // Scrolling inside the panel (a long option list) does not move it.
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      schedule();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer && panelRef.current) observer.observe(panelRef.current);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [phase, measure]);

  return { phase, mounted: phase !== "closed", isOpen: phase === "open", open, close, rootRef, panelRef, placement };
}

/** Position + motion classes of a floating panel (below the sticky header, z-30, above the page content). */
export function floatingPanelClass(phase: PanelPhase, placement: PanelPlacement): string {
  return cn(
    "absolute z-20",
    placement.above ? "bottom-full mb-2 origin-bottom" : "top-full mt-2 origin-top",
    placement.alignEnd ? "right-0" : "left-0",
    phase === "closing" ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-pop-in"
  );
}

/** Inline offset for the narrow-viewport correction (undefined when none is needed). */
export function floatingPanelStyle(placement: PanelPlacement): { left: number } | undefined {
  return placement.shiftX !== 0 && !placement.alignEnd ? { left: placement.shiftX } : undefined;
}
