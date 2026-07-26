"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { loadPdfjs } from "./planUpload";

/** THE PLAN LAYER, RASTERISED FROM THE SOURCE PDF — ONLY THE PART YOU CAN SEE, AT THE ZOOM YOU
 *  ARE AT.
 *
 *  The uploaded PDF is also flattened to a fixed 2600px PNG (see planUpload.ts) — fine as a
 *  thumbnail, visibly interpolated past ~100% zoom. When the source PDF survived upload, this layer
 *  draws the real vector instead, the way any PDF viewer does.
 *
 *  WHY A REGION AND NOT THE PAGE — this is the whole design.
 *
 *  Rasterising the WHOLE page into one canvas puts a hard ceiling on sharpness: the entire sheet
 *  has to fit inside one bitmap, so the scale runs out of browser canvas budget (see
 *  MAX_CANVAS_EDGE_PX / MAX_CANVAS_PIXELS) at roughly 2.7x on a real 2600px sheet, and every zoom
 *  past that is an UPSCALED bitmap — i.e. blurry, which is exactly what the whole feature exists to
 *  avoid.
 *
 *  Rasterising only the region on screen unties the bitmap from the DOCUMENT and ties it to the
 *  VIEWPORT, which does not grow when you zoom. The visible slice shrinks in plan pixels at exactly
 *  the rate the scale grows, so the product — the bitmap — stays roughly pane-sized at ANY
 *  magnification. Sharpness becomes unbounded, and it costs LESS memory than the whole-page path
 *  did (a pane-sized canvas rather than a 5200x3467 one).
 *
 *  GEOMETRY — this is the one thing that must not drift.
 *
 *  The layer sits at the visible region expressed in PLAN coordinates (the same image-pixel space
 *  everything else here uses), inside the same live `<g transform="translate(pan) scale(zoom)">`.
 *  Everything the canvas positions (pins, room polygons, wall runs, snapping) is in that space; the
 *  coordinate model is untouched by this component, which only ever occupies a sub-box of it. When
 *  the whole plan is on screen — the fitted view the canvas mounts in — the region clamps to the
 *  page and the box is exactly (0, 0, imgW, imgH), as it always was.
 *
 *  The `<image href={planUrl}>` base layer in FloorPlanCanvas stays underneath unconditionally.
 *  With a region canvas it does more work than before, not less: it is what fills the page OUTSIDE
 *  the rendered region, as well as covering load, floor switches and each re-rasterisation.
 *
 *  COST — the user's own sheet is ~84,000 path ops.
 *
 *  Re-rendering is rationed three ways: bucketed (only when zoom crosses a power-of-root-2
 *  boundary — see `zoomBucket`), overscanned (a pan inside the 15% margin does not re-rasterise at
 *  all — see `OVERSCAN`), and spaced (>= MIN_RENDER_INTERVAL_MS apart, so a burst of pans or
 *  crossings collapses to one render). An in-flight render is cancelled when a newer one starts.
 */

/** Buckets are powers of root 2 — ~41% apart, i.e. about one "zoom step" of visible sharpness.
 *  CEILING, not rounding: the rasterised scale is always >= the displayed zoom, so the canvas is
 *  downsampled (crisp) rather than stretched (soft). Boundaries land exactly on 0.707/1/1.414/2. */
export function zoomBucket(zoom: number): number {
  return Math.ceil(Math.log(Math.max(zoom, 1e-6)) / Math.log(Math.SQRT2));
}

/** Fraction of the visible extent rasterised BEYOND each edge. The margin is what makes ordinary
 *  dragging free: a pan that stays inside it reuses the existing bitmap and never touches pdf.js.
 *  15% per side (1.3x overall) buys a comfortable drag for a 30% larger bitmap. */
const OVERSCAN = 0.15;

/** Two rasterisations of an 84k-path sheet may never be closer together than this. Now also the
 *  pan debounce: a drag re-enters this code every frame, and at most one render starts per window. */
const MIN_RENDER_INTERVAL_MS = 150;

/** Plan-pixel slack when asking "is the rendered region still covering the view?". Purely a
 *  float-noise guard — the real tolerance for a moving view is OVERSCAN, which is four orders of
 *  magnitude larger. Without it, a pan of 1e-13 plan pixels could count as escaping the region. */
