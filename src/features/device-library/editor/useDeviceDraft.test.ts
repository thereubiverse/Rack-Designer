import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeviceDraft, emptyDraft } from "./useDeviceDraft";
import { emptyFace, type Face } from "@/domain/faceplate";

const oneGroupFace: Face = {
  portGroups: [{
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {},
  }],
  elements: [],
};

describe("useDeviceDraft", () => {
  it("starts empty and invalid (no name, no type)", () => {
    const { result } = renderHook(() => useDeviceDraft());
    expect(result.current.draft.name).toBe("");
    expect(result.current.draft.activeSide).toBe("front");
    expect(result.current.isValid).toBe(false);
    expect(result.current.errors.name).toBeTruthy();
    expect(result.current.errors.deviceTypeId).toBeTruthy();
  });

  it("becomes valid once name, type, width and rack units are set", () => {
    const { result } = renderHook(() => useDeviceDraft());
    act(() => { result.current.setField("name", "Switch"); });
    act(() => { result.current.setField("deviceTypeId", "t1"); });
    expect(result.current.isValid).toBe(true);
    expect(result.current.errors).toEqual({});
  });

  it("flags invalid width and rack units", () => {
    const { result } = renderHook(() => useDeviceDraft({ name: "X", deviceTypeId: "t1" }));
    act(() => { result.current.setField("widthIn", 0); });
    act(() => { result.current.setField("rackUnits", 0); });
    expect(result.current.errors.widthIn).toBeTruthy();
    expect(result.current.errors.rackUnits).toBeTruthy();
    expect(result.current.isValid).toBe(false);
  });

  it("activeFace follows activeSide", () => {
    const { result } = renderHook(() =>
      useDeviceDraft({ frontFace: oneGroupFace, backFace: emptyFace() }),
    );
    expect(result.current.activeFace).toEqual(oneGroupFace);
    act(() => { result.current.setActiveSide("back"); });
    expect(result.current.activeFace).toEqual(emptyFace());
  });

  it("setActiveFace writes to the active side only", () => {
    const { result } = renderHook(() => useDeviceDraft());
    act(() => { result.current.setActiveFace(oneGroupFace); });
    expect(result.current.draft.frontFace).toEqual(oneGroupFace);
    expect(result.current.draft.backFace).toEqual(emptyFace());
    act(() => { result.current.setActiveSide("back"); });
    act(() => { result.current.setActiveFace(oneGroupFace); });
    expect(result.current.draft.backFace).toEqual(oneGroupFace);
  });
});

describe("emptyDraft defaults (3e)", () => {
  it("defaults the body width to 17.5in so a new device shows ears", () => {
    expect(emptyDraft().widthIn).toBe(17.5);
  });
});
