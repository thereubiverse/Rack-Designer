import { describe, it, expect } from "vitest";
import { addIconElement, moveElement, resizeElement, deleteElement, setElementIcon, resolveIconResize, resolveIconGroupResize, resolveElementsResize, resizeElements, resolveIconDrop, setElementsColor, setElementsOpacity, duplicateElements, resolveElementsDrag, placeElements, ICON_DEFAULT_SIZE, ICON_MIN_SIZE } from "./elementOps";
import {
  addTextElement, addShapeElement, addLineElement, updateElements,
  translateLine, moveLineEndpoint, LINE_MIN_LEN,
} from "./elementOps";
import type { Face } from "@/domain/faceplate";
import { emptyFace } from "@/domain/faceplate";

const empty: Face = { portGroups: [], elements: [] };

describe("addIconElement", () => {
  it("appends an icon element at the position with a default size + a fresh id", () => {
    const out = addIconElement(empty, { gridX: 40, gridY: 20, iconName: "tabler:home" });
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0]).toMatchObject({
      kind: "icon", gridX: 40, gridY: 20, iconName: "tabler:home", w: ICON_DEFAULT_SIZE, h: ICON_DEFAULT_SIZE,
    });
    expect(out.elements[0].id.length).toBeGreaterThan(0);
  });
  it("leaves existing elements and port groups untouched", () => {
    const seeded = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "tabler:a" });
    const out = addIconElement(seeded, { gridX: 10, gridY: 10, iconName: "tabler:b" });
    expect(out.elements).toHaveLength(2);
  });
});

describe("moveElement", () => {
  it("moves the element to the new position", () => {
    const f = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "tabler:home" });
    const id = f.elements[0].id;
    expect(moveElement(f, id, { gridX: 100, gridY: 50 }).elements[0]).toMatchObject({ gridX: 100, gridY: 50 });
  });
});

describe("resizeElement", () => {
  it("resizes, clamped to a minimum", () => {
    const f = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "tabler:home" });
    const id = f.elements[0].id;
    expect(resizeElement(f, id, { w: 80, h: 60 }).elements[0]).toMatchObject({ w: 80, h: 60 });
    expect(resizeElement(f, id, { w: 2, h: 2 }).elements[0]).toMatchObject({ w: ICON_MIN_SIZE, h: ICON_MIN_SIZE });
  });
});

describe("deleteElement", () => {
  it("removes the element", () => {
    const f = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "tabler:home" });
    expect(deleteElement(f, f.elements[0].id).elements).toHaveLength(0);
  });
});

describe("setElementIcon", () => {
  it("swaps the icon name", () => {
    const f = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "tabler:home" });
    expect(setElementIcon(f, f.elements[0].id, "mdi:cog").elements[0]).toMatchObject({ iconName: "mdi:cog" });
  });
});

describe("resolveIconResize", () => {
  const bounds = { width: 400, height: 84 };
  it("keeps the box square (uniform scale from the corner)", () => {
    const orig = { gridX: 10, gridY: 10, w: 36, h: 36 };
    expect(resolveIconResize(orig, 20, 5, bounds)).toEqual({ w: 56, h: 56 }); // 36 + max(20,5)
  });
  it("clamps so the square stays inside the body (never past the edge)", () => {
    const orig = { gridX: 380, gridY: 10, w: 20, h: 20 };
    expect(resolveIconResize(orig, 200, 200, bounds)).toEqual({ w: 20, h: 20 }); // maxSize = min(20, 74) = 20
  });
  it("clamps to the minimum size", () => {
    const orig = { gridX: 10, gridY: 10, w: 36, h: 36 };
    expect(resolveIconResize(orig, -100, -100, bounds)).toEqual({ w: ICON_MIN_SIZE, h: ICON_MIN_SIZE });
  });
});

describe("resolveIconGroupResize", () => {
  const bounds = { width: 400, height: 84 };
  const boxes = [
    { id: "a1", gridX: 0, gridY: 10, w: 36, h: 36 },
    { id: "a2", gridX: 100, gridY: 10, w: 18, h: 18 },
  ];
  it("scales all icons proportionally (keeps relative sizes) when not uniform", () => {
    // drag a1 by +18 → 54 (factor 1.5); a2 keeps its ratio → 27
    expect(resolveIconGroupResize(boxes, "a1", 18, 0, bounds, false)).toEqual([
      { id: "a1", w: 54, h: 54 },
      { id: "a2", w: 27, h: 27 },
    ]);
  });
  it("forces every icon to the anchor's size when uniform (Shift)", () => {
    expect(resolveIconGroupResize(boxes, "a1", 18, 0, bounds, true)).toEqual([
      { id: "a1", w: 54, h: 54 },
      { id: "a2", w: 54, h: 54 },
    ]);
  });
  it("clamps each icon to its own room in the body", () => {
    const near = [{ id: "e", gridX: 380, gridY: 10, w: 20, h: 20 }];
    expect(resolveIconGroupResize(near, "e", 200, 200, bounds, false)).toEqual([{ id: "e", w: 20, h: 20 }]);
  });
});

