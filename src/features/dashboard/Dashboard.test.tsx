import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { ClientSummary } from "@/features/clients/repository";

const client = (over: Partial<ClientSummary> = {}): ClientSummary => ({
  id: "c1",
  code: "URI",
  name: "Urban Resource Institute",
  siteCount: 31,
  rackCount: 4,
  deviceCount: 128,
  ...over,
});

describe("Dashboard", () => {
  it("shows a card per client with all three counts", () => {
    render(<Dashboard clients={[client()]} />);
    const card = screen.getByTestId("dashboard-client-URI");
    expect(within(card).getByText("Urban Resource Institute")).toBeInTheDocument();
    expect(within(card).getByText("URI")).toBeInTheDocument();
    expect(within(card).getByText("31")).toBeInTheDocument();
    expect(within(card).getByText("4")).toBeInTheDocument();
    expect(within(card).getByText("128")).toBeInTheDocument();
    // Each number is labelled, or three bare figures mean nothing.
    for (const label of ["Sites", "Racks", "Devices"]) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
  });

  it("links the WHOLE card to that client, with the code URL-encoded", () => {
    render(<Dashboard clients={[client({ code: "A B&C" })]} />);
    const card = screen.getByTestId("dashboard-client-A B&C");
    expect(card.tagName.toLowerCase()).toBe("a");
    expect(card).toHaveAttribute("href", "/clients/A%20B%26C");
  });

  it("renders one card per client", () => {
    render(
      <Dashboard
        clients={[
          client(),
          client({ id: "c2", code: "UP", name: "Urban Pathways", siteCount: 0, rackCount: 0, deviceCount: 0 }),
        ]}
      />
    );
    expect(screen.getByTestId("dashboard-client-URI")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-client-UP")).toBeInTheDocument();
  });

  it("shows a ZERO rather than hiding the stat — an empty client is a real state", () => {
    render(<Dashboard clients={[client({ siteCount: 0, rackCount: 0, deviceCount: 0 })]} />);
    const card = screen.getByTestId("dashboard-client-URI");
    expect(within(card).getAllByText("0")).toHaveLength(3);
  });

  // `deviceCount` already covers rack AND floor-plan devices — the repository sums them, so there
  // is nothing for this component to add up. countSiteCascade/countClientCascade own that.
  it("totals every client across the top", () => {
    render(
      <Dashboard
        clients={[
          client({ siteCount: 31, rackCount: 4, deviceCount: 128 }),
          client({ id: "c2", code: "UP", siteCount: 2, rackCount: 1, deviceCount: 7 }),
        ]}
      />
    );
    const totals = screen.getByTestId("dashboard-totals").textContent ?? "";
    expect(totals).toContain("2 clients");
    expect(totals).toContain("33 sites");
    expect(totals).toContain("5 racks");
    expect(totals).toContain("135 devices");
  });

  it("says 1 client, not 1 clients", () => {
    render(<Dashboard clients={[client()]} />);
    expect(screen.getByTestId("dashboard-totals").textContent).toContain("1 client ");
  });

  it("offers a way forward when there are no clients at all", () => {
    render(<Dashboard clients={[]} />);
    expect(screen.getByTestId("dashboard-empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Clients" })).toHaveAttribute("href", "/clients");
    // No empty totals line hanging above an empty state.
    expect(screen.queryByTestId("dashboard-totals")).toBeNull();
    expect(screen.queryByTestId("dashboard-grid")).toBeNull();
  });
});
