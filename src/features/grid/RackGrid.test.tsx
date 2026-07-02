import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackGrid } from "./RackGrid";
import type { RackWithPath } from "@/features/locations/repository";

const racks: RackWithPath[] = [
  { id: "1", label: "HQ/28/SL/RK001_M", siteCode: "HQ", floorCode: "28", roomCode: "SL", roomType: "MDF", rackCode: "RK001_M", heightU: 42 },
  { id: "2", label: "HQ/29/IDF1/RK002", siteCode: "HQ", floorCode: "29", roomCode: "IDF1", roomType: "IDF", rackCode: "RK002", heightU: 24 },
];

describe("RackGrid", () => {
  it("renders one row per rack with its derived label", () => {
    render(<RackGrid racks={racks} />);
    expect(screen.getByText("HQ/28/SL/RK001_M")).toBeInTheDocument();
    expect(screen.getByText("HQ/29/IDF1/RK002")).toBeInTheDocument();
  });

  it("filters rows by the search box", async () => {
    render(<RackGrid racks={racks} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "IDF1");
    expect(screen.queryByText("HQ/28/SL/RK001_M")).not.toBeInTheDocument();
    expect(screen.getByText("HQ/29/IDF1/RK002")).toBeInTheDocument();
  });

  it("sorts by height when the height header is clicked", async () => {
    render(<RackGrid racks={racks} />);
    await userEvent.click(screen.getByRole("button", { name: /height/i }));
    const rows = screen.getAllByRole("row").slice(1); // drop header row
    expect(within(rows[0]).getByText("24")).toBeInTheDocument();
  });
});
