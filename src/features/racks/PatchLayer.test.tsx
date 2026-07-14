import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { RackCanvas } from "./RackCanvas";
import type { RackPlacementRender } from "./RackFrame";
import type { Face, PortGroup } from "@/domain/faceplate";

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });
const dev = (id: string, startU: number, gid: string): RackPlacementRender => ({
  id, startU, code: id,
  template: { rackUnits: 1, widthIn: 19, rackMounted: true, frontFace: face(gid), backFace: face(gid + "-b") },
});

function setup(onPatch = vi.fn()) {
  const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
  const utils = render(
    <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
      onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
      connections={[]} selectedConnectionId={null}
      onPatch={onPatch} onSelectConnection={() => {}} onDisconnect={() => {}} />,
  );
  return { ...utils, onPatch };
}

const pdown = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
const pup = (el: Element) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));

describe("PatchLayer drag-to-patch", () => {
  it("dragging sw port 0 onto pp port 0 calls onPatch with both refs", () => {
    const { container, onPatch } = setup();
    const src = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    const dst = container.querySelector('[data-testid="port-dot-pp-front-g-pp-0"]')!;
    expect(src).toBeTruthy(); expect(dst).toBeTruthy();
    act(() => { pdown(src); });
    act(() => { pup(dst); }); // PatchLayer resolves the target via elementFromPoint OR the pointerup target
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [a, b] = onPatch.mock.calls[0];
    expect(a).toEqual({ rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 });
    expect(b).toEqual({ rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 });
  });

  it("renders a cable path for an existing connection", () => {
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[{ id: "c1",
          a: { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
          b: { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 } }]}
        selectedConnectionId={null} onPatch={() => {}} onSelectConnection={() => {}}
        onDisconnect={() => {}} />,
    );
    expect(container.querySelector('[data-testid="cable-c1"]')).toBeTruthy();
  });

  it("Delete removes the selected connection", () => {
    const onSelectConnection = vi.fn();
    const onDisconnect = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={"c1"}
        onPatch={() => {}} onSelectConnection={onSelectConnection}
        onDisconnect={onDisconnect} />,
    );
    container.querySelector('[data-testid="cable-c1"]'); // present
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(onDisconnect).toHaveBeenCalledWith("c1");
  });

  it("clicking a cable selects it and the selection is not immediately cleared", () => {
    // Regression: the cable path selected via onPointerDown + stopPropagation, but the browser's
    // synthesized click still bubbles to the svg's onClick, which clears the selection in the same
    // tick. Selection must happen on click (with the click itself stopped) so it sticks.
    const onSelectConnection = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={onSelectConnection}
        onDisconnect={() => {}} />,
    );
    const cable = container.querySelector('[data-testid="cable-c1"]')!;
    expect(cable).toBeTruthy();
    // Real browsers fire pointerdown/pointerup then a synthesized click that bubbles; jsdom's
    // fireEvent.click / dispatched click also bubbles to ancestors the same way.
    cable.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectConnection).toHaveBeenCalled();
    expect(onSelectConnection.mock.calls.at(-1)?.[0]).toBe("c1");
  });

  it("a cable turns amber on hover and back to blue on leave", () => {
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}} />,
    );
    const cable = container.querySelector('[data-testid="cable-c1"]')!;
    expect(cable.getAttribute("stroke")).toBe("#2d5bff"); // blue by default
    // React derives onPointerEnter/Leave from pointerover/pointerout.
    act(() => { cable.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#f59e0b"); // amber on hover
    act(() => { cable.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#2d5bff"); // back to blue
  });

  it("hovering a patched port turns its run amber (cable + endpoint cells)", () => {
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}} />,
    );
    const cable = container.querySelector('[data-testid="cable-c1"]')!;
    // connected ports render blue at rest (2 endpoints highlighted, no amber).
    const highlightedAtRest = container.querySelectorAll('[data-testid="port-cell"][data-highlighted="true"]');
    expect(highlightedAtRest.length).toBe(2);
    expect(cable.getAttribute("stroke")).toBe("#2d5bff");
    // hovering one endpoint port ambers the whole run.
    const dot = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    act(() => { dot.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#f59e0b");
  });
});
