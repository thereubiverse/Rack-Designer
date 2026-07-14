import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
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
      onPatch={onPatch} onSelectConnection={() => {}} />,
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
    pdown(src);
    pup(dst); // PatchLayer resolves the target via elementFromPoint OR the pointerup target
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
        selectedConnectionId={null} onPatch={() => {}} onSelectConnection={() => {}} />,
    );
    expect(container.querySelector('[data-testid="cable-c1"]')).toBeTruthy();
  });
});
