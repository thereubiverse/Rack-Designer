import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PlanVectorLayer } from "./PlanVectorLayer";

// pdf.js cannot rasterise anything in jsdom (no real 2D backend, and the library's worker never
// boots), so the whole module is faked. These tests are about the WIRING — how many times we ask
// pdf.js to rasterise, at what scale, and whether an in-flight task is cancelled — never about
// pixels. `vi.hoisted` because a vi.mock factory is hoisted above every const in this file.
const pdfMocks = vi.hoisted(() => {
  const cancel = vi.fn();
  // A render whose promise stays pending until something CANCELS it, so every test that asks "was
  // the in-flight render killed?" is looking at a genuinely in-flight render. cancel() rejects it,
  // exactly as pdf.js does (with a RenderingCancelledException) — that rejection is
  // indistinguishable from a real failure at the catch site, which is the whole reason the
  // component has to disambiguate the two.
  const render = vi.fn((_params: { transform?: number[]; canvas?: HTMLCanvasElement }) => {
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<void>((_resolve, rej) => {
      reject = rej;
    });
    // Nothing awaits the rejection until the component does; keep Node quiet in the meantime.
    promise.catch(() => {});
    return {
      promise,
      cancel: () => {
        cancel();
        reject(new Error("RenderingCancelledException"));
      },
    };
  });
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 1000 * scale,
    height: 666 * scale,
  }));
  const getPage = vi.fn(async () => ({ getViewport, render }));
  const destroy = vi.fn(async () => {});
  // The document load is GATED, not immediate: a real one downloads and parses an 84k-path sheet,
  // and a test needs to be able to unmount while that is still in the air. `flush` opens the gate;
  // a test that wants a load still in flight simply doesn't. The gate LATCHES, so it does not
  // matter whether `releaseDocument` is called before or after `getDocument` (which only runs once
  // the lazy `import("pdfjs-dist")` has settled).
  let gateOpen = false;
  let openGate: (() => void) | null = null;
  const getDocument = vi.fn(() => {
    const gate = new Promise<void>((resolve) => {
      if (gateOpen) resolve();
      else openGate = resolve;
    });
    return { promise: gate.then(() => ({ getPage, numPages: 3 })), destroy };
  });
  return {
    cancel,
    render,
    getViewport,
    getPage,
    destroy,
    getDocument,
    releaseDocument: () => {
      gateOpen = true;
      openGate?.();
    },
    resetGate: () => {
      gateOpen = false;
      openGate = null;
    },
  };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

const PDF_URL = "https://signed.test/plan.pdf";
const IMG_W = 1200;
const IMG_H = 800;

/** The pane these tests pretend to be looking through. The whole point of viewport rendering is
 *  that the bitmap is sized by THIS, not by IMG_W x IMG_H — so every expectation below is derived
 *  from it. */
const PANE_W = 800;
const PANE_H = 600;

type View = { zoom: number; panX?: number; panY?: number };

/** The visible slice of the plan, in PLAN pixels — the exact derivation FloorPlanCanvas does from
 *  its own pan/zoom and measured pane. Screen (0,0) is plan ((0 - panX) / zoom, ...), and the pane
 *  spans paneW/zoom plan pixels across. Kept here in the same shape so these tests exercise the
 *  arithmetic the canvas actually feeds in rather than a convenient fiction. */
function visible({ zoom, panX = 0, panY = 0 }: View) {
  return {
    visX: -panX / zoom,
    visY: -panY / zoom,
    visW: PANE_W / zoom,
    visH: PANE_H / zoom,
  };
}

/** The layer is an `<svg>` child (a `<foreignObject>`), so it can only be mounted inside one. */
function renderLayer(zoomOrView: number | View, onError?: () => void) {
  const initial: View = typeof zoomOrView === "number" ? { zoom: zoomOrView } : zoomOrView;
  const tree = (view: View, url: string) => (
    <svg data-testid="svg-root">
      <PlanVectorLayer
        pdfUrl={url}
        pageIndex={0}
        imgW={IMG_W}
        imgH={IMG_H}
        zoom={view.zoom}
        {...visible(view)}
        onError={onError}
      />
    </svg>
  );
  const utils = render(tree(initial, PDF_URL));
  let current = initial;
  return {
    ...utils,
    /** Zoom changed, view still centred at the same pan. */
    rerenderAt: (nextZoom: number) => {
      current = { ...current, zoom: nextZoom };
      utils.rerender(tree(current, PDF_URL));
    },
    /** Pan only — the zoom (and so the rasterisation scale) is untouched. */
    rerenderPanned: (panX: number, panY = 0) => {
      current = { ...current, panX, panY };
      utils.rerender(tree(current, PDF_URL));
    },
    /** A refreshed signed URL: same plan, new short-lived link. */
    rerenderWithUrl: (url: string) => utils.rerender(tree(current, url)),
  };
}

