import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { UnlocatedSites } from "./UnlocatedSites";
import { VAGUE_ADDRESS_HINT } from "./geocodeOps";
import type { SiteSummary } from "./repository";
import { locateSiteAction } from "./actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  locateSiteAction: vi.fn(async () => ({ ok: true })),
}));

function site(overrides: Partial<SiteSummary>): SiteSummary {
  return {
    id: "id-default",
    code: "CODE",
    name: "Default Site",
    address: "1 Main St, Springfield, USA",
    latitude: null,
    longitude: null,
    geocodeStatus: "pending",
    rackCount: 0,
    deviceCount: 0,
    ...overrides,
  };
}

describe("UnlocatedSites", () => {
  it("never shows a site whose geocodeStatus is ok", () => {
    render(<UnlocatedSites sites={[site({ id: "s1", code: "OK1", geocodeStatus: "ok" })]} />);
    expect(screen.queryByText("OK1")).toBeNull();
  });

  it("renders nothing at all when every site is ok", () => {
    const { container } = render(
      <UnlocatedSites sites={[site({ id: "s1", code: "OK1", geocodeStatus: "ok" })]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing at all when the site list is empty", () => {
    const { container } = render(<UnlocatedSites sites={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders VAGUE_ADDRESS_HINT for a not_found site", () => {
    render(
      <UnlocatedSites
        sites={[site({ id: "s1", code: "NF1", geocodeStatus: "not_found" })]}
      />
    );
    expect(screen.getByText(VAGUE_ADDRESS_HINT)).toBeInTheDocument();
  });

  it("reads a pending site as not yet located", () => {
    render(
      <UnlocatedSites sites={[site({ id: "s1", code: "PEND1", geocodeStatus: "pending" })]} />
    );
    expect(screen.getByText(/not yet located/i)).toBeInTheDocument();
  });

  it("offers a retry for a failed site", () => {
    render(
      <UnlocatedSites sites={[site({ id: "s1", code: "FAIL1", geocodeStatus: "failed" })]} />
    );
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
    expect(screen.getByTestId("locate-FAIL1")).toBeInTheDocument();
  });

  it("calls locateSiteAction with that site's id when Locate is clicked", async () => {
    render(
      <UnlocatedSites
        sites={[site({ id: "site-abc", code: "RETRY1", geocodeStatus: "failed" })]}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("locate-RETRY1"));
    });

    expect(locateSiteAction).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(locateSiteAction).mock.calls[0][0] as FormData;
    expect(formData.get("siteId")).toBe("site-abc");
  });

  it("gives each site its own Locate button keyed by code", () => {
    render(
      <UnlocatedSites
        sites={[
          site({ id: "s1", code: "A", geocodeStatus: "pending" }),
          site({ id: "s2", code: "B", geocodeStatus: "failed" }),
        ]}
      />
    );
    expect(screen.getByTestId("locate-A")).toBeInTheDocument();
    expect(screen.getByTestId("locate-B")).toBeInTheDocument();
  });

  it("states the count in the heading, singular for one site", () => {
    render(
      <UnlocatedSites sites={[site({ id: "s1", code: "ONE", geocodeStatus: "pending" })]} />
    );
    expect(screen.getByText("1 site isn't on the map yet")).toBeInTheDocument();
  });

  it("states the count in the heading, plural for more than one site", () => {
    render(
      <UnlocatedSites
        sites={[
          site({ id: "s1", code: "A", geocodeStatus: "pending" }),
          site({ id: "s2", code: "B", geocodeStatus: "failed" }),
        ]}
      />
    );
    expect(screen.getByText("2 sites aren't on the map yet")).toBeInTheDocument();
  });

  it("mixes ok sites in with unlocated ones and only lists the unlocated", () => {
    render(
      <UnlocatedSites
        sites={[
          site({ id: "s1", code: "LOCATED", geocodeStatus: "ok" }),
          site({ id: "s2", code: "MISSING", geocodeStatus: "not_found" }),
        ]}
      />
    );
    expect(screen.getByText("1 site isn't on the map yet")).toBeInTheDocument();
    expect(screen.getByTestId("locate-MISSING")).toBeInTheDocument();
    expect(screen.queryByTestId("locate-LOCATED")).toBeNull();
  });

  it("shows name and code for each unlocated site row", () => {
    render(
      <UnlocatedSites
        sites={[site({ id: "s1", code: "BR1", name: "Branch One", geocodeStatus: "pending" })]}
      />
    );
    const row = screen.getByTestId("unlocated-site-BR1");
    expect(within(row).getByText(/Branch One/)).toBeInTheDocument();
    expect(within(row).getByText(/BR1/)).toBeInTheDocument();
  });
});
