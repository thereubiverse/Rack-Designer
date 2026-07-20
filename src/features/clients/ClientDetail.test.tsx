import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { ClientDetail } from "./ClientDetail";
import type { SiteSummary } from "./repository";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  createSiteAction: vi.fn(async () => ({ ok: true })),
  renameSiteAction: vi.fn(async () => ({ ok: true })),
  deleteSiteAction: vi.fn(async () => ({ ok: true })),
  locateSiteAction: vi.fn(async () => ({ ok: true })),
}));

// `next/dynamic` resolves its loader asynchronously (a promise), which would make presence/
// absence of the map race the test if left as-is. Mocking next/dynamic itself hands back the
// mocked SitesMap component directly and synchronously, regardless of the promise-returning
// loader ClientDetail.tsx passes in (`() => import("./SitesMap").then((m) => m.SitesMap)`). That
// removes the async resolution entirely: whether <SitesMap> appears now depends solely on
// ClientDetail's `blips.length > 0 &&` gate, never on module-cache timing or test order.
const { MockSitesMap } = vi.hoisted(() => {
  function MockSitesMap({
    blips,
    selectedId,
    onSelect,
  }: {
    blips: { id: string; code: string }[];
    selectedId?: string | null;
    onSelect: (id: string) => void;
  }) {
    return (
      <div data-testid="sites-map">
        {blips.map((b) => (
          <button key={b.id} data-testid={`blip-${b.code}`} onClick={() => onSelect(b.id)}>
            {b.code}
            {selectedId === b.id ? " (selected)" : ""}
          </button>
        ))}
      </div>
    );
  }
  return { MockSitesMap };
});

// The mock ignores the loader argument entirely (rather than trying to resolve or await it), so
// it copes with the promise-returning loader by simply never depending on its resolution.
vi.mock("next/dynamic", () => ({
  default: (_loader: () => Promise<unknown>) => MockSitesMap,
}));

// Kept in case anything ever imports ./SitesMap directly (bypassing next/dynamic) — still the
// same fake component, so no Leaflet code can run in jsdom either way.
vi.mock("./SitesMap", () => ({ SitesMap: MockSitesMap }));

const client = { id: "c1", code: "ACME", name: "Acme Corp", created_at: "2026-01-01" };
const sites: SiteSummary[] = [
  {
    id: "s1",
    code: "HQ",
    name: "Headquarters",
    address: "123 Main St",
    latitude: null,
    longitude: null,
    geocodeStatus: "pending" as const,
    rackCount: 5,
    deviceCount: 30,
  },
];

describe("ClientDetail", () => {
  it("renders a linked row per site with rack count and address", () => {
    render(<ClientDetail client={client} sites={sites} />);
    const row = screen.getByTestId("site-row-HQ");
    const link = within(row).getByRole("link", { name: /Headquarters/ });
    expect(link).toHaveAttribute("href", "/clients/ACME/HQ");
    expect(row).toHaveTextContent("5");
    expect(row).toHaveTextContent("123 Main St");
  });

  it("shows a breadcrumb with the client name", () => {
    render(<ClientDetail client={client} sites={sites} />);
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    render(<ClientDetail client={client} sites={[]} />);
    expect(screen.getByText("No sites yet")).toBeInTheDocument();
  });

  it("renders no map frame with zero geocoded sites, but does render the unlocated list", () => {
    render(<ClientDetail client={client} sites={sites} />);
    // `sites` is all-pending: toBlips() yields zero blips, so <SitesMap> is never mounted at all
    // (not merely hidden). This assertion is safe to make synchronously only because next/dynamic
    // itself is mocked above to resolve synchronously — with the real (async) next/dynamic this
    // negative assertion would false-pass on a cold module cache regardless of the component's
    // gate, since the dynamic import simply wouldn't have resolved yet.
    expect(screen.queryByTestId("sites-map")).not.toBeInTheDocument();
    expect(screen.getByText("1 site isn't on the map yet")).toBeInTheDocument();
  });

  const okSite: SiteSummary = {
    id: "s2",
    code: "DC1",
    name: "Data Center 1",
    address: "1 Data Way",
    latitude: 40.0,
    longitude: -74.0,
    geocodeStatus: "ok",
    rackCount: 3,
    deviceCount: 12,
  };
  const mixedSites: SiteSummary[] = [sites[0], okSite];

  it("renders both the map and the unlocated list with a mix of ok and non-ok sites", async () => {
    render(<ClientDetail client={client} sites={mixedSites} />);
    // next/dynamic is mocked to resolve synchronously (see above), but findBy* is kept here since
    // it's a harmless, non-throwing way to assert presence either way.
    expect(await screen.findByTestId("sites-map")).toBeInTheDocument();
    expect(screen.getByTestId("blip-DC1")).toBeInTheDocument();
    expect(screen.getByText("1 site isn't on the map yet")).toBeInTheDocument();
    expect(screen.getByTestId("unlocated-site-HQ")).toBeInTheDocument();
  });

  it("wires selection both ways between the table and the map", async () => {
    render(<ClientDetail client={client} sites={mixedSites} />);
    const blip = await screen.findByTestId("blip-DC1");

    // Selecting a row highlights its blip.
    fireEvent.click(screen.getByTestId("site-row-DC1"));
    expect(blip).toHaveTextContent("(selected)");
    expect(screen.getByTestId("site-row-DC1").className).toContain("bg-blue-50");

    // Selecting a blip highlights its row.
    fireEvent.click(screen.getByTestId("site-row-HQ"));
    expect(blip).not.toHaveTextContent("(selected)");
    fireEvent.click(blip);
    expect(blip).toHaveTextContent("(selected)");
    expect(screen.getByTestId("site-row-DC1").className).toContain("bg-blue-50");
  });

  it("does not select the row when clicking Rename", async () => {
    render(<ClientDetail client={client} sites={mixedSites} />);
    await screen.findByTestId("sites-map");

    fireEvent.click(screen.getByTestId("edit-site-DC1"));
    expect(screen.getByTestId("site-row-DC1").className).not.toContain("bg-blue-50");
    // Rename dialog opened instead of selecting the row.
    expect(screen.getByRole("dialog", { name: "Rename site" })).toBeInTheDocument();
  });

  it("does not select the row when clicking Delete", async () => {
    render(<ClientDetail client={client} sites={mixedSites} />);
    await screen.findByTestId("sites-map");

    fireEvent.click(screen.getByTestId("delete-site-DC1"));
    expect(screen.getByTestId("site-row-DC1").className).not.toContain("bg-blue-50");
    // Delete dialog opened instead of selecting the row.
    expect(screen.getByRole("dialog", { name: "Delete site" })).toBeInTheDocument();
  });
});
