import type { DetectedFace, DetectedGroup, DetectedLabel } from "./aiDetect";
import type { Face, PortGroup, TextElement } from "@/domain/faceplate";
import { frameDims, GRID_PX, CELL_W, RU_PX, ROW_H } from "@/domain/faceplate-geometry";
import { findFreePosition, type GridBounds } from "../editor/portGroupOps";

const snap = (n: number) => Math.round(n / GRID_PX) * GRID_PX;

function toPortGroup(d: DetectedGroup, bounds: GridBounds): PortGroup {
  const cols = Math.max(1, Math.ceil(d.count / d.rows));
  // Downward offset from centre for a group the model placed low on a tall device.
  // 1U devices centre a single band, so yOffset stays 0 there.
  const bandCenter = d.bbox.y * bounds.height + (d.bbox.h * bounds.height) / 2;
  const yOffset = bounds.height > RU_PX ? snap(bandCenter - bounds.height / 2) : 0;
  // Per-row orientation → port rotation. "up" = flipped (180°); "down"/absent = default (0°).
  // Only the non-default rows get overrides, so portOverrides stays sparse (and empty when the
  // model reports no orientation at all — unchanged behavior).
  const portOverrides: PortGroup["portOverrides"] = {};
  if (d.rowOrientations) {
    for (let r = 0; r < d.rows; r++) {
      if (d.rowOrientations[r] === "up") {
        for (let c = 0; c < cols; c++) portOverrides[r * cols + c] = { rotation: 180 };
      }
    }
  }
  return {
    id: crypto.randomUUID(),
    media: d.media,
    connectorType: d.connector,
    idPrefix: d.labelPrefix ?? "",
    countingDirection: d.order,
    rows: d.rows,
    cols,
    gridX: 0,
    gridY: 0,
    yOffset,
    colSpacing: 0,
    rowSpacing: 0,
    portOverrides,
  };
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

  let out: Face = { portGroups: [], elements: [] };
  for (const d of face.groups) {
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
