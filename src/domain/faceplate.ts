export type Media =
  | "copper" | "fiber" | "sfp" | "usb_a" | "usb_c"
  | "hdmi" | "dp" | "vga" | "ps2" | "audio";

export const MEDIA: Media[] = [
  "copper", "fiber", "sfp", "usb_a", "usb_c",
  "hdmi", "dp", "vga", "ps2", "audio",
];

export type CountingDirection = "ttb" | "btt" | "ltr" | "rtl";

export const CONNECTORS: Record<Media, string[]> = {
  copper: ["RJ45", "RJ11", "Keystone"],
  fiber: ["LC", "SC", "ST", "MPO-MTP"],
  sfp: ["SFP", "SFP+", "SFP28", "QSFP", "QSFP+"],
  usb_a: ["USB-A"],
  usb_c: ["USB-C"],
  hdmi: ["HDMI"],
  dp: ["DisplayPort"],
  vga: ["VGA"],
  ps2: ["PS/2"],
  audio: ["3.5mm"],
};

export interface PortGroup {
  id: string;
  media: Media;
  connectorType: string;
  idPrefix: string;
  countingDirection: CountingDirection;
  rows: number;
  cols: number;
  gridX: number;
  gridY: number;
  // Signed vertical offset (px) from the auto-centered position. Undefined/0 = centered
  // (default; every existing device). Only set on 2RU+ devices where the group can be
  // dragged up/down. Clamped by layout so the port stack stays inside the device.
  yOffset?: number;
  colSpacing: number;
  rowSpacing: number;
  portOverrides: Record<number, { name?: string; flipped?: boolean; labelPos?: "top" | "bottom"; rotation?: number; media?: Media; connectorType?: string }>;
}

export interface TextElement {
  id: string;
  kind: "text";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  content: string;
  alignment: "left" | "center" | "right";
  fontSize: number;
  color?: string;   // defaults to faceplate ink when unset
}

export interface IconElement {
  id: string;
  kind: "icon";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  iconName: string;
  color?: string;
  opacity?: number;
}

export interface ShapeElement {
  id: string;
  kind: "shape";
  shape: "rect" | "ellipse";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  fill?: string;        // defaults to "none"
  stroke?: string;      // defaults to faceplate ink
  strokeWidth?: number; // defaults to 1.5
}

export interface LineElement {
  id: string;
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export type BoxElement = TextElement | IconElement | ShapeElement;
export type FaceElement = BoxElement | LineElement;

export interface Face {
  portGroups: PortGroup[];
  elements: FaceElement[];
}

export function emptyFace(): Face {
  return { portGroups: [], elements: [] };
}

/** Max device body width — a rack device never exceeds this (rails are 19", ears fill the rest). */
export const MAX_BODY_WIDTH_IN = 17.5;

export function isValidWidthIn(n: number): boolean {
  return typeof n === "number" && n > 0 && n <= MAX_BODY_WIDTH_IN;
}

export function isValidRackUnits(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 60;
}