const COVERAGE_EPSILON_PX = 0.5;

/** Hard ceilings on the BITMAP. Past roughly these a browser hands back a canvas that silently
 *  draws nothing, i.e. a BLANK plan, which is the one outcome worse than a soft one.
 *
 *  These are now a SAFETY NET rather than the working limit they used to be: the region is
 *  pane-sized, so a 4K display at 2x dpr with the overscan lands near 5000x2800 (~14M px) at its
 *  very worst, and a normal pane an order of magnitude below that. They are asserted, not relied
 *  on. Crucially they no longer bound SHARPNESS — zooming in shrinks the region rather than
 *  growing the bitmap, so the budget is never what stops you. */
const MAX_CANVAS_EDGE_PX = 8192;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** `scale` (device pixels per plan pixel), lowered if the region at that scale would ask for a
 *  bitmap no browser will give us. Never returns 0 — a tiny canvas still beats no canvas. */
export function clampToCanvasBudget(regionW: number, regionH: number, scale: number): number {
  const byEdge = MAX_CANVAS_EDGE_PX / Math.max(1, regionW, regionH);
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, regionW * regionH));
  return Math.max(0.05, Math.min(scale, byEdge, byArea));
}

/** The slice of the plan a rasterisation covers, in PLAN pixels, plus the scale it was solved for
 *  and the inputs that solved it. Held as state (not recomputed per render) precisely so that a
 *  view which is still covered produces the SAME object and re-rasterises nothing. */
type RenderRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Device pixels per plan pixel, already walked back to something allocatable. */
  scale: number;
  // The inputs this region was solved for; a change in any of them invalidates it.
  bucket: number;
  dpr: number;
  imgW: number;
  imgH: number;
};

type VisibleRect = { x: number; y: number; w: number; h: number };

function clamp(v: number, hi: number): number {
  return Math.min(Math.max(v, 0), hi);
}

/** The visible rect clipped to the page. Rasterising off-page area would be wasted work, and the
 *  clip is also what keeps `covers` from demanding a region that cannot exist. */
function clipToPage(vis: VisibleRect, imgW: number, imgH: number): VisibleRect {
  const x0 = clamp(vis.x, imgW);
  const y0 = clamp(vis.y, imgH);
  return {
    x: x0,
    y: y0,
    w: clamp(vis.x + vis.w, imgW) - x0,
    h: clamp(vis.y + vis.h, imgH) - y0,
  };
}

/** Is everything the user can see already on the existing bitmap? */
function covers(region: RenderRegion, vis: VisibleRect, imgW: number, imgH: number): boolean {
  const v = clipToPage(vis, imgW, imgH);
  return (
    region.x <= v.x + COVERAGE_EPSILON_PX &&
    region.y <= v.y + COVERAGE_EPSILON_PX &&
    region.x + region.w >= v.x + v.w - COVERAGE_EPSILON_PX &&
    region.y + region.h >= v.y + v.h - COVERAGE_EPSILON_PX
  );
}

/** Solve the region to rasterise: the visible rect grown by OVERSCAN on every side, clipped to the
 *  page, at the bucket's scale walked back into the canvas budget.
 *
 *  Guaranteed to satisfy `covers` for the rect it was solved from — which is what stops the
 *  adjust-state-during-render below from looping. */
function solveRegion(
  vis: VisibleRect,
  imgW: number,
  imgH: number,
  bucket: number,
  dpr: number
): RenderRegion {
  const mx = Math.max(0, vis.w) * OVERSCAN;
  const my = Math.max(0, vis.h) * OVERSCAN;
  const x0 = clamp(vis.x - mx, imgW);
  const y0 = clamp(vis.y - my, imgH);
  // `max(1, ...)` keeps a degenerate view (a zero-size pane, or the plan panned entirely off
  // screen) from asking for a 0-pixel canvas, which throws in some browsers.
  const w = Math.max(1, clamp(vis.x + vis.w + mx, imgW) - x0);
  const h = Math.max(1, clamp(vis.y + vis.h + my, imgH) - y0);
  const scale = clampToCanvasBudget(w, h, Math.SQRT2 ** bucket * dpr);
  return { x: x0, y: y0, w, h, scale, bucket, dpr, imgW, imgH };
}

