import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { getDocument as pdfjsGetDocument } from "pdfjs-dist";
import { FloorPlanCanvas, type FloorPlanCanvasHandle } from "./FloorPlanCanvas";
import type { FloorPlanRow, RoomRow, FloorDeviceRow, WallRun } from "@/lib/supabase/types";
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
import { discoverSymbolsAction, pickSymbolAction } from "./symbolActions";
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
// Symbol discovery is a server action too (Supabase + pdf.js + the raster matcher). Same contract:
// the canvas only awaits its result shape.
vi.mock("./symbolActions", () => ({
  discoverSymbolsAction: vi.fn(async () => ({ ok: true, proposals: [] })),
  pickSymbolAction: vi.fn(async () => ({
    ok: true,
    box: { x: 0.1, y: 0.2, w: 0.05, h: 0.06 },
    pathCount: 12,
  })),
}));

/** Open the wizard and run the AI device pass. It now lives one level down, under "Discover
 *  devices" — clicking that item opens the device-type submenu the symbol flow starts from, and
 *  the AI entry sits at its head. The drill-down click stays OUTSIDE act so the submenu has
 *  actually rendered before the AI entry is looked up. */
async function runDeviceAiPass() {
  fireEvent.click(screen.getByTestId("plan-wizard"));
  fireEvent.click(screen.getByTestId("discover-devices"));
  await act(async () => {
    fireEvent.click(screen.getByTestId("discover-devices-ai"));
  });
}

