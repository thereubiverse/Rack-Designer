import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FloorPlanCanvas, type FloorPlanCanvasHandle } from "./FloorPlanCanvas";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import type { SiteRackRow } from "./repository";
import { isValidPolygon } from "./floorPlanOps";
import {
  placeFloorDeviceAction,
  clearFloorDevicePlacementAction,
  placeRackAction,
  clearRackPlacementAction,
  setRoomPolygonAction,
  clearRoomPolygonAction,
  createFloorDeviceAction,
  createRoomAction,
} from "./actions";
import { discoverRoomsAction, discoverDevicesAction } from "./discoverActions";
import type { DeviceProposal, RoomProposal } from "./planDetect";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: pushMock }) }));
vi.mock("./actions", () => ({
  placeFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  clearFloorDevicePlacementAction: vi.fn(async () => ({ ok: true })),
  placeRackAction: vi.fn(async () => ({ ok: true })),
  clearRackPlacementAction: vi.fn(async () => ({ ok: true })),
  setRoomPolygonAction: vi.fn(async () => ({ ok: true })),
  clearRoomPolygonAction: vi.fn(async () => ({ ok: true })),
  // Accepting a proposal with no inventory match creates the row first, then places it — both
  // creates hand back the new id the placement is chained on.
  createFloorDeviceAction: vi.fn(async () => ({ ok: true, id: "new-device" })),
  createRoomAction: vi.fn(async () => ({ ok: true, id: "new-room" })),
}));
// The discovery actions are server actions (Supabase + Gemini); the canvas only ever awaits their
// result shape, so a module mock is the whole contract this file needs.
vi.mock("./discoverActions", () => ({
  discoverRoomsAction: vi.fn(async () => ({
    ok: true,
    proposals: [
      {
        id: "room-0",
        name: "MDF",
        roomType: "other",
        polygon: [
          [0.1, 0.1],
          [0.3, 0.1],
          [0.3, 0.3],
          [0.1, 0.3],
        ],
        confidence: "high",
      },
    ],
  })),
  discoverDevicesAction: vi.fn(async () => ({
    ok: true,
    proposals: [
      { id: "dev-0", label: "CAM01", typeCode: "CAM", point: [0.5, 0.5], confidence: "high" },
      { id: "dev-1", label: "AP02", typeCode: "AP", point: [0.7, 0.2], confidence: "low" },
    ],
  })),
}));

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
  // A SECOND unplaced device — gives the tray a NON-first unplaced device to select in the
  // placement test (TO01 alone would always be "the first" tray item).
  {
    id: "dev-to02",
    site_id: "site-1",
    floor_id: "floor-1",
    room_id: null,
    device_type_id: "type-to",
    code: "TO02",
    name: "Second spare telephone",
    status: "planned",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    x: null,
    y: null,
  },
];

const DEVICE_TYPES: DeviceTypeRow[] = [
  { id: "type-cam", name: "Camera", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "CAM", is_standard: true, color: null, icon: null },
  { id: "type-sen", name: "Sensor", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "SEN", is_standard: true, color: null, icon: null },
  { id: "type-to", name: "Telephone", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "TO", is_standard: true, color: null, icon: null },
];

function rack(over: Partial<SiteRackRow>): SiteRackRow {
  return {
    id: "rk", code: "RK00", heightU: 42, floorCode: "GF", roomCode: "MDF", roomType: "MDF",
    deviceCount: 0, x: null, y: null, ...over,
  };
}

const RACKS: SiteRackRow[] = [
  rack({ id: "rack-placed", code: "RK01", x: 0.4, y: 0.6 }), // placed → renders a marker
  rack({ id: "rack-un1", code: "RK02" }), // unplaced → tray
  rack({ id: "rack-un2", code: "RK03" }), // a NON-first unplaced rack to select in the tray
];

