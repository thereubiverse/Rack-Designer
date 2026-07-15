import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RackBuilder } from "./RackBuilder";
import type { RackRow, RackDeviceRow } from "./repository";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";
import type { Connection } from "./connectionOps";
import type { PortEndpoint } from "./endpointOps";
import type { PortGroup, Face } from "@/domain/faceplate";
import { emptyFace } from "@/domain/faceplate";
import type { SiteScope } from "./siteScope";
import { SNAP_MS, PULL_DIST } from "./palettePull";
import { RACK_GUTTER_L, RACK_INTERIOR_W } from "./RackFrame";

// Pure UI-wiring tests: the rack builder must never touch the network/DB. Saves are debounced
// 600ms and mocked out here so a stray timer firing mid-test can't hit a real server action.
vi.mock("./actions", () => ({
  saveRackLayoutAction: vi.fn().mockResolvedValue({ ok: true }),
  saveConnectionsAction: vi.fn().mockResolvedValue({ ok: true }),
  saveEndpointsAction: vi.fn().mockResolvedValue({ ok: true }),
  updateRackAction: vi.fn().mockResolvedValue({ ok: true }),
}));

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 4, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

const typeId = "type-sw";
const templateId = "tpl-sw";

const deviceType: DeviceTypeRow = {
  id: typeId, organization_id: "org", name: "Switch", created_at: "", category: "rack", code: "SW", is_standard: true,
};

const template: PickerTemplate = {
  id: templateId, name: "Switch 24p", brandId: null, deviceTypeId: typeId,
  rackUnits: 1, widthIn: 19, rackMounted: true,
  frontFace: emptyFace(), backFace: emptyFace(),
  brandName: null,
};

function deviceRow(id: string, code: string, startU: number, groupId: string): RackDeviceRow {
  return {
    id, rack_id: "rack-1", device_template_id: templateId, code, name: null,
    start_u: startU, side: "front", status: "installed",
    manufacturer: null, model_name: null, serial_number: null, purchase_date: null, operation_start: null,
    front_face: face(groupId), back_face: emptyFace(), height_u: 1,
    created_at: "", updated_at: "",
  };
}

const rack: RackRow = { id: "rack-1", room_id: "room-1", code: "RK01", name: "Rack 1", height_u: 12 };

