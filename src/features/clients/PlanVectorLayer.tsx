"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { loadPdfjs } from "./planUpload";

/** THE PLAN LAYER, RASTERISED FROM THE SOURCE PDF AT THE CURRENT ZOOM.
 *
 *  The uploaded PDF is also flattened to a fixed 2600px PNG (see planUpload.ts) — fine as a
 *  thumbnail, visibly interpolated past ~100% zoom, which is exactly the "no loss of quality or
 *  compression" the plan is meant to keep. When the source PDF survived upload, this layer draws
 *  the real vector at whatever magnification the user is at instead, the way any PDF viewer does.
 *
 *  GEOMETRY — this is the one thing that must not drift.
 *
 *  The layer occupies exactly the `imgW x imgH` box the `<image>` did, inside the same live
 *  `<g transform="translate(pan) scale(zoom)">`. Everything the canvas positions (pins, room
 *  polygons, wall runs, snapping) is in image-pixel space; if this box moved or resized by a
 *  pixel, every one of those placements would silently misalign. So: `<foreignObject>` at (0,0),
 *  `imgW` wide, `imgH` tall, and the `<canvas>` stretched to fill it. The canvas's BACKING STORE
 *  is what changes with zoom — its CSS box never does.
 *
 *  COST — the user's own sheet is ~84,000 path ops.
 *
 *  Rasterising that per wheel tick would be unusable, so re-rendering is rationed three ways:
 *  bucketed (only when zoom crosses a power-of-root-2 boundary — see `zoomBucket`), capped (never
 *  more than MAX_SCALE_DPR_MULTIPLE x devicePixelRatio, so a deep zoom can't ask for a
 *  multi-gigabyte bitmap), and spaced (>= MIN_RENDER_INTERVAL_MS apart, so a burst of crossings
 *  collapses to one render). An in-flight render is cancelled when a newer one starts.
 */

/** Buckets are powers of root 2 — ~41% apart, i.e. about one "zoom step" of visible sharpness.
 *  CEILING, not rounding: the rasterised scale is always >= the displayed zoom, so the canvas is
 *  downsampled (crisp) rather than stretched (soft). Boundaries land exactly on 0.707/1/1.414/2. */
export function zoomBucket(zoom: number): number {
  return Math.ceil(Math.log(Math.max(zoom, 1e-6)) / Math.log(Math.SQRT2));
}

/** Rasterise at most this many device pixels per CSS pixel. 4x dpr is already past what any
 *  display resolves; without a cap, a 20x zoom would ask for a bitmap in the gigapixels. */
const MAX_SCALE_DPR_MULTIPLE = 4;
/** Two rasterisations of an 84k-path sheet may never be closer together than this. */
const MIN_RENDER_INTERVAL_MS = 150;

/** Hard ceilings on the BITMAP, on top of the scale cap — because the scale cap alone is relative
 *  and browsers' limits are absolute. Past roughly these a browser hands back a canvas that
 *  silently draws nothing, i.e. a BLANK plan, which is the one outcome worse than a soft one. A
 *  2600px-wide sheet at 4x on a retina display would ask for ~20800px across and ~300M pixels;
 *  these walk the scale back to something allocatable rather than letting it fail.
 *
 *  This is also the ceiling on how sharp a plan can get: the whole page is rasterised, not just
 *  the visible part, so magnification buys resolution only until the budget runs out (a 2600px
 *  sheet tops out near 2.6x its stored size). Going beyond that means tiling the viewport, which
 *  is a different component. */
const MAX_CANVAS_EDGE_PX = 8192;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** `scale` (device pixels per plan pixel), lowered if it would ask for a bitmap no browser will
 *  give us. Never returns 0 — a tiny canvas still beats no canvas. */
export function clampToCanvasBudget(imgW: number, imgH: number, scale: number): number {
  const byEdge = MAX_CANVAS_EDGE_PX / Math.max(1, imgW, imgH);
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, imgW * imgH));
  return Math.max(0.05, Math.min(scale, byEdge, byArea));
}

export function PlanVectorLayer({
  pdfUrl,
  pageIndex,
  imgW,
  imgH,
  zoom,
  onError,
}: {
  pdfUrl: string;
  /** 0-based, like the rest of this feature. pdf.js pages are 1-indexed, hence the +1 below. */
  pageIndex: number;
  imgW: number;
  imgH: number;
  zoom: number;
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
  // bucket would cost far more than the rasterisation it feeds.
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

  // The only zoom-derived input to rasterisation. Depending on the BUCKET (not `zoom`) is what
  // makes "a wheel tick inside one bucket costs nothing" a structural fact rather than a guard:
  // the effect below simply does not re-run.
  const pixelScale = clampToCanvasBudget(
    imgW,
    imgH,
    Math.min(Math.SQRT2 ** zoomBucket(zoom), MAX_SCALE_DPR_MULTIPLE) * devicePixelRatio()
  );

  // Timestamp of the last rasterisation START, so a burst of bucket crossings is spaced out rather
  // than queued up. Leading-edge: the first render fires immediately (no blank plan on mount) and
  // only the follow-ups wait out the remainder of the interval.
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
          // Scale is solved from WIDTH: the PNG's imgW/imgH came from rasterising this same page,
          // so the aspect ratio already matches to within a rounding pixel.
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (imgW * pixelScale) / base.width });
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          task = page.render({ canvas, viewport });
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
  }, [page, imgW, imgH, pixelScale]);

  return (
    <foreignObject data-testid="plan-vector-layer" x={0} y={0} width={imgW} height={imgH}>
      {/* The CSS box is pinned to the plan's image-pixel size; only the backing store above scales
          with zoom. `display:block` kills the inline-element baseline gap that would otherwise
          shift the plan down by a few pixels inside the foreignObject. */}
      <canvas
        ref={canvasRef}
        data-testid="plan-vector-canvas"
        style={{ display: "block", width: imgW, height: imgH }}
      />
    </foreignObject>
  );
}
