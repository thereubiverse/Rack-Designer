import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ClientDetail } from "./ClientDetail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  createSiteAction: vi.fn(async () => ({ ok: true })),
  renameSiteAction: vi.fn(async () => ({ ok: true })),
  deleteSiteAction: vi.fn(async () => ({ ok: true })),
}));

const client = { id: "c1", code: "ACME", name: "Acme Corp", created_at: "2026-01-01" };
const sites = [
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
});
