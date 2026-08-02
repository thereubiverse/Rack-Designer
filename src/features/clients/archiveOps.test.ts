import { describe, it, expect } from "vitest";
import { buildArchiveTree } from "./archiveOps";

const AT = "2026-07-27T10:00:00Z";

const liveClient = { id: "c1", code: "URI", name: "Urban Resource Institute" };
const liveSite = { id: "s1", code: "HQ", name: "Headquarters", clientId: "c1" };

describe("buildArchiveTree", () => {
  it("lists an archived client on its own", () => {
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients).toHaveLength(1);
    expect(tree.clients[0].code).toBe("OLD");
  });

  it("nests an archived site under its LIVE client", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" }],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toHaveLength(1);
    expect(tree.sites[0].clientCode).toBe("URI");
    expect(tree.sites[0].clientName).toBe("Urban Resource Institute");
  });

  it("OMITS an archived site whose client is also archived — it returns with its client", () => {
    // Listing it separately would offer a Restore that puts it back somewhere still invisible,
    // which reads as a broken restore.
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c9" }],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients).toHaveLength(1);
    expect(tree.sites).toEqual([]);
  });

  it("nests an archived floor under its live client and site", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s1" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.floors).toHaveLength(1);
    expect(tree.floors[0].clientCode).toBe("URI");
    expect(tree.floors[0].siteCode).toBe("HQ");
    expect(tree.floors[0].siteName).toBe("Headquarters");
  });

  it("OMITS an archived floor whose site is archived", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" }],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s9" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toHaveLength(1);
    expect(tree.floors).toEqual([]);
  });

  it("OMITS an archived floor whose CLIENT is archived, even though its site is live", () => {
    // The site is live but unreachable, because its client is archived. Two levels up still counts.
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s2" }],
      liveClients: [liveClient],
      liveSites: [liveSite, { id: "s2", code: "S2", name: "Site Two", clientId: "c9" }],
    });
    expect(tree.floors).toEqual([]);
  });

  it("drops a row whose ancestor is missing entirely rather than crashing", () => {
    // Defensive: a race between the page's queries could hand us a floor whose site row is gone.
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "nope" }],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "nope" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toEqual([]);
    expect(tree.floors).toEqual([]);
  });

  it("sorts each group by code so the page is stable between loads", () => {
    const tree = buildArchiveTree({
      archivedClients: [
        { id: "c9", code: "ZED", name: "Zed", archivedAt: AT },
        { id: "c8", code: "ACME", name: "Acme", archivedAt: AT },
      ],
      archivedSites: [],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients.map((c) => c.code)).toEqual(["ACME", "ZED"]);
  });
});