// PlanVectorLayer lazily imports pdf.js, which evaluates `new DOMMatrix()` at module scope and
// cannot rasterise in jsdom anyway. These tests only care WHICH layer the canvas chooses, so the
// library is faked; the layer's own debounce/cancel behaviour is covered in PlanVectorLayer.test.tsx.
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  // The document never resolves: these tests assert the DOM shape the canvas mounts, and a load
  // that completes would only settle state after the assertions (outside act) for no added cover.
  getDocument: vi.fn(() => ({
    promise: new Promise<never>(() => {}),
    destroy: async () => {},
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
  pdf_storage_path: null,
  pdf_page: null,
  wall_runs: null,
  plan_labels: null,
  geometry_extracted_at: null,
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

// Every code at the SITE — the fixture floor's own, by default. Device codes are unique per SITE,
// so a test can widen this to prove a generated code dodges another floor's codes too.
const SITE_CODES = DEVICES.map((d) => d.code);

function renderCanvas(editable = false, allSiteDeviceCodes: string[] = SITE_CODES) {
  return render(
    <FloorPlanCanvas
      plan={PLAN}
      planUrl={PLAN_URL}
      rooms={ROOMS}
      devices={DEVICES}
      racks={RACKS}
      deviceTypes={DEVICE_TYPES}
      allSiteDeviceCodes={allSiteDeviceCodes}
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
        allSiteDeviceCodes={SITE_CODES}
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
    if (which === "discover-devices") {
      await runDeviceAiPass();
      return;
    }
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

  /** Render the canvas and stage exactly these device proposals through a real discovery pass.
   *  `siteCodes` widens the site-wide code space beyond this floor's own codes. */
  async function stageDevices(proposals: DeviceProposal[], siteCodes: string[] = SITE_CODES) {
    vi.mocked(discoverDevicesAction).mockResolvedValueOnce({ ok: true, proposals });
    renderCanvas(true, siteCodes);
    await runDeviceAiPass();
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
    const refreshBefore = refreshMock.mock.calls.length;
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
    // Delta, not a bare toHaveBeenCalled: mocks are never reset in this file, so an earlier test's
    // refresh would satisfy that on its own.
    expect(refreshMock.mock.calls.length).toBeGreaterThan(refreshBefore);
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

  it("generates a DIFFERENT code for each unlabeled proposal in one batch", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-a" });
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-b" });
    // Unlabeled devices are ordinary plan-pass output: planDeviceCommit falls through to a
    // GENERATED code for both, and the props stay pre-refresh for the whole batch — so without the
    // canvas feeding the row it just created back into the decision, both would ask for CAM03 and
    // the second create would die on the site-unique constraint.
    await stageDevices([
      deviceProposal({ id: "dev-0", label: "", typeCode: "CAM", point: [0.1, 0.1] }),
      deviceProposal({ id: "dev-1", label: "", typeCode: "CAM", point: [0.9, 0.9] }),
    ]);

    await clickAsync("accept-all");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore + 2);
    const codes = vi
      .mocked(createFloorDeviceAction)
      .mock.calls.slice(-2)
      .map((c) => c[0].get("code"));
    // CAM01/CAM02 are taken by the fixture, so the pair must be the next two free codes.
    expect(codes).toEqual(["CAM03", "CAM04"]);
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  it("generates a code that dodges the codes used on OTHER floors of the site", async () => {
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    // CAM03/CAM04 belong to other floors: free on THIS floor's list, taken at the site — and the
    // table is `unique (site_id, code)`, so generating either one makes the create fail outright.
    await stageDevices([deviceProposal({ label: "", typeCode: "CAM" })], [...SITE_CODES, "CAM03", "CAM04"]);

    await clickAsync("accept-dev-0");

    expect(createFloorDeviceAction).toHaveBeenCalledTimes(createBefore + 1);
    expect(lastFormData(createFloorDeviceAction).get("code")).toBe("CAM05");
  });

  it("refuses a plan label already used on ANOTHER floor rather than creating a doomed duplicate", async () => {
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    await stageDevices([deviceProposal({ label: "CAM09", typeCode: "CAM" })], [...SITE_CODES, "CAM09"]);

    await clickAsync("accept-dev-0");

    // Not CAM09 — that code is spoken for at this site, so it falls through to a generated one.
    expect(lastFormData(createFloorDeviceAction).get("code")).toBe("CAM03");
  });

  it("records a created code the way the DATABASE stores it, so the next generated code clears it", async () => {
    vi.mocked(createFloorDeviceAction)
      .mockResolvedValueOnce({ ok: true, id: "dev-a" })
      .mockResolvedValueOnce({ ok: true, id: "dev-b" });
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    // CAM01..CAM06 taken, so the next free code is CAM07 — which the first proposal is about to
    // claim in lowercase. createFloorDeviceAction normalises it to CAM07 on the way in, so the
    // pending row must say CAM07 too, or suggestDeviceCode's ^CAM(\d+)$ misses it and hands the
    // second proposal the same code.
    const siteCodes = ["CAM01", "CAM02", "CAM03", "CAM04", "CAM05", "CAM06"];
    await stageDevices(
      [
        deviceProposal({ id: "dev-0", label: "cam07", typeCode: "CAM" }),
        deviceProposal({ id: "dev-1", label: "", typeCode: "CAM" }),
      ],
      siteCodes
    );

    await clickAsync("accept-all");

    const codes = vi
      .mocked(createFloorDeviceAction)
      .mock.calls.slice(createBefore)
      .map((c) => String(c[0].get("code")));
    expect(codes).toEqual(["cam07", "CAM08"]);
  });

  it("places a matched device ONCE: a second proposal for it reports a duplicate instead of moving it", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    // Both proposals match the same unplaced inventory device. Until the refresh lands it still
    // reads x/y = null, so without a session guard the second accept would silently overwrite the
    // first placement — and both proposals would vanish with nothing said.
    await stageDevices([
      deviceProposal({ id: "dev-0", label: "TO02", typeCode: "TO", point: [0.2, 0.2] }),
      deviceProposal({ id: "dev-1", label: "TO02", typeCode: "TO", point: [0.8, 0.8] }),
    ]);

    await clickAsync("accept-all");

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 1);
    const fd = lastFormData(placeFloorDeviceAction);
    expect(fd.get("id")).toBe("dev-to02");
    // The FIRST proposal's point survives — the second never overwrote it.
    expect(Number(fd.get("x"))).toBeCloseTo(0.2, 10);
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
    expect(screen.getByTestId("canvas-error").textContent).toContain("already on the plan");
  });

  it("outlines a matched room ONCE: a second proposal for it reports a duplicate instead of reshaping it", async () => {
    const setBefore = vi.mocked(setRoomPolygonAction).mock.calls.length;
    await stageRooms([
      roomProposal({ id: "room-0", name: "No polygon yet" }),
      roomProposal({
        id: "room-1",
        name: "No polygon yet",
        polygon: [
          [0.6, 0.6],
          [0.8, 0.6],
          [0.8, 0.8],
        ],
      }),
    ]);

    await clickAsync("accept-all");

    expect(setRoomPolygonAction).toHaveBeenCalledTimes(setBefore + 1);
    const fd = lastFormData(setRoomPolygonAction);
    expect(fd.get("roomId")).toBe("room-none");
    // The first proposal's outline stands.
    expect(JSON.parse(String(fd.get("polygon")))[0]).toEqual([0.1, 0.1]);
    expect(screen.getByTestId("canvas-error").textContent).toContain("already outlined");
  });

  it("refreshes ONCE for a whole batch, not once per commit", async () => {
    await stageDevices([
      deviceProposal({ id: "dev-0", label: "TO01", typeCode: "TO", point: [0.1, 0.1] }),
      deviceProposal({ id: "dev-1", label: "TO02", typeCode: "TO", point: [0.9, 0.9] }),
    ]);
    const refreshBefore = refreshMock.mock.calls.length;

    await clickAsync("accept-all");

    expect(refreshMock.mock.calls.length - refreshBefore).toBe(1);
  });

  it("generates a DIFFERENT code for each unmatched room in one batch", async () => {
    const createBefore = vi.mocked(createRoomAction).mock.calls.length;
    vi.mocked(createRoomAction).mockResolvedValueOnce({ ok: true, id: "room-a" });
    vi.mocked(createRoomAction).mockResolvedValueOnce({ ok: true, id: "room-b" });
    await stageRooms([
      roomProposal({ id: "room-0", name: "Store", roomType: "other" }),
      roomProposal({ id: "room-1", name: "Plant", roomType: "other" }),
    ]);

    await clickAsync("accept-all");

    expect(createRoomAction).toHaveBeenCalledTimes(createBefore + 2);
    const codes = vi
      .mocked(createRoomAction)
      .mock.calls.slice(-2)
      .map((c) => c[0].get("code"));
    expect(codes).toEqual(["R01", "R02"]);
  });

  /** The canvas with a swapped-in device list, so a test can re-render it the way SiteDetail does.
   *  The site codes are derived from the same list, because SiteDetail derives both from the one
   *  `devices` array it was given — a refresh that adds a row adds its code in the same render. */
  function canvasWithDevices(devices: FloorDeviceRow[]) {
    return (
      <FloorPlanCanvas
        plan={PLAN}
        planUrl={PLAN_URL}
        rooms={ROOMS}
        devices={devices}
        racks={RACKS}
        deviceTypes={DEVICE_TYPES}
        allSiteDeviceCodes={devices.map((d) => d.code)}
        editable
      />
    );
  }

  function placedDevice(id: string, code: string): FloorDeviceRow {
    return {
      id, site_id: "site-1", floor_id: "floor-1", room_id: null, device_type_id: "type-cam",
      code, name: "", status: "planned", created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z", x: 0.5, y: 0.5,
    };
  }

  /** The canvas with a swapped-in room list, for the room-path mirror of the above. */
  function canvasWithRooms(rooms: RoomRow[]) {
    return (
      <FloorPlanCanvas
        plan={PLAN}
        planUrl={PLAN_URL}
        rooms={rooms}
        devices={DEVICES}
        racks={RACKS}
        deviceTypes={DEVICE_TYPES}
        allSiteDeviceCodes={SITE_CODES}
        editable
      />
    );
  }

  function outlinedRoom(id: string, code: string): RoomRow {
    return {
      id, floor_id: "floor-1", code, name: "", type: "other",
      created_at: "2026-01-01T00:00:00Z",
      plan_polygon: [
        [0.1, 0.1],
        [0.3, 0.1],
        [0.3, 0.3],
      ],
    };
  }

  /** A deferred-per-call mock: every invocation returns a promise the test releases by hand. That
   *  is what lets the re-render AND the release happen inside the test's own act scope — resolving
   *  from inside the mock instead would pop the outer scope first and leave the rest of the batch's
   *  state updates outside any act(), which React reports as a warning. */
  function deferredOk(mock: { mockImplementationOnce: (f: () => Promise<{ ok: boolean }>) => unknown }, times: number) {
    const releases: ((value: { ok: boolean }) => void)[] = [];
    for (let i = 0; i < times; i++) {
      mock.mockImplementationOnce(() => new Promise((resolve) => releases.push(resolve)));
    }
    return releases;
  }

  /** Stage three unlabeled CAM proposals (the fall-through-to-a-generated-code case) on a canvas
   *  rendered by the caller, Accept all, and hand back the created codes. `beforeEachRelease`
   *  re-renders the canvas between accepts, standing in for whatever SiteDetail pushes down
   *  mid-batch. */
  async function threeGeneratedDeviceCodes(beforeEachRelease: (nth: number) => void) {
    vi.mocked(createFloorDeviceAction)
      .mockResolvedValueOnce({ ok: true, id: "dev-a" })
      .mockResolvedValueOnce({ ok: true, id: "dev-b" })
      .mockResolvedValueOnce({ ok: true, id: "dev-c" });
    vi.mocked(discoverDevicesAction).mockResolvedValueOnce({
      ok: true,
      proposals: [0, 1, 2].map((i) =>
        deviceProposal({ id: `dev-${i}`, label: "", typeCode: "CAM", point: [0.1 * (i + 1), 0.5] })
      ),
    });
    await runDeviceAiPass();
    const createBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
    const releases = deferredOk(vi.mocked(placeFloorDeviceAction), 3);

    // Starts the batch and suspends it on the first placement.
    await clickAsync("accept-all");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        beforeEachRelease(i);
        releases[i]({ ok: true });
      });
    }
    return vi
      .mocked(createFloorDeviceAction)
      .mock.calls.slice(createBefore)
      .map((c) => String(c[0].get("code")));
  }

  /** The room mirror: three unmatched "other" proposals, so planRoomCommit falls through to a
   *  generated code for each. The room path is duplicated code (its own ref, its own prune effect),
   *  so it needs its own coverage — the device tests cannot reach it. */
  async function threeGeneratedRoomCodes(beforeEachRelease: (nth: number) => void) {
    vi.mocked(createRoomAction)
      .mockResolvedValueOnce({ ok: true, id: "room-a" })
      .mockResolvedValueOnce({ ok: true, id: "room-b" })
      .mockResolvedValueOnce({ ok: true, id: "room-c" });
    vi.mocked(discoverRoomsAction).mockResolvedValueOnce({
      ok: true,
      proposals: ["Store", "Plant", "Riser"].map((name, i) =>
        roomProposal({ id: `room-${i}`, name, roomType: "other" })
      ),
    });
    fireEvent.click(screen.getByTestId("plan-wizard"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("discover-rooms"));
    });
    const createBefore = vi.mocked(createRoomAction).mock.calls.length;
    const releases = deferredOk(vi.mocked(setRoomPolygonAction), 3);

    await clickAsync("accept-all");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        beforeEachRelease(i);
        releases[i]({ ok: true });
      });
    }
    return vi
      .mocked(createRoomAction)
      .mock.calls.slice(createBefore)
      .map((c) => String(c[0].get("code")));
  }

  it("keeps generated codes distinct when a FRESH-IDENTITY but still-stale device list arrives mid-batch", async () => {
    const view = render(canvasWithDevices(DEVICES));
    // SiteDetail derives activeFloorDevices with an unmemoized .filter(), so any unrelated state
    // change there (a layout measurement, a menu opening) pushes down a brand-new array holding
    // exactly the same, pre-refresh rows. Pending rows must survive that.
    const codes = await threeGeneratedDeviceCodes(() => view.rerender(canvasWithDevices([...DEVICES])));
    expect(codes).toEqual(["CAM03", "CAM04", "CAM05"]);
  });

  it("keeps generated codes distinct when a REAL refresh lands mid-batch", async () => {
    const view = render(canvasWithDevices(DEVICES));
    // Now the re-render carries the rows this batch just created — a router.refresh() landing. The
    // pending copies drop (the prop has them), so the decision must be reading the LATEST prop and
    // not the list captured when the batch started.
    const landed = [...DEVICES];
    const codes = await threeGeneratedDeviceCodes((nth) => {
      landed.push(placedDevice(["dev-a", "dev-b", "dev-c"][nth], `CAM0${nth + 3}`));
      view.rerender(canvasWithDevices([...landed]));
    });
    expect(codes).toEqual(["CAM03", "CAM04", "CAM05"]);
  });

  it("keeps generated ROOM codes distinct when a FRESH-IDENTITY but still-stale room list arrives mid-batch", async () => {
    const view = render(canvasWithRooms(ROOMS));
    const codes = await threeGeneratedRoomCodes(() => view.rerender(canvasWithRooms([...ROOMS])));
    expect(codes).toEqual(["R01", "R02", "R03"]);
  });

  it("keeps generated ROOM codes distinct when a REAL refresh lands mid-batch", async () => {
    const view = render(canvasWithRooms(ROOMS));
    const landed = [...ROOMS];
    const codes = await threeGeneratedRoomCodes((nth) => {
      landed.push(outlinedRoom(["room-a", "room-b", "room-c"][nth], `R0${nth + 1}`));
      view.rerender(canvasWithRooms([...landed]));
    });
    expect(codes).toEqual(["R01", "R02", "R03"]);
  });

  it("waits for each accept to finish before starting the next one", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    // The first placement hangs until this test releases it. Under Promise.all BOTH calls would
    // already have fired; sequential means the second cannot start yet.
    let release!: (value: { ok: boolean; error?: string }) => void;
    vi.mocked(placeFloorDeviceAction).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    await stageDevices([
      deviceProposal({ id: "dev-0", label: "TO01", typeCode: "TO", point: [0.1, 0.1] }),
      deviceProposal({ id: "dev-1", label: "TO02", typeCode: "TO", point: [0.9, 0.9] }),
    ]);

    await clickAsync("accept-all");
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 1);
    expect(screen.getByTestId("proposal-item-dev-1")).toBeInTheDocument();

    await act(async () => {
      release({ ok: true });
    });
    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 2);
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  it("drops the proposal when the device is CREATED but its placement fails, and says where it went", async () => {
    const refreshBefore = refreshMock.mock.calls.length;
    vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: true, id: "dev-fresh" });
    vi.mocked(placeFloorDeviceAction).mockResolvedValueOnce({ ok: false, error: "Placement rejected" });
    await stageDevices([deviceProposal({ label: "CAM09", typeCode: "CAM" })]);

    await clickAsync("accept-dev-0");

    // The row exists, so re-staging it would only tempt a duplicate create.
    expect(screen.queryByTestId("proposal-item-dev-0")).toBeNull();
    const error = screen.getByTestId("canvas-error").textContent!;
    expect(error).toContain("CAM09");
    expect(error).toContain("tray");
    // Refreshed anyway, or the new unplaced device wouldn't appear in that tray.
    expect(refreshMock.mock.calls.length).toBeGreaterThan(refreshBefore);
  });

  it("drops the proposal when the room is CREATED but its outline fails, and says where it went", async () => {
    const refreshBefore = refreshMock.mock.calls.length;
    vi.mocked(createRoomAction).mockResolvedValueOnce({ ok: true, id: "room-fresh" });
    vi.mocked(setRoomPolygonAction).mockResolvedValueOnce({ ok: false, error: "Outline rejected" });
    await stageRooms([roomProposal({ name: "Server room", roomType: "IDF" })]);

    await clickAsync("accept-room-0");

    expect(screen.queryByTestId("proposal-item-room-0")).toBeNull();
    const error = screen.getByTestId("canvas-error").textContent!;
    expect(error).toContain("IDF01");
    expect(error).toContain("tray");
    expect(refreshMock.mock.calls.length).toBeGreaterThan(refreshBefore);
  });

  it("keeps a keystroke aimed at a panel field away from the selected outline vertex", async () => {
    await stageRooms([roomProposal()]);
    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));

    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(screen.getByTestId("proposal-vertex-room-0-1"), {
      clientX: 267, clientY: 71, button: 0, pointerId: 1,
    });
    fireEvent.pointerUp(svg, { clientX: 267, clientY: 71, pointerId: 1 });
    // The selected handle is the filled one.
    expect(screen.getByTestId("proposal-vertex-room-0-1").getAttribute("fill")).toBe("#2563eb");

    // Backspacing a typo out of the room's name must not delete a corner of its outline.
    const nameField = screen.getByTestId("proposal-name-room-0");
    fireEvent.keyDown(nameField, { key: "Backspace" });
    expect(screen.getByTestId("proposal-vertex-room-0-3")).toBeInTheDocument();
    // Nor may Esc in a field drop the selection out from under the user.
    fireEvent.keyDown(nameField, { key: "Escape" });
    expect(screen.getByTestId("proposal-vertex-room-0-1").getAttribute("fill")).toBe("#2563eb");

    // The same keys still work when the plan itself has focus.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Backspace" });
    });
    expect(screen.queryByTestId("proposal-vertex-room-0-3")).toBeNull();
  });

  it("lets a placement click through a ghost pin instead of swallowing it", async () => {
    const placeBefore = vi.mocked(placeFloorDeviceAction).mock.calls.length;
    await stageDevices([deviceProposal({ label: "CAM09", point: [0.5, 0.5] })]);
    enterEditMode();
    fireEvent.click(screen.getByTestId("tray-device-TO02"));

    // A click that lands on the ghost while a placement is armed belongs to the plan underneath —
    // the committed pins only intercept in edit mode, and placement/trace gestures run outside it.
    await act(async () => {
      fireEvent.click(screen.getByTestId("proposal-pin-dev-0"), { clientX: 400, clientY: 300 });
    });

    expect(placeFloorDeviceAction).toHaveBeenCalledTimes(placeBefore + 1);
    expect(lastFormData(placeFloorDeviceAction).get("id")).toBe("dev-to02");
  });

  it("does not nudge a ghost pin when the press barely moves (a select-click, not a drag)", async () => {
    await stageDevices([deviceProposal({ label: "CAM09", point: [0.5, 0.5] })]);

    const svg = screen.getByTestId("floor-plan-canvas");
    const pin = screen.getByTestId("proposal-pin-dev-0");
    fireEvent.pointerDown(pin, { clientX: 615, clientY: 400, button: 0, pointerId: 1 });
    // Under the 6px tap threshold — physical click drift, not a drag.
    fireEvent.pointerMove(svg, { clientX: 618, clientY: 402, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 618, clientY: 402, pointerId: 1 });

    expect(screen.getByTestId("proposal-pin-dev-0").getAttribute("transform")).toBe("translate(600 400)");
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

describe("FloorPlanCanvas (wall snapping)", () => {
  // The jsdom fallback fit is fully determined: pane 870x560 over a 1200x800 plan gives
  // zoom = min(870/1200, 560/800) = 0.7, panX = (870 - 840)/2 = 15, panY = (560 - 560)/2 = 0.
  // So a normalized point lands at screen (15 + nx*840, ny*560) — every coordinate below is
  // hand-computed from that, the same way the existing room-snap tests are.
  const sx = (nx: number) => 15 + nx * 840;
  const sy = (ny: number) => ny * 560;

  const WALL_RUNS: WallRun[] = [
    // A long horizontal run, well clear of both fixture rooms. Its left end and the run below
    // share the corner (0.2, 0.8) — screen (183, 448).
    { x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.8 },
    { x1: 0.2, y1: 0.8, x2: 0.2, y2: 0.95 },
    // A stub whose endpoint sits 0.0025 (≈2.1 screen px) to the RIGHT of room MDF's corner
    // [0.3, 0.1] — deliberately the NEARER target for the priority test below.
    { x1: 0.3025, y1: 0.1, x2: 0.3025, y2: 0.05 },
    // A stub whose TOP endpoint (204, 178.08) sits just below room MDF's bottom edge (y = 168),
    // for the "wall corner beats room edge" ordering test.
    { x1: 0.225, y1: 0.318, x2: 0.225, y2: 0.45 },
    // A run parallel to, and 5.6 screen px below, that same bottom edge — so a click between the
    // two is NEARER this line than the room's, for the "room edge beats wall line" ordering test.
    // x2 stops at 0.20, not 0.25: at 0.25 this run's line, extended by the wall-INTERSECTION
    // deriver's default 12px overshoot, would cross the wall stub above (x=0.225) at (0.225, 0.31)
    // — 6.4px short of that stub's own top endpoint, well inside the 12px allowance — and that
    // accidental crossing would outrank the stub's endpoint in the "wall corner beats room edge"
    // test below. 0.20 keeps this run's line (still covering every click used against it here) out
    // of range of x=0.225 by a wide margin.
    { x1: 0.05, y1: 0.31, x2: 0.20, y2: 0.31 },
    // Two runs whose endpoints both fall inside the 12px radius of one click, the FARTHER one
    // listed FIRST — so "nearest wins" and "first hit wins" give different answers. Endpoint
    // (653.4, 364) is 8.4px from the click; (642.9, 364) is 2.1px.
    { x1: 0.76, y1: 0.65, x2: 0.76, y2: 0.72 },
    { x1: 0.7475, y1: 0.65, x2: 0.68, y2: 0.65 },
    // The same trap for LINE snapping: two parallel runs straddling one click, no endpoint of
    // either in range, the FARTHER line (8.96px) listed before the nearer one (2.8px).
    { x1: 0.8, y1: 0.516, x2: 0.95, y2: 0.516 },
    { x1: 0.8, y1: 0.505, x2: 0.95, y2: 0.505 },
  ];

  function renderWithWalls(props: {
    ref: React.Ref<FloorPlanCanvasHandle>;
    onRoomTraced?: (polygon: [number, number][]) => void;
    wallRuns?: WallRun[];
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
        allSiteDeviceCodes={SITE_CODES}
        wallRuns={props.wallRuns ?? WALL_RUNS}
        editable
        onRoomTraced={props.onRoomTraced}
      />
    );
  }

  /** Trace a triangle whose FIRST click is `first` (the point under test) and whose other two are
   *  far from it, then close it. Returns the committed polygon.
   *
   *  WALLS ARE TURNED ON FIRST, because wall snapping is armed by the "Show walls" toggle — snapping
   *  a click to geometry the user cannot see reads as the cursor being yanked for no reason. Pass
   *  `showWalls: false` to exercise the ungated behaviour. */
  async function traceFrom(
    first: { x: number; y: number },
    wallRuns?: WallRun[],
    showWalls = true
  ) {
    const onRoomTraced = vi.fn();
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithWalls({ ref, onRoomTraced, wallRuns });

    // queryBy, not getBy: with `wallRuns=[]` the toggle isn't rendered at all, and that case has
    // nothing to snap to anyway.
    const wallsToggle = screen.queryByTestId("toggle-walls");
    if (showWalls && wallsToggle) fireEvent.click(wallsToggle);
    act(() => ref.current!.startTraceRoom());
    const svg = screen.getByTestId("floor-plan-canvas");
    await act(async () => {
      fireEvent.click(svg, { clientX: first.x, clientY: first.y });
      fireEvent.click(svg, { clientX: 500, clientY: 300 });
      fireEvent.click(svg, { clientX: 300, clientY: 400 });
    });
    await act(async () => {
      fireEvent.doubleClick(svg, { clientX: 300, clientY: 400 });
    });

    expect(onRoomTraced).toHaveBeenCalledTimes(1);
    return onRoomTraced.mock.calls[0][0] as [number, number][];
  }

  it("snaps a traced point EXACTLY onto a wall run's endpoint", async () => {
    // The shared corner (0.2, 0.8) renders at (183, 448); click ~4px off it, diagonally.
    const polygon = await traceFrom({ x: sx(0.2) + 3, y: sy(0.8) + 3 });
    expect(polygon[0][0]).toBeCloseTo(0.2, 10);
    expect(polygon[0][1]).toBeCloseTo(0.8, 10);
  });

  it("snaps a traced point ONTO a wall run's line, not to either endpoint", async () => {
    // The midpoint of the horizontal run is (0.4, 0.8) -> (351, 448); its nearest endpoint is
    // 168 screen px away, so only a line snap can catch this click.
    const polygon = await traceFrom({ x: sx(0.4), y: sy(0.8) + 3 });
    expect(polygon[0][1]).toBeCloseTo(0.8, 10); // perpendicular distance to the run is 0
    expect(polygon[0][0]).toBeCloseTo(0.4, 10); // projected, not pulled to 0.2 or 0.6
  });

  it("picks the NEAREST wall corner when several are in range, not the first one found", async () => {
    // Both corners are inside the radius of (645, 364) and the FARTHER one comes first in
    // wallRuns — so a scan that returned its first hit would answer 0.76.
    const polygon = await traceFrom({ x: 645, y: 364 });
    expect(polygon[0][0]).toBeCloseTo(0.7475, 10);
    expect(polygon[0][1]).toBeCloseTo(0.65, 10);
  });

  it("picks the NEAREST wall line when several are in range, not the first one found", async () => {
    // (729, 280) sits between two parallel runs, 2.8px from the second and 8.96px from the first,
    // with no endpoint of either in range. First-hit would answer y = 0.516.
    const polygon = await traceFrom({ x: 729, y: 280 });
    expect(polygon[0][1]).toBeCloseTo(0.505, 10);
    expect(polygon[0][0]).toBeCloseTo(0.85, 10); // (729 - 15) / 840, projected along the run
  });

  it("keeps an existing ROOM vertex ahead of a NEARER wall corner", async () => {
    // Room MDF's corner [0.3, 0.1] is at (267, 56); the wall stub's endpoint [0.3025, 0.1] is at
    // (269.1, 56). Clicking (270, 56) is 0.9px from the wall corner and 3px from the room corner —
    // the room must still win, or two rooms sharing this wall would stop meeting exactly.
    const polygon = await traceFrom({ x: 270, y: sy(0.1) });
    expect(polygon[0][0]).toBeCloseTo(0.3, 10);
    expect(polygon[0][1]).toBeCloseTo(0.1, 10);
  });

  it("prefers a wall CORNER over a nearer point on an existing room's edge", async () => {
    // Room MDF's bottom edge is the line y = 168 across x 99..267; the wall stub's top endpoint is
    // (204, 178.08). A click at (200, 172) is 4px from the edge and 7.3px from the corner — the
    // corner is FARTHER, and must still win: a corner is a point two walls agree on.
    const polygon = await traceFrom({ x: 200, y: 172 });
    expect(polygon[0][0]).toBeCloseTo(0.225, 10);
    expect(polygon[0][1]).toBeCloseTo(0.318, 10);
  });

  it("prefers an existing room's edge over a nearer wall LINE", async () => {
    // A click at (150, 172) is 1.6px from the wall run at y = 173.6 and 4px from room MDF's bottom
    // edge at y = 168, with no corner of either kind in range. The room still wins — a shared wall
    // has to stay shared even when the PDF's run sits half a wall-thickness off it.
    const polygon = await traceFrom({ x: 150, y: 172 });
    expect(polygon[0][1]).toBeCloseTo(0.3, 10);
    expect(polygon[0][0]).toBeCloseTo((150 - 15) / 840, 10);
  });

  it("does not snap past the END of a wall run — the projection is clamped to the segment", async () => {
    // The horizontal run ends at (519, 448). A click at (560, 450) is 2px from that run's INFINITE
    // line but 41px past its end, so an unclamped projection would wrongly pin it to y = 0.8.
    const polygon = await traceFrom({ x: 560, y: 450 });
    expect(polygon[0][0]).toBeCloseTo((560 - 15) / 840, 10);
    expect(polygon[0][1]).toBeCloseTo(450 / 560, 10);
  });

  it("leaves a click far from every wall and room untouched", async () => {
    // (700, 200) is >100 screen px from any wall run and any room edge.
    const polygon = await traceFrom({ x: 700, y: 200 });
    expect(polygon[0][0]).toBeCloseTo((700 - 15) / 840, 10);
    expect(polygon[0][1]).toBeCloseTo(200 / 560, 10);
  });

  // These three exercise `snapToWallIntersection` — the actual crossing of two wall runs, which
  // ranks ABOVE a raw run endpoint (`snapToWallCorner`) because a run's endpoint is wherever
  // extraction happened to stop, often mid-wall, while an intersection is where two walls actually
  // meet: the real room corner. A dedicated small `wallRuns` array is used for each so the derived
  // corner set stays small and easy to reason about (deriveWallCorners runs over every pair).
  describe("wall INTERSECTION snapping", () => {
    // A clean perpendicular crossing, isolated from every fixture room and from WALL_RUNS above:
    // horizontal run y=0.42 (pixel 336) crosses vertical run x=0.42 (pixel 504) at exactly
    // (504, 336) -> norm (0.42, 0.42) -> screen (367.8, 235.2).
    const CROSS_A: WallRun = { x1: 0.35, y1: 0.42, x2: 0.49, y2: 0.42 };
    const CROSS_B: WallRun = { x1: 0.42, y1: 0.35, x2: 0.42, y2: 0.49 };

    it("snaps a trace click near a wall INTERSECTION exactly onto it", async () => {
      // (370, 236) is ~2.3 screen px from the crossing, well inside SNAP_PX, and far from every
      // room vertex/edge and from either run's own endpoints.
      const polygon = await traceFrom({ x: 370, y: 236 }, [CROSS_A, CROSS_B]);
      expect(polygon[0][0]).toBeCloseTo(0.42, 6);
      expect(polygon[0][1]).toBeCloseTo(0.42, 6);
    });

    it("prefers the wall INTERSECTION over a STRICTLY CLOSER wall-run endpoint", async () => {
      // A third run, C, shares the crossing's y (0.42) — parallel to CROSS_A, so it can never form
      // its own spurious intersection with it — and its near endpoint sits EXACTLY at the click
      // point: pixel (518, 336) -> norm (518/1200, 0.42). That endpoint is 0 screen px from the
      // click; the true crossing (367.8, 235.2 screen) is ~9.8 screen px away — the endpoint is
      // unambiguously the nearer target. (C does cross CROSS_B, but at the same pixel (504, 336)
      // as CROSS_A x CROSS_B, so it only reinforces the one true corner, not a second one.)
      const cThroughClick: WallRun = { x1: 518 / 1200, y1: 0.42, x2: 488 / 1200, y2: 0.42 };
      const click = { x: 15 + (518 / 1200) * 840, y: 235.2 }; // = the endpoint's own screen position
      const polygon = await traceFrom(click, [CROSS_A, CROSS_B, cThroughClick]);
      // Must land on the CROSSING (0.42, 0.42), not the nearer endpoint (518/1200, 0.42).
      expect(polygon[0][0]).toBeCloseTo(0.42, 6);
      expect(polygon[0][1]).toBeCloseTo(0.42, 6);
    });

    it("still lets an existing ROOM vertex beat a NEARER wall intersection", async () => {
      // Two runs crossing exactly at (100, 58) in screen space -- 0 screen px from the click -- while
      // room MDF's vertex [0.1, 0.1] sits at screen (99, 56), ~2.24 screen px from the same click.
      // The intersection is nearer, but the room vertex must still win (Slice B contract: rooms
      // sharing a wall must keep landing on exactly the same vertex).
      const clickNorm: [number, number] = [(100 - 15) / 840, 58 / 560];
      const runA: WallRun = { x1: 0.08, y1: clickNorm[1], x2: 0.12, y2: clickNorm[1] };
      const runB: WallRun = { x1: clickNorm[0], y1: 0.09, x2: clickNorm[0], y2: 0.12 };
      const polygon = await traceFrom({ x: 100, y: 58 }, [runA, runB]);
      expect(polygon[0][0]).toBeCloseTo(0.1, 6);
      expect(polygon[0][1]).toBeCloseTo(0.1, 6);
    });
  });

  describe("gated on the Show walls toggle", () => {
    // Snapping to geometry the user cannot see reads as the cursor being yanked somewhere for no
    // reason. The toggle is what draws the walls, so it is also what arms snapping to them.

    it("does NOT snap to a wall endpoint while walls are hidden", async () => {
      // The exact click that snaps exactly onto (0.2, 0.8) with walls shown.
      const polygon = await traceFrom({ x: sx(0.2) + 3, y: sy(0.8) + 3 }, undefined, false);
      expect(polygon[0][0]).toBeCloseTo((sx(0.2) + 3 - 15) / 840, 10);
      expect(polygon[0][1]).toBeCloseTo((sy(0.8) + 3) / 560, 10);
    });

    it("does NOT snap onto a wall line while walls are hidden", async () => {
      const polygon = await traceFrom({ x: sx(0.4), y: sy(0.8) + 3 }, undefined, false);
      expect(polygon[0][1]).toBeCloseTo((sy(0.8) + 3) / 560, 10);
    });

    it("STILL snaps to an existing room's vertex while walls are hidden", async () => {
      // Room geometry is deliberately not gated: its targets are always drawn, and two rooms
      // sharing a wall must land on the same vertices whether or not the overlay is on.
      const polygon = await traceFrom({ x: sx(0.3) + 3, y: sy(0.1) + 3 }, undefined, false);
      expect(polygon[0][0]).toBeCloseTo(0.3, 10);
      expect(polygon[0][1]).toBeCloseTo(0.1, 10);
    });

    it("snaps again once the toggle is switched back on", async () => {
      const polygon = await traceFrom({ x: sx(0.2) + 3, y: sy(0.8) + 3 }, undefined, true);
      expect(polygon[0][0]).toBeCloseTo(0.2, 10);
      expect(polygon[0][1]).toBeCloseTo(0.8, 10);
    });
  });

  it("with wallRuns=[] behaves exactly as before — the wall-corner click does not snap", async () => {
    const click = { x: sx(0.2) + 3, y: sy(0.8) + 3 };
    const polygon = await traceFrom(click, []);
    expect(polygon[0][0]).toBeCloseTo((click.x - 15) / 840, 10);
    expect(polygon[0][1]).toBeCloseTo(click.y / 560, 10);
  });

  it("renders the wall overlay only once toggled, before the rooms, in image-pixel space", () => {
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithWalls({ ref });
    expect(screen.queryByTestId("wall-overlay")).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-walls"));
    const overlay = screen.getByTestId("wall-overlay");
    const lines = overlay.querySelectorAll("line");
    expect(lines).toHaveLength(WALL_RUNS.length);
    // identity-view image pixels: 0.2*1200 = 240, 0.8*800 = 640, 0.6*1200 = 720.
    expect(lines[0].getAttribute("x1")).toBe("240");
    expect(lines[0].getAttribute("y1")).toBe("640");
    expect(lines[0].getAttribute("x2")).toBe("720");
    expect(lines[0].getAttribute("y2")).toBe("640");
    // Walls are CONTEXT: they must paint under the rooms, never over them.
    const room = screen.getByTestId("plan-room-MDF");
    expect(overlay.compareDocumentPosition(room) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId("toggle-walls"));
    expect(screen.queryByTestId("wall-overlay")).toBeNull();
  });

  it("draws the walls in sky-500 at half opacity, with a stroke that counter-scales the live zoom", () => {
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithWalls({ ref });
    fireEvent.click(screen.getByTestId("toggle-walls"));

    // Ink lives on the overlay GROUP and is inherited by every line — see the render comment for
    // why (one attribute write per zoom frame, and one composited opacity).
    const overlay = screen.getByTestId("wall-overlay");
    expect(overlay.getAttribute("stroke")).toBe("#0ea5e9");
    expect(overlay.getAttribute("opacity")).toBe("0.5");
    // The jsdom fit zoom is 0.7, so a 1px-on-screen hairline is 1/0.7 image px inside the live <g>.
    // A fixed strokeWidth={1} — the classic bug in a scaled group — would read "1" here.
    expect(overlay.getAttribute("stroke-width")).toBe(String(1 / 0.7));

    // And it tracks the zoom, while the line's own coordinates do NOT move: they are image-pixel
    // space, and only the one live <g> transform ever carries the zoom.
    fireEvent.click(screen.getByTestId("plan-zoom-in"));
    const zoomed = screen.getByTestId("wall-overlay");
    expect(zoomed.getAttribute("stroke-width")).toBe(String(1 / (0.7 * 1.25)));
    expect(zoomed.querySelector("line")!.getAttribute("x1")).toBe("240");
  });

  it("offers no wall toggle at all when the plan has no extracted walls", () => {
    const ref = createRef<FloorPlanCanvasHandle>();
    renderWithWalls({ ref, wallRuns: [] });
    // An image-sourced plan (or a PDF whose extraction hasn't run) gets exactly the toolbar it had
    // before walls existed — the fit button is still there, a dead wall control is not.
    expect(screen.getByTestId("fit-to-area")).toBeInTheDocument();
    expect(screen.queryByTestId("toggle-walls")).toBeNull();
  });
});

// The user's requirement: "no loss of quality or compression". A retained source PDF is rasterised
// live at the current zoom instead of stretching the fixed 2600px PNG. These tests are the WIRING
// contract only — which layer the canvas picks, and that picking the vector one moves nothing.
describe("FloorPlanCanvas (vector plan rendering)", () => {
  const PDF_PLAN: FloorPlanRow = {
    ...PLAN,
    source: "pdf",
    pdf_storage_path: "floor-1/source.pdf",
    pdf_page: 2,
  };
  const PDF_URL = "https://example.test/plan.pdf";

  function renderWithPdf(over: { pdfUrl?: string | null; pdfPage?: number | null } = {}) {
    return render(
      <FloorPlanCanvas
        plan={PDF_PLAN}
        planUrl={PLAN_URL}
        pdfUrl={"pdfUrl" in over ? over.pdfUrl : PDF_URL}
        pdfPage={"pdfPage" in over ? over.pdfPage : PDF_PLAN.pdf_page}
        rooms={ROOMS}
        devices={DEVICES}
        racks={RACKS}
        deviceTypes={DEVICE_TYPES}
        allSiteDeviceCodes={SITE_CODES}
        editable={false}
      />
    );
  }

  beforeEach(() => {
    // The layer debounces before it touches pdf.js; frozen timers mean these DOM-shape assertions
    // never race an async rasterisation.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("composites the vector layer OVER the raster <image>, which stays as the instant base", () => {
    renderWithPdf();
    const svg = screen.getByTestId("floor-plan-canvas");
    const image = svg.querySelector("image")!;
    const layer = screen.getByTestId("plan-vector-layer");

    // The PNG is still there and still points at the same URL. It is what the user sees while the
    // PDF downloads, parses and rasterises, and during each re-rasterisation (which clears the
    // canvas) — without it the plan area is blank on every page load and floor switch.
    expect(image).not.toBeNull();
    expect(image.getAttribute("href")).toBe(PLAN_URL);
    // ...and the vector layer paints ON TOP of it: SVG has no z-index, only document order.
    expect(image.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sizes the vector layer to exactly the imgW x imgH box the <image> occupied", () => {
    renderWithPdf();
    const fo = screen.getByTestId("plan-vector-layer");
    expect(fo.tagName.toLowerCase()).toBe("foreignobject");
    expect(fo.getAttribute("x")).toBe("0");
    expect(fo.getAttribute("y")).toBe("0");
    expect(fo.getAttribute("width")).toBe("1200");
    expect(fo.getAttribute("height")).toBe("800");
  });

  it("leaves every plan coordinate exactly where the raster path put it", () => {
    renderWithPdf();
    // Identical to the raster-path expectation above: normToScreen([0.8,0.65]) in image-pixel space.
    expect(screen.getByTestId("plan-pin-CAM02").getAttribute("transform")).toBe("translate(960 520)");
    expect(screen.getByTestId("plan-room-MDF").getAttribute("points")!.trim().split(/\s+/)).toHaveLength(4);
    // The single live transform is untouched: jsdom fit zoom 0.7, panX 15, panY 0.
    const live = screen.getByTestId("floor-plan-canvas").querySelector("g")!;
    expect(live.getAttribute("transform")).toBe("translate(15 0) scale(0.7)");
  });

  it("hands the vector layer the visible slice of the plan, derived from the live view and the pane", () => {
    // The layer rasterises only what's on screen, and it does NOT re-derive "on screen" itself —
    // this component is the only thing that knows both the live pan/zoom and the measured pane, so
    // the derivation lives here and is wired through. If it were wrong, the plan would rasterise
    // the wrong slice of the sheet, which looks like a correctly-drawn plan in the wrong place.
    renderWithPdf();

    // Two zoom-in clicks about the pane centre: 0.7 -> 1.09375, pan (15, 0) -> (-221.25, -157.5),
    // on jsdom's fallback 870 x 560 pane. The pane then sees plan x 202.29..997.71, y 144..656,
    // which overscanned by 15% a side and clipped to the page is (82.97, 67.2) 1034.06 x 665.6.
    act(() => {
      fireEvent.click(screen.getByTestId("plan-zoom-in"));
      fireEvent.click(screen.getByTestId("plan-zoom-in"));
    });

    const live = screen.getByTestId("floor-plan-canvas").querySelector("g")!;
    expect(live.getAttribute("transform")).toBe("translate(-221.25 -157.5) scale(1.09375)");

    const fo = screen.getByTestId("plan-vector-layer");
    expect(Number(fo.getAttribute("x"))).toBeCloseTo(82.97, 2);
    expect(Number(fo.getAttribute("y"))).toBeCloseTo(67.2, 2);
    expect(Number(fo.getAttribute("width"))).toBeCloseTo(1034.06, 2);
    expect(Number(fo.getAttribute("height"))).toBeCloseTo(665.6, 2);

    // ...and the PNG underneath still spans the WHOLE page. It is now what fills the plan outside
    // the rasterised region, so it matters more than it did, not less.
    const image = screen.getByTestId("floor-plan-canvas").querySelector("image")!;
    expect(image.getAttribute("width")).toBe("1200");
    expect(image.getAttribute("height")).toBe("800");
  });

  it("keeps the raster <image> when no source PDF was retained (image uploads, failed retention)", () => {
    renderWithPdf({ pdfUrl: null, pdfPage: null });
    const svg = screen.getByTestId("floor-plan-canvas");
    const image = svg.querySelector("image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("href")).toBe(PLAN_URL);
    expect(image?.getAttribute("width")).toBe("1200");
    expect(image?.getAttribute("height")).toBe("800");
    expect(image?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(screen.queryByTestId("plan-vector-layer")).toBeNull();
  });

  it("tears the vector layer back down if the PDF cannot be rendered, leaving the PNG alone", async () => {
    // A dead signed URL / corrupt PDF must stop trying, rather than sit as an empty canvas over
    // the perfectly good PNG underneath.
    vi.useRealTimers();
    vi.mocked(pdfjsGetDocument).mockImplementationOnce(() => {
      throw new Error("signed URL expired");
    });
    renderWithPdf();
    await waitFor(() => expect(screen.queryByTestId("plan-vector-layer")).toBeNull());
    const svg = screen.getByTestId("floor-plan-canvas");
    expect(svg.querySelector("image")?.getAttribute("href")).toBe(PLAN_URL);
  });
});

describe("FloorPlanCanvas (symbol discovery)", () => {
  // The jsdom fallback view (no ResizeObserver): fit zoom 0.7, panX 15, panY 0 on this 1200x800
  // plan — the same derivation the placement tests spell out. A pointer at (cx, cy) is therefore
  // this normalized point, and a drag between two pointers is the box below.
  // (normX(cx) = (cx - 15) / 840, normY(cy) = cy / 560 — spelled out inline where used.)

  // This file has no global mock reset, so call COUNTS would otherwise accumulate across the
  // block and "called once" would pass for a handler that fired on every previous test too.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A rack-category type, so "floor types only" is a real assertion rather than a tautology
  // against the all-floor default fixture.
  const TYPES_WITH_RACK: DeviceTypeRow[] = [
    ...DEVICE_TYPES,
    { id: "type-sw", name: "Switch", created_at: "2026-01-01T00:00:00Z", category: "rack", code: "SW", is_standard: true, color: null, icon: null },
  ];

  function renderWithTypes(deviceTypes: DeviceTypeRow[] = TYPES_WITH_RACK) {
    return render(
      <FloorPlanCanvas
        plan={PLAN}
        planUrl={PLAN_URL}
        rooms={ROOMS}
        devices={DEVICES}
        racks={RACKS}
        deviceTypes={deviceTypes}
        allSiteDeviceCodes={SITE_CODES}
        editable
      />
    );
  }

  /** Open the wizard, open the device-type submenu, and enter pick mode for one type. */
  function armSymbolSelect(code = "CAM") {
    fireEvent.click(screen.getByTestId("plan-wizard"));
    fireEvent.click(screen.getByTestId("discover-devices"));
    fireEvent.click(screen.getByTestId(`symbol-type-${code}`));
  }

  /** Click a point on the plan — press, release, click, exactly as a real tap arrives. */
  async function clickPlan(x: number, y: number) {
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(svg, { clientX: x, clientY: y, button: 0, pointerId: 11 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: x, clientY: y, pointerId: 11 });
    });
    await act(async () => {
      fireEvent.click(svg, { clientX: x, clientY: y });
    });
  }

  /** Click the symbol, then confirm the highlighted pick — the whole two-step gesture. */
  async function pickAndConfirm(x = 200, y = 100) {
    await clickPlan(x, y);
    await act(async () => {
      fireEvent.click(screen.getByTestId("symbol-pick-confirm"));
    });
  }

  it("'Discover devices' opens a submenu of the FLOOR device types only", () => {
    // Would catch: forgetting the category filter, so a rack-only type (a switch) could be
    // proposed as a thing that lives on a floor plan.
    renderWithTypes();
    fireEvent.click(screen.getByTestId("plan-wizard"));
    expect(screen.queryByTestId("symbol-type-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("discover-devices"));
    expect(screen.getByTestId("symbol-type-menu")).toBeInTheDocument();
    expect(screen.getByTestId("symbol-type-CAM")).toBeInTheDocument();
    expect(screen.getByTestId("symbol-type-SEN")).toBeInTheDocument();
    expect(screen.getByTestId("symbol-type-TO")).toBeInTheDocument();
    expect(screen.queryByTestId("symbol-type-SW")).toBeNull();
  });

  it("choosing a type closes the menu, enters pick mode and prompts with the type NAME", () => {
    renderWithTypes();
    armSymbolSelect("CAM");
    expect(screen.queryByTestId("plan-wizard-menu")).toBeNull();
    expect(screen.getByTestId("symbol-prompt").textContent).toContain("Camera");
    expect(screen.getByTestId("symbol-prompt").textContent).toContain("Esc to cancel");
    // Nothing has been picked or searched yet — entering pick mode is not a pass.
    expect(pickSymbolAction).not.toHaveBeenCalled();
    expect(discoverSymbolsAction).not.toHaveBeenCalled();
  });

  it("a click sends the hand-computed NORMALIZED point, and searches nothing yet", async () => {
    // Would catch: sending screen pixels, or firing the multi-second full-sheet search off the
    // click instead of off the confirmation.
    renderWithTypes();
    armSymbolSelect("CAM");
    await clickPlan(200, 100);

    expect(pickSymbolAction).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(pickSymbolAction).mock.calls[0];
    expect(arg.floorId).toBe("floor-1");
    // normX(200) = (200 - 15) / 840, normY(100) = 100 / 560 — the jsdom fallback view.
    expect(arg.point.x).toBeCloseTo(185 / 840, 10);
    expect(arg.point.y).toBeCloseTo(100 / 560, 10);
    expect(discoverSymbolsAction).not.toHaveBeenCalled();
  });

  it("draws the picked box as a highlight in image-pixel space, zoom-compensated", async () => {
    // Would catch: rounding the rect (a picked symbol is ~15px on the sheet), or drawing it in
    // screen space inside a group that is already pan/zoom transformed.
    renderWithTypes();
    armSymbolSelect("CAM");
    expect(screen.queryByTestId("symbol-pick-box")).toBeNull();
    await clickPlan(200, 100);

    const box = screen.getByTestId("symbol-pick-box");
    // The mocked pick is {x:0.1, y:0.2, w:0.05, h:0.06} on this 1200 x 800 plan:
    expect(Number(box.getAttribute("x"))).toBeCloseTo(120, 6);
    expect(Number(box.getAttribute("y"))).toBeCloseTo(160, 6);
    expect(Number(box.getAttribute("width"))).toBeCloseTo(60, 6);
    expect(Number(box.getAttribute("height"))).toBeCloseTo(48, 6);
    // Hairline at any magnification: 1 / the fallback fit zoom of 0.7.
    expect(Number(box.getAttribute("stroke-width"))).toBeCloseTo(1 / 0.7, 6);
    // ...and both confirm affordances are offered.
    expect(screen.getByTestId("symbol-pick-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("symbol-pick-cancel")).toBeInTheDocument();
  });

  it("confirming searches with the EXACT picked box and the chosen type", async () => {
    // Would catch: re-deriving the box from the click point, rounding it, or sending the type NAME
    // instead of its code.
    renderWithTypes();
    armSymbolSelect("TO");
    await pickAndConfirm(200, 100);

    expect(discoverSymbolsAction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discoverSymbolsAction).mock.calls[0][0]).toEqual({
      floorId: "floor-1",
      box: { x: 0.1, y: 0.2, w: 0.05, h: 0.06 },
      typeCode: "TO",
    });
    // The highlight and the whole gesture are done once the search is running.
    expect(screen.queryByTestId("symbol-pick-box")).toBeNull();
    expect(screen.queryByTestId("symbol-prompt")).toBeNull();
  });

  it("cancelling drops the highlight and returns to pick mode WITHOUT searching", async () => {
    // A bad pick must cost a click, not a search.
    renderWithTypes();
    armSymbolSelect("CAM");
    await clickPlan(200, 100);
    await act(async () => {
      fireEvent.click(screen.getByTestId("symbol-pick-cancel"));
    });

    expect(discoverSymbolsAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("symbol-pick-box")).toBeNull();
    // Still in pick mode, so the next click picks again.
    expect(screen.getByTestId("symbol-prompt").textContent).toContain("Camera");
    await clickPlan(300, 200);
    expect(pickSymbolAction).toHaveBeenCalledTimes(2);
  });

  it("says so when the click hit no symbol, and stays in pick mode", async () => {
    vi.mocked(pickSymbolAction).mockResolvedValueOnce({
      ok: false,
      error: "No symbol there — click directly on a device symbol.",
    });
    renderWithTypes();
    armSymbolSelect("CAM");
    await clickPlan(200, 100);

    expect(screen.getByTestId("wizard-notice").textContent).toContain("No symbol there");
    expect(screen.queryByTestId("symbol-pick-box")).toBeNull();
    expect(screen.getByTestId("symbol-prompt")).toBeInTheDocument();
    expect(discoverSymbolsAction).not.toHaveBeenCalled();
  });

  it("pick mode does NOT pan the plan", async () => {
    // Would catch: leaving the root's pan bookkeeping armed during pick mode, which would drag the
    // whole sheet out from under the symbol the user is trying to click.
    renderWithTypes();
    const before = screen
      .getByTestId("floor-plan-canvas")
      .querySelector("g")!
      .getAttribute("transform");
    armSymbolSelect("CAM");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(svg, { clientX: 200, clientY: 100, button: 0, pointerId: 21 });
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 300, pointerId: 21 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 400, clientY: 300, pointerId: 21 });
    });
    expect(
      screen.getByTestId("floor-plan-canvas").querySelector("g")!.getAttribute("transform")
    ).toBe(before);
  });

  it("stages the returned proposals as ghost pins AND panel rows", async () => {
    vi.mocked(discoverSymbolsAction).mockResolvedValueOnce({
      ok: true,
      proposals: [
        { id: "sym-0", label: "CP12", typeCode: "CAM", point: [0.5, 0.5], confidence: "high" },
        { id: "sym-1", label: "", typeCode: "CAM", point: [0.25, 0.75], confidence: "low" },
      ],
    });
    renderWithTypes();
    armSymbolSelect("CAM");
    await pickAndConfirm();

    // Same IMAGE-PIXEL placement every committed and proposed pin uses: [0.5,0.5] on 1200x800.
    expect(screen.getByTestId("proposal-pin-sym-0").getAttribute("transform")).toBe("translate(600 400)");
    expect(screen.getByTestId("proposal-pin-sym-1").getAttribute("transform")).toBe("translate(300 600)");
    // The EXISTING review panel picks them up with no changes of its own.
    expect(screen.getByTestId("proposal-panel")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-item-sym-0")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-item-sym-1")).toBeInTheDocument();
  });

  it("NUMBERS the results after the type prefix, ignoring the plan's own text", async () => {
    // The sheet's text sits where it fits, not where its device is, so a telecom outlet was
    // regularly named after the GFI tag nearest it. Labels are generated now.
    vi.mocked(discoverSymbolsAction).mockResolvedValueOnce({
      ok: true,
      proposals: [
        { id: "sym-0", label: "GFI", typeCode: "CAM", point: [0.5, 0.5], confidence: "high" },
        { id: "sym-1", label: "41,43", typeCode: "CAM", point: [0.25, 0.75], confidence: "high" },
      ],
    });
    renderWithTypes();
    armSymbolSelect("CAM");
    await pickAndConfirm();

    // CAM03/CAM04, not CAM01/CAM02: the fixture site already owns those two, and a generated code
    // has to step over what exists or the create would collide on `unique (site_id, code)`.
    expect(screen.getByTestId<HTMLInputElement>("proposal-label-sym-0").value).toBe("CAM03");
    expect(screen.getByTestId<HTMLInputElement>("proposal-label-sym-1").value).toBe("CAM04");
  });

  it("centres and zooms the plan on a proposal when its dot is clicked", async () => {
    vi.mocked(discoverSymbolsAction).mockResolvedValueOnce({
      ok: true,
      proposals: [
        { id: "sym-0", label: "", typeCode: "CAM", point: [0.5, 0.5], confidence: "high" },
        { id: "sym-1", label: "", typeCode: "CAM", point: [0.25, 0.75], confidence: "high" },
      ],
    });
    renderWithTypes();
    armSymbolSelect("CAM");
    await pickAndConfirm();

    const g = () => screen.getByTestId("floor-plan-canvas").querySelector("g")!.getAttribute("transform");
    const before = g();
    await act(async () => {
      fireEvent.click(screen.getByTestId("proposal-confidence-sym-1"));
    });
    // It TWEENS (the shared fit easing), so the view arrives over several frames rather than
    // jumping — waitFor lets it land instead of asserting a mid-flight value.
    await waitFor(() => {
      const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(g()!)!;
      const [panX, panY, zoom] = [Number(m[1]), Number(m[2]), Number(m[3])];
      // Centred in the space LEFT OF THE PROPOSAL CARD, not the middle of the pane: the card floats
      // over the right 344px (w-72 at right-14), so centring on 870/2 would put the thing you asked
      // to see underneath the card you clicked it in. Pane is 870x560 in jsdom.
      expect(zoom).toBeCloseTo(2.5, 3);
      expect(panX + 0.25 * 1200 * zoom).toBeCloseTo((870 - 344) / 2, 1);
      expect(panY + 0.75 * 800 * zoom).toBeCloseTo(560 / 2, 1);
      // Generous timeout: this waits on a real 340ms rAF tween, and the 1s default has been seen
      // to lose the race on a loaded machine.
    }, { timeout: 4000 });
    expect(g()).not.toBe(before);
  });

  it("says so when nothing matched, rather than falling silent", async () => {
    vi.mocked(discoverSymbolsAction).mockResolvedValueOnce({ ok: true, proposals: [] });
    const { container } = renderWithTypes();
    armSymbolSelect("CAM");
    await pickAndConfirm();

    expect(screen.getByTestId("wizard-notice").textContent).toContain("Nothing found");
    expect(container.querySelectorAll('[data-testid^="proposal-pin-"]')).toHaveLength(0);
  });

  it("surfaces the action's error verbatim and stages nothing", async () => {
    vi.mocked(discoverSymbolsAction).mockResolvedValueOnce({
      ok: false,
      error: "This plan has no source PDF.",
    });
    const { container } = renderWithTypes();
    armSymbolSelect("CAM");
    await pickAndConfirm();

    expect(screen.getByTestId("wizard-notice").textContent).toContain("no source PDF");
    expect(container.querySelectorAll('[data-testid^="proposal-pin-"]')).toHaveLength(0);
  });

  it("Esc exits the whole flow cleanly — no prompt, no highlight, neither action", async () => {
    renderWithTypes();
    armSymbolSelect("CAM");
    await clickPlan(200, 100);
    expect(screen.getByTestId("symbol-pick-box")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(screen.queryByTestId("symbol-prompt")).toBeNull();
    expect(screen.queryByTestId("symbol-pick-box")).toBeNull();
    expect(screen.queryByTestId("symbol-pick-confirm")).toBeNull();
    expect(discoverSymbolsAction).not.toHaveBeenCalled();
    // ...and a click after Esc is an ordinary canvas click again, not another pick.
    await clickPlan(260, 160);
    expect(pickSymbolAction).toHaveBeenCalledTimes(1);
  });

  it("pick mode stands the committed pins down, so a click on one still picks", async () => {
    // Would catch: leaving the edit-mode pin handlers live, which stopPropagation and would eat
    // the press before the root ever saw it.
    renderWithTypes();
    fireEvent.click(screen.getByTestId("edit-layout-toggle"));
    armSymbolSelect("CAM");
    const pin = screen.getByTestId("plan-pin-CAM01");
    const svg = screen.getByTestId("floor-plan-canvas");
    fireEvent.pointerDown(pin, { clientX: 200, clientY: 100, button: 0, pointerId: 15 });
    await act(async () => {
      fireEvent.pointerUp(svg, { clientX: 200, clientY: 100, pointerId: 15 });
    });
    await act(async () => {
      fireEvent.click(svg, { clientX: 200, clientY: 100 });
    });
    expect(pickSymbolAction).toHaveBeenCalledTimes(1);
    // The pin itself must not have been moved by the gesture.
    expect(placeFloorDeviceAction).not.toHaveBeenCalled();
  });
});