function renderCanvas(editable = false) {
  return render(
    <FloorPlanCanvas
      plan={PLAN}
      planUrl={PLAN_URL}
      rooms={ROOMS}
      devices={DEVICES}
      racks={RACKS}
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

  it("labels a traced room with its NAME, hover-gated by the room-group class (not always shown)", () => {
    renderCanvas();
    const label = screen.getByTestId("plan-room-label-MDF");
    // Shows the name ("Main closet"), not the code ("MDF").
    expect(label.textContent).toBe("Main closet");
    // Visibility is CSS-driven off the ancestor group's :hover — the class must be present.
    expect(label.closest(".plan-room-group")).not.toBeNull();
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

function enterEditMode() {
  fireEvent.click(screen.getByTestId("edit-layout-toggle"));
}

/** Tap a room's polygon to select it (pointer-down on the polygon, pointer-up at the same spot on
 *  the SVG root — a zero-travel tap the pan handler treats as a select, not a drag). */
function tapRoom(code: string) {
  const poly = screen.getByTestId(`plan-room-${code}`);
  fireEvent.pointerDown(poly, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
  fireEvent.pointerUp(screen.getByTestId("floor-plan-canvas"), { clientX: 120, clientY: 120, pointerId: 1 });
}

/** Select a room and promote it to vertex editing via the popover's Edit icon. */
function editRoomOutline(code: string) {
  tapRoom(code);
  fireEvent.click(screen.getByTestId("room-action-edit"));
}

describe("FloorPlanCanvas (edit mode)", () => {
  it("places a NON-first tray device at the clicked plan position", async () => {
    const callsBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    // TO02 is the second unplaced device in the tray — TO01 renders first.
    fireEvent.click(screen.getByTestId("tray-device-TO02"));

    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: 400, clientY: 300 });
    });

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(placeFloorDeviceAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("id")).toBe("dev-to02");
    const x = Number(formData.get("x"));
    const y = Number(formData.get("y"));
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    // Hand-derived expected value for the jsdom fallback view (no ResizeObserver in jsdom, so
    // FloorPlanCanvas's fit-on-mount effect always uses FALLBACK_PANE_WIDTH=870; CANVAS_HEIGHT is
    // the component's fixed 560; the plan here is 1200x800):
    //   fit zoom = min(paneW/imgW, CANVAS_HEIGHT/imgH) = min(870/1200, 560/800)
    //            = min(0.725, 0.7) = 0.7
    //   panX = (paneW - imgW*zoom)/2 = (870 - 1200*0.7)/2 = (870-840)/2 = 15
    //   panY = (CANVAS_HEIGHT - imgH*zoom)/2 = (560 - 800*0.7)/2 = (560-560)/2 = 0
    // jsdom's getBoundingClientRect is unmocked here and returns all zeros, so rect.left/top = 0
    // and screenToNorm's local x/y equal clientX/clientY directly:
    //   nx = (clientX - panX) / (imgW*zoom) = (400 - 15) / (1200*0.7) = 385/840 = 0.4583333333333333
    //   ny = (clientY - panY) / (imgH*zoom) = (300 - 0)  / (800*0.7)  = 300/560 = 0.5357142857142857
    // Both a correct live-view computation AND a broken identity-view swap happen to land in
    // [0,1] here, so only an exact value pins the actual math down.
    expect(x).toBeCloseTo(0.4583333333333333, 5);
    expect(y).toBeCloseTo(0.5357142857142857, 5);
    expect(refreshMock).toHaveBeenCalled();
  });

  it("commits exactly ONE move action on pointer-up after a multi-move pin drag, and leaves pan state unchanged", async () => {
    const callsBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    const svg = screen.getByTestId("floor-plan-canvas");
    const transformBefore = svg.querySelector("g")!.getAttribute("transform");

    // CAM02 is a NON-first placed device (CAM01 renders before it).
    const pin = screen.getByTestId("plan-pin-CAM02");
    fireEvent.pointerDown(pin, { clientX: 687, clientY: 364, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 700, clientY: 370, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 720, clientY: 380, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 740, clientY: 390, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 740, clientY: 390, pointerId: 1 });
    });

    // Exactly ONE action call for the whole gesture — never per pointermove.
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(placeFloorDeviceAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("id")).toBe("dev-cam02");
    const x = Number(formData.get("x"));
    const y = Number(formData.get("y"));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);

    // The pin's own pointerdown must stopPropagation, or this same gesture would also pan the
    // canvas via the SVG root's onPointerDown — assert the pan/zoom transform never moved.
    const transformAfter = svg.querySelector("g")!.getAttribute("transform");
    expect(transformAfter).toBe(transformBefore);
  });

  it("draws a room outline: 3 clicks + Enter commits a valid polygon", async () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    fireEvent.click(screen.getByTestId("tray-room-NOPLAN"));

    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.click(svg, { clientX: 100, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 100 });
    fireEvent.click(svg, { clientX: 200, clientY: 300 });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(setRoomPolygonAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("roomId")).toBe("room-none");
    const parsed = JSON.parse(String(formData.get("polygon")));
    expect(isValidPolygon(parsed)).toBe(true);
    expect(refreshMock).toHaveBeenCalled();
  });

  it("does nothing on Enter with fewer than 3 drawn points", () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    fireEvent.click(screen.getByTestId("tray-room-NOPLAN"));

    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.click(svg, { clientX: 100, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 100 });

    fireEvent.keyDown(window, { key: "Enter" });

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore);
  });

  it("Esc cancels an in-progress room draw with no action call", () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    fireEvent.click(screen.getByTestId("tray-room-NOPLAN"));

    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.click(svg, { clientX: 100, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 100 });

    fireEvent.keyDown(window, { key: "Escape" });
    // A stray Enter after Esc must not resurrect the cancelled draw.
    fireEvent.keyDown(window, { key: "Enter" });

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore);
  });

  it("un-places a NON-first pin via the Delete key after selecting it", async () => {
    const callsBefore = vi.mocked(clearFloorDevicePlacementAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    const svg = screen.getByTestId("floor-plan-canvas");
    // CAM02 is a NON-first placed device (CAM01 renders before it).
    const pin = screen.getByTestId("plan-pin-CAM02");
    fireEvent.pointerDown(pin, { clientX: 687, clientY: 364, button: 0, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: 687, clientY: 364, pointerId: 2 });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });

    expect(clearFloorDevicePlacementAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(clearFloorDevicePlacementAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("id")).toBe("dev-cam02");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("dedupes a duplicate vertex from a native double-click close (2 clicks then a second click + dblclick at the 3rd point)", async () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    fireEvent.click(screen.getByTestId("tray-room-NOPLAN"));

    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.click(svg, { clientX: 100, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 100 });
    // A native double-click gesture at the 3rd point: the browser fires click, click, THEN
    // dblclick — each `click` appends a draw point before `dblclick` ever commits, so without
    // dedupe this saves a junk 4-vertex polygon whose last two vertices are byte-identical.
    fireEvent.click(svg, { clientX: 200, clientY: 300 });
    fireEvent.click(svg, { clientX: 200, clientY: 300 });
    await act(async () => {
      fireEvent.doubleClick(svg, { clientX: 200, clientY: 300 });
    });

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(setRoomPolygonAction).mock.calls[callsBefore][0] as FormData;
    const parsed = JSON.parse(String(formData.get("polygon"))) as [number, number][];
    expect(parsed).toHaveLength(3);
    for (let i = 0; i < parsed.length; i++) {
      const next = parsed[(i + 1) % parsed.length];
      expect(parsed[i]).not.toEqual(next);
    }
  });

  it("Esc mid-drag cancels a pin drag: the subsequent pointerup commits nothing and the pin renders back at its pre-drag position", async () => {
    const callsBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    const svg = screen.getByTestId("floor-plan-canvas");
    const pin = screen.getByTestId("plan-pin-CAM02");
    const originalTransform = pin.getAttribute("transform");

    fireEvent.pointerDown(pin, { clientX: 687, clientY: 364, button: 0, pointerId: 5 });
    fireEvent.pointerMove(svg, { clientX: 720, clientY: 390, pointerId: 5 });

    fireEvent.keyDown(window, { key: "Escape" });

    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 720, clientY: 390, pointerId: 5 });
    });

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(callsBefore);
    const pinAfter = screen.getByTestId("plan-pin-CAM02");
    expect(pinAfter.getAttribute("transform")).toBe(originalTransform);
  });

  it("Esc mid-drag cancels a vertex drag: the subsequent pointerup commits nothing and the vertex renders back at its pre-drag position", async () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    editRoomOutline("TRI");
    const originalPoints = screen.getByTestId("plan-room-TRI").getAttribute("points");
    const vertex = screen.getByTestId("vertex-TRI-0");
    const svg = screen.getByTestId("floor-plan-canvas");

    fireEvent.pointerDown(vertex, { clientX: 10, clientY: 10, button: 0, pointerId: 6 });
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 50, pointerId: 6 });

    fireEvent.keyDown(window, { key: "Escape" });

    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 50, clientY: 50, pointerId: 6 });
    });

    // Esc cancels the drag: nothing commits and the polygon's geometry is untouched (asserting on
    // the durable outline, not the vertex handle, which Esc also dismisses by exiting edit mode).
    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore);
    expect(screen.getByTestId("plan-room-TRI").getAttribute("points")).toBe(originalPoints);
  });

  it("refuses to delete a vertex below 3 points, leaving the polygon unchanged", async () => {
    const callsBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();

    // TRI has exactly 3 vertices — deleting any one must be refused.
    editRoomOutline("TRI");
    const vertex = screen.getByTestId("vertex-TRI-0");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(vertex, { clientX: 10, clientY: 10, button: 0, pointerId: 3 });
    fireEvent.pointerUp(svg, { clientX: 10, clientY: 10, pointerId: 3 });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(callsBefore);
    const points = screen.getByTestId("plan-room-TRI").getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(3);
  });

  it("tapping a room shows its edit/delete popover but no vertex handles yet", () => {
    renderCanvas(true);
    enterEditMode();
    expect(screen.queryByTestId("room-actions-popover")).toBeNull();

    // A NON-first outlined room, tapped (zero-travel).
    tapRoom("TRI");

    expect(screen.getByTestId("room-actions-popover")).toBeInTheDocument();
    expect(screen.getByTestId("room-action-edit")).toBeInTheDocument();
    expect(screen.getByTestId("room-action-delete")).toBeInTheDocument();
    // Handles only appear once Edit is clicked — a plain select can't be fumbled into a drag.
    expect(screen.queryByTestId("vertex-TRI-0")).toBeNull();
  });

  it("a pan (press that travels past the tap threshold) does NOT select a room", () => {
    renderCanvas(true);
    enterEditMode();
    const poly = screen.getByTestId("plan-room-TRI");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(poly, { clientX: 120, clientY: 120, button: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 180, clientY: 150, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: 180, clientY: 150, pointerId: 2 });
    expect(screen.queryByTestId("room-actions-popover")).toBeNull();
  });

  it("the Edit icon reveals vertex handles for that room", () => {
    renderCanvas(true);
    enterEditMode();
    tapRoom("TRI");
    expect(screen.queryByTestId("vertex-TRI-0")).toBeNull();
    fireEvent.click(screen.getByTestId("room-action-edit"));
    expect(screen.getByTestId("vertex-TRI-0")).toBeInTheDocument();
    expect(screen.getByTestId("vertex-TRI-2")).toBeInTheDocument();
  });

  it("the Delete icon clears the OUTLINE (not the room) via clearRoomPolygonAction with that room's id", async () => {
    const callsBefore = vi.mocked(clearRoomPolygonAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    tapRoom("TRI");
    await act(async () => {
      fireEvent.click(screen.getByTestId("room-action-delete"));
    });
    expect(clearRoomPolygonAction).toHaveBeenCalledTimes(callsBefore + 1);
    const fd = vi.mocked(clearRoomPolygonAction).mock.calls.at(-1)![0] as FormData;
    expect(fd.get("roomId")).toBe("room-tri");
    // Popover closes on delete.
    expect(screen.queryByTestId("room-actions-popover")).toBeNull();
  });

  it("tapping empty plan space deselects the room", () => {
    renderCanvas(true);
    enterEditMode();
    tapRoom("TRI");
    expect(screen.getByTestId("room-actions-popover")).toBeInTheDocument();
    // A zero-travel tap that starts on the SVG root (no data-room-id) clears the selection.
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(svg, { clientX: 300, clientY: 300, button: 0, pointerId: 4 });
    fireEvent.pointerUp(svg, { clientX: 300, clientY: 300, pointerId: 4 });
    expect(screen.queryByTestId("room-actions-popover")).toBeNull();
  });

  it("right-click while TRACING removes the last placed point", async () => {
    renderCanvas(true);
    enterEditMode();
    fireEvent.click(screen.getByTestId("tray-room-NOPLAN"));
    const svg = screen.getByTestId("floor-plan-canvas");
    // Four corners, then undo one → three remain → Enter commits a 3-vertex polygon.
    fireEvent.click(svg, { clientX: 100, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 100 });
    fireEvent.click(svg, { clientX: 300, clientY: 300 });
    fireEvent.click(svg, { clientX: 100, clientY: 300 });
    fireEvent.contextMenu(svg);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    const fd = vi.mocked(setRoomPolygonAction).mock.calls.at(-1)![0] as FormData;
    expect(JSON.parse(String(fd.get("polygon")))).toHaveLength(3);
  });

  it("right-click while EDITING reverts the last committed vertex change", async () => {
    renderCanvas(true);
    enterEditMode();
    editRoomOutline("TRI"); // TRI has 3 vertices; handles shown
    const svg = screen.getByTestId("floor-plan-canvas");

    // Insert a vertex → commits a 4-point polygon and records the 3-point original for undo.
    await act(async () => {
      fireEvent.click(screen.getByTestId("vertex-insert-TRI-0"));
    });
    const afterInsert = JSON.parse(
      String((vi.mocked(setRoomPolygonAction).mock.calls.at(-1)![0] as FormData).get("polygon"))
    );
    expect(afterInsert).toHaveLength(4);

    // Right-click → re-commits the original 3-point polygon.
    await act(async () => {
      fireEvent.contextMenu(svg);
    });
    const afterUndo = JSON.parse(
      String((vi.mocked(setRoomPolygonAction).mock.calls.at(-1)![0] as FormData).get("polygon"))
    );
    expect(afterUndo).toHaveLength(3);
  });

  it("renders a marker for a placed rack and lists unplaced racks in the tray (never 'everything is placed')", () => {
    renderCanvas(true);
    enterEditMode();
    expect(screen.getByTestId("plan-rack-RK01")).toBeInTheDocument(); // placed → marker
    expect(screen.queryByTestId("plan-rack-RK02")).toBeNull(); // unplaced → no marker
    expect(screen.getByTestId("tray-rack-RK02")).toBeInTheDocument(); // unplaced → tray prompt
    expect(screen.getByTestId("tray-rack-RK03")).toBeInTheDocument();
    // With unplaced racks present, the tray must NOT claim everything is placed.
    expect(screen.queryByText("Everything is placed")).toBeNull();
  });

  it("places a NON-first tray rack at the clicked plan position", async () => {
    const before = vi.mocked(placeRackAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    fireEvent.click(screen.getByTestId("tray-rack-RK03")); // non-first unplaced rack
    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: 200, clientY: 150 });
    });
    expect(placeRackAction).toHaveBeenCalledTimes(before + 1);
    const fd = vi.mocked(placeRackAction).mock.calls.at(-1)![0] as FormData;
    expect(fd.get("id")).toBe("rack-un2");
    const x = Number(fd.get("x")), y = Number(fd.get("y"));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);
  });

  it("a still press on a placed rack selects it (popover) and commits no move", async () => {
    const before = vi.mocked(placeRackAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    expect(screen.queryByTestId("rack-actions-popover")).toBeNull();
    const marker = screen.getByTestId("plan-rack-RK01");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(marker, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 120, clientY: 120, pointerId: 1 });
    });
    expect(screen.getByTestId("rack-actions-popover")).toBeInTheDocument();
    expect(screen.getByTestId("rack-action-edit")).toBeInTheDocument();
    expect(screen.getByTestId("rack-action-delete")).toBeInTheDocument();
    // A still press is a select, never a move.
    expect(placeRackAction).toHaveBeenCalledTimes(before);
  });

  it("dragging a placed rack commits exactly ONE move (placeRackAction) and leaves pan unchanged", async () => {
    const before = vi.mocked(placeRackAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    const svg = screen.getByTestId("floor-plan-canvas");
    const transformBefore = svg.querySelector("g")!.getAttribute("transform");

    const marker = screen.getByTestId("plan-rack-RK01");
    fireEvent.pointerDown(marker, { clientX: 300, clientY: 300, button: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 320, clientY: 310, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 350, clientY: 330, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: 380, clientY: 350, pointerId: 2 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 380, clientY: 350, pointerId: 2 });
    });

    expect(placeRackAction).toHaveBeenCalledTimes(before + 1);
    const fd = vi.mocked(placeRackAction).mock.calls.at(-1)![0] as FormData;
    expect(fd.get("id")).toBe("rack-placed");
    const x = Number(fd.get("x")), y = Number(fd.get("y"));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);
    // The marker's pointerdown must stopPropagation, or this drag would also pan the canvas.
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(transformBefore);
  });

  it("the rack Edit icon opens the rack in the rack designer (/racks/<id>)", () => {
    renderCanvas(true);
    enterEditMode();
    const marker = screen.getByTestId("plan-rack-RK01");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(marker, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.click(screen.getByTestId("rack-action-edit"));
    expect(pushMock).toHaveBeenCalledWith("/racks/rack-placed");
  });

  it("the rack Delete icon clears the PLACEMENT (not the rack) via clearRackPlacementAction with that id", async () => {
    const before = vi.mocked(clearRackPlacementAction).mock.calls.length;
    renderCanvas(true);
    enterEditMode();
    const marker = screen.getByTestId("plan-rack-RK01");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(marker, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 120, clientY: 120, pointerId: 1 });
    await act(async () => {
      fireEvent.click(screen.getByTestId("rack-action-delete"));
    });
    expect(clearRackPlacementAction).toHaveBeenCalledTimes(before + 1);
    const fd = vi.mocked(clearRackPlacementAction).mock.calls.at(-1)![0] as FormData;
    expect(fd.get("id")).toBe("rack-placed");
    expect(screen.queryByTestId("rack-actions-popover")).toBeNull();
  });
});