const conn: Connection = {
  id: "c1",
  a: { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
  b: { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 },
};

const siteScope: SiteScope = { racks: [], switches: [] };

function baseProps() {
  return {
    rack,
    initialDevices: [deviceRow("sw", "SW01", 5, "g-sw"), deviceRow("pp", "PP01", 3, "g-pp")],
    initialConnections: [conn] as Connection[],
    initialEndpoints: [] as PortEndpoint[],
    siteScope,
    floorTypes: [] as DeviceTypeRow[],
    types: [deviceType],
    templatesByType: { [typeId]: [template] },
  };
}

// Real click on the base rack svg (the one with the onClick that clears both selections) —
// distinct from the overlay svg (PatchLayer), which has no click handler of its own.
function clickEmptyCanvas(container: HTMLElement) {
  const svg = container.querySelector("svg")!;
  act(() => { fireEvent.click(svg); });
}

function clickCable(container: HTMLElement, id: string) {
  const cable = container.querySelector(`[data-testid="cable-${id}"]`)!;
  // Real browsers deliver a bubbling click after pointerdown/pointerup; PatchLayer's cable
  // selects on click (see PatchLayer.test.tsx). A raw dispatchEvent (rather than fireEvent)
  // isn't auto-wrapped in act() by RTL, so wrap it explicitly to force the resulting state
  // update to flush before the next assertion.
  act(() => { cable.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

// The blob only solidifies near the RACK's centre line, and jsdom has no layout — so derive the same
// x the component will, from the live transform, rather than fabricating a coordinate and hoping it
// lands inside the current RACK_LATCH_X. Hardcoding one made these tests break the first time that
// constant was tuned, which is the tunable-in-an-assertion trap wearing a different hat.
function rackCentreX(): number {
  const el = screen.getByTestId("rack-canvas-scale");
  const s = parseFloat(el.style.transform.match(/scale\(([-0-9.]+)\)/)?.[1] ?? "1");
  return el.getBoundingClientRect().left + (RACK_GUTTER_L + RACK_INTERIOR_W / 2) * s;
}

describe("RackBuilder sidebar selection", () => {
  it("selecting a device then a cable opens ConnectionDetails and hides device settings", () => {
    // Regression for the unwired half of selection exclusion: RackBuilder must pass a setter
    // that clears selectedId when a connection is picked, not the raw setSelectedConnectionId.
    // This test fails against the old `onSelectConnection={setSelectedConnectionId}` wiring,
    // because `selected` stays truthy and the sidebar keeps rendering device settings.
    const { container } = render(<RackBuilder {...baseProps()} />);
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    clickCable(container, "c1");

    expect(screen.getByTestId("connection-details")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
  });

  it("selecting a cable then a device shows device settings and hides ConnectionDetails", () => {
    const { container } = render(<RackBuilder {...baseProps()} />);
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rack-dev-ear-l-pp"));

    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });

  it("deleting the selected device after it replaced a cable selection falls back to RackSettings", () => {
    // Guards the "earlier strand bug": deleting a device must never leave the sidebar blank or
    // stuck on a stale ConnectionDetails. Mutual exclusion means a device and a cable can never
    // be selected at once post-fix, so this exercises the round-trip immediately before the
    // delete (cable selected -> device selected, replacing it -> device deleted) and checks the
    // sidebar recovers to RackSettings rather than rendering nothing.
    const { container } = render(<RackBuilder {...baseProps()} />);
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("device-delete"));

    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });

  it("clicking the empty canvas shows RackSettings and clears both selections", () => {
    const { container } = render(<RackBuilder {...baseProps()} />);
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    clickEmptyCanvas(container);

    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
    expect(screen.queryByTestId("connection-details")).toBeNull();

    // And from a cable selection too.
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();
    clickEmptyCanvas(container);
    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });

  it("Delete removes the selected device, not the previously selected cable", () => {
    // Regression for the unwired half of selection exclusion on the device side: selectDevice
    // must clear selectedConnectionId, or else RackCanvas's Delete handler (which prefers
    // selectedConnectionId) silently disconnects the stale cable instead of deleting the device
    // that's visibly selected in the sidebar.
    const { container } = render(<RackBuilder {...baseProps()} />);
    clickCable(container, "c1");
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    act(() => { fireEvent.keyDown(window, { key: "Delete" }); });
    expect(screen.queryByTestId("rack-dev-sw")).toBeNull();
  });

  it("pressing a palette chip and dropping on a free RU opens the picker at that RU", () => {
    // The whole gesture: press the chip, pull past PULL_DIST so it latches solid, release on a strip.
    // jsdom reports a zero-size rect for the chip, so its centre is (0,0) and the pointer's distance
    // is simply clientX. Aim at the rack: past PULL_DIST (so the neck snaps) AND near the rack centre
    // (so it solidifies) — both are now required.
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); }); // -> latches solid
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
  });

  it("a chip press released before it solidifies opens nothing", () => {
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: PULL_DIST / 10, clientY: 0 }); }); // short of PULL_DIST
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
  });

  it("right-clicking a chip starts no pull", () => {
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 2 });
    expect(screen.queryByTestId("pull-box")).toBeNull();
  });

  it("still opens the picker on a plain chip click", () => {
    // The existing palette behaviour must survive: click a chip -> picker at that type, no RU.
    render(<RackBuilder {...baseProps()} />);
    fireEvent.click(screen.getByTestId("palette-type-SW"));
    expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
  });

  it("a blob carried far from the rack never solidifies, so it cannot be dropped", () => {
    // The RACK is what turns slime into a device. Pull the neck clean off (far past PULL_DIST) but
    // stay away from the rack's centre line: it must stay a blob, the drop must not arm, and
    // releasing on a strip must do nothing. Distance from the chip alone is no longer enough.
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: 10000, clientY: 0 }); }); // free, but nowhere near
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
  });

  it("an abandoned MID-pull snaps back from where the box IS, not from the cursor", () => {
    // Mid-pull the box lags the cursor — it travels from the chip toward the pointer as you drag.
    // beginSnapBack must therefore capture the BOX's position, not the pointer's; capturing the
    // pointer teleports the box to the cursor before it starts shrinking. Every other abandon test
    // latches solid first, where the two coincide (pullAt === pointer at t=1), so only a mid-pull
    // abandon can catch this.
    // Two things make this observable only with effort, and both are why it nearly shipped untested:
    //  - abandoning MID-pull calls setDropArmed(false) when it is already false, so React bails out
    //    and never re-renders. The snap-back is painted ONLY by the rAF loop — and jsdom never fires
    //    rAF on its own. So capture the frame callback and run one by hand.
    //  - the clock must be FROZEN: the snap-back starts retreating immediately and the right and
    //    wrong start points decay at the same rate, so with a live clock the wrong one drifts under
    //    any threshold and the test silently stops discriminating (verified — it did).
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      render(<RackBuilder {...baseProps()} />);
      fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
      const pointerX = PULL_DIST / 2;                     // half-way: still stretching, still lagging
      act(() => { fireEvent.pointerMove(window, { clientX: pointerX, clientY: 0 }); });
      act(() => { fireEvent.pointerUp(window, { clientX: pointerX, clientY: 0 }); }); // abandon
      act(() => { frame?.(0); });                         // the loop paints the snap-back's first frame
      const box = screen.getByTestId("pull-box");
      const tx = parseFloat(box.style.transform.match(/translate\(([-0-9.]+)px/)![1]);
      const centreX = tx + parseFloat(box.style.width) / 2;
      // A relationship, not a magic number: at the instant it is abandoned the box must still be
      // BEHIND the cursor. The 0.95 leaves the easing curve free to be tuned.
      expect(centreX).toBeLessThan(pointerX * 0.95);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("a pull abandoned then immediately restarted is not killed by the old snap-back timer", () => {
    // Race: beginSnapBack schedules endPull after SNAP_MS. Grab another chip inside that window and
    // the stale timer would clear the NEW pull mid-gesture. startPull must cancel it.
    vi.useFakeTimers();
    try {
      render(<RackBuilder {...baseProps()} />);
      const chip = screen.getByTestId("palette-type-SW");
      // pull #1, then abandon it away from the rack -> snap-back timer is now pending
      fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
      act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); });
      act(() => { fireEvent.pointerUp(window, { clientX: rackCentreX(), clientY: 0 }); });
      // pull #2 starts INSIDE the snap window
      fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
      act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); });
      act(() => { vi.advanceTimersByTime(SNAP_MS * 2); }); // the OLD timer would fire in here
      // pull #2 must still be alive and droppable
      fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
      expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abandoned solid pull starts its snap-back at full size, not the live pointer distance", () => {
    // Pins beginSnapBack's capture order: p.phase must be read BEFORE it's overwritten to
    // "snapback", so a solid pull reads snapT=1 regardless of where the pointer ended up. Drives
    // the real gesture (unlike palettePull.test.ts, which hand-builds a PullState with snapT
    // already set and never runs beginSnapBack at all) so reordering those two lines is caught.
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); }); // -> latches solid
    const solidWidth = screen.getByTestId("pull-box").style.width;
    expect(parseFloat(solidWidth)).toBeGreaterThan(0);

    // Pull back near the chip — the solid latch is one-way, phase must stay "solid".
    act(() => { fireEvent.pointerMove(window, { clientX: 5, clientY: 0 }); });

    // Abandon off the rack strips entirely, so the window's pointerup listener runs beginSnapBack.
    act(() => { fireEvent.pointerUp(window, { clientX: 5, clientY: 0 }); });

    const box = screen.getByTestId("pull-box");
    expect(parseFloat(box.style.width)).toBeGreaterThan(parseFloat(solidWidth) * 0.8);
  });
});
