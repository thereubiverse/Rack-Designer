import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppSidebar } from "./AppSidebar";
import type { Role } from "@/features/auth/roles";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

// The real action signs out and redirects; the menu only needs to render its submit button.
vi.mock("@/features/auth/authActions", () => ({ signOutAction: vi.fn() }));

function renderSidebar(props?: {
  collapsed?: boolean;
  memberName?: string | null;
  memberEmail?: string | null;
  memberAvatarUrl?: string | null;
  memberRole?: Role | null;
}) {
  return render(
    <AppSidebar
      collapsed={props?.collapsed ?? false}
      memberName={props?.memberName === undefined ? "Reuben Singh" : props.memberName}
      memberEmail={props?.memberEmail === undefined ? "rsingh@qtsi.us" : props.memberEmail}
      memberAvatarUrl={props?.memberAvatarUrl === undefined ? null : props.memberAvatarUrl}
      memberRole={props?.memberRole === undefined ? "admin" : props.memberRole}
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

  it("offers profile and log out, but not account", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    const menu = screen.getByTestId("account-menu");
    for (const label of ["Profile", "Log out"]) {
      expect(menu.textContent).toContain(label);
    }
    expect(menu.textContent).not.toContain("Account");
  });

  it("links Profile to /profile", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("account-trigger"));
    const link = screen.getByRole("menuitem", { name: "Profile" });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("renders the member's picture in the card when one is set", () => {
    renderSidebar({ memberAvatarUrl: "https://example.com/avatar.png" });
    const trigger = screen.getByTestId("account-trigger");
    const img = trigger.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/avatar.png");
  });

  it("falls back to the initial letter when there is no picture", () => {
    renderSidebar({ memberAvatarUrl: null });
    const trigger = screen.getByTestId("account-trigger");
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger.textContent).toContain("R");
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
    rerender(<AppSidebar collapsed memberName="Reuben Singh" memberEmail="rsingh@qtsi.us" memberAvatarUrl={null} memberRole="admin" />);
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });
});