describe("resolveElementsResize", () => {
  const bounds = { width: 400, height: 84 };
  it("single element, non-uniform: grows w by dx and leaves h unchanged when dy=0 (no square-lock)", () => {
    const boxes = [{ id: "a", gridX: 10, gridY: 10, w: 40, h: 20 }];
    expect(resolveElementsResize(boxes, "a", 20, 0, bounds, false)).toEqual([
      { id: "a", w: 60, h: 20 },
    ]);
  });
  it("multi-element, non-uniform: scales every box by the anchor's per-axis factor (keeps relative sizes)", () => {
    const boxes = [
      { id: "a", gridX: 0, gridY: 10, w: 40, h: 20 },
      { id: "b", gridX: 100, gridY: 10, w: 20, h: 10 },
    ];
    // anchor a: w 40->60 (factor 1.5), h 20->30 (factor 1.5) -> b scales same factors: 20->30, 10->15
    expect(resolveElementsResize(boxes, "a", 20, 10, bounds, false)).toEqual([
      { id: "a", w: 60, h: 30 },
      { id: "b", w: 30, h: 15 },
    ]);
  });
  it("uniform (Shift): forces every box to a square of the anchor's larger new side", () => {
    const boxes = [
      { id: "a", gridX: 0, gridY: 10, w: 40, h: 20 },
      { id: "b", gridX: 100, gridY: 10, w: 20, h: 10 },
    ];
    // anchor a: w 40->60, h 20->25 -> larger side 60 -> broadcast 60x60 to all (clamped per box)
    expect(resolveElementsResize(boxes, "a", 20, 5, bounds, true)).toEqual([
      { id: "a", w: 60, h: 60 },
      { id: "b", w: 60, h: 60 },
    ]);
  });
  it("clamps each result to ICON_MIN_SIZE and to the body per-axis", () => {
    const boxes = [{ id: "a", gridX: 380, gridY: 10, w: 20, h: 20 }];
    // w would grow past the body edge (maxW = 400-380 = 20); h stays within room (maxH = 84-10 = 74)
    expect(resolveElementsResize(boxes, "a", 200, 5, bounds, false)).toEqual([
      { id: "a", w: 20, h: 25 },
    ]);
    // shrinking past the minimum clamps to ICON_MIN_SIZE on both axes
    expect(resolveElementsResize(boxes, "a", -100, -100, bounds, false)).toEqual([
      { id: "a", w: ICON_MIN_SIZE, h: ICON_MIN_SIZE },
    ]);
  });
});

describe("resizeElements", () => {
  it("sets sizes on the listed elements (clamped to minimum)", () => {
    const f = addIconElement(addIconElement(empty, { gridX: 0, gridY: 0, iconName: "a" }), { gridX: 10, gridY: 10, iconName: "b" });
    const [id0, id1] = f.elements.map((e) => e.id);
    const out = resizeElements(f, [{ id: id0, w: 60, h: 60 }, { id: id1, w: 2, h: 2 }]).elements;
    expect(out[0]).toMatchObject({ w: 60, h: 60 });
    expect(out[1]).toMatchObject({ w: ICON_MIN_SIZE, h: ICON_MIN_SIZE });
  });
});

describe("resolveIconDrop", () => {
  const bounds = { width: 400, height: 84 };
  it("centres the icon square on the cursor", () => {
    expect(resolveIconDrop(100, 40, 36, bounds)).toEqual({ gridX: 82, gridY: 22 }); // 100-18, 40-18
  });
  it("clamps the box inside the body (never past the edge / into an ear)", () => {
    expect(resolveIconDrop(0, 0, 36, bounds)).toEqual({ gridX: 0, gridY: 0 });
    expect(resolveIconDrop(1000, 1000, 36, bounds)).toEqual({ gridX: 364, gridY: 48 }); // width-size, height-size
  });
});

