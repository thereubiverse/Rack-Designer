# Phase 1 — Deferred items (Phase 2 backlog)

These surfaced during Phase 1 reviews and were intentionally deferred (single-org
internal slice, no auth/concurrency yet). None are happy-path correctness bugs.

## Should-fix early in Phase 2
1. **Rack grid sort UX** — headers set a sort key but there is no ascending/
   descending toggle and no active-column/direction indicator. Add `sortDir`
   state + an aria-sort/caret. (`src/features/grid/RackGrid.tsx`)
2. **Write-path robustness** — `createRackWithHierarchyAction` find-or-create is
   read-then-insert with no transaction; concurrent same-code submits race on the
   unique constraint and the raw Postgres error is shown to the user. Use upsert
   `onConflict` on the composite unique keys (or catch `23505` + re-select), and
   add a shared `mapDbError()` so raw DB text never reaches the UI.
   (`src/features/locations/actions.ts`)
3. **Service-key isolation** — when auth lands, add the `server-only` package
   import to `src/lib/supabase/server.ts` so a client-side import fails at build
   time. Replace the placeholder permissive RLS policies with org-scoped policies
   and stop relying on `service_role` (which bypasses RLS).

## Minor / nice-to-have
4. `listRacksWithPath` uses `as unknown as RackJoinRow[]`; add a runtime shape
   guard (or zod) if the join and type drift. (`src/features/locations/repository.ts`)
5. `createSite` re-calls `getDefaultOrganization` per insert (N+1-ish for the
   Phase 6 CSV bulk-import path). Cache/pass the org id.
6. Broaden `RackGrid.test.tsx` to cover label/roomType (`localeCompare`) sort and
   the empty-state message.
7. Add a comment in `.env.example` that `SUPABASE_SERVICE_ROLE_KEY` must never be
   `NEXT_PUBLIC_`-prefixed / exposed client-side.

## Accepted as-is (no action)
- `tsconfig.json` `jsx: "react-jsx"` — Next 16 auto-writes this; forcing
  `"preserve"` just gets rewritten. Build passes.
- Vitest prints "CJS build of Vite's Node API is deprecated" — intrinsic to the
  Vitest 2 + Vite combo, not our code.
