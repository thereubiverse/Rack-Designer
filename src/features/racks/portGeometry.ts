// Absolute port centres for a placed device, in the rack-SVG coordinate space RackFrame draws in.
// Mirrors Faceplate.renderFace's port placement exactly: the body group is translated by the ear
// width, layoutPortGroup gives each cell's (x,y), and the glyph centre is +CELL_W/2 / +ROW_H/2.
import type { Face } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
import { ruTopY, RACK_GUTTER_L, RACK_PAD } from "./RackFrame";
import type { PortRef } from "./connectionOps";

export type PortDot = { port: PortRef; x: number; y: number };

export function portCenters(args: {
  rackDeviceId: string; side: "front" | "back"; face: Face;
  startU: number; rackUnits: number; widthIn: number; rackMounted: boolean; heightU: number;
}): PortDot[] {
  const { rackDeviceId, side, face, startU, rackUnits, widthIn, rackMounted, heightU } = args;
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const ix = RACK_GUTTER_L + RACK_PAD;                 // faceplate origin x in rack-SVG space
  const deviceTop = ruTopY(startU, rackUnits, heightU); // faceplate origin y
  const dots: PortDot[] = [];
  for (const g of face.portGroups) {
    const laid = layoutPortGroup(g, dims.heightPx);
    for (const cell of laid.cells) {
      dots.push({
        port: { rackDeviceId, side, groupId: g.id, portIndex: cell.index },
        x: ix + dims.earWidthPx + cell.x + CELL_W / 2,
        y: deviceTop + cell.y + ROW_H / 2,
      });
    }
  }
  return dots;
}

/** Which edge a cable leaves a port toward — `"top"` or `"bottom"` of the device.
 *
 *  Default is the NEAREST edge: up for a port in the device's upper half, down for the lower half.
 *  Exception: a SINGLE-ROW group sitting near the device's vertical middle always exits to the
 *  BOTTOM. A lone centred port is an exact top/bottom tie whose nearest-edge pick is otherwise
 *  decided by floating-point noise, and it reads cleaner dropping into the space below than
 *  crowding the seam against whatever device is stacked directly above. The `rows === 1` gate keeps
 *  a multi-row group's rows on their nearest edge (both rows of a 2-row switch sit within the same
 *  middle band, but the top row must still exit up). */
export function portExitEdge(
  portY: number, top: number, bottom: number, rows: number,
): "top" | "bottom" {
  const mid = (top + bottom) / 2;
  const nearMiddle = Math.abs(portY - mid) <= (bottom - top) * 0.25; // within the middle 50%
  if (rows === 1 && nearMiddle) return "bottom";
  return portY - top < bottom - portY ? "top" : "bottom";
}
