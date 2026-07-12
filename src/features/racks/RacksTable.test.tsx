import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RacksTable } from "./RacksTable";

const racks = [
  { id: "r1", label: "HQ/28/SL/RK001", siteCode: "HQ", floorCode: "28", roomCode: "SL", roomType: "other" as const, rackCode: "RK001", heightU: 42, deviceCount: 3 },
];

describe("RacksTable", () => {
  it("renders a linked row per rack with path, height, and device count", () => {
    render(<RacksTable racks={racks} />);
    const link = screen.getByRole("link", { name: /RK001/ });
    expect(link).toHaveAttribute("href", "/racks/r1");
    expect(screen.getByText("HQ/28/SL/RK001")).toBeInTheDocument();
    expect(screen.getByText("42 U")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
  it("shows an empty state", () => {
    render(<RacksTable racks={[]} />);
    expect(screen.getByText(/no racks yet/i)).toBeInTheDocument();
  });
});