export function PlanVectorLayer({
  pdfUrl,
  pageIndex,
  imgW,
  imgH,
  zoom,
  visX,
  visY,
  visW,
  visH,
  onError,
}: {
  pdfUrl: string;
  /** 0-based, like the rest of this feature. pdf.js pages are 1-indexed, hence the +1 below. */
  pageIndex: number;
  imgW: number;
  imgH: number;
  zoom: number;
  /** The rectangle currently on screen, in PLAN pixels (0..imgW, 0..imgH) — may extend outside the
   *  page on any side when the plan doesn't fill the pane. Supplied by FloorPlanCanvas, which is
   *  the only thing that knows both the live pan/zoom and the measured pane; deliberately NOT
   *  re-derived here, so there is exactly one definition of "visible". */
  visX: number;
  visY: number;
  visW: number;
  visH: number;
  /** The PDF could not be loaded or rendered (expired signed URL, corrupt file). The caller falls
   *  back to the raster PNG — a soft plan beats a blank one. A render that was merely SUPERSEDED
   *  or unmounted never reports here; only a real failure does. May fire more than once, so the
   *  handler must be idempotent. */
  onError?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);

  // Read by the effects but deliberately NOT an effect dependency: `onError` is typically a fresh
  // closure on every parent render, and re-rasterising 84k paths because a callback's identity
  // changed would defeat the whole point of the bucketing below.
  //
  // Assigning a ref during render is a deliberate trade, not an oversight: it is technically a
  // side effect in the render body (React reserves the right to discard a render pass, which would
  // leave this ref ahead of the committed tree). The alternative — an effect that syncs it — costs
  // an extra commit per parent render for a value only ever read from an async callback, and the
  // failure mode here is at worst calling a slightly newer `onError` than the committed one, which
  // is idempotent by contract.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // The in-flight rasterisation, at component scope so BOTH the render effect's cleanup and the
  // document teardown can cancel it — cancel must always happen before the document is destroyed.
  const renderTaskRef = useRef<RenderTask | null>(null);
  const cancelRender = () => {
    const task = renderTaskRef.current;
    renderTaskRef.current = null;
    // pdf.js rejects the task's promise with RenderingCancelledException; the awaiting code below
    // treats a cancelled render as a non-event, and cancel() itself must never throw upward.
    try {
      task?.cancel();
    } catch {
      /* already finished or destroyed */
    }
  };

  // Load the document ONCE per URL and hold the page. Re-parsing an 84k-path sheet on every zoom
  // bucket or pan would cost far more than the rasterisation it feeds.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ url: pdfUrl });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        const loaded = await doc.getPage(pageIndex + 1);
        if (cancelled) return;
        setPage(loaded);
      } catch {
        if (cancelled) return;
        onErrorRef.current?.();
      }
    })();

    return () => {
      cancelled = true;
      setPage(null);
      cancelRender();
      // destroy() tears down the worker and any pending request; it rejects if something was still
      // in flight, which is precisely the case we are unmounting in.
      void loadingTask?.destroy().catch(() => {});
    };
  }, [pdfUrl, pageIndex]);

  // A non-finite pan/zoom (a pane measured at zero mid-layout, a zoom of 0) would poison every
  // number downstream; fall back to the whole page, which is always a valid thing to draw.
  const finite = [visX, visY, visW, visH].every(Number.isFinite);
  const vis: VisibleRect = finite
    ? { x: visX, y: visY, w: visW, h: visH }
    : { x: 0, y: 0, w: imgW, h: imgH };

  const bucket = zoomBucket(zoom);
  const dpr = devicePixelRatio();

  // THE RATIONING, and the reason this is state rather than a plain derivation: the region only
  // changes when the existing bitmap genuinely stops being good enough. A wheel tick inside one
  // bucket, or a drag inside the overscan margin, returns the SAME object — so the effect below
  // does not re-run and pdf.js is never touched. That is a structural fact, not a guard.
  //
  // Adjusting state during render (React's own supported pattern for "derived from props, but with
  // memory") rather than in an effect: an effect would commit a stale region for one frame, and the
  // canvas would visibly draw the wrong slice before correcting. `solveRegion` always covers the
  // rect it was solved from, so the re-run this schedules converges immediately.
  const [region, setRegion] = useState<RenderRegion | null>(null);
  const target =
    region &&
    region.bucket === bucket &&
    region.dpr === dpr &&
    region.imgW === imgW &&
    region.imgH === imgH &&
    covers(region, vis, imgW, imgH)
      ? region
      : solveRegion(vis, imgW, imgH, bucket, dpr);
  if (target !== region) setRegion(target);

  const { x, y, w, h, scale } = target;

  // Timestamp of the last rasterisation START, so a burst of pans or bucket crossings is spaced out
  // rather than queued up. Leading-edge: the first render fires immediately (no blank plan on
  // mount) and only the follow-ups wait out the remainder of the interval.
  const lastRenderStartRef = useRef(0);

  useEffect(() => {
    if (!page) return;
    let cancelled = false;

    const wait = Math.max(0, MIN_RENDER_INTERVAL_MS - (Date.now() - lastRenderStartRef.current));
    const timer = setTimeout(() => {
      lastRenderStartRef.current = Date.now();
      void (async () => {
        // A render is only ever superseded here, never run twice concurrently.
        cancelRender();
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        // Declared outside the try so the catch can tell "this render was superseded" from
        // "this render failed" — see the comment there.
        let task: RenderTask | null = null;
        try {
          // The viewport is the WHOLE page at the region's scale — pdf.js has no notion of a
          // sub-rect. Scale is solved from WIDTH: the PNG's imgW/imgH came from rasterising this
          // same page, so the aspect ratio already matches to within a rounding pixel. The
          // viewport's pixel space is therefore exactly plan-pixel space times `scale`.
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (imgW * scale) / base.width });
          // FLOOR, not round: `scale` may have been walked back to land the bitmap exactly on the
          // canvas budget, and rounding UP from there would step back over the ceiling the walk-back
          // was there to respect. Losing a sub-device-pixel off the region's edge is invisible.
          canvas.width = Math.max(1, Math.floor(w * scale));
          canvas.height = Math.max(1, Math.floor(h * scale));
          // ...and the sub-rect is cut out by translating the page so the region's top-left lands
          // on the canvas origin. pdf.js applies this BEFORE the viewport transform, in device
          // pixels, so the origin converts from plan pixels with the same `scale`. Everything
          // outside the canvas is clipped by the canvas itself.
          task = page.render({
            canvas,
            viewport,
            transform: [1, 0, 0, 1, -(x * scale), -(y * scale)],
          });
          renderTaskRef.current = task;
          await task.promise;
          // Finished: there is no longer anything in flight to cancel, and the ref should say so.
          if (renderTaskRef.current === task) renderTaskRef.current = null;
        } catch {
          // A CANCELLED render rejects here exactly like a failed one, and must not be mistaken for
          // a broken PDF — that would drop the whole plan back to the PNG for good the first time
          // the signed URL was refreshed mid-render. `cancelRender` always clears (or replaces) the
          // ref, so "still the live task" is the test for a genuine failure. `cancelled` alone is
          // not enough: the document teardown can cancel this render before THIS effect's cleanup
          // has run.
          if (cancelled || (task !== null && renderTaskRef.current !== task)) return;
          onErrorRef.current?.();
        }
      })();
    }, wait);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      cancelRender();
    };
    // Destructured into scalars rather than depending on `target`: the identity of a region object
    // is already stable (see the state above), but scalars make the contract explicit and survive
    // anyone later swapping the memo for a plain derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, imgW, x, y, w, h, scale]);

  return (
    <foreignObject data-testid="plan-vector-layer" x={x} y={y} width={w} height={h}>
      {/* The CSS box is the region's size in PLAN pixels; only the backing store above scales with
          zoom. `display:block` kills the inline-element baseline gap that would otherwise shift the
          plan down by a few pixels inside the foreignObject. */}
      <canvas
        ref={canvasRef}
        data-testid="plan-vector-canvas"
        style={{ display: "block", width: w, height: h }}
      />
    </foreignObject>
  );
}
