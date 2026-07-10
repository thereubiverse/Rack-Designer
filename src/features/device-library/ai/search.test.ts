import { describe, it, expect } from "vitest";
import { parseDeviceMatch, type SearchHit } from "./search";

const hit = (over: Partial<SearchHit>): SearchHit => ({ title: "", description: "", imageUrl: "http://img/x.png", source: "duckduckgo", ...over });

describe("parseDeviceMatch", () => {
  it("reads a known brand from the title", () => {
    const m = parseDeviceMatch(hit({ title: "Cisco Catalyst 9200 24-Port Switch" }), "C9200-24T");
    expect(m.brand).toBe("Cisco");
    expect(m.name).toContain("Catalyst 9200");
    expect(m.imageUrl).toBe("http://img/x.png");
  });

  it("derives rackUnits from a '1U' mention", () => {
    const m = parseDeviceMatch(hit({ description: "This switch is a 1U rack-mountable unit." }), "X");
    expect(m.rackUnits).toBe(1);
  });

  it("derives rackUnits from a '2RU' mention", () => {
    const m = parseDeviceMatch(hit({ description: "2RU chassis" }), "X");
    expect(m.rackUnits).toBe(2);
  });

  it("defaults width to full-width and rackUnits to 1 when unknown", () => {
    const m = parseDeviceMatch(hit({ title: "Mystery Box", description: "no size here" }), "MB-1");
    expect(m.widthIn).toBe(17.5);
    expect(m.rackUnits).toBe(1);
    expect(m.name).toBe("Mystery Box"); // prefers title when non-empty
  });

  it("falls back to model name when title is empty", () => {
    const m = parseDeviceMatch(hit({ title: "", description: "no size here" }), "MB-1");
    expect(m.name).toBe("MB-1");
  });
});
