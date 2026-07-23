import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { FloorTabs } from "./FloorTabs";
import type { FloorRow } from "@/lib/supabase/types";

function floor(overrides: Partial<FloorRow>): FloorRow {
  return {
    id: "id-default",
    site_id: "site-1",
    code: "CODE",
    name: null,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FloorTabs", () => {
  it("renders one tab per floor in the given order, not re-sorted by code", () => {
    // Prop order is [GF, 2F], but alphabetically "2F" < "GF" (digits sort before letters in JS
    // string comparison). If the component secretly sorted by code, tabs would flip to [2F, GF].
    // This test ensures the component preserves prop order and does not re-sort.
    const floors = [
      floor({ id: "f1", code: "GF", sort_order: 0 }),
      floor({ id: "f2", code: "2F", sort_order: 1 }),
    ];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={vi.fn()} onAdd={vi.fn()} />);
    const tabs = screen.getAllByTestId(/^floor-tab-/);
    expect(tabs.map((t) => t.getAttribute("data-testid"))).toEqual([
      "floor-tab-GF",
      "floor-tab-2F",
    ]);
  });

  it('marks the tab matching activeCode with aria-current="page"', () => {
    const floors = [
      floor({ id: "f1", code: "1F" }),
      floor({ id: "f2", code: "GF" }),
    ];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.getByTestId("floor-tab-GF")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("floor-tab-1F")).not.toHaveAttribute("aria-current");
  });

  it("calls onSelect with the clicked non-active floor's code (third of 3+)", () => {
    const onSelect = vi.fn();
    const floors = [
      floor({ id: "f1", code: "GF" }),
      floor({ id: "f2", code: "1F" }),
      floor({ id: "f3", code: "2F" }),
    ];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={onSelect} onAdd={vi.fn()} />);
    fireEvent.click(screen.getByTestId("floor-tab-2F"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("2F");
  });

  it("calls onAdd when the add-floor button is clicked", () => {
    const onAdd = vi.fn();
    const floors = [floor({ id: "f1", code: "GF" })];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={vi.fn()} onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId("add-floor"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("shows code plus name when name is non-null", () => {
    const floors = [floor({ id: "f1", code: "GF", name: "Ground" })];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={vi.fn()} onAdd={vi.fn()} />);
    const tab = screen.getByTestId("floor-tab-GF");
    expect(within(tab).getByText("GF — Ground")).toBeInTheDocument();
  });

  it("shows code alone when name is null", () => {
    const floors = [floor({ id: "f1", code: "GF", name: null })];
    render(<FloorTabs floors={floors} activeCode="GF" onSelect={vi.fn()} onAdd={vi.fn()} />);
    const tab = screen.getByTestId("floor-tab-GF");
    expect(within(tab).getByText("GF")).toBeInTheDocument();
    expect(within(tab).queryByText(/—/)).toBeNull();
  });
});
