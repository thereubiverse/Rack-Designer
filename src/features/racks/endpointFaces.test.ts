import { describe, it, expect } from "vitest";
import { faceForDescribed, ENDPOINT_GROUP_ID } from "./endpointFaces";

// The data outlet is no longer built here — it is a wall plate, drawn by outletFaceplate.tsx.
// This module now only builds the single-port devices (camera, access point, ACP, …).
describe("endpointFaces", () => {
  it("gives a described device a single-port face", () => {
    const f = faceForDescribed({ landingPortLabel: "" });
    expect(f.portGroups).toHaveLength(1);
    expect(f.portGroups[0].cols).toBe(1);
    expect(f.portGroups[0].rows).toBe(1);
  });

  it("labels the port with the endpoint label", () => {
    const f = faceForDescribed({ landingPortLabel: "Lobby" });
    expect(f.portGroups[0].portOverrides[0]).toEqual({ name: "Lobby" });
  });

  it("leaves the port unlabelled when no endpoint label is set", () => {
    expect(faceForDescribed({ landingPortLabel: "" }).portGroups[0].portOverrides).toEqual({});
  });

  it("uses a stable group id so highlights can target it", () => {
    expect(faceForDescribed({ landingPortLabel: "" }).portGroups[0].id).toBe(ENDPOINT_GROUP_ID);
  });

  it("has no free-floating elements", () => {
    expect(faceForDescribed({ landingPortLabel: "" }).elements).toEqual([]);
  });
});
