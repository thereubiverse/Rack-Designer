// Built-in faces for DESCRIBED endpoints. Pure: returns a real Face, so the existing renderFace
// draws a far end exactly like any other device face — no second renderer.
//
// These are the single-port devices (camera, access point, access control panel, …). The data
// outlet is NOT drawn here: it is a wall plate with its own port grid, rendered by
// outletFaceplate.tsx.
import type { Face, PortGroup } from "@/domain/faceplate";

/** Stable group id: the face is transient (never persisted) and highlights target this id. */
export const ENDPOINT_GROUP_ID = "endpoint-face";

/** The device's single RJ45 keystone, labelled with the endpoint label when one is set. */
export function faceForDescribed(args: { landingPortLabel: string }): Face {
  const portOverrides: PortGroup["portOverrides"] = {};
  if (args.landingPortLabel !== "") portOverrides[0] = { name: args.landingPortLabel };
  const group: PortGroup = {
    id: ENDPOINT_GROUP_ID, media: "copper", connectorType: "Keystone", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides,
  };
  return { portGroups: [group], elements: [] };
}
