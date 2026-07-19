import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SiteDetail } from "./SiteDetail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/locations/actions", () => ({
  createRackInSiteAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./actions", () => ({
  deleteRackAction: vi.fn(async () => ({ ok: true })),
}));

const client = { id: "c1", code: "ACME", name: "Acme Corp", created_at: "2026-01-01" };
const site = { id: "s1", client_id: "c1", code: "HQ", name: "Headquarters", address: null, created_at: "2026-01-01" };

const racks = [
  { id: "r1", code: "RK01", heightU: 20, floorCode: "GF", roomCode: "MDF", roomType: "MDF" as const, deviceCount: 3 },
  { id: "r2", code: "RK02", heightU: 42, floorCode: "GF", roomCode: "MDF", roomType: "MDF" as const, deviceCount: 0 },
  { id: "r3", code: "RK03", heightU: 12, floorCode: "L1", roomCode: "IDF", roomType: "IDF" as const, deviceCount: 1 },
];

describe("SiteDetail", () => {
  it("groups racks by floor and room, preserving first-seen order", () => {
    render(<SiteDetail client={client} site={site} racks={racks} />);
    expect(screen.getByTestId("rack-group-GF-MDF")).toHaveTextContent("GF · MDF");
    expect(screen.getByTestId("rack-group-L1-IDF")).toHaveTextContent("L1 · IDF");

    const gfGroup = screen.getByTestId("rack-group-GF-MDF").closest("section")!;
    expect(within(gfGroup).getByText("RK01")).toBeInTheDocument();
    expect(within(gfGroup).getByText("RK02")).toBeInTheDocument();
    expect(within(gfGroup).queryByText("RK03")).toBeNull();
  });

  it("links each rack to its /racks/<id> permalink, not a nested URL", () => {
    render(<SiteDetail client={client} site={site} racks={racks} />);
    const link = screen.getByRole("link", { name: /RK01/ });
    expect(link).toHaveAttribute("href", "/racks/r1");
  });

  it("shows an empty state", () => {
    render(<SiteDetail client={client} site={site} racks={[]} />);
    expect(screen.getByText("No racks yet")).toBeInTheDocument();
  });
});
