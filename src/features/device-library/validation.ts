import { isValidWidthIn, isValidRackUnits, type Face } from "@/domain/faceplate";

// Plain module (NOT "use server") so it can export the synchronous validator and
// the input type. A "use server" file may only export async server actions, so
// these live here and are imported by actions.ts.

export interface DeviceTemplateInput {
  name: string;
  brandId: string | null;
  deviceTypeId: string;
  rackUnits: number;
  widthIn: number;
  rackMounted: boolean;
  frontFace: Face;
  backFace: Face;
}

/** Returns an error message, or null if the input is valid. */
export function validateDeviceTemplateInput(input: DeviceTemplateInput): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.deviceTypeId) return "Device type is required";
  if (!isValidWidthIn(input.widthIn)) return "Width must be greater than 0";
  if (!isValidRackUnits(input.rackUnits)) return "Rack units must be at least 1";
  return null;
}
