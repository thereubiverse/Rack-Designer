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

export type PlanTextItem = { text: string; x: number; y: number };

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
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      const text = (item.str ?? "").trim();
      if (!text || !item.transform) continue;
      const [x, y] = apply(vp.transform as number[], item.transform[4], item.transform[5]);
      texts.push({ text, x, y });
    }

    return { paths, texts, width, height };
  } finally {
    await task.destroy();
  }
}
