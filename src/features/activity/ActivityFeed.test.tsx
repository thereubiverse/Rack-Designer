import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { ActivityFeed, PAGE_SIZE, type ActivityFilterState } from "./ActivityFeed";
import type { ActivityEntry } from "./repository";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockClear());

const actors = [
  { id: "m1", name: "Jane Doe", email: "jane@example.com" },
  { id: "m2", name: "", email: "bob@example.com" },
];

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "e1",
    actorEmail: "jane@example.com",
    actorName: "Jane Doe",
    action: "client.rename",
    memberId: "m1",
    outcome: "ok",
    details: { code: "ACME" },
    error: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function baseFilter(overrides: Partial<ActivityFilterState> = {}): ActivityFilterState {
  return { offset: 0, ...overrides };
}

describe("ActivityFeed", () => {
  it("renders When/Who/What/Outcome for a successful entry", () => {
    const e = entry();
    render(<ActivityFeed entries={[e]} total={1} actors={actors} filter={baseFilter()} />);
    const row = screen.getByTestId(`activity-row-${e.id}`);
    expect(row).toHaveTextContent("Jane Doe");
    // "What" comes from summarise(): a rename of a named client renders as "Renamed client ACME".
    expect(row).toHaveTextContent("Renamed client ACME");
    expect(within(row).getByTestId(`outcome-badge-${e.id}`)).toHaveTextContent("Succeeded");
  });

  // The brief requires a refusal to render distinctly from a success, and MUTED — present for the
  // record, not competing with real changes for attention. Pinning both the badge wording/color and
  // the row text color so a future edit can't silently make a refusal look identical to an "ok" row.
  it("renders a refusal distinctly and muted, unlike a success", () => {
    const ok = entry({ id: "ok1", outcome: "ok" });
    const refused = entry({ id: "refused1", outcome: "refused", action: "client.delete", details: { id: "c1" } });
    render(<ActivityFeed entries={[ok, refused]} total={2} actors={actors} filter={baseFilter()} />);

    const okRow = screen.getByTestId("activity-row-ok1");
    const refusedRow = screen.getByTestId("activity-row-refused1");

    expect(within(refusedRow).getByTestId("outcome-badge-refused1")).toHaveTextContent("Refused");
    expect(refusedRow).toHaveTextContent("Not allowed to");

    // Muted: the refused row's text uses a dim neutral color, not the emphasised color a
    // success/ok row uses, and its badge is neutral rather than red (which would read as an
    // alarming system error rather than a routine, expected refusal).
    const okCell = within(okRow).getAllByRole("cell")[2];
    const refusedCell = within(refusedRow).getAllByRole("cell")[2];
    expect(refusedCell.className).toContain("text-neutral-400");
    expect(okCell.className).not.toContain("text-neutral-400");

    const badge = within(refusedRow).getByTestId("outcome-badge-refused1");
    expect(badge.className).not.toContain("red");
  });

  it("renders the empty state, not a blank card, when there are no entries", () => {
    render(<ActivityFeed entries={[]} total={0} actors={actors} filter={baseFilter()} />);
    expect(screen.getByTestId("activity-empty")).toHaveTextContent("No activity yet");
  });

  it("shows a filtered empty state message when filters are active and nothing matches", () => {
    render(
      <ActivityFeed entries={[]} total={0} actors={actors} filter={baseFilter({ outcome: "failed" })} />
    );
    expect(screen.getByTestId("activity-empty")).toHaveTextContent("No activity matches these filters");
  });

  it("composes a new filter into the existing query instead of replacing it", () => {
    render(
      <ActivityFeed
        entries={[entry()]}
        total={1}
        actors={actors}
        filter={baseFilter({ memberId: "m1" })}
      />
    );
    fireEvent.change(screen.getByTestId("filter-outcome"), { target: { value: "refused" } });

    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], "http://localhost");
    expect(url.pathname).toBe("/activity");
    expect(url.searchParams.get("member")).toBe("m1");
    expect(url.searchParams.get("outcome")).toBe("refused");
  });

  it("resets the offset to 0 when a filter changes", () => {
    render(
      <ActivityFeed
        entries={[entry()]}
        total={200}
        actors={actors}
        filter={baseFilter({ offset: PAGE_SIZE * 2 })}
      />
    );
    fireEvent.change(screen.getByTestId("filter-action"), { target: { value: "client.rename" } });

    const url = new URL(push.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.get("action")).toBe("client.rename");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("clearing a select filter removes it from the query rather than sending an empty value", () => {
    render(
      <ActivityFeed
        entries={[entry()]}
        total={1}
        actors={actors}
        filter={baseFilter({ memberId: "m1", outcome: "ok" })}
      />
    );
    fireEvent.change(screen.getByTestId("filter-outcome"), { target: { value: "" } });

    const url = new URL(push.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.get("member")).toBe("m1");
    expect(url.searchParams.has("outcome")).toBe(false);
  });

  it("links Next to the following page, keeping the active filters", () => {
    render(
      <ActivityFeed
        entries={new Array(PAGE_SIZE).fill(0).map((_, i) => entry({ id: `e${i}` }))}
        total={PAGE_SIZE + 5}
        actors={actors}
        filter={baseFilter({ outcome: "ok" })}
      />
    );
    const next = screen.getByTestId("page-next") as HTMLAnchorElement;
    const url = new URL(next.getAttribute("href")!, "http://localhost");
    expect(url.searchParams.get("offset")).toBe(String(PAGE_SIZE));
    expect(url.searchParams.get("outcome")).toBe("ok");
  });

  it("does not offer Previous on the first page", () => {
    render(<ActivityFeed entries={[entry()]} total={1} actors={actors} filter={baseFilter({ offset: 0 })} />);
    expect(screen.queryByTestId("page-prev")).toBeNull();
  });

  it("does not offer Next when every result is already shown", () => {
    render(<ActivityFeed entries={[entry()]} total={1} actors={actors} filter={baseFilter()} />);
    expect(screen.queryByTestId("page-next")).toBeNull();
  });

  it("offers Clear filters only when a filter is active", () => {
    const { rerender } = render(
      <ActivityFeed entries={[]} total={0} actors={actors} filter={baseFilter()} />
    );
    expect(screen.queryByTestId("clear-filters")).toBeNull();

    rerender(<ActivityFeed entries={[]} total={0} actors={actors} filter={baseFilter({ action: "client.delete" })} />);
    const clear = screen.getByTestId("clear-filters") as HTMLAnchorElement;
    expect(clear.getAttribute("href")).toBe("/activity");
  });
});
