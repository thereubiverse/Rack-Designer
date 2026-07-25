import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PlanVectorLayer } from "./PlanVectorLayer";

// pdf.js cannot rasterise anything in jsdom (no real 2D backend, and the library's worker never
// boots), so the whole module is faked. These tests are about the WIRING — how many times we ask
// pdf.js to rasterise, at what scale, and whether an in-flight task is cancelled — never about
// pixels. `vi.hoisted` because a vi.mock factory is hoisted above every const in this file.
const pdfMocks = vi.hoisted(() => {
  const cancel = vi.fn();
  // A render whose promise never settles unless the test settles it, so "unmount mid-render" is an
  // actual mid-render and not a race. cancel() REJECTS it, exactly as pdf.js does (with a
  // RenderingCancelledException) — that rejection is indistinguishable from a real failure at the
  // catch site, which is the whole reason the component has to disambiguate it.
  let settleRender: (() => void) | null = null;
  const render = vi.fn(() => {
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      settleRender = res;
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
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({ getPage, numPages: 3 }),
    destroy,
  }));
  return {
    cancel,
    render,
    getViewport,
    getPage,
    destroy,
    getDocument,
    settle: () => settleRender?.(),
  };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

const PDF_URL = "https://signed.test/plan.pdf";
const IMG_W = 1200;
const IMG_H = 800;

/** The layer is an `<svg>` child (a `<foreignObject>`), so it can only be mounted inside one. */
function renderLayer(zoom: number, onError?: () => void) {
  const tree = (z: number, url: string) => (
    <svg data-testid="svg-root">
      <PlanVectorLayer
        pdfUrl={url}
        pageIndex={0}
        imgW={IMG_W}
        imgH={IMG_H}
        zoom={z}
        onError={onError}
      />
    </svg>
  );
  const utils = render(tree(zoom, PDF_URL));
  return {
    ...utils,
    rerenderAt: (nextZoom: number) => utils.rerender(tree(nextZoom, PDF_URL)),
    /** A refreshed signed URL: same plan, new short-lived link. */
    rerenderWithUrl: (url: string) => utils.rerender(tree(zoom, url)),
  };
}

/** Runs the promise chain (getDocument -> getPage) AND the debounce timer behind it.
 *
 *  Two passes, deliberately: React's `act` queues state updates and only flushes effects when the
 *  scope EXITS, so the first pass settles the document load and lets the render effect mount its
 *  debounce timer, and the second pass actually runs that timer. The first advances the clock by
 *  zero so `ms` stays an honest measure of how much time the test let pass. */
async function flush(ms = 500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  pdfMocks.render.mockClear();
  pdfMocks.cancel.mockClear();
  pdfMocks.getDocument.mockClear();
  pdfMocks.destroy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlanVectorLayer", () => {
  it("occupies exactly the imgW x imgH box the <image> used to, so no plan coordinate moves", async () => {
    const { container } = renderLayer(1);
    await flush();

    const fo = container.querySelector("foreignObject")!;
    expect(fo).not.toBeNull();
    expect(fo.getAttribute("width")).toBe(String(IMG_W));
    expect(fo.getAttribute("height")).toBe(String(IMG_H));
    expect(fo.getAttribute("x")).toBe("0");
    expect(fo.getAttribute("y")).toBe("0");
  });

  it("rasterises the page once for the initial zoom", async () => {
    renderLayer(1);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);
    // pdf.js pages are 1-indexed; pageIndex is 0-based (same convention as planUpload.ts).
    expect(pdfMocks.getPage).toHaveBeenCalledWith(1);
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

  it("caps the rasterisation scale at 4x device pixel ratio", async () => {
    const { container } = renderLayer(50);
    await flush();

    // scale = min(bucketed zoom, 4) * dpr; jsdom's dpr is 1. The canvas backing store is therefore
    // 4 * imgW wide, not 50 * imgW (which would be a ~7GB allocation).
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(IMG_W * 4);
  });

  it("walks the scale back rather than asking for a bitmap the browser will refuse", async () => {
    // A real sheet: 2600px stored, retina display. 4x dpr would be 8x = ~20800px across, past
    // Chrome's 16384px maximum — the canvas would allocate nothing and the plan would be BLANK.
    const utils = render(
      <svg>
        <PlanVectorLayer pdfUrl={PDF_URL} pageIndex={0} imgW={2600} imgH={1840} zoom={50} />
      </svg>
    );
    await flush();

    const canvas = utils.container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBeLessThanOrEqual(8192);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(32 * 1024 * 1024);
    // ...but still meaningfully sharper than the 2600px raster it replaces.
    expect(canvas.width).toBeGreaterThan(2600 * 2);
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
    const onError = vi.fn();
    const { rerenderWithUrl } = renderLayer(1, onError);
    await flush(1);
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    rerenderWithUrl("https://signed.test/plan.pdf?refreshed");
    await flush();
    expect(pdfMocks.cancel).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("tolerates unmount mid-render: cancels the task and never sets state afterwards", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderLayer(1);
    await flush();
    expect(pdfMocks.render).toHaveBeenCalledTimes(1);

    unmount();
    expect(pdfMocks.cancel).toHaveBeenCalled();

    // Let the (still pending) render settle AFTER the component is gone.
    await act(async () => {
      pdfMocks.settle();
      await vi.advanceTimersByTimeAsync(200);
    });
    // A setState on an unmounted component logs a React error; none must appear.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