describe("setElementsColor / setElementsOpacity", () => {
  const face2 = (): Face => addIconElement(addIconElement(empty, { gridX: 0, gridY: 0, iconName: "a" }), { gridX: 10, gridY: 10, iconName: "b" });
  it("sets color on all listed elements", () => {
    const f = face2(); const ids = f.elements.map((e) => e.id);
    const out = setElementsColor(f, ids, "#ff0000").elements;
    expect(out.every((e) => e.kind === "icon" && e.color === "#ff0000")).toBe(true);
  });
  it("sets opacity on all listed elements", () => {
    const f = face2(); const ids = [f.elements[0].id];
    const out = setElementsOpacity(f, ids, 0.5).elements;
    expect(out[0]).toMatchObject({ opacity: 0.5 });
    expect(out[1].kind === "icon" && out[1].opacity).toBeUndefined();
  });
});

describe("duplicateElements", () => {
  it("clones the listed elements with fresh ids", () => {
    const f = addIconElement(empty, { gridX: 5, gridY: 5, iconName: "a" });
    const { face: out, newIds } = duplicateElements(f, [f.elements[0].id]);
    expect(out.elements).toHaveLength(2);
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).not.toBe(f.elements[0].id);
    expect(out.elements[1]).toMatchObject({ gridX: 5, gridY: 5, iconName: "a" });
  });
});

describe("resolveElementsDrag", () => {
  const bounds = { width: 400, height: 84 };
  it("clamps the shared delta so the whole set's bounding box stays in the body", () => {
    const boxes = [{ gridX: 0, gridY: 10, w: 36, h: 36 }, { gridX: 100, gridY: 10, w: 36, h: 36 }];
    expect(resolveElementsDrag(boxes, 300, 5, bounds)).toEqual({ dx: 264, dy: 5 }); // right box (136) can only reach 400 → +264
    expect(resolveElementsDrag(boxes, -50, 5, bounds)).toEqual({ dx: 0, dy: 5 });    // left box at 0 → can't go left
  });
});

describe("placeElements", () => {
  it("sets absolute positions for the listed elements", () => {
    const f = addIconElement(empty, { gridX: 0, gridY: 0, iconName: "a" });
    const out = placeElements(f, [{ id: f.elements[0].id, gridX: 40, gridY: 20 }]).elements[0];
    expect(out).toMatchObject({ gridX: 40, gridY: 20 });
  });
});

it("addTextElement appends a text element at the drop point", () => {
  const f = addTextElement(emptyFace(), { gridX: 10, gridY: 20 });
  expect(f.elements[0]).toMatchObject({ kind: "text", gridX: 10, gridY: 20, content: "Text", alignment: "center" });
});

it("addShapeElement appends the requested shape", () => {
  const f = addShapeElement(emptyFace(), "ellipse", { gridX: 5, gridY: 5 });
  expect(f.elements[0]).toMatchObject({ kind: "shape", shape: "ellipse", gridX: 5, gridY: 5 });
});

it("addLineElement appends a horizontal line centred on the drop point", () => {
  const f = addLineElement(emptyFace(), { gridX: 50, gridY: 30 });
  const l = f.elements[0] as Extract<typeof f.elements[number], { kind: "line" }>;
  expect(l.kind).toBe("line");
  expect(l.y1).toBe(30); expect(l.y2).toBe(30);
  expect(l.x2 - l.x1).toBeGreaterThan(0);
});

it("updateElements shallow-merges a patch into listed elements of any kind", () => {
  const f0 = addTextElement(emptyFace(), { gridX: 0, gridY: 0 });
  const id = f0.elements[0].id;
  const f1 = updateElements(f0, [id], { content: "Hi", alignment: "left" });
  expect(f1.elements[0]).toMatchObject({ content: "Hi", alignment: "left" });
});

it("translateLine shifts both endpoints", () => {
  const f0 = addLineElement(emptyFace(), { gridX: 50, gridY: 30 });
  const id = f0.elements[0].id;
  const f1 = translateLine(f0, id, 5, -10);
  const l = f1.elements[0] as any;
  expect(l.y1).toBe(20); expect(l.y2).toBe(20);
});

it("moveLineEndpoint moves one end, never collapsing below LINE_MIN_LEN", () => {
  const f0 = addLineElement(emptyFace(), { gridX: 50, gridY: 30 }); // x1<x2, same y
  const id = f0.elements[0].id;
  const l0 = f0.elements[0] as any;
  const f1 = moveLineEndpoint(f0, id, "b", { x: l0.x1 + 2, y: l0.y1 }); // try to collapse b onto a
  const l1 = f1.elements[0] as any;
  expect(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1)).toBeGreaterThanOrEqual(LINE_MIN_LEN - 0.001);
});
