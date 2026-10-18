// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computePlacement, floatingPanelClass, floatingPanelStyle, useFloatingPanel, type PanelPlacement } from "./floating-panel";

const BELOW: PanelPlacement = { alignEnd: false, above: false, shiftX: 0 };
const ABOVE: PanelPlacement = { alignEnd: false, above: true, shiftX: 0 };
const viewport = { width: 1024, height: 800 };
const panel = { width: 300, height: 320 };
const anchorAt = (top: number, left = 100, width = 200) => ({ top, bottom: top + 40, left, right: left + width });

describe("computePlacement", () => {
  it("below and left-aligned when it fits", () => {
    expect(computePlacement({ anchor: anchorAt(100), panel, viewport, topInset: 0, current: BELOW })).toEqual(BELOW);
  });

  it("above when there is no room below and there is room above", () => {
    expect(computePlacement({ anchor: anchorAt(600), panel, viewport, topInset: 0, current: BELOW })).toEqual(ABOVE);
  });

  it("the sticky header counts as the top edge: no room above under it, so it stays below", () => {
    // 600 - 8 - 320 = 272 above the control; with a header ending at 300 that space is covered.
    expect(computePlacement({ anchor: anchorAt(600), panel, viewport, topInset: 300, current: BELOW })).toEqual(BELOW);
    // and an open panel above goes back below once the header would cover it
    expect(computePlacement({ anchor: anchorAt(380), panel, viewport, topInset: 64, current: ABOVE })).toEqual(BELOW);
  });

  it("keeps its side while it fits (no flip back and forth while scrolling)", () => {
    expect(computePlacement({ anchor: anchorAt(420), panel, viewport, topInset: 0, current: ABOVE })).toEqual(ABOVE);
    expect(computePlacement({ anchor: anchorAt(420), panel, viewport, topInset: 0, current: BELOW })).toEqual(BELOW);
  });

  it("neither side fits: keeps the current one", () => {
    const tall = { width: 300, height: 900 };
    expect(computePlacement({ anchor: anchorAt(400), panel: tall, viewport, topInset: 0, current: BELOW })).toEqual(BELOW);
    expect(computePlacement({ anchor: anchorAt(400), panel: tall, viewport, topInset: 0, current: ABOVE })).toEqual(ABOVE);
  });

  it("right edge: aligned to the control's right edge, or slid left just enough on a narrow viewport", () => {
    expect(computePlacement({ anchor: anchorAt(100, 800, 200), panel, viewport, topInset: 0, current: BELOW })).toEqual({ alignEnd: true, above: false, shiftX: 0 });
    const narrow = { width: 320, height: 640 };
    // control 150..310 on a 320 px screen, panel 296 px: right-aligned would start at 14 - fits
    expect(computePlacement({ anchor: anchorAt(100, 150, 160), panel: { width: 296, height: 300 }, viewport: narrow, topInset: 0, current: BELOW }).alignEnd).toBe(true);
    // control 16..120, panel 296: neither edge fits, slid left to the 8 px margin
    expect(computePlacement({ anchor: anchorAt(100, 30, 90), panel: { width: 304, height: 300 }, viewport: narrow, topInset: 0, current: BELOW })).toEqual({
      alignEnd: false,
      above: false,
      shiftX: -22
    });
  });
});

/* The hook, with layout faked: jsdom has no layout, so the control's rectangle and the panel size are stubbed. */
let anchorTop = 100;
let headerBottom = 0;

function Probe() {
  const floating = useFloatingPanel<HTMLDivElement>();
  return (
    <div>
      <header data-floating-inset data-testid="header" />
      <div ref={floating.rootRef} data-testid="root">
        <button type="button" onClick={floating.open}>
          abrir
        </button>
        {floating.mounted ? (
          <div ref={floating.panelRef} data-testid="panel" className={floatingPanelClass(floating.phase, floating.placement)} style={floatingPanelStyle(floating.placement)}>
            <div data-testid="inner" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "panel" ? panel.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "panel" ? panel.height : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = (this as HTMLElement).dataset?.testid;
    const rect = id === "root" ? { ...anchorAt(anchorTop), width: 200, height: 40 } : id === "header" ? { top: 0, bottom: headerBottom, left: 0, right: 1024, width: 1024, height: headerBottom } : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect;
  });
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(viewport.height);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(viewport.width);
}

describe("useFloatingPanel placement while open", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    anchorTop = 100;
    headerBottom = 0;
  });

  it("is measured on open and follows a page scroll and a resize", async () => {
    stubLayout();
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "abrir" }));
    expect(screen.getByTestId("panel").className).toMatch(/\btop-full\b/);

    anchorTop = 600; // the page scrolled: the control is near the bottom now
    act(() => void window.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(screen.getByTestId("panel").className).toMatch(/\bbottom-full\b/));

    anchorTop = 100;
    headerBottom = 64;
    act(() => void window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(screen.getByTestId("panel").className).toMatch(/\btop-full\b/)); // no room above under the header
  });

  it("a scroll inside the panel itself does not move it", async () => {
    stubLayout();
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "abrir" }));
    const frames = vi.spyOn(window, "requestAnimationFrame");
    anchorTop = 600;
    act(() => void fireEvent.scroll(screen.getByTestId("inner")));
    expect(frames).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel").className).toMatch(/\btop-full\b/);
  });

  it("stays below the sticky header (z-30) and above the page content", () => {
    expect(floatingPanelClass("open", BELOW)).toMatch(/\bz-20\b/);
  });
});
