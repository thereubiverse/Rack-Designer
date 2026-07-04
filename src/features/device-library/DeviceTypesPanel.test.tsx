import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceTypesPanel } from "./DeviceTypesPanel";
import type { DeviceTypeRow } from "./repository";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const types: DeviceTypeRow[] = [
  { id: "1", organization_id: "o", name: "Switch", created_at: "" },
  { id: "2", organization_id: "o", name: "Router", created_at: "" },
];

describe("DeviceTypesPanel", () => {
  it("renders each device type and an add input", () => {
    render(<DeviceTypesPanel types={types} />);
    expect(screen.getByText("Switch")).toBeInTheDocument();
    expect(screen.getByText("Router")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/new device type/i)).toBeInTheDocument();
  });
});
