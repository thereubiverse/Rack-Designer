import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** The service role bypasses row-level security entirely, so a file still using it is silently
 *  unprotected — it keeps working, which is exactly why nothing draws attention to it. This list is
 *  the only thing that makes the remainder visible.
 *
 *  It starts at every file that used the service client when slice 2 began, and SHRINKS as each
 *  moves to createTenantClient. When the slice is done only PERMANENT holds four entries. Removing a
 *  file from this list is the definition of done for that file; adding one requires a reason in the
 *  table in docs/superpowers/specs/2026-08-07-database-enforced-isolation-design.md. */
const PERMANENT = [
  "src/features/activity/authLog.ts",     // sign-in refusals for addresses belonging to nobody
  "src/features/auth/authActions.ts",     // sign-in and sign-out, either side of a session
  "src/features/auth/members.ts",         // resolves the member, so cannot already have an org
  "src/features/devices/actions.ts",      // the device flow runs before device trust exists
];

/** Still to move. Every deletion from here is progress; nothing should ever be added. */
const REMAINING: string[] = [
  "src/app/activity/page.tsx",
  "src/app/clients/[clientCode]/[siteCode]/page.tsx",
  "src/app/clients/[clientCode]/page.tsx",
  "src/app/clients/page.tsx",
  "src/app/device-library/page.tsx",
  "src/app/device-library/types/page.tsx",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/profile/page.tsx",
  "src/app/racks/[id]/page.tsx",
  "src/app/settings/archive/page.tsx",
  "src/app/users/page.tsx",
  "src/app/verify-device/page.tsx",
  "src/features/auth/withMember.ts",
  "src/features/clients/actions.ts",
  "src/features/clients/discoverActions.ts",
  "src/features/clients/planExtractActions.ts",
  "src/features/clients/symbolActions.ts",
  "src/features/device-library/actions.ts",
  "src/features/device-library/typeActions.ts",
  "src/features/locations/actions.ts",
  "src/features/profile/actions.ts",
  "src/features/racks/actions.ts",
  "src/features/settings/store.ts",
  "src/features/users/actions.ts",
];

describe("who may use the service role", () => {
  it("is exactly the allowlist, and nothing else", () => {
    const out = execFileSync(
      "bash",
      ["-c", `command grep -rl 'from "@/lib/supabase/server"' src --include='*.ts' --include='*.tsx' | command grep -v '\\.test\\.' | sort`],
      { encoding: "utf8" }
    );
    const actual = out.split("\n").map((l) => l.trim()).filter(Boolean);
    // Exact equality both ways: a NEW file reaching for the service role fails here, and so does a
    // file listed as remaining that has already moved — which keeps the list honest as it shrinks.
    expect(actual).toEqual([...PERMANENT, ...REMAINING].sort());
  });
});
