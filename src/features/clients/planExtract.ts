import "server-only";
import type { WallRun, PlanLabel } from "@/lib/supabase/types";
import { buildWallRuns, normalizeRuns } from "./planGeometry";

const RENDER_LONG_EDGE = 2600;   // matches the PNG Slice B renders, so both share one coordinate space
const MAX_LABELS = 400;

/** True for the SCREENED-BACK stroke class. On every overlay discipline (electrical, mechanical,
 *  ceiling) the base building is greyed and the sheet's own subject is drawn prominently — so the
 *  walls are in here, not in the black. Verified on the real sheet: grey-only reaches 94.9%
 *  edge coverage. */
function isScreenedBack(colour: unknown): boolean {
  return typeof colour === "string" && /^#[9abcdABCD]/.test(colour);
}

export async function extractPlanGeometry(
  pdfBytes: Uint8Array,
  pageIndex: number
): Promise<{ walls: WallRun[]; labels: PlanLabel[]; width: number; height: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true }).promise;
  const page = await doc.getPage(pageIndex + 1);          // pdf.js pages are 1-based

  const unit = page.getViewport({ scale: 1 });
  const scale = RENDER_LONG_EDGE / Math.max(unit.width, unit.height);
  const vp = page.getViewport({ scale });                 // includes /Rotate
  const W = Math.round(vp.width), H = Math.round(vp.height);

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

  const segs: { a: [number, number]; b: [number, number]; grey: boolean }[] = [];
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
      // Fill colour is intentionally NOT tracked alongside stroke colour: wall outlines on these
      // sheets are stroked, not filled (94.9% coverage proves it), and picking up filled regions
      // would pull in hatching noise. A grey-filled/black-stroked region is classified by the
      // stale stroke colour — that's accepted, not a bug to "fix" here.
      const grey = isScreenedBack(colour);
      const n = flat.length ?? 0;
      let j = 0;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      while (j < n) {
        const op = flat[j++];
        if (op === 0) { cur = apply(ctm, flat[j++], flat[j++]); start = cur; }
        else if (op === 1) {
          const p = apply(ctm, flat[j++], flat[j++]);
          if (cur) segs.push({ a: toPx(cur), b: toPx(p), grey });
          cur = p;
        }
        else if (op === 2) { j += 4; cur = apply(ctm, flat[j++], flat[j++]); }
        // No opcode-3 case: pdf.js's buildPath (pdf.worker.mjs) emits BOTH curveTo variants (PDF
        // `v`/`y`) as opcode 2 with 6 coords, duplicating the implicit control point. The
        // "quadraticCurveTo, 4 coords" opcode is only emitted by a font-glyph-outline routine that
        // never appears in getOperatorList()'s content-stream array, so this branch would be dead
        // code with an unverified "skip 2, read 2" formula. `else break` below safely bails out on
        // any opcode this decoder doesn't recognise, rather than guessing and desyncing `j`.
        else if (op === 4) { if (cur && start) segs.push({ a: toPx(cur), b: toPx(start), grey }); cur = start; }
        else break;
      }
    }
  }

  const walls = normalizeRuns(buildWallRuns(segs, W, H), W, H);

  const content = await page.getTextContent();
  const labels: PlanLabel[] = [];
  for (const item of content.items as { str?: string; transform?: number[] }[]) {
    const text = (item.str ?? "").trim();
    if (!text || !item.transform) continue;
    const [x, y] = apply(vp.transform as number[], item.transform[4], item.transform[5]);
    labels.push({ text, x: Math.max(0, Math.min(1, x / W)), y: Math.max(0, Math.min(1, y / H)) });
    if (labels.length >= MAX_LABELS) break;
  }

  return { walls, labels, width: W, height: H };
}
