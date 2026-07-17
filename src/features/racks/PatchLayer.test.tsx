import { describe, it, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { RackCanvas } from "./RackCanvas";
import type { RackPlacementRender } from "./RackFrame";
import type { Face, PortGroup } from "@/domain/faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";

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
      onPatch={onPatch} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
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
        onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
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
        onDisconnect={onDisconnect}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
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
        onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
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
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    const cable = container.querySelector('[data-testid="cable-c1"]')!;
    expect(cable.getAttribute("stroke")).toBe("#1a55d8"); // blue by default
    // React derives onPointerEnter/Leave from pointerover/pointerout.
    act(() => { cable.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#fdc700"); // amber on hover
    act(() => { cable.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#1a55d8"); // back to blue
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
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    const cable = container.querySelector('[data-testid="cable-c1"]')!;
    // connected ports render blue at rest (2 endpoints highlighted, no amber).
    const highlightedAtRest = container.querySelectorAll('[data-testid="port-cell"][data-highlighted="true"]');
    expect(highlightedAtRest.length).toBe(2);
    expect(cable.getAttribute("stroke")).toBe("#1a55d8");
    // hovering one endpoint port ambers the whole run.
    const dot = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    act(() => { dot.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerId: 1 })); });
    expect(cable.getAttribute("stroke")).toBe("#fdc700");
  });

  it("a top-half port exits toward the top edge, a bottom-half toward the bottom, angled off the port", () => {
    // A 2-row switch: indices 0–11 are the top row (upper half), 12–23 the bottom row (lower half).
    // Each cable runs to its NEAREST device edge, and the segment onto the port angles toward the
    // trunk (its first waypoint sits LEFT of the port) so it clears the port's centred label.
    const g2 = (id: string): PortGroup => ({ ...g(id), rows: 2, cols: 12 });
    const sw = { id: "sw", startU: 5, code: "sw",
      template: { rackUnits: 1, widthIn: 19, rackMounted: true,
        frontFace: { portGroups: [g2("g-sw")], elements: [] } as Face, backFace: face("g-sw-b") } };
    const pp = dev("pp", 3, "g-pp"); // single-row panel → centred ports
    const ref = (d: string, gid: string, i: number) => ({ rackDeviceId: d, side: "front" as const, groupId: gid, portIndex: i });
    const conns = [
      { id: "top", a: ref("sw", "g-sw", 0), b: ref("pp", "g-pp", 0) },   // sw top-row port
      { id: "bot", a: ref("sw", "g-sw", 12), b: ref("pp", "g-pp", 1) },  // sw bottom-row port
    ];
    const { container } = render(
      <RackCanvas heightU={12} placements={[sw, pp]} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={conns} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    const seg = (id: string) => {
      // d = "M portX portY L wpX wpY Q ..." — n[0..1] the port, n[2..3] the first waypoint.
      const n = [...container.querySelector(`[data-testid="cable-${id}"]`)!.getAttribute("d")!.matchAll(/-?\d+\.?\d*/g)].map(Number);
      return { portX: n[0], portY: n[1], wpX: n[2], wpY: n[3] };
    };
    const top = seg("top");
    expect(top.wpY).toBeLessThan(top.portY);   // top-half exits UP toward the top edge
    expect(top.wpX).toBeLessThan(top.portX);   // ...angled toward the trunk, off the label
    const bot = seg("bot");
    expect(bot.wpY).toBeGreaterThan(bot.portY); // bottom-half exits DOWN toward the bottom edge
    expect(bot.wpX).toBeLessThan(bot.portX);    // ...angled toward the trunk, off the label
  });

  it("a patched port selects on the 1st click and shows the disconnect pin on the 2nd; the pin disconnects", () => {
    const onDisconnect = vi.fn(), onSelectConnection = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={onSelectConnection} onDisconnect={onDisconnect}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    const dot = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    // 1st click: selects the run, no pin yet.
    act(() => { dot.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onSelectConnection).toHaveBeenCalledWith("c1");
    expect(container.querySelector('[data-testid="disconnect-pin"]')).toBeFalsy();
    // 2nd click on the same port: pin appears.
    act(() => { dot.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const pin = container.querySelector('[data-testid="disconnect-pin"]');
    expect(pin).toBeTruthy();
    act(() => { pin!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onDisconnect).toHaveBeenCalledWith("c1");
  });

  it("clicking an unpatched port makes the connectable (unpatched) ports flash", () => {
    const { container } = setup();
    // sw port 0 is unpatched → clicking it starts a pending connection; other unpatched ports flash.
    const src = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    act(() => { src.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelectorAll(".patch-flash").length).toBeGreaterThan(0);
  });

  it("completing a connection onto an already-patched port prompts to replace it", () => {
    const onPatch = vi.fn(), onReplace = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    // pp port 0 is already connected to sw port 5.
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 5 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={onPatch} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={onReplace} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    // click unpatched sw/0 (source), then patched pp/0 (target).
    act(() => { container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    act(() => { container.querySelector('[data-testid="port-dot-pp-front-g-pp-0"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onPatch).not.toHaveBeenCalled(); // no direct patch — a prompt is shown instead
    const confirm = container.querySelector('[data-testid="replace-confirm"]')!;
    expect(confirm).toBeTruthy();
    act(() => { confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onReplace).toHaveBeenCalledWith(["c1"],
      { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
      { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 });
  });

  it("prompts to replace when the SOURCE port is the patched one (moving a cable)", () => {
    const onPatch = vi.fn(), onReplace = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    // sw/0 is already connected to pp/0; the user drags sw/0 onto a FREE port instead.
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={onPatch} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={onReplace} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    const src = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;   // PATCHED
    const dst = container.querySelector('[data-testid="port-dot-pp-front-g-pp-4"]')!;   // free
    act(() => { src.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 })); });
    act(() => { dst.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 })); });
    expect(onPatch).not.toHaveBeenCalled(); // must NOT hard-error — it offers to move the cable
    act(() => { container.querySelector('[data-testid="replace-confirm"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onReplace).toHaveBeenCalledWith(["c1"],
      { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
      { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 4 });
  });

  it("takes BOTH cables out when both ports are already patched", () => {
    const onReplace = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const c1 = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const c2 = { id: "c2",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 1 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 1 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[c1, c2]} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={onReplace} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    // drag sw/0 (on c1) onto pp/1 (on c2) — leaving c2 in place would double-book pp/1
    act(() => { container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 })); });
    act(() => { container.querySelector('[data-testid="port-dot-pp-front-g-pp-1"]')!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 })); });
    act(() => { container.querySelector('[data-testid="replace-confirm"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const [ids] = onReplace.mock.calls[0];
    expect([...(ids as string[])].sort()).toEqual(["c1", "c2"]);
  });

  it("does nothing when the two ports are already patched to each other", () => {
    const onPatch = vi.fn(), onReplace = vi.fn();
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const conn = { id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[conn]} selectedConnectionId={null}
        onPatch={onPatch} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={onReplace} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
      dropArmed={false} onDropAt={() => {}} />,
    );
    act(() => { container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 })); });
    act(() => { container.querySelector('[data-testid="port-dot-pp-front-g-pp-0"]')!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 })); });
    expect(container.querySelector('[data-testid="replace-confirm"]')).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("cables are drawn 2px thicker (stroke-width 4), including the drag animations", () => {
    const sw = dev("sw", 5, "g-sw"), pp = dev("pp", 3, "g-pp");
    const conns = [{ id: "c1",
      a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
      b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } }];
    const { container } = render(
      <RackCanvas heightU={12} placements={[sw, pp]} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={conns} selectedConnectionId={null}
        onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
        onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
        dropArmed={false} onDropAt={() => {}} />,
    );
    // the routed cable (overlap is a visual property, verified in the browser; the edge waypoint is
    // rounded by roundedPath's 14px radius so it is not a clean numeric check).
    expect(container.querySelector('[data-testid="cable-c1"]')!.getAttribute("stroke-width")).toBe("4");
  });

  it("a cable stays attached to a device as it is grip-dragged", () => {
    // The device moves imperatively during a grip drag (no re-render), so the cable must be updated
    // imperatively too. Capture the rAF callback (jsdom never fires it) and step one frame after a
    // pointermove, then assert the dragged device's end of the cable moved by the drag delta.
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const sw = dev("sw", 5, "g-sw"), pp = dev("pp", 3, "g-pp");
      const conns = [{ id: "c1",
        a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
        b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } }];
      const { container } = render(
        <RackCanvas heightU={12} placements={[sw, pp]} side="FRONT" selectedId="sw"
          onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
          connections={conns} selectedConnectionId={null}
          onPatch={() => {}} onSelectConnection={() => {}} onDisconnect={() => {}}
          onReplace={() => {}} portLabel={(p) => `${p.rackDeviceId}/${p.portIndex + 1}`}
          dropArmed={false} onDropAt={() => {}} />,
      );
      const cable = () => container.querySelector('[data-testid="cable-c1"]')!.getAttribute("d")!;
      // the sw end is the FIRST point of the path: "M x y ..."
      const swEndY = () => Number(cable().match(/^M\s*-?[\d.]+\s+(-?[\d.]+)/)![1]);
      const before = swEndY();

      // grip-drag sw up by one RU (scale defaults to 1 in jsdom)
      const grip = container.querySelector('[data-testid="rack-grip-sw"]') as HTMLElement;
      fireEvent.pointerDown(grip, { clientX: 0, clientY: 100, button: 0 });
      act(() => { fireEvent.pointerMove(window, { clientX: 0, clientY: 100 - RU_PX }); }); // up one RU
      act(() => { frame?.(0); });   // PatchLayer's per-frame update runs once

      const after = swEndY();
      expect(after).toBeCloseTo(before - RU_PX, 0);   // the sw end followed the device up by one RU
      fireEvent.pointerUp(window, { clientX: 0, clientY: 100 - RU_PX });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
