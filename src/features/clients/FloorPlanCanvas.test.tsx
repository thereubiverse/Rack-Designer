import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FloorPlanCanvas } from "./FloorPlanCanvas";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";

// jsdom has no ResizeObserver, so FloorPlanCanvas falls back to a fixed 870px pane width for its
// initial fit — deterministic, but NOT exercised by these tests: every assertion below checks
// child geometry computed in IMAGE-PIXEL space (norm * imgW/imgH, the IDENTITY view), which never
// depends on the live pan/zoom. See the coordinate-model comment in FloorPlanCanvas.tsx.

const PLAN: FloorPlanRow = {
  id: "plan-1",
  floor_id: "floor-1",
  storage_path: "floor-1/plan.png",
  width_px: 1200,
  height_px: 800,
  original_filename: "plan.png",
  source: "image",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const PLAN_URL = "https://example.test/plan.png";

const ROOMS: RoomRow[] = [
  {
    id: "room-mdf",
    floor_id: "floor-1",
    code: "MDF",
    name: "Main closet",
    type: "MDF",
    created_at: "2026-01-01T00:00:00Z",
    plan_polygon: [
      [0.1, 0.1],
      [0.3, 0.1],
      [0.3, 0.3],
      [0.1, 0.3],
    ],
  },
  {
    id: "room-tri",
    floor_id: "floor-1",
    code: "TRI",
    name: "Triangle room",
    type: "other",
    created_at: "2026-01-01T00:00:00Z",
    plan_polygon: [
      [0.5, 0.5],
      [0.6, 0.5],
      [0.55, 0.6],
    ],
  },
  {
    id: "room-none",
    floor_id: "floor-1",
    code: "NOPLAN",
    name: "No polygon yet",
    type: "other",
    created_at: "2026-01-01T00:00:00Z",
    plan_polygon: null,
  },
];

const DEVICES: FloorDeviceRow[] = [
  {
    id: "dev-cam01",
    site_id: "site-1",
    floor_id: "floor-1",
    room_id: "room-mdf",
    device_type_id: "type-cam",
    code: "CAM01",
    name: "Lobby camera",
    status: "planned",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    x: 0.5,
    y: 0.3,
  },
  // Non-first placed device — used for the hand-computed position assertion.
  {
    id: "dev-cam02",
    site_id: "site-1",
    floor_id: "floor-1",
    room_id: "room-mdf",
    device_type_id: "type-cam",
    code: "CAM02",
    name: "Hallway camera",
    status: "installed",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    x: 0.8,
    y: 0.65,
  },
  // The falsy-check tripwire: x === 0 / y === 0 is a REAL placement, not "unset".
  {
    id: "dev-sen01",
    site_id: "site-1",
    floor_id: "floor-1",
    room_id: null,
    device_type_id: "type-sen",
    code: "SEN01",
    name: "Corner sensor",
    status: "planned",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    x: 0,
    y: 0,
  },
  // Unplaced — must never render a pin.
  {
    id: "dev-to01",
    site_id: "site-1",
    floor_id: "floor-1",
    room_id: null,
    device_type_id: "type-to",
    code: "TO01",
    name: "Spare telephone",
    status: "planned",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    x: null,
    y: null,
  },
];

const DEVICE_TYPES: DeviceTypeRow[] = [
  { id: "type-cam", name: "Camera", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "CAM", is_standard: true },
  { id: "type-sen", name: "Sensor", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "SEN", is_standard: true },
  { id: "type-to", name: "Telephone", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "TO", is_standard: true },
];

function renderCanvas(editable = false) {
  return render(
    <FloorPlanCanvas
      plan={PLAN}
      planUrl={PLAN_URL}
      rooms={ROOMS}
      devices={DEVICES}
      deviceTypes={DEVICE_TYPES}
      editable={editable}
    />
  );
}

describe("FloorPlanCanvas (view mode)", () => {
  it("renders the SVG root with the plan image", () => {
    renderCanvas();
    const svg = screen.getByTestId("floor-plan-canvas");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const image = svg.querySelector("image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("href")).toBe(PLAN_URL);
  });

  it("renders a 4-point room polygon with the right point count", () => {
    renderCanvas();
    const polygon = screen.getByTestId("plan-room-MDF");
    const points = polygon.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(4);
  });

  it("renders a 3-point room polygon with the right point count", () => {
    renderCanvas();
    const polygon = screen.getByTestId("plan-room-TRI");
    const points = polygon.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(3);
  });

  it("renders no polygon for a room with no plan_polygon", () => {
    renderCanvas();
    expect(screen.queryByTestId("plan-room-NOPLAN")).toBeNull();
  });

  it("renders a NON-first placed device's pin at its hand-computed image-pixel position", () => {
    renderCanvas();
    // identity-view normToScreen([0.8, 0.65], {panX:0,panY:0,zoom:1,imgW:1200,imgH:800})
    //   = { x: 0.8*1200, y: 0.65*800 } = { x: 960, y: 520 }
    const pin = screen.getByTestId("plan-pin-CAM02");
    expect(pin.getAttribute("transform")).toBe("translate(960 520)");
  });

  it("renders a pin for a device placed at x=0/y=0 (the falsy-check tripwire)", () => {
    renderCanvas();
    const pin = screen.getByTestId("plan-pin-SEN01");
    expect(pin.getAttribute("transform")).toBe("translate(0 0)");
  });

  it("renders no pin for an unplaced device", () => {
    renderCanvas();
    expect(screen.queryByTestId("plan-pin-TO01")).toBeNull();
  });

  it("hides the edit-layout toggle when editable is false", () => {
    renderCanvas(false);
    expect(screen.queryByTestId("edit-layout-toggle")).toBeNull();
  });

  it("shows the edit-layout toggle when editable is true", () => {
    renderCanvas(true);
    expect(screen.getByTestId("edit-layout-toggle")).toBeInTheDocument();
  });
});
