import type { DetectedFace, DetectedGroup, DetectedLabel } from "./aiDetect";
import { CONNECTORS, type Face, type PortGroup, type TextElement } from "@/domain/faceplate";
import { frameDims, GRID_PX, CELL_W, RU_PX, ROW_H } from "@/domain/faceplate-geometry";
import { findFreePosition, resolveYOffset, type GridBounds } from "../editor/portGroupOps";

const snap = (n: number) => Math.round(n / GRID_PX) * GRID_PX;

function toPortGroup(d: DetectedGroup, bounds: GridBounds): PortGroup {
  const cols = Math.max(1, Math.ceil(d.count / d.rows));
  const bandCenter = d.bbox.y * bounds.height + (d.bbox.h * bounds.height) / 2;

  // Part C — horizontal extent: spread the ports so the group spans the detected block width,
  // clamped so the spread group still fits the device (a tighter-than-minimum block packs normally).
  const tightWidth = cols * CELL_W;
  const targetWidth = d.bbox.w * bounds.width;
  const maxSpread = cols > 1 ? Math.max(0, (bounds.width - tightWidth) / (cols - 1)) : 0;
  const colSpacing = cols > 1 && targetWidth > tightWidth
    ? Math.min((targetWidth - tightWidth) / (cols - 1), maxSpread)
    : 0;

  // Port overrides (sparse): per-row orientation → rotation ("up" = 180°), then Part A per-port
  // type exceptions (media + connector). A port can carry both; the type merges over the rotation.
  const portOverrides: PortGroup["portOverrides"] = {};
  if (d.rowOrientations) {
    for (let r = 0; r < d.rows; r++) {
      if (d.rowOrientations[r] === "up") {
        for (let c = 0; c < cols; c++) portOverrides[r * cols + c] = { rotation: 180 };
      }
    }
  }
  if (d.portTypes) {
    for (const pt of d.portTypes) {
      portOverrides[pt.index] = { ...portOverrides[pt.index], media: pt.media, connectorType: pt.connector ?? CONNECTORS[pt.media][0] };
    }
  }

  const g: PortGroup = {
    id: crypto.randomUUID(),
    media: d.media,
    connectorType: d.connector,
    idPrefix: d.labelPrefix ?? "",
    countingDirection: d.order,
    rows: d.rows,
    cols,
    gridX: 0,
    gridY: 0,
    yOffset: 0,
    colSpacing,
    rowSpacing: 0,
    portOverrides,
  };

  // Part B — vertical: a single-row group is positioned by its bbox centre (snapped + clamped in the
  // device); multi-row groups keep the prior band behaviour (bbox-based on tall devices, else centred).
  g.yOffset = d.rows === 1
    ? resolveYOffset(g, bandCenter - bounds.height / 2, bounds, GRID_PX)
    : bounds.height > RU_PX ? snap(bandCenter - bounds.height / 2) : 0;

  return g;
}

function toTextElement(l: DetectedLabel, bounds: GridBounds): TextElement {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    gridX: snap(l.bbox.x * bounds.width),
    gridY: snap(l.bbox.y * bounds.height),
    w: Math.max(CELL_W, Math.round(l.bbox.w * bounds.width)),
    h: ROW_H,
    content: l.text,
    alignment: "center",
    highlighted: false,
  };
}

export function layoutDetectedFace(face: DetectedFace, dims: { widthIn: number; rackUnits: number }): Face {
  const fd = frameDims({ widthIn: dims.widthIn, rackUnits: dims.rackUnits, rackMounted: true });
  const bounds: GridBounds = { width: fd.bodyWidthPx, height: fd.heightPx };

  // Part C — place groups left-to-right by their real horizontal position, so overlap-resolution
  // preserves relative order and only nudges rightward into free space.
  const groups = [...face.groups].sort((a, b) => a.bbox.x - b.bbox.x);
  let out: Face = { portGroups: [], elements: [] };
  for (const d of groups) {
    const g = toPortGroup(d, bounds);
    const desiredX = d.bbox.x * bounds.width;
    const free = findFreePosition(out, g, { x: desiredX, y: 0 }, bounds, undefined, GRID_PX);
    if (!free) continue; // no room on this row — skip rather than overlap
    out = { ...out, portGroups: [...out.portGroups, { ...g, gridX: free.x }] };
  }

  if (face.labels?.length) {
    out = { ...out, elements: face.labels.map((l) => toTextElement(l, bounds)) };
  }
  return out;
}
