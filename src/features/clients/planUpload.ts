/** Browser-only conversion layer for floor plan uploads: downscales images and rasterises a
 *  chosen PDF page, both to a PNG `Blob`, so `uploadFloorPlanAction` (Task 3) always receives
 *  bytes it can decode with `readPngDimensions` regardless of what the user actually picked.
 *  Nothing here runs server-side or in tests — `PlanUploadZone.test.tsx` mocks this whole module
 *  (jsdom implements neither `createImageBitmap`+canvas rendering nor a PDF renderer), so these
 *  functions have no automated coverage of their own in this slice; they're exercised manually /
 *  by a future E2E pass instead. */

import * as pdfjs from "pdfjs-dist";

// pdf.js needs a worker script URL. `new URL(..., import.meta.url)` is resolvable by both
// Turbopack (dev) and webpack (build) at bundle time. This assignment is a plain top-level
// side effect of importing the module — safe here because PlanUploadZone.test.tsx mocks
// "./planUpload" entirely via `vi.mock`, so this file's body is never evaluated under vitest.
// (Contingency, unused: if a real build/dev server can't resolve this worker URL, copy
// node_modules/pdfjs-dist/build/pdf.worker.min.mjs to public/pdf.worker.min.mjs and set
// `workerSrc = "/pdf.worker.min.mjs"` instead.)
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const MAX_IMAGE_LONG_EDGE = 3000;
const MAX_PDF_PAGE_LONG_EDGE = 2600;

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas produced no image data"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

/** Downscales `file` (if needed) so its long edge is at most `MAX_IMAGE_LONG_EDGE`, then
 *  re-encodes it as PNG via canvas — regardless of the source format (jpeg/webp/png). */
export async function convertImageFile(file: File): Promise<{ blob: Blob; source: "image" }> {
  const bitmap = await createImageBitmap(file);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_IMAGE_LONG_EDGE / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasToPngBlob(canvas);
    return { blob, source: "image" };
  } finally {
    bitmap.close();
  }
}

// `destroy()` (worker + network teardown) lives on the *loading task* pdfjs.getDocument()
// returns, not on the PDFDocumentProxy its `.promise` resolves to — so callers need both.
async function loadPdfDocument(file: File) {
  const data = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  return { doc, loadingTask };
}

/** Total page count of `file`, for deciding whether to skip the page picker (1 page) or show
 *  it (2+ pages). */
export async function getPdfPageCount(file: File): Promise<number> {
  const { doc, loadingTask } = await loadPdfDocument(file);
  try {
    return doc.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

/** Renders 0-based `pageIndex` of the PDF `file` to a PNG blob, scaled so its long edge is
 *  ~`MAX_PDF_PAGE_LONG_EDGE` px. pdf.js pages are 1-indexed, so this calls `getPage(pageIndex + 1)`. */
export async function convertPdfPage(file: File, pageIndex: number): Promise<{ blob: Blob; source: "pdf" }> {
  const { doc, loadingTask } = await loadPdfDocument(file);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const longEdge = Math.max(unscaledViewport.width, unscaledViewport.height);
    const scale = MAX_PDF_PAGE_LONG_EDGE / longEdge;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    if (!canvas.getContext("2d")) throw new Error("2D canvas context unavailable");

    await page.render({ canvas, viewport }).promise;

    const blob = await canvasToPngBlob(canvas);
    return { blob, source: "pdf" };
  } finally {
    await loadingTask.destroy();
  }
}
