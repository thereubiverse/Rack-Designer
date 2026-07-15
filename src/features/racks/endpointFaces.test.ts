import { describe, it, expect } from "vitest";
import { faceForDescribed, ENDPOINT_GROUP_ID } from "./endpointFaces";

describe("endpointFaces", () => {
  it("gives a single-port face to a non-outlet type regardless of portCount", () => {
    const f = faceForDescribed({ typeCode: "CAM", portCount: 4, landingPortIndex: 0, landingPortLabel: "" });
    expect(f.portGroups).toHaveLength(1);
    expect(f.portGroups[0].cols).toBe(1);
    expect(f.portGroups[0].rows).toBe(1);
  });

  it("gives an outlet the port count it was asked for", () => {
    for (const n of [1, 2, 3, 4, 6]) {
      const f = faceForDescribed({ typeCode: "TO", portCount: n, landingPortIndex: 0, landingPortLabel: "" });
      expect(f.portGroups[0].cols).toBe(n);
    }
  });

  it("labels the landing port with the endpoint label", () => {
    const f = faceForDescribed({ typeCode: "TO", portCount: 4, landingPortIndex: 2, landingPortLabel: "Desk A" });
    expect(f.portGroups[0].portOverrides[2]).toEqual({ name: "Desk A" });
  });

  it("leaves ports unlabelled when no endpoint label is set", () => {
    const f = faceForDescribed({ typeCode: "TO", portCount: 4, landingPortIndex: 2, landingPortLabel: "" });
    expect(f.portGroups[0].portOverrides).toEqual({});
  });

  it("uses a stable group id so highlights can target it", () => {
    const f = faceForDescribed({ typeCode: "CAM", portCount: 1, landingPortIndex: 0, landingPortLabel: "" });
    expect(f.portGroups[0].id).toBe(ENDPOINT_GROUP_ID);
  });

  it("has no free-floating elements", () => {
    expect(faceForDescribed({ typeCode: "CAM", portCount: 1, landingPortIndex: 0, landingPortLabel: "" }).elements).toEqual([]);
  });
});
