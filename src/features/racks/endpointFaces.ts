// Built-in faces for DESCRIBED endpoints. Pure: returns a real Face, so the existing renderFace
// draws a far end exactly like any other device face — no second renderer.
import type { Face, PortGroup } from "@/domain/faceplate";

/** Telecommunications Outlet — the only described type with a user-chosen port count. */
export const OUTLET_TYPE_CODE = "TO";
/** Stable group id: the face is transient (never persisted) and highlights target this id. */
export const ENDPOINT_GROUP_ID = "endpoint-face";

/** One row of RJ45 keystones: `portCount` wide for an outlet, otherwise a single port. */
export function faceForDescribed(args: {
  typeCode: string; portCount: number; landingPortIndex: number; landingPortLabel: string;
}): Face {
  const cols = args.typeCode === OUTLET_TYPE_CODE ? args.portCount : 1;
  const portOverrides: PortGroup["portOverrides"] = {};
  if (args.landingPortLabel !== "") portOverrides[args.landingPortIndex] = { name: args.landingPortLabel };
  const group: PortGroup = {
    id: ENDPOINT_GROUP_ID, media: "copper", connectorType: "Keystone", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides,
  };
  return { portGroups: [group], elements: [] };
}
