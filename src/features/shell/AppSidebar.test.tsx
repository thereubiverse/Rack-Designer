import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppSidebar } from "./AppSidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

// The real action signs out and redirects; the menu only needs to render its submit button.
vi.mock("@/features/auth/authActions", () => ({ signOutAction: vi.fn() }));

function renderSidebar(props?: { collapsed?: boolean; memberName?: string | null; memberEmail?: string | null }) {
  return render(
    <AppSidebar
      collapsed={props?.collapsed ?? false}
      memberName={props?.memberName === undefined ? "Reuben Singh" : props.memberName}
      memberEmail={props?.memberEmail === undefined ? "rsingh@qtsi.us" : props.memberEmail}
    />
  );
}

describe("AppSidebar account menu", () => {
  it("stays closed until the name card is clicked", () => {
    renderSidebar();
    expect(screen.queryByTestId("account-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("account-trigger"));
    expect(screen.getByTestId("account-menu")).toBeTruthy();
  });

  it("offers account, profile and log out", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    const menu = screen.getByTestId("account-menu");
    for (const label of ["Account", "Profile", "Log out"]) {
      expect(menu.textContent).toContain(label);
    }
  });

  it("names the signed-in account, so two members sharing a display name are told apart", () => {
    renderSidebar({ memberName: "Reuben Singh", memberEmail: "rsingh@qtsi.us" });
    fireEvent.click(screen.getByTestId("account-trigger"));
    expect(screen.getByTestId("account-menu").textContent).toContain("rsingh@qtsi.us");
  });

  it("closes when the pointer goes down outside it", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    expect(screen.getByTestId("account-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  it("closes on Escape", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  it("reports its open state to assistive tech", () => {
    renderSidebar();
    const trigger = screen.getByTestId("account-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapsing the rail closes an open menu", () => {
    const { rerender } = renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    expect(screen.getByTestId("account-menu")).toBeTruthy();
    rerender(<AppSidebar collapsed memberName="Reuben Singh" memberEmail="rsingh@qtsi.us" />);
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });
});