function canvasOf(container: HTMLElement) {
  return container.querySelector("canvas") as HTMLCanvasElement;
}

/** Lets the document load finish, then runs the promise chain (getDocument -> getPage) AND the
 *  debounce timer behind it.
 *
 *  Two passes, deliberately: React's `act` queues state updates and only flushes effects when the
 *  scope EXITS, so the first pass settles the document load and lets the render effect mount its
 *  debounce timer, and the second pass actually runs that timer. The first advances the clock by
 *  zero so `ms` stays an honest measure of how much time the test let pass. */
async function flush(ms = 500) {
  await settleImport();
  await act(async () => {
    pdfMocks.releaseDocument();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets the lazy `import("pdfjs-dist")` settle — so `getDocument` has actually been called — while
 *  leaving the document itself still loading behind the gate. */
async function settleImport() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  pdfMocks.resetGate();
  pdfMocks.render.mockClear();
  pdfMocks.cancel.mockClear();
  pdfMocks.getDocument.mockClear();
  pdfMocks.getPage.mockClear();
  pdfMocks.destroy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlanVectorLayer", () => {
  it("sits at exactly the overscanned visible region, in PLAN coordinates", async () => {
    // zoom 1, no pan: the pane sees plan pixels 0..800 x 0..600. Overscan adds 15% of each extent
    // on every side (120 x 90), and the top/left margins clamp away at the page edge:
    //   x 0..920, y 0..690.
    // These are PLAN coordinates, so the box still sits correctly inside the canvas's live
    // translate(pan) scale(zoom) group and nothing positioned in plan space moves.
    const { container } = renderLayer(1);
    await flush();

    const fo = container.querySelector("foreignObject")!;
    expect(fo).not.toBeNull();
    expect(fo.getAttribute("x")).toBe("0");
    expect(fo.getAttribute("y")).toBe("0");
    expect(fo.getAttribute("width")).toBe("920");
    expect(fo.getAttribute("height")).toBe("690");
  });

  it("still covers the whole imgW x imgH box when the whole plan is on screen", async () => {
    // The fitted view — the state the canvas mounts in. The visible region plus overscan spills off
    // every edge and clamps back to the page, so the layer occupies exactly the box the <image>
    // does, exactly as it did before viewport rendering. This is the case FloorPlanCanvas's own
    // "leaves every plan coordinate where the raster path put it" test is standing on.
    const { container } = renderLayer(0.5);
    await flush();

    const fo = container.querySelector("foreignObject")!;
    expect(fo.getAttribute("x")).toBe("0");
    expect(fo.getAttribute("y")).toBe("0");
    expect(fo.getAttribute("width")).toBe(String(IMG_W));
    expect(fo.getAttribute("height")).toBe(String(IMG_H));
  });

  it("rasterises the page once for the initial zoom", async () => {
    renderLayer(1);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    // pdf.js pages are 1-indexed; pageIndex is 0-based (same convention as planUpload.ts).
    expect(pdfMocks.getPage).toHaveBeenCalledWith(1);
  });

  it("rasterises the page the plan was actually taken from, not always the first", async () => {
    // A multi-sheet drawing set: the plan came from sheet index 2, so pdf.js must be asked for
    // page 3. Getting this wrong silently renders a different floor under the right pins.
    render(
      <svg>
        <PlanVectorLayer
          pdfUrl={PDF_URL}
          pageIndex={2}
          imgW={IMG_W}
          imgH={IMG_H}
          zoom={1}
          {...visible({ zoom: 1 })}
        />
      </svg>
    );
    await flush();
    expect(pdfMocks.getPage).toHaveBeenCalledWith(3);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-rasterise for a zoom change inside the same power-of-root-2 bucket", async () => {
    const { rerenderAt } = renderLayer(1.2);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    // 1.2 and 1.4 both live in the (1, 1.414] bucket — a wheel tick between them must not cost
    // an 84k-path re-rasterisation.
    rerenderAt(1.4);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
  });

  it("re-rasterises exactly once when the zoom crosses a bucket boundary", async () => {
    const { rerenderAt } = renderLayer(1.2);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    // 1.5 is past sqrt(2) — a new bucket.
    rerenderAt(1.5);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(2);
  });

  it("re-rasterises on a PAN that leaves the rendered region, at unchanged zoom", async () => {
    // Now that only the visible slice is rasterised, panning moves the thing that has to be drawn.
    // Before viewport rendering a pan cost nothing because the whole page was already on the
    // canvas; if this doesn't fire, the user drags into blank canvas / stale PNG and stays there.
    const { rerenderPanned, container } = renderLayer(1);
    await flush(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    expect(container.querySelector("foreignObject")!.getAttribute("x")).toBe("0");

    // 600 plan px left, at zoom 1: the pane now sees 600..1200, entirely outside the 0..920 that
    // was rendered.
    rerenderPanned(-600);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(2);
    // ...and it followed: region x 600 - 15% of 800 = 480, running to the right-hand page edge.
    const fo = container.querySelector("foreignObject")!;
    expect(fo.getAttribute("x")).toBe("480");
    expect(fo.getAttribute("width")).toBe("720");
  });

  it("does NOT re-rasterise for a pan that stays inside the overscan margin", async () => {
    // The 15% margin exists so ordinary dragging doesn't re-rasterise an 84k-path sheet on every
    // frame. 50 plan px is well inside the 120px margin rendered at zoom 1.
    const { rerenderPanned, container } = renderLayer(1);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    const before = container.querySelector("foreignObject")!.getAttribute("width");

    rerenderPanned(-50);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    // The region is untouched too — it must not creep with the pan, or the margin never holds.
    expect(container.querySelector("foreignObject")!.getAttribute("width")).toBe(before);

    // Sub-pixel jitter (a trackpad drag settling) is likewise a non-event.
    rerenderPanned(-50.0001);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
  });

  it("coalesces bucket crossings that arrive within the 150ms debounce into one rasterisation", async () => {
    // Only 1ms of slack after the leading-edge first render, so the crossings below genuinely land
    // inside its 150ms window.
    const { rerenderAt } = renderLayer(1);
    await flush(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    // Two more buckets crossed inside one debounce window: the intermediate one never rasterises.
    rerenderAt(1.5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    rerenderAt(3);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(2);
  });

  // THE POINT OF THE WHOLE COMPONENT: "text, lines and symbols stay sharp no matter how much we
  // zoom in". Rasterising the whole page put a hard ceiling on that — the page had to fit in one
  // canvas, so the scale ran out of budget at ~2.7x on a real sheet and everything past that was an
  // upscaled bitmap. Rasterising only what's on screen moves the ceiling off the DOCUMENT and onto
  // the VIEWPORT, which does not grow when you zoom.
  it("sizes the bitmap by the PANE, not the page — so zooming in does not grow it", async () => {
    // Two views 16x apart in magnification, both looking at the middle of the sheet so neither
    // region is clipped by a page edge. Hand-computed at 4x: the pane sees 800/4 = 200 plan px
    // across, overscanned by 15% a side to 260, rasterised at 4 device px per plan px = 1040. At
    // 64x it sees 12.5, overscanned to 16.25, rasterised at 64 = 1040. Identical, because the slice
    // shrinks at exactly the rate the scale grows. That is the whole fix.
    const shallow = renderLayer({ zoom: 4, panX: -1000, panY: -600 });
    await flush();
    const near = canvasOf(shallow.container);
    expect([near.width, near.height]).toEqual([1040, 780]);
    shallow.unmount();

    // 64x is far past the ~2.7x the whole-page path could reach on a real sheet.
    const deep = renderLayer({ zoom: 64, panX: -30000, panY: -20000 });
    await flush();
    const canvas = canvasOf(deep.container);
    expect([canvas.width, canvas.height]).toEqual([1040, 780]);

    // The general invariant, independent of where the root-2 bucket happens to land: the bitmap can
    // never exceed pane * overscan * dpr, times at most one bucket's worth of ceiling (sqrt 2).
    expect(canvas.width).toBeLessThanOrEqual(Math.ceil(PANE_W * 1.3 * Math.SQRT2));
    expect(canvas.height).toBeLessThanOrEqual(Math.ceil(PANE_H * 1.3 * Math.SQRT2));
    // Nowhere near the page-sized bitmap the old path would have asked for at this zoom
    // (1200 * 64 = 76800px across, clamped back to a blurry 8192 — the blur being reported).
    expect(canvas.width).toBeLessThan(IMG_W);
  });

  it("translates the render to the region's origin, so the right slice of the page lands on it", async () => {
    // Same 64x view as above. The region starts at plan (466.875, 311.09375); the scaled pdf.js
    // viewport is plan-pixel space multiplied by 64, so the region's top-left sits at device
    // (29880, 19910) within it and the page must be shifted back by exactly that to land at the
    // canvas origin. Get this wrong and the plan is drawn offset — silently, and only when panned.
    const { container } = renderLayer({ zoom: 64, panX: -30000, panY: -20000 });
    await flush();

    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    const args = pdfMocks.render.mock.calls[0][0] as {
      transform?: number[];
      canvas?: HTMLCanvasElement;
    };
    expect(args.transform).toBeDefined();
    const [a, b, c, d, e, f] = args.transform!;
    // Pure translation — no extra scaling; the viewport already carries the scale.
    expect([a, b, c, d]).toEqual([1, 0, 0, 1]);
    expect(e).toBeCloseTo(-29880, 6);
    expect(f).toBeCloseTo(-19910, 6);

    // ...and the viewport it is applied to is the FULL page at the region's scale: imgW * 64 device
    // px wide, i.e. pdf.js scale (1200 * 64) / 1000 = 76.8 against this mock's 1000pt-wide page.
    const vpScale = pdfMocks.getViewport.mock.calls.at(-1)![0].scale;
    expect(vpScale).toBeCloseTo(76.8, 6);
    expect(args.canvas).toBe(canvasOf(container));
  });

  it("walks the scale back rather than asking for a bitmap the browser will refuse", async () => {
    // A safety net, not a working limit: a pane-sized bitmap is naturally modest, so nothing a real
    // display produces gets near this. It takes an absurd 9000 x 6000 CSS-pixel pane at 8x zoom to
    // reach it — asserted rather than assumed, because a canvas past the browser's maximum
    // allocates nothing and draws a BLANK plan, which is the one outcome worse than a soft one.
    const utils = render(
      <svg>
        <PlanVectorLayer
          pdfUrl={PDF_URL}
          pageIndex={0}
          imgW={2600}
          imgH={1840}
          zoom={8}
          visX={100}
          visY={100}
          visW={9000 / 8}
          visH={6000 / 8}
        />
      </svg>
    );
    await flush();

    const canvas = canvasOf(utils.container);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.width).toBeLessThanOrEqual(8192);
    expect(canvas.height).toBeLessThanOrEqual(8192);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("cancels the in-flight render the moment it is superseded, not when its replacement starts", async () => {
    const { rerenderAt } = renderLayer(1);
    await flush(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    expect(pdfMocks.cancel).not.toHaveBeenCalled();

    // The replacement is still 150ms of debounce away — an 84k-path render that is already known
    // to be stale must not keep burning the main thread until then.
    rerenderAt(3);
    expect(pdfMocks.cancel).toHaveBeenCalledTimes(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(2);
  });

  it("does NOT report a render cancelled by a document swap as a failure", async () => {
    // pdf.js rejects a cancelled render exactly like a failed one. When the signed URL refreshes
    // mid-render the DOCUMENT is torn down, which cancels that render while the render effect
    // itself has not been torn down — so "am I unmounted?" is not enough to tell the two apart.
    // Getting this wrong drops the plan back to the PNG permanently.
    //
    // CAVEAT, read before deleting the `renderTaskRef.current !== task` guard this describes: this
    // test passes with AND without that guard. `act()` flushes the intervening `setPage(null)`
    // re-render synchronously, so the render effect's own `cancelled` flag is already set by the
    // time the rejection microtask runs, and it short-circuits first. In a real browser React
    // SCHEDULES that update, the ordering is not guaranteed, and the guard is what holds. This
    // asserts the end-to-end behaviour and documents the intent; it does not prove the guard.
    const onError = vi.fn();
    const { rerenderWithUrl } = renderLayer(1, onError);
    await flush(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    rerenderWithUrl("https://signed.test/plan.pdf?refreshed");
    await flush();
    expect(pdfMocks.cancel).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops walking the pdf.js chain when unmounted mid-load", async () => {
    // Switching floor tabs unmounts this component while the document is still downloading and
    // parsing. Every step after that await — getting the page, sizing the canvas, rasterising —
    // is work for a component that no longer exists, on a sheet with 84k path operations.
    const { unmount } = renderLayer(1);
    // The document has been asked for but the gate is still shut: the load is genuinely in flight.
    await settleImport();
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfMocks.getPage).not.toHaveBeenCalled();

    unmount();
    // The document load is torn down, and releasing it now must wake nothing up.
    expect(pdfMocks.destroy).toHaveBeenCalled();
    await flush();

    expect(pdfMocks.getPage).not.toHaveBeenCalled();
    expect(pdfMocks.render).not.toHaveBeenCalled();
  });
});
