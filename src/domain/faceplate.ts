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
  colSpacing: number;
  rowSpacing: number;
  portOverrides: Record<number, { name?: string; flipped?: boolean }>;
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
  highlighted: boolean;
}

export interface IconElement {
  id: string;
  kind: "icon";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  iconName: string;
}

export type FaceElement = TextElement | IconElement;

export interface Face {
  portGroups: PortGroup[];
  elements: FaceElement[];
}

export function emptyFace(): Face {
  return { portGroups: [], elements: [] };
}

export function isValidWidthIn(n: number): boolean {
  return typeof n === "number" && n > 0 && n <= 30;
}

export function isValidRackUnits(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 60;
}
