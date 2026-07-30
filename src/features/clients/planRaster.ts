import "server-only";
import type { GreyImage } from "./symbolMatch";

/** The ONE render scale for this feature. planExtract.ts rasterises wall geometry at exactly this
 *  long edge, and the stored PNG is produced at it too, so a pixel here is the same pixel there and
 *  a hit's normalized centre lands where the canvas draws it. Changing this number silently
 *  re-scales every symbol coordinate — don't. */
const RENDER_LONG_EDGE = 2600;

/** Rasterise one PDF page to a single-channel greyscale buffer for the template matcher.
 *
 *  GREYSCALE, NOT BINARISED, and with the screened-back architecture left in: symbolMatch's header
 *  records the measurement — pre-isolating the black foreground drops CP recall from 9/10 to 6/10,
 *  and hard binarisation to 3/10, because NCC uses the consistent grey context around a symbol.
 *
 *  Server-only: pulls in pdf.js's legacy (Node) build and the native canvas. Kept in its own module
 *  so symbolActions.test.ts can fake it wholesale and stay free of both. */
export async function renderPlanGrey(pdfBytes: Uint8Array, pageIndex: number): Promise<GreyImage> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  // The LOADING TASK, not the document, is what owns the worker — and in pdf.js v6 it is the only
  // one of the two with a `destroy()` (a smoke test against a real PDF caught `doc.destroy` being
  // undefined here).
  const task = pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageIndex + 1); // pdf.js pages are 1-based

    // Same derivation as planExtract.extractPlanGeometry: one viewport, scaled so the LONG edge is
    // RENDER_LONG_EDGE, /Rotate included. Both files must agree or the two coordinate spaces drift.
    const unit = page.getViewport({ scale: 1 });
    const scale = RENDER_LONG_EDGE / Math.max(unit.width, unit.height);
    const vp = page.getViewport({ scale });
    const width = Math.round(vp.width);
    const height = Math.round(vp.height);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    // PDF pages have no background of their own; without this the page composites onto transparent
    // black and every unmarked pixel reads as ink.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    await page.render({
      // pdf.js v6 wants the canvas as well as its context; @napi-rs/canvas's pair are structurally
      // compatible with the DOM ones it is typed against, but not nominally.
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: vp,
    }).promise;

    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      // Rec. 601 luma. Integer maths on purpose — the matcher reads Uint8Array.
      data[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    }
    return { data, width, height };
  } finally {
    // pdf.js holds a worker and the decoded page cache open until this runs. Server actions are
    // long-lived in Next's Node runtime, so a leak here accumulates across every search.
    await task.destroy();
  }
}
