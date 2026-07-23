import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanBottomSheet } from "./PlanBottomSheet";

const tabs = [
  { id: "a", label: "Alpha", content: <div>alpha-content</div> },
  { id: "b", label: "Beta", content: <div>beta-content</div> },
];

describe("PlanBottomSheet", () => {
  it("mounts every tab's content but visually hides the inactive one", () => {
    render(<PlanBottomSheet tabs={tabs} />);
    // Both are in the DOM (off-tab content must stay queryable), first tab active.
    expect(screen.getByText("alpha-content").parentElement).not.toHaveClass("hidden");
    expect(screen.getByText("beta-content").parentElement).toHaveClass("hidden");
  });

  it("switches which tab is shown on tab click", () => {
    render(<PlanBottomSheet tabs={tabs} />);
    fireEvent.click(screen.getByTestId("sheet-tab-b"));
    expect(screen.getByText("beta-content").parentElement).not.toHaveClass("hidden");
    expect(screen.getByText("alpha-content").parentElement).toHaveClass("hidden");
  });

  it("starts collapsed and expands when the handle is tapped (down + up, no travel)", () => {
    render(<PlanBottomSheet tabs={tabs} />);
    const sheet = screen.getByTestId("plan-sheet");
    expect(sheet).toHaveStyle({ height: "64px" });

    const handle = screen.getByTestId("plan-sheet-handle");
    // A tap: pointer-up bubbles to the window listener with no intervening move → toggle open.
    fireEvent.pointerDown(handle, { clientY: 500 });
    fireEvent.pointerUp(handle, { clientY: 500 });

    expect(sheet).toHaveStyle({ height: "320px" });
  });

  it("expands when a tab is clicked while collapsed", () => {
    render(<PlanBottomSheet tabs={tabs} />);
    const sheet = screen.getByTestId("plan-sheet");
    expect(sheet).toHaveStyle({ height: "64px" });
    fireEvent.click(screen.getByTestId("sheet-tab-b"));
    expect(sheet).toHaveStyle({ height: "320px" });
  });
});
