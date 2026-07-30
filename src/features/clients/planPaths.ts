import "server-only";

/** The ONE render scale for this feature. planRaster rasterises at exactly this long edge and the
 *  stored PNG is produced at it too, so a pixel here is the same pixel there. Changing this number
 *  silently re-scales every coordinate this feature exchanges — don't. */
export const RENDER_LONG_EDGE = 2600;

/** True for the SCREENED-BACK stroke class. On every overlay discipline (electrical, mechanical,
 *  ceiling) the base building is greyed and the sheet's own subject is drawn prominently — so the
 *  walls are in here, not in the black. Verified on the real sheet: grey-only reaches 94.9%
 *  edge coverage.
 *
 *  Classified from the STROKE colour alone. The sheet also carries ~82k grey-FILLED hatch paths
 *  drawn with a black stroke; they land in the black class, which is what both callers want —
 *  buildWallRuns discards them (they are neither long nor orthogonal) and symbol picking keeps
 *  them only when they sit inside a symbol's own bbox, where they cost nothing. Measured: picking
 *  the real sheet's card reader reproduces the same region either way (59.0 x 22.9 with this
 *  split, 55.9 x 22.9 if grey-filled paths are excluded as well). */
export function isScreenedBack(colour: unknown): boolean {
  return typeof colour === "string" && /^#[9abcdABCD]/.test(colour);
}

export type PlanSeg = { a: [number, number]; b: [number, number] };

/** One PDF `constructPath`, already in DEVICE PIXELS (the RENDER_LONG_EDGE page space).
 *  `segs` are its straight runs — what wall extraction reads. `minX..maxY` is its bounding box,
 *  which includes curve endpoints that produce no segment — what symbol picking hit-tests. */
