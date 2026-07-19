import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ClientsTable } from "./ClientsTable";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  createClientAction: vi.fn(async () => ({ ok: true })),
  renameClientAction: vi.fn(async () => ({ ok: true })),
  deleteClientAction: vi.fn(async () => ({ ok: true })),
}));

const clients = [
  { id: "c1", code: "ACME", name: "Acme Corp", siteCount: 3, rackCount: 12 },
];

describe("ClientsTable", () => {
  it("renders a linked row per client with site and rack counts", () => {
    render(<ClientsTable clients={clients} />);
    const row = screen.getByTestId("client-row-ACME");
    const link = within(row).getByRole("link", { name: /Acme Corp/ });
    expect(link).toHaveAttribute("href", "/clients/ACME");
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent("12");
  });

  it("shows an empty state that still offers the create control", () => {
    render(<ClientsTable clients={[]} />);
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
    expect(screen.getByTestId("table-create")).toBeInTheDocument();
  });
});
