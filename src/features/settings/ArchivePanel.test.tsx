import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ArchivePanel } from "./ArchivePanel";
import type { ArchiveTree } from "@/features/clients/archiveOps";

vi.mock("@/features/clients/actions", () => ({
  restoreClientAction: vi.fn(async () => ({ ok: true })),
  restoreSiteAction: vi.fn(async () => ({ ok: true })),
  restoreFloorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { restoreClientAction, restoreSiteAction } from "@/features/clients/actions";

const AT = "2026-07-27T10:00:00Z";
const empty: ArchiveTree = { clients: [], sites: [], floors: [] };

beforeEach(() => vi.clearAllMocks());

describe("ArchivePanel", () => {
  it("says so when nothing is archived", () => {
    render(<ArchivePanel tree={empty} />);
    expect(screen.getByTestId("archive-empty")).toBeInTheDocument();
  });

  it("lists an archived client with its code", () => {
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    const row = screen.getByTestId("archived-client-c9");
    expect(row.textContent).toContain("Old Co");
    expect(row.textContent).toContain("OLD");
  });

  it("shows an archived site under its client's name", () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          sites: [
            {
              site: { id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" },
              clientCode: "URI",
              clientName: "Urban Resource Institute",
            },
          ],
        }}
      />
    );
    const row = screen.getByTestId("archived-site-s9");
    expect(row.textContent).toContain("Branch");
    expect(row.textContent).toContain("Urban Resource Institute");
  });

  it("shows an archived floor under its client AND site", () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          floors: [
            {
              floor: { id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s1" },
              clientCode: "URI",
              siteCode: "HQ",
              siteName: "Headquarters",
            },
          ],
        }}
      />
    );
    const row = screen.getByTestId("archived-floor-f9");
    expect(row.textContent).toContain("Ground");
    expect(row.textContent).toContain("Headquarters");
  });

  it("restores a client when its Restore is clicked", async () => {
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-client-c9"));
    });
    const sent = vi.mocked(restoreClientAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("c9");
  });

  it("restores a site when its Restore is clicked", async () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          sites: [
            {
              site: { id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" },
              clientCode: "URI",
              clientName: "Urban Resource Institute",
            },
          ],
        }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-site-s9"));
    });
    const sent = vi.mocked(restoreSiteAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("s9");
  });

  it("offers NO permanent delete anywhere — that is Slice G2", () => {
    // A narrower check (specific testid, specific wording) would miss a destructive control
    // that simply used a different name, e.g. data-testid="delete-client-c9" labelled "Delete".
    // Assert on every button the panel renders instead: each one must be a Restore control, and
    // no rendered text may read as delete/permanent language.
    const { container } = render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toHaveAccessibleName(/^Restore /);
    }
    expect(container.textContent).not.toMatch(/delete/i);
    expect(container.textContent).not.toMatch(/permanently/i);
  });

  it("surfaces a failed restore instead of silently doing nothing", async () => {
    vi.mocked(restoreClientAction).mockResolvedValueOnce({ ok: false, error: "db down" });
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-client-c9"));
    });
    expect(screen.getByTestId("archive-error").textContent).toContain("db down");
  });
});
