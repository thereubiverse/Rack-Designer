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
