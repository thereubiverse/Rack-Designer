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

/** Still to move. Every deletion from here is progress; nothing should ever be added.
 *
 *  Five of Task 7's thirteen page components are listed here still, not because they were skipped,
 *  but because each one's ONLY remaining service-client use touches something app_tenant has no
 *  grant on at all — proven directly against the local stack, not assumed:
 *
 *    - storage.objects (the whole storage schema): "permission denied for schema storage".
 *      layout.tsx and profile/page.tsx (avatar signed URLs), and
 *      clients/[clientCode]/[siteCode]/page.tsx (floor-plan signed URLs).
 *    - trusted_devices, deliberately ungranted per migration 0042/0043's own comment ("fails
 *      loudly instead of quietly working"): "permission denied for table trusted_devices".
 *      profile/page.tsx and users/page.tsx (listing a member's devices), and
 *      verify-device/page.tsx (looking up the current device by hash).
 *
 *  Every other query in these five files already moved to createTenantClient — see task-7-report.md
 *  for the file-by-file split. Fully removing them needs either a storage RLS policy for app_tenant
 *  (the design doc defers this explicitly) or a trusted_devices grant, neither of which is a page
 *  change.
 *
 *  src/features/clients/actions.ts, discoverActions.ts, planExtractActions.ts and symbolActions.ts
 *  (Task 8) stay for the same storage.objects reason — every DB call in those four already moved,
 *  only the storage.upload/download/remove calls keep a narrow service client.
 *
 *  src/features/profile/actions.ts (Task 9) stays for BOTH reasons at once: avatar upload/remove
 *  is storage.objects, and phone verification is phone_verifications — also deliberately ungranted
 *  (same 0042/0043 comment as trusted_devices, proven live: "permission denied for table
 *  phone_verifications"). Every members-table query in that file already moved to
 *  createTenantClient; only those two narrow, commented calls remain on the service client. */
const REMAINING: string[] = [
  "src/app/clients/[clientCode]/[siteCode]/page.tsx",
  "src/app/layout.tsx",
  "src/app/profile/page.tsx",
  "src/app/users/page.tsx",
  "src/app/verify-device/page.tsx",
  "src/features/clients/actions.ts",
  "src/features/clients/discoverActions.ts",
  "src/features/clients/planExtractActions.ts",
  "src/features/clients/symbolActions.ts",
  "src/features/profile/actions.ts",
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