describe("FloorPlanCanvas (pin labels toggle)", () => {
  it("toggles the plan pane into hover-only-label mode", () => {
    renderCanvas();
    const pane = screen.getByTestId("floor-plan-canvas").parentElement!;
    expect(pane.className).not.toContain("pins-hover-labels");

    fireEvent.click(screen.getByTestId("toggle-pin-labels"));
    expect(pane.className).toContain("pins-hover-labels");

    fireEvent.click(screen.getByTestId("toggle-pin-labels"));
    expect(pane.className).not.toContain("pins-hover-labels");
  });
});

describe("FloorPlanCanvas (create-by-geometry handle)", () => {
  function renderWithHandle(props: {
    ref: React.Ref<FloorPlanCanvasHandle>;
    onRoomTraced?: (polygon: [number, number][]) => void;
    onDevicePlaced?: (point: [number, number]) => void;
  }) {
    return render(
      <FloorPlanCanvas
        ref={props.ref}
        plan={PLAN}
        planUrl={PLAN_URL}
        rooms={ROOMS}
        devices={DEVICES}
        racks={RACKS}
        deviceTypes={DEVICE_TYPES}
        editable
        onRoomTraced={props.onRoomTraced}
        onDevicePlaced={props.onDevicePlaced}
      />
    );
  }

  it("startPlaceDevice + a plan click reports the placed point (no id, no place action)", async () => {
    const before = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    const onDevicePlaced = vi.fn();
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithHandle({ ref, onDevicePlaced });

    act(() => ref.current!.startPlaceDevice());
    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: 400, clientY: 300 });
    });

    expect(onDevicePlaced).toHaveBeenCalledTimes(1);
    const [pt] = onDevicePlaced.mock.calls[0];
    expect(pt[0]).toBeGreaterThanOrEqual(0);
    expect(pt[0]).toBeLessThanOrEqual(1);
    expect(pt[1]).toBeGreaterThanOrEqual(0);
    expect(pt[1]).toBeLessThanOrEqual(1);
    // Creation defers persistence to the modal — the canvas never places an id-less device itself.
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(before);
  });

  it("startTraceRoom + three clicks + double-click reports the traced outline", async () => {
    const onRoomTraced = vi.fn();
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithHandle({ ref, onRoomTraced });

    act(() => ref.current!.startTraceRoom());
    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: 300, clientY: 200 });
      fireEvent.click(svg, { clientX: 500, clientY: 200 });
      fireEvent.click(svg, { clientX: 400, clientY: 400 });
    });
    await act(async () => {
      fireEvent.doubleClick(svg, { clientX: 400, clientY: 400 });
    });

    expect(onRoomTraced).toHaveBeenCalledTimes(1);
    const [polygon] = onRoomTraced.mock.calls[0];
    expect(polygon.length).toBeGreaterThanOrEqual(3);
    expect(isValidPolygon(polygon)).toBe(true);
  });

  it("right-click removes the last traced point during Add room (runs outside edit mode)", async () => {
    const ref = createRef<FloorPlanCanvasHandle>();
    const { container } = renderWithHandle({ ref });

    act(() => ref.current!.startTraceRoom());
    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: 300, clientY: 200 });
      fireEvent.click(svg, { clientX: 500, clientY: 200 });
      fireEvent.click(svg, { clientX: 400, clientY: 400 });
    });
    expect(container.querySelectorAll('[data-testid^="draw-point-"]')).toHaveLength(3);

    await act(async () => {
      fireEvent.contextMenu(svg, { clientX: 400, clientY: 400 });
    });
    expect(container.querySelectorAll('[data-testid^="draw-point-"]')).toHaveLength(2);
  });

  it("snaps a traced point to a nearby existing-room vertex", async () => {
    const onRoomTraced = vi.fn();
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithHandle({ ref, onRoomTraced });

    act(() => ref.current!.startTraceRoom());
    const svg = screen.getByTestId("floor-plan-canvas");
    // room-mdf's corner [0.3, 0.1] renders at screen ~(267, 56) given the jsdom fallback fit
    // (870px pane, 1200x800 plan -> zoom 0.7, panX 15). Click ~4px off it: it should snap exactly.
    await act(async () => {
      fireEvent.click(svg, { clientX: 270, clientY: 59 });
      fireEvent.click(svg, { clientX: 500, clientY: 300 });
      fireEvent.click(svg, { clientX: 300, clientY: 400 });
    });
    await act(async () => {
      fireEvent.doubleClick(svg, { clientX: 300, clientY: 400 });
    });

    expect(onRoomTraced).toHaveBeenCalledTimes(1);
    const [polygon] = onRoomTraced.mock.calls[0];
    expect(polygon[0][0]).toBeCloseTo(0.3, 5);
    expect(polygon[0][1]).toBeCloseTo(0.1, 5);
  });

  it("snaps a traced point onto an existing wall between corners (edge snap)", async () => {
    const onRoomTraced = vi.fn();
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithHandle({ ref, onRoomTraced });

    act(() => ref.current!.startTraceRoom());
    const svg = screen.getByTestId("floor-plan-canvas");
    // room-mdf's top wall runs [0.1,0.1]->[0.3,0.1] (screen y ~56); its midpoint is ~(183, 56).
    // Click ~3px below it, far from either corner: it should snap onto the wall, not a corner.
    await act(async () => {
      fireEvent.click(svg, { clientX: 183, clientY: 59 });
      fireEvent.click(svg, { clientX: 500, clientY: 300 });
      fireEvent.click(svg, { clientX: 300, clientY: 400 });
    });
    await act(async () => {
      fireEvent.doubleClick(svg, { clientX: 300, clientY: 400 });
    });

    expect(onRoomTraced).toHaveBeenCalledTimes(1);
    const [polygon] = onRoomTraced.mock.calls[0];
    expect(polygon[0][1]).toBeCloseTo(0.1, 5); // pinned onto the wall's y
    expect(polygon[0][0]).toBeGreaterThan(0.1); // strictly between the two corners
    expect(polygon[0][0]).toBeLessThan(0.3);
  });
});

