import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { RackBuilder } from "./RackBuilder";
import type { RackRow, RackDeviceRow } from "./repository";
import type { DeviceTypeRow, PickerTemplate, BrandRow } from "@/features/device-library/repository";
import type { Connection } from "./connectionOps";
import type { PortEndpoint } from "./endpointOps";
import type { PortGroup, Face } from "@/domain/faceplate";
import { emptyFace } from "@/domain/faceplate";
import type { SiteScope } from "./siteScope";
import { listTemplatesForTypeAction } from "@/features/device-library/actions";
import { SNAP_MS, RACK_LATCH_X } from "./palettePull";
import { RACK_GUTTER_L, RACK_INTERIOR_W } from "./RackFrame";

// Pure UI-wiring tests: the rack builder must never touch the network/DB. Saves are debounced
// 600ms and mocked out here so a stray timer firing mid-test can't hit a real server action.
vi.mock("./actions", () => ({
  saveRackLayoutAction: vi.fn().mockResolvedValue({ ok: true }),
  saveConnectionsAction: vi.fn().mockResolvedValue({ ok: true }),
  saveEndpointsAction: vi.fn().mockResolvedValue({ ok: true }),
  updateRackAction: vi.fn().mockResolvedValue({ ok: true }),
}));

// Device-library server actions — the create-custom flow calls these. The refreshed-templates
// return is configured per-test (below) so we can assert the new template lands in the picker.
vi.mock("@/features/device-library/actions", () => ({
  saveNewDeviceTemplateAction: vi.fn().mockResolvedValue({ ok: true, id: "new-tpl" }),
  listTemplatesForTypeAction: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
  createBrandAction: vi.fn().mockResolvedValue({ ok: true }),
  deleteBrandAction: vi.fn().mockResolvedValue({ ok: true }),
}));

// The editor's internals (and its server-only DeviceWizard/AI import chain) are covered by
// RackDeviceEditor.test.tsx — here we stub it to a Save button that fires onSave with a draft,
// so this test focuses on RackBuilder's wiring: open → save → refetch → preselect in the picker.
vi.mock("@/features/device-library/editor/RackDeviceEditor", () => ({
  RackDeviceEditor: ({ initial, onSave }: { initial?: { deviceTypeId?: string }; onSave: (d: unknown) => void }) => (
    <div data-testid="stub-editor" data-locked-type={initial?.deviceTypeId}>
      <button onClick={() => onSave({
        name: "My Custom SW", brandId: null, deviceTypeId: initial?.deviceTypeId ?? "",
        rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace(),
      })}>stub-save</button>
    </div>
  ),
}));

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 4, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

const typeId = "type-sw";
const templateId = "tpl-sw";

const deviceType: DeviceTypeRow = {
  id: typeId, name: "Switch", created_at: "", category: "rack", code: "SW", is_standard: true,
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
    brands: [] as BrandRow[],
    wizard: { enabled: false, hasKey: false },
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
    // The whole gesture: press the chip, carry it to the rack so it opens into a device, release on
    // a strip. Reaching the rack's centre line is the ONLY thing that opens it now.
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); }); // -> latches solid
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
  });

  it("Create Custom Device opens the editor locked to the browsed type; save refreshes it into the picker, pre-selected and placeable", async () => {
    // The refreshed list the picker gets after the save — includes the just-created template.
    const created: PickerTemplate = {
      id: "new-tpl", name: "My Custom SW", brandId: null, brandName: null, deviceTypeId: typeId,
      rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace(),
    };
    vi.mocked(listTemplatesForTypeAction).mockResolvedValueOnce({ ok: true, templates: [template, created] });

    render(<RackBuilder {...baseProps()} />);
    // Open the picker at the SW type (plain chip click → level 2 for that type).
    fireEvent.click(screen.getByTestId("palette-type-SW"));
    expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();

    // Create Custom Device → the editor opens, locked to the type the picker was browsing.
    fireEvent.click(screen.getByTestId("picker-create-custom"));
    const editor = screen.getByTestId("stub-editor");
    expect(editor.getAttribute("data-locked-type")).toBe(typeId);

    // Save → the new template refreshes into the picker (still open underneath), pre-selected.
    fireEvent.click(screen.getByText("stub-save"));
    await waitFor(() => expect(screen.queryByTestId("stub-editor")).toBeNull()); // editor closed
    expect(listTemplatesForTypeAction).toHaveBeenCalledWith(typeId);
    // The new device is selected in the picker (its Insert button goes live once the preselect
    // effect commits) and can be placed onto the rack.
    await waitFor(() => expect(screen.getByTestId("picker-insert")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("picker-insert"));
    // Inserting closes the picker — the device using the new template is now on the rack.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull());
  });

  it("a chip released just short of the rack opens nothing", () => {
    // Derived from RACK_LATCH_X rather than hardcoded, so tuning the threshold can't break this.
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX() - RACK_LATCH_X - 20, clientY: 0 }); });
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
  });

  it("picking a chip up empties ITS slot — you are moving the chip, not a copy", () => {
    render(<RackBuilder {...baseProps()} />);
    const chip = screen.getByTestId("palette-type-SW");
    expect(chip.style.visibility).toBe("");
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
    // Hidden rather than unmounted: the slot must keep its space, or the palette below it jumps up
    // and reflows the instant you pick a chip up.
    expect(chip.style.visibility).toBe("hidden");
    expect(screen.getByTestId("palette-type-SW")).toBeInTheDocument();
  });

  it("the chip comes back the moment the carried one is gone", () => {
    vi.useFakeTimers();
    try {
      render(<RackBuilder {...baseProps()} />);
      const chip = screen.getByTestId("palette-type-SW");
      fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
      act(() => { fireEvent.pointerUp(window, { clientX: 0, clientY: 0 }); });   // abandon -> snap back
      expect(chip.style.visibility).toBe("hidden");            // still away, mid snap-back
      act(() => { vi.advanceTimersByTime(SNAP_MS + 20); });
      expect(screen.getByTestId("palette-type-SW").style.visibility).toBe("");   // home again
    } finally {
      vi.useRealTimers();
    }
  });

  it("only the chip you picked up is hidden", () => {
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
    for (const el of screen.getAllByTestId(/^palette-type-/)) {
      expect(el.style.visibility).toBe(el.getAttribute("data-testid") === "palette-type-SW" ? "hidden" : "");
    }
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

  it("leaving the rack closes it back to a chip AND disarms the drop", () => {
    // The rule is symmetric: cross in and it opens, cross back out and it closes. The disarm is the
    // load-bearing half — a device that closed but stayed armed could still be dropped from across
    // the page, which is exactly the bug the proximity rule exists to prevent.
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); });   // opens
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX() - RACK_LATCH_X - 40, clientY: 0 }); }); // leaves
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
  });

  it("crossing back IN re-opens it, so the whole trip works in one motion", () => {
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); });   // open
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX() - RACK_LATCH_X - 40, clientY: 0 }); }); // close
    act(() => { fireEvent.pointerMove(window, { clientX: rackCentreX(), clientY: 0 }); });   // open again
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
  });

  it("a chip carried far PAST the rack never opens, so it cannot be dropped", () => {
    // The RACK is what turns a carried chip into a device. Carry it way beyond the rack's centre
    // line and it must stay a chip, the drop must not arm, and releasing on a strip must do nothing.
    // Distance travelled is not the test — proximity to the rack is.
    render(<RackBuilder {...baseProps()} />);
    fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 0 });
    act(() => { fireEvent.pointerMove(window, { clientX: 10000, clientY: 0 }); }); // free, but nowhere near
    fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
    expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
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

});
