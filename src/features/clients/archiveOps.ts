/** Shaping for the archive page: which archived rows to show, and what to nest them under.
 *
 *  PURE — no database, no React. The one rule with any subtlety is that a row is listed only when
 *  every ancestor above it is live, and that rule is easier to trust with tests than with a join. */

export interface ArchivedClient {
  id: string;
  code: string;
  name: string;
  archivedAt: string;
}

export interface ArchivedSite {
  id: string;
  code: string;
  name: string;
  archivedAt: string;
  clientId: string;
}

export interface ArchivedFloor {
  id: string;
  code: string;
  name: string | null;
  archivedAt: string;
  siteId: string;
}

export interface ArchiveTree {
  clients: ArchivedClient[];
  sites: { site: ArchivedSite; clientCode: string; clientName: string }[];
  floors: { floor: ArchivedFloor; clientCode: string; siteCode: string; siteName: string }[];
}

const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code);

/**
 * Group archived rows under their live ancestors.
 *
 * A row appears ONLY if every ancestor above it is live. An archived site under an archived client
 * is omitted, and so is an archived floor under either an archived site or an archived client —
 * restoring one alone would put it back somewhere still invisible, which reads as a broken restore.
 * Those rows come back with their ancestor instead.
 *
 * `liveClients` and `liveSites` are the UNARCHIVED rows; a row whose ancestor appears in neither the
 * live nor the archived list is dropped rather than thrown on, so a race between the page's queries
 * degrades to a missing line instead of a crash.
 */
export function buildArchiveTree(input: {
  archivedClients: ArchivedClient[];
  archivedSites: ArchivedSite[];
  archivedFloors: ArchivedFloor[];
  liveClients: { id: string; code: string; name: string }[];
  liveSites: { id: string; code: string; name: string; clientId: string }[];
}): ArchiveTree {
  const liveClientById = new Map(input.liveClients.map((c) => [c.id, c]));
  const liveSiteById = new Map(input.liveSites.map((s) => [s.id, s]));

  const sites = input.archivedSites
    .map((site) => {
      const client = liveClientById.get(site.clientId);
      return client ? { site, clientCode: client.code, clientName: client.name } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => byCode(a.site, b.site));

  const floors = input.archivedFloors
    .map((floor) => {
      const site = liveSiteById.get(floor.siteId);
      if (!site) return null;
      // Two levels up still counts: a live site under an archived client is itself unreachable.
      const client = liveClientById.get(site.clientId);
      if (!client) return null;
      return { floor, clientCode: client.code, siteCode: site.code, siteName: site.name };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => byCode(a.floor, b.floor));

  return { clients: [...input.archivedClients].sort(byCode), sites, floors };
}