export type PlanPath = {
  segs: PlanSeg[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Screened-back (background architecture) rather than foreground subject matter. */
  grey: boolean;
};

/** One text-content item, ALREADY in device-pixel space (the RENDER_LONG_EDGE page space, same as
 *  PlanPath). `x, y` is the run's anchor point (its baseline start) — what planExtract's plan_label
 *  rows use. `minX..maxY` is the run's own glyph box — what symbol picking hit-tests to tell a
 *  letter/digit path from a device symbol's own ink. */
export type PlanTextItem = {
  text: string;
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type PlanPageGeometry = {
  paths: PlanPath[];
  texts: PlanTextItem[];
  width: number;
  height: number;
};

/**
 * Decode ONE PDF page's vector paths and text into device-pixel space.
 *
 * This is the single pdf.js operator walk for the whole feature: wall extraction (planExtract) and
 * click-to-pick symbol discovery (symbolActions) both read it. They previously would have carried
 * two copies of this decoder, which is exactly how the two coordinate spaces drift apart.
 *
 * Text comes back with the paths because both callers pay for the same page load; the walk itself
 * dominates (~83k paths on the real sheet), so the extra getTextContent is noise beside it.
 */
export async function decodePlanPage(
  pdfBytes: Uint8Array,
  pageIndex: number
): Promise<PlanPageGeometry> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS;
  // The LOADING TASK, not the document, owns the worker — and in pdf.js v6 it is the only one of
  // the two with a destroy().
  const task = pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageIndex + 1); // pdf.js pages are 1-based

    const unit = page.getViewport({ scale: 1 });
    const scale = RENDER_LONG_EDGE / Math.max(unit.width, unit.height);
    const vp = page.getViewport({ scale }); // includes /Rotate
    const width = Math.round(vp.width);
    const height = Math.round(vp.height);

    const ops = await page.getOperatorList();
    let ctm: number[] = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    let colour = "#000000";
    const mul = (m: number[], n: number[]) => [
      m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
      m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
      m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5],
    ];
    const apply = (m: number[], x: number, y: number): [number, number] =>
      [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
    // viewport.transform maps PDF user space to device pixels: scale + Y-flip + rotation, all at once.
    const toPx = (p: [number, number]) => apply(vp.transform as number[], p[0], p[1]);

    const paths: PlanPath[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as never[];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as number[]);
      else if (fn === OPS.setStrokeRGBColor) colour = String((args as unknown as unknown[])[0]);
      else if (fn === OPS.constructPath) {
        // args = [paintOp, [flatArray], minMax]. paintOp === OPS.endPath means this path is
        // clip-only geometry (never stroked or filled) — overlay exports use clipping for masking,
        // so without this check invisible clip regions get treated as walls.
        const paintOp = (args as unknown as unknown[])[0];
        if (paintOp === OPS.endPath) continue;
        const flat = (args as unknown as [unknown, ArrayLike<number>[]])[1]?.[0];
        if (!flat) continue;
        // Fill colour is intentionally NOT tracked alongside stroke colour — see isScreenedBack.
        const grey = isScreenedBack(colour);
        const n = flat.length ?? 0;
        const segs: PlanSeg[] = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const grow = (p: [number, number]) => {
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        };
        let j = 0;
        let cur: [number, number] | null = null;
        let start: [number, number] | null = null;
        while (j < n) {
          const op = flat[j++];
          if (op === 0) { cur = toPx(apply(ctm, flat[j++], flat[j++])); start = cur; grow(cur); }
          else if (op === 1) {
            const p = toPx(apply(ctm, flat[j++], flat[j++]));
            if (cur) segs.push({ a: cur, b: p });
            cur = p;
            grow(p);
          }
          // No opcode-3 case: pdf.js's buildPath (pdf.worker.mjs) emits BOTH curveTo variants (PDF
          // `v`/`y`) as opcode 2 with 6 coords, duplicating the implicit control point. The
          // "quadraticCurveTo, 4 coords" opcode is only emitted by a font-glyph-outline routine that
          // never appears in getOperatorList()'s content-stream array, so this branch would be dead
          // code with an unverified "skip 2, read 2" formula. `else break` below safely bails out on
          // any opcode this decoder doesn't recognise, rather than guessing and desyncing `j`.
          // A curve contributes NO segment (its chord is not a wall run) but its endpoint still
          // grows the bbox — a circle is nothing but curve endpoints, and picking hit-tests bboxes.
          else if (op === 2) { j += 4; cur = toPx(apply(ctm, flat[j++], flat[j++])); grow(cur); }
          else if (op === 4) { if (cur && start) segs.push({ a: cur, b: start }); cur = start; }
          else break;
        }
        if (minX === Infinity) continue;   // nothing decoded — not a path at all
        paths.push({ segs, minX, minY, maxX, maxY, grey });
      }
    }

    const content = await page.getTextContent();
    const texts: PlanTextItem[] = [];
    for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      const text = (item.str ?? "").trim();
      if (!text || !item.transform) continue;
      // Same composition pdf.js's own text layer uses to place a glyph run: the item's transform
      // (position + rotation, in PDF user space) through the page viewport (scale + rotation +
      // Y-flip) gives a device-pixel matrix whose translation is the run's baseline start and whose
      // columns give its direction. `width`/`height` are plain PDF-user-space lengths (pdf.js scales
      // them by the page's own scale factor alone, never by this matrix), so `scale` — already
      // computed above for the viewport — converts them to device pixels.
      const tx = mul(vp.transform as number[], item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      const runW = (item.width ?? 0) * scale;
      const runH = (item.height ?? 0) * scale;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      // "Up" from the baseline (the ascent direction), matching pdf.js's own text-layer placement
      // (which computes left/top as tx4 + ascent*sin(angle), tx5 - ascent*cos(angle)): for the
      // common angle=0 case this is (0, -1) — SMALLER device y, since a Y-flipping viewport already
      // makes "smaller y" the on-screen up. Getting this backwards was tried and measured: the box
      // extended BELOW the baseline instead, reaching into a device symbol drawn just under a label
      // (a GFI outlet's circle sits ~a few px below its own "GFI" tag) and excluding the symbol's own
      // ink as if it were text.
      const perpX = sin, perpY = -cos;
      // Baseline-start and baseline-end corners, plus their ascent-band counterparts. Bounding
      // these four covers the glyph box at any of the sheet's (axis-aligned) page rotations
      // without assuming in advance which screen direction is "up".
      const x0 = tx[4], y0 = tx[5];
      const x1 = x0 + runW * cos, y1 = y0 + runW * sin;
      const x2 = x0 + runH * perpX, y2 = y0 + runH * perpY;
      const x3 = x1 + runH * perpX, y3 = y1 + runH * perpY;
      const xs = [x0, x1, x2, x3];
      const ys = [y0, y1, y2, y3];
      texts.push({
        text,
        x: x0,
        y: y0,
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      });
    }

    return { paths, texts, width, height };
  } finally {
    await task.destroy();
  }
}