describe("FloorPlanCanvas (AI discovery wizard)", () => {
  /** Open the wizard menu and run one discovery pass, flushing the action's promise. */
  async function runDiscovery(which: "discover-rooms" | "discover-devices") {
    fireEvent.click(screen.getByTestId("plan-wizard"));
    await act(async () => {
      fireEvent.click(screen.getByTestId(which));
    });
  }

  it("hides the wizard button when editable is false", () => {
    renderCanvas(false);
    expect(screen.queryByTestId("plan-wizard")).toBeNull();
  });

  it("opens a menu with both discovery passes", () => {
    renderCanvas(true);
    expect(screen.queryByTestId("plan-wizard-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("plan-wizard"));
    expect(screen.getByTestId("plan-wizard-menu")).toBeInTheDocument();
    expect(screen.getByTestId("discover-rooms")).toBeInTheDocument();
    expect(screen.getByTestId("discover-devices")).toBeInTheDocument();
  });

  it("renders a ghost pin for every discovered device", async () => {
    renderCanvas(true);
    await runDiscovery("discover-devices");

    expect(discoverDevicesAction).toHaveBeenCalledWith("floor-1");
    // Positioned in IMAGE-PIXEL space like every committed pin: [0.5,0.5] on a 1200x800 plan.
    expect(screen.getByTestId("proposal-pin-dev-0").getAttribute("transform")).toBe("translate(600 400)");
    expect(screen.getByTestId("proposal-pin-dev-1")).toBeInTheDocument();
    // The menu closes as the pass starts, so the plan isn't obscured while reviewing.
    expect(screen.queryByTestId("plan-wizard-menu")).toBeNull();
  });

  it("renders a ghost polygon with the discovered vertex count", async () => {
    const { container } = renderCanvas(true);
    await runDiscovery("discover-rooms");

    const group = screen.getByTestId("proposal-room-room-0");
    const polygon = group.querySelector("polygon")!;
    expect(polygon.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(4);
    // Rooms-only pass: no device ghosts leak in.
    expect(container.querySelectorAll('[data-testid^="proposal-pin-"]')).toHaveLength(0);
  });

  it("draws proposals ON TOP of the committed shapes", async () => {
    const { container } = renderCanvas(true);
    await runDiscovery("discover-devices");

    const live = container.querySelector('[data-testid="floor-plan-canvas"] > g')!;
    const nodes = Array.from(live.querySelectorAll("*"));
    const committed = nodes.indexOf(screen.getByTestId("plan-pin-CAM01"));
    const proposed = nodes.indexOf(screen.getByTestId("proposal-pin-dev-0"));
    expect(committed).toBeGreaterThanOrEqual(0);
    expect(proposed).toBeGreaterThan(committed);
  });

  it("points a missing Gemini key at Settings instead of printing the sentinel", async () => {
    vi.mocked(discoverDevicesAction).mockResolvedValueOnce({ ok: false, error: "no-key" });
    const { container } = renderCanvas(true);
    await runDiscovery("discover-devices");

    const notice = screen.getByTestId("wizard-notice");
    expect(notice.textContent).toContain("Settings");
    expect(notice.textContent).not.toContain("no-key");
    expect(notice.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="proposal-pin-"]')).toHaveLength(0);
  });

  it("says so when a pass finds nothing", async () => {
    vi.mocked(discoverRoomsAction).mockResolvedValueOnce({ ok: true, proposals: [] });
    renderCanvas(true);
    await runDiscovery("discover-rooms");

    expect(screen.getByTestId("wizard-notice").textContent).toContain("Nothing found");
  });

  it("surfaces any other action error verbatim", async () => {
    vi.mocked(discoverRoomsAction).mockResolvedValueOnce({
      ok: false,
      error: "The vision model is busy right now — please try again in a moment.",
    });
    renderCanvas(true);
    await runDiscovery("discover-rooms");

    expect(screen.getByTestId("wizard-notice").textContent).toContain("busy right now");
  });
});

describe("FloorPlanCanvas (proposal editing, accept / dismiss)", () => {
  // The jsdom fallback view (no ResizeObserver): fit zoom 0.7, panX 15, panY 0 on this 1200x800
  // plan — the same derivation the placement test above spells out. A pointer at (cx, cy) is
  // therefore this normalized point, which is what an accepted proposal must commit.
  const normX = (cx: number) => (cx - 15) / 840;
  const normY = (cy: number) => cy / 560;

  function deviceProposal(over: Partial<DeviceProposal> = {}): DeviceProposal {
    return { id: "dev-0", label: "CAM09", typeCode: "CAM", point: [0.5, 0.5], confidence: "high", ...over };
  }
  function roomProposal(over: Partial<RoomProposal> = {}): RoomProposal {
    return {
      id: "room-0",
      name: "Server room",
      roomType: "IDF",
      polygon: [
        [0.1, 0.1],
        [0.3, 0.1],
        [0.3, 0.3],
        [0.1, 0.3],
      ],
      confidence: "high",
      ...over,
    };
  }

  /** Render the canvas and stage exactly these device proposals through a real discovery pass. */
  async function stageDevices(proposals: DeviceProposal[]) {
    vi.mocked(discoverDevicesAction).mockResolvedValueOnce({ ok: true, proposals });
    renderCanvas(true);
    fireEvent.click(screen.getByTestId("plan-wizard"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("discover-devices"));
    });
  }
  async function stageRooms(proposals: RoomProposal[]) {
    vi.mocked(discoverRoomsAction).mockResolvedValueOnce({ ok: true, proposals });
    renderCanvas(true);
    fireEvent.click(screen.getByTestId("plan-wizard"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("discover-rooms"));
    });
  }

  async function clickAsync(testId: string) {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId));
    });
  }

  const lastFormData = (mock: unknown) =>
    (vi.mocked(mock as (fd: FormData) => Promise<unknown>).mock.calls.at(-1)![0]) as FormData;

  it("shows no panel while there is nothing to review", () => {
    renderCanvas(true);
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  it("shows a panel row per proposal once a pass returns", async () => {
    await stageDevices([deviceProposal(), deviceProposal({ id: "dev-1", label: "AP02", typeCode: "AP" })]);
    expect(screen.getByTestId("proposal-panel")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-item-dev-0")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-item-dev-1")).toBeInTheDocument();
  });

  it("accepts a device matching an EXISTING UNPLACED device: places THAT id, creates nothing", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    // TO02 is the SECOND unplaced device in the fixture — never "the first row".
    await stageDevices([deviceProposal({ label: "TO02", typeCode: "TO", point: [0.25, 0.75] })]);

    await clickAsync("accept-dev-0");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore);
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 1);
    const fd = lastFormData(placeFloorDeviceAction);
    expect(fd.get("id")).toBe("dev-to02");
    expect(Number(fd.get("x"))).toBeCloseTo(0.25, 10);
    expect(Number(fd.get("y"))).toBeCloseTo(0.75, 10);
    // Accepted proposals leave the panel; this was the only one, so the panel goes with it.
    expect(screen.queryByTestId("proposal-item-dev-0")).toBeNull();
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("accepts an UNMATCHED device by creating it with the label as its code, then placing the NEW id", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    await stageDevices([deviceProposal({ label: "CAM09", typeCode: "CAM", point: [0.2, 0.4] })]);

    await clickAsync("accept-dev-0");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore + 1);
    const cfd = lastFormData(createFloorDeviceAction);
    expect(cfd.get("floorId")).toBe("floor-1");
    expect(cfd.get("code")).toBe("CAM09");
    // The proposal carries a type CODE; the action needs the type's ID.
    expect(cfd.get("deviceTypeId")).toBe("type-cam");
    expect(cfd.get("status")).toBe("planned");
    expect(cfd.get("roomId")).toBe("");

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 1);
    const pfd = lastFormData(placeFloorDeviceAction);
    expect(pfd.get("id")).toBe("dev-fresh");
    expect(Number(pfd.get("x"))).toBeCloseTo(0.2, 10);
    expect(Number(pfd.get("y"))).toBeCloseTo(0.4, 10);
    // Create STRICTLY before place — the placement is chained on the id the create returned.
    expect(vi.mocked(createFloorDeviceAction).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(placeFloorDeviceAction).mock.invocationCallOrder.at(-1)!
    );
    expect(screen.queryByTestId("proposal-item-dev-0")).toBeNull();
  });

  it("refuses a device whose label is ALREADY on the plan: no action at all, proposal dropped, error shown", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    // CAM01 exists AND is placed (x/y set) — device codes are site-unique, so this is a duplicate.
    await stageDevices([deviceProposal({ label: "CAM01", typeCode: "CAM" })]);

    await clickAsync("accept-dev-0");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore);
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore);
    expect(screen.queryByTestId("proposal-item-dev-0")).toBeNull();
    expect(screen.getByTestId("canvas-error").textContent).toContain("CAM01");
  });

  it("refuses to create a device for an unknown type code rather than sending a bad type id", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal({ label: "XX01", typeCode: "ZZZ" })]);

    await clickAsync("accept-dev-0");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore);
    expect(screen.getByTestId("canvas-error").textContent).toContain("ZZZ");
    // Nothing was committed, so the proposal stays staged for a type fix.
    expect(screen.getByTestId("proposal-item-dev-0")).toBeInTheDocument();
  });

  it("accepts a room matching a POLYGON-LESS room by name: outlines THAT room, creates nothing", async () => {
    const setBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    const createBefore = vi.mocked(createRoomAction).mock.calls.length;
    // "No polygon yet" is the fixture's third room (code NOPLAN) and the only one without a polygon.
    await stageRooms([roomProposal({ name: "No polygon yet" })]);

    await clickAsync("accept-room-0");

    expect(createRoomAction).toHaveBeenCalledTimes(createBefore);
    expect(setRoomPolygonAction).toHaveBeenCalledTimes(setBefore + 1);
    const fd = lastFormData(setRoomPolygonAction);
    expect(fd.get("roomId")).toBe("room-none");
    expect(JSON.parse(String(fd.get("polygon")))).toEqual([
      [0.1, 0.1],
      [0.3, 0.1],
      [0.3, 0.3],
      [0.1, 0.3],
    ]);
    expect(screen.queryByTestId("proposal-item-room-0")).toBeNull();
  });

  it("accepts an UNMATCHED room by creating it, then outlining the NEW id", async () => {
    const createBefore = vi.mocked(createRoomAction).mock.calls.length;
    const setBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    vi.mocked(createRoomAction).mockResolvedValueOnce({ ok: true, id: "room-fresh" });
    await stageRooms([roomProposal({ name: "Server room", roomType: "IDF" })]);

    await clickAsync("accept-room-0");

    expect(createRoomAction).toHaveBeenCalledTimes(createBefore + 1);
    const cfd = lastFormData(createRoomAction);
    expect(cfd.get("floorId")).toBe("floor-1");
    expect(cfd.get("name")).toBe("Server room");
    expect(cfd.get("type")).toBe("IDF");
    // Generated from the room type prefix against the existing codes (MDF / TRI / NOPLAN).
    expect(cfd.get("code")).toBe("IDF01");

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(setBefore + 1);
    const sfd = lastFormData(setRoomPolygonAction);
    expect(sfd.get("roomId")).toBe("room-fresh");
    expect(vi.mocked(createRoomAction).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(setRoomPolygonAction).mock.invocationCallOrder.at(-1)!
    );
    expect(screen.queryByTestId("proposal-item-room-0")).toBeNull();
  });

  it("dismisses a NON-first proposal with no action call, leaving the others staged", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal(), deviceProposal({ id: "dev-1", label: "AP02", typeCode: "AP" })]);

    await clickAsync("dismiss-dev-1");

    expect(screen.queryByTestId("proposal-item-dev-1")).toBeNull();
    expect(screen.queryByTestId("proposal-pin-dev-1")).toBeNull();
    expect(screen.getByTestId("proposal-item-dev-0")).toBeInTheDocument();
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore);
    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore);
  });

  it("dismisses everything at once with no action call", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal(), deviceProposal({ id: "dev-1", label: "AP02", typeCode: "AP" })]);

    await clickAsync("dismiss-all");

    expect(screen.queryByTestId("proposal-panel")).toBeNull();
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore);
  });

  it("accepts all SEQUENTIALLY, and a failure keeps only its own proposal staged", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    // The FIRST accept fails; the batch must carry on and still place the second.
    vi.mocked(placeFloorDeviceAction).mockResolvedValueOnce({ ok: false, error: "Placement rejected" });
    await stageDevices([
      deviceProposal({ id: "dev-0", label: "TO01", typeCode: "TO", point: [0.1, 0.1] }),
      deviceProposal({ id: "dev-1", label: "TO02", typeCode: "TO", point: [0.9, 0.9] }),
    ]);

    await clickAsync("accept-all");

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 2);
    expect(vi.mocked(placeFloorDeviceAction).mock.calls.at(-2)![0].get("id")).toBe("dev-to01");
    expect(vi.mocked(placeFloorDeviceAction).mock.calls.at(-1)![0].get("id")).toBe("dev-to02");
    // The failed one stays for a retry; the succeeded one is gone.
    expect(screen.getByTestId("proposal-item-dev-0")).toBeInTheDocument();
    expect(screen.queryByTestId("proposal-item-dev-1")).toBeNull();
    // The batch's error survives the later success that cleared the canvas error.
    expect(screen.getByTestId("canvas-error").textContent).toContain("Placement rejected");
  });

  it("an edited label decides the commit: retyping it onto an existing device places that device", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal({ label: "CAM09", typeCode: "CAM" })]);

    fireEvent.change(screen.getByTestId("proposal-label-dev-0"), { target: { value: "TO02" } });
    await clickAsync("accept-dev-0");

    // Editing is state-only: nothing was committed until Accept, and then it was a PLACE.
    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore);
    expect(lastFormData(placeFloorDeviceAction).get("id")).toBe("dev-to02");
  });

  it("an edited type decides which device type is created", async () => {
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    await stageDevices([deviceProposal({ label: "SEN09", typeCode: "CAM" })]);

    fireEvent.change(screen.getByTestId("proposal-type-dev-0"), { target: { value: "SEN" } });
    await clickAsync("accept-dev-0");

    expect(lastFormData(createFloorDeviceAction).get("deviceTypeId")).toBe("type-sen");
  });

  it("an edited room name and type flow into the created room", async () => {
    vi.mocked(createRoomAction).mockResolvedValueOnce({ ok: true, id: "room-fresh" });
    await stageRooms([roomProposal({ name: "Server room", roomType: "IDF" })]);

    fireEvent.change(screen.getByTestId("proposal-name-room-0"), { target: { value: "Comms cupboard" } });
    fireEvent.change(screen.getByTestId("proposal-roomtype-room-0"), { target: { value: "MDF" } });
    await clickAsync("accept-room-0");

    const fd = lastFormData(createRoomAction);
    expect(fd.get("name")).toBe("Comms cupboard");
    expect(fd.get("type")).toBe("MDF");
    expect(fd.get("code")).toBe("MDF01");
  });

  it("dragging a ghost pin moves it, commits nothing, and never pans the canvas", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal({ label: "CAM09", point: [0.5, 0.5] })]);

    const svg = screen.getByTestId("floor-plan-canvas");
    const transformBefore = svg.querySelector("g")!.getAttribute("transform");
    const pin = screen.getByTestId("proposal-pin-dev-0");
    expect(pin.getAttribute("transform")).toBe("translate(600 400)");

    fireEvent.pointerDown(pin, { clientX: 615, clientY: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 500, clientY: 350, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 300, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 400, clientY: 300, pointerId: 1 });
    });

    // Moving a ghost is a staged edit — never an action.
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore);
    const moved = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(
      screen.getByTestId("proposal-pin-dev-0").getAttribute("transform")!
    )!;
    expect(Number(moved[1])).toBeCloseTo(normX(400) * 1200, 6);
    expect(Number(moved[2])).toBeCloseTo(normY(300) * 800, 6);
    // The ghost owns its pointer-down, so the plan must not have panned with it — during the drag,
    // and equally after it: a press that reached the SVG root would leave a pan armed behind it,
    // and the very next pointer move (button already up) would drag the whole plan.
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(transformBefore);
    fireEvent.pointerMove(svg, { clientX: 250, clientY: 200, pointerId: 1 });
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(transformBefore);

    // Accepting afterwards commits the DRAGGED point, not the model's original one.
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    await clickAsync("accept-dev-0");
    const fd = lastFormData(placeFloorDeviceAction);
    expect(Number(fd.get("x"))).toBeCloseTo(normX(400), 10);
    expect(Number(fd.get("y"))).toBeCloseTo(normY(300), 10);
  });

  it("shows a proposed room's vertex handles only once outline editing is toggled on", async () => {
    await stageRooms([roomProposal()]);
    expect(screen.queryByTestId("proposal-vertex-room-0-0")).toBeNull();

    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));
    // One handle per vertex, in image-pixel space: [0.1,0.1] on a 1200x800 plan.
    expect(screen.getByTestId("proposal-vertex-room-0-0").getAttribute("cx")).toBe("120");
    expect(screen.getByTestId("proposal-vertex-room-0-3")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));
    expect(screen.queryByTestId("proposal-vertex-room-0-0")).toBeNull();
  });

  it("dragging a proposed room's vertex reshapes it with no action, and Accept commits the new outline", async () => {
    const setBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    await stageRooms([roomProposal({ name: "No polygon yet" })]);
    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));

    const svg = screen.getByTestId("floor-plan-canvas");
    const transformBefore = svg.querySelector("g")!.getAttribute("transform");
    fireEvent.pointerDown(screen.getByTestId("proposal-vertex-room-0-0"), {
      clientX: 99, clientY: 71, button: 0, pointerId: 1,
    });
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 300, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 400, clientY: 300, pointerId: 1 });
    });
    expect(setRoomPolygonAction).toHaveBeenCalledTimes(setBefore);
    // The handle owns its pointer-down, so no pan was armed by the gesture or left behind it.
    fireEvent.pointerMove(svg, { clientX: 250, clientY: 200, pointerId: 1 });
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(transformBefore);

    await clickAsync("accept-room-0");
    const polygon = JSON.parse(String(lastFormData(setRoomPolygonAction).get("polygon")));
    expect(polygon).toHaveLength(4);
    expect(polygon[0][0]).toBeCloseTo(normX(400), 10);
    expect(polygon[0][1]).toBeCloseTo(normY(300), 10);
    // Every other vertex is untouched.
    expect(polygon[1]).toEqual([0.3, 0.1]);
  });

  it("inserts a vertex on a proposed room's edge, and Delete removes a selected one", async () => {
    await stageRooms([roomProposal({ name: "No polygon yet" })]);
    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));

    fireEvent.click(screen.getByTestId("proposal-vertex-insert-room-0-0"));
    expect(screen.getByTestId("proposal-vertex-room-0-4")).toBeInTheDocument();
    // The midpoint of edge 0 ([0.1,0.1] -> [0.3,0.1]) landed at index 1.
    expect(screen.getByTestId("proposal-vertex-room-0-1").getAttribute("cx")).toBe("240");

    // Select a vertex (a press with no travel) and delete it.
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(screen.getByTestId("proposal-vertex-room-0-1"), {
      clientX: 200, clientY: 90, button: 0, pointerId: 1,
    });
    fireEvent.pointerUp(svg, { clientX: 200, clientY: 90, pointerId: 1 });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(screen.queryByTestId("proposal-vertex-room-0-4")).toBeNull();

    await clickAsync("accept-room-0");
    expect(JSON.parse(String(lastFormData(setRoomPolygonAction).get("polygon")))).toEqual([
      [0.1, 0.1],
      [0.3, 0.1],
      [0.3, 0.3],
      [0.1, 0.3],
    ]);
  });

  it("Esc closes the wizard menu", () => {
    renderCanvas(true);
    fireEvent.click(screen.getByTestId("plan-wizard"));
    expect(screen.getByTestId("plan-wizard-menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("plan-wizard-menu")).toBeNull();
  });

  it("a click outside the wizard menu closes it", () => {
    renderCanvas(true);
    fireEvent.click(screen.getByTestId("plan-wizard"));
    expect(screen.getByTestId("plan-wizard-menu")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("floor-plan-canvas"), { clientX: 400, clientY: 300, button: 0, pointerId: 1 });
    expect(screen.queryByTestId("plan-wizard-menu")).toBeNull();
  });
});
