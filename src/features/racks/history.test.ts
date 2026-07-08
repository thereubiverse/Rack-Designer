import { describe, it, expect } from "vitest";
import { createHistory, push, undo, redo, canUndo, canRedo } from "./history";

describe("history", () => {
  it("pushes states and walks back/forward", () => {
    let h = createHistory(0);
    h = push(h, 1); h = push(h, 2);
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(2);
  });
  it("push after undo truncates the future (branching)", () => {
    let h = push(push(createHistory(0), 1), 2);
    h = undo(h);          // present 1, future [2]
    h = push(h, 9);       // future discarded
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(9);
    expect(undo(h).present).toBe(1);
  });
  it("undo/redo at the boundaries are no-ops", () => {
    const h = createHistory("x");
    expect(undo(h)).toEqual(h);
    expect(redo(h)).toEqual(h);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});
