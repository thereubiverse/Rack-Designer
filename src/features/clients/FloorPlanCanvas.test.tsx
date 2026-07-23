import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FloorPlanCanvas } from "./FloorPlanCanvas";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { isValidPolygon } from "./floorPlanOps";
import {
  placeFloorDeviceAction,
  clearFloorDevicePlacementAction,
  setRoomPolygonAction,
  clearRoomPolygonAction,
} from "./actions";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("./actions", () => ({
  placeFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  clearFloorDevicePlacementAction: vi.fn(async () => ({ ok: true })),
  setRoomPolygonAction: vi.fn(async () => ({ ok: true })),
  clearRoomPolygonAction: vi.fn(async () => ({ ok: true })),
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
});
