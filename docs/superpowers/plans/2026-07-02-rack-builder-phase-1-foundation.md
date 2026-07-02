# Rack Builder — Phase 1: Foundation & Location Hierarchy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project and deliver a working slice where a user can create the location hierarchy (Site → Floor → Room → Rack) and see every rack in a searchable/sortable data grid with auto-derived path labels.

**Architecture:** Next.js App Router app backed by Supabase (Postgres). Pure domain logic (naming engine, validation) lives framework-free and is unit-tested. Data access is a repository module that takes a Supabase client (so it's integration-testable against local Supabase). Reads happen in server components; writes happen through server actions. The synced data grid is a client component fed server data — the first "view over the source of truth."

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS v4, Supabase (`@supabase/supabase-js`) + Supabase CLI for local Postgres, Vitest + React Testing Library (unit/component), Playwright (E2E smoke).

## Global Constraints

- **Runtime/tooling versions (match existing company project):** Next.js `16.x`, React `19.x`, TypeScript `5.x`, Tailwind CSS `4.x`, ESLint `9.x`.
- **Single-org, multi-tenant-ready:** every domain table carries `organization_id`; one seeded default organization; RLS enabled with a permissive single-org policy marked for replacement when auth lands. Never drop `organization_id`.
- **Naming is auto-derived, fixed-format:** labels are composed from hierarchy `code`s as `site/floor/room/rack/device/port`, joined by `/`. Codes match `^[A-Za-z0-9_-]+$` (no slashes). No hierarchy label is ever hand-typed. (Cable-name free-text is Phase 3, not here.)
- **TDD always:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Package manager:** npm (matches existing project).
- **Path alias:** `@/*` maps to `src/*`.

---

### Task 1: Project scaffold & base app shell

**Files:**
- Create: `network-doc-platform/package.json`
- Create: `network-doc-platform/tsconfig.json`
- Create: `network-doc-platform/next.config.ts`
- Create: `network-doc-platform/postcss.config.mjs`
- Create: `network-doc-platform/eslint.config.mjs`
- Create: `network-doc-platform/src/app/layout.tsx`
- Create: `network-doc-platform/src/app/page.tsx`
- Create: `network-doc-platform/src/app/globals.css`
- Create: `network-doc-platform/.env.example`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a runnable Next.js app; the `@/*` → `src/*` alias; Tailwind v4 configured.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "network-doc-platform",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "next": "16.2.9",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "@supabase/supabase-js": "^2.45.0",
    "lucide-react": "^1.21.0"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4",
    "eslint": "^9",
    "eslint-config-next": "16.2.9"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd network-doc-platform && npm install`
Expected: `node_modules/` populated, no peer-dependency errors that abort install.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create config files**

`next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

`postcss.config.mjs`:
```js
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
```

`eslint.config.mjs`:
```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**"] },
];

export default eslintConfig;
```

- [ ] **Step 5: Create the app shell**

`src/app/globals.css`:
```css
@import "tailwindcss";

:root {
  --background: #0e0e12;
  --foreground: #e6e8ec;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Network Documentation Platform",
  description: "Rack builder & network documentation",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Network Documentation Platform</h1>
      <p className="text-sm text-neutral-400">Phase 1 foundation is running.</p>
    </main>
  );
}
```

`.env.example`:
```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=replace-with-supabase-status-anon-key
SUPABASE_SERVICE_ROLE_KEY=replace-with-supabase-status-service-role-key
```

- [ ] **Step 6: Verify the app builds and runs**

Run: `npm run build`
Expected: build completes with "Compiled successfully" and a route listing that includes `/`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs src/ .env.example
git commit -m "chore: scaffold Next.js app shell with Tailwind v4"
```

---

### Task 2: Test harness (Vitest + React Testing Library)

**Files:**
- Modify: `network-doc-platform/package.json` (add dev deps)
- Create: `network-doc-platform/vitest.config.ts`
- Create: `network-doc-platform/vitest.setup.ts`
- Create: `network-doc-platform/src/domain/smoke.test.ts`

**Interfaces:**
- Consumes: the scaffold from Task 1.
- Produces: `npm test` runs Vitest with jsdom + `@testing-library/jest-dom` matchers available globally.

- [ ] **Step 1: Add test dependencies**

Run:
```bash
npm install -D vitest@^2 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 @vitejs/plugin-react@^4 vite-tsconfig-paths@^5
```
Expected: packages added to `devDependencies`.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

- [ ] **Step 3: Create `vitest.setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Write a smoke test**

`src/domain/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: PASS — 1 test passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts vitest.setup.ts src/domain/smoke.test.ts
git commit -m "chore: add Vitest + React Testing Library harness"
```

---

### Task 3: Naming engine (derived path labels)

**Files:**
- Create: `network-doc-platform/src/domain/naming.ts`
- Test: `network-doc-platform/src/domain/naming.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `interface HierarchyCodes { site: string; floor?: string; room?: string; rack?: string; device?: string; port?: number; }`
  - `function buildLabel(codes: HierarchyCodes): string` — joins present levels top-down with `/`; stops at the first missing level; appends `port` only if `device` is present.

- [ ] **Step 1: Write the failing test**

`src/domain/naming.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildLabel } from "./naming";

describe("buildLabel", () => {
  it("builds a full port-level path", () => {
    expect(
      buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M", device: "D", port: 17 })
    ).toBe("HQ/28/SL/RK001_M/D/17");
  });

  it("builds a rack-level path", () => {
    expect(buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M" })).toBe(
      "HQ/28/SL/RK001_M"
    );
  });

  it("builds a site-only path", () => {
    expect(buildLabel({ site: "HQ" })).toBe("HQ");
  });

  it("stops at the first missing level (room without floor is ignored)", () => {
    expect(buildLabel({ site: "HQ", room: "SL" })).toBe("HQ");
  });

  it("ignores a port when there is no device", () => {
    expect(buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M", port: 17 })).toBe(
      "HQ/28/SL/RK001_M"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- naming`
Expected: FAIL — cannot find module `./naming` / `buildLabel is not a function`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/naming.ts`:
```ts
export interface HierarchyCodes {
  site: string;
  floor?: string;
  room?: string;
  rack?: string;
  device?: string;
  port?: number;
}

const LEVEL_ORDER = ["site", "floor", "room", "rack", "device"] as const;

export function buildLabel(codes: HierarchyCodes): string {
  const parts: string[] = [];
  for (const level of LEVEL_ORDER) {
    const value = codes[level];
    if (value === undefined || value === null || value === "") break;
    parts.push(String(value));
  }
  if (codes.device !== undefined && codes.device !== "" && codes.port !== undefined) {
    parts.push(String(codes.port));
  }
  return parts.join("/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- naming`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/naming.ts src/domain/naming.test.ts
git commit -m "feat: add derived naming engine (buildLabel)"
```

---

### Task 4: Code validation & hierarchy types

**Files:**
- Create: `network-doc-platform/src/domain/hierarchy.ts`
- Test: `network-doc-platform/src/domain/hierarchy.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `type RoomType = "MDF" | "IDF" | "other"`
  - `const ROOM_TYPES: RoomType[]`
  - `function isValidCode(code: string): boolean` — true when it matches `^[A-Za-z0-9_-]+$`.
  - `function isValidRackHeight(u: number): boolean` — true when integer, `> 0`, `<= 60`.

- [ ] **Step 1: Write the failing test**

`src/domain/hierarchy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isValidCode, isValidRackHeight, ROOM_TYPES } from "./hierarchy";

describe("isValidCode", () => {
  it("accepts alphanumeric, underscore, and hyphen", () => {
    expect(isValidCode("RK001_M")).toBe(true);
    expect(isValidCode("HQ-2")).toBe(true);
  });
  it("rejects slashes and empty strings", () => {
    expect(isValidCode("HQ/28")).toBe(false);
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("has space")).toBe(false);
  });
});

describe("isValidRackHeight", () => {
  it("accepts 1..60", () => {
    expect(isValidRackHeight(42)).toBe(true);
    expect(isValidRackHeight(1)).toBe(true);
  });
  it("rejects zero, negatives, non-integers, and over 60", () => {
    expect(isValidRackHeight(0)).toBe(false);
    expect(isValidRackHeight(-5)).toBe(false);
    expect(isValidRackHeight(12.5)).toBe(false);
    expect(isValidRackHeight(61)).toBe(false);
  });
});

describe("ROOM_TYPES", () => {
  it("lists the three room types", () => {
    expect(ROOM_TYPES).toEqual(["MDF", "IDF", "other"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hierarchy`
Expected: FAIL — cannot find module `./hierarchy`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/hierarchy.ts`:
```ts
export type RoomType = "MDF" | "IDF" | "other";

export const ROOM_TYPES: RoomType[] = ["MDF", "IDF", "other"];

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function isValidRackHeight(u: number): boolean {
  return Number.isInteger(u) && u > 0 && u <= 60;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- hierarchy`
Expected: PASS — all tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/hierarchy.ts src/domain/hierarchy.test.ts
git commit -m "feat: add code/height validation and room types"
```

---

### Task 5: Supabase local + schema migration + seed

**Files:**
- Create: `network-doc-platform/supabase/config.toml` (generated by `supabase init`)
- Create: `network-doc-platform/supabase/migrations/0001_location_hierarchy.sql`
- Modify: `network-doc-platform/.gitignore` (ensure `.env.local` and `supabase/.temp` ignored)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `organizations`, `sites`, `floors`, `rooms`, `racks` in local Postgres with one seeded default organization (`code = 'DEFAULT'`); RLS enabled with a permissive single-org policy.

- [ ] **Step 1: Install the Supabase CLI and initialize**

Run:
```bash
cd network-doc-platform
npx supabase init
```
Expected: creates `supabase/config.toml` and `supabase/` folder. Accept defaults; answer "N" to VS Code settings prompt if asked.

- [ ] **Step 2: Ensure secrets are gitignored**

Confirm `.gitignore` contains these lines (append any missing):
```
.env.local
supabase/.temp
supabase/.branches
```

- [ ] **Step 3: Write the migration**

`supabase/migrations/0001_location_hierarchy.sql`:
```sql
-- Organizations (single default now; tenant-ready)
create table organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  address text,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table floors (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  code text not null,
  name text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (site_id, code)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references floors(id) on delete cascade,
  code text not null,
  name text,
  type text not null default 'other' check (type in ('MDF', 'IDF', 'other')),
  created_at timestamptz not null default now(),
  unique (floor_id, code)
);

create table racks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  code text not null,
  name text,
  height_u int not null check (height_u > 0 and height_u <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, code)
);

-- Enable RLS. NOTE: single-org placeholder policy — replace with
-- organization-scoped policies when auth lands (Phase: multi-tenant auth).
alter table organizations enable row level security;
alter table sites enable row level security;
alter table floors enable row level security;
alter table rooms enable row level security;
alter table racks enable row level security;

create policy "single_org_all" on organizations for all using (true) with check (true);
create policy "single_org_all" on sites for all using (true) with check (true);
create policy "single_org_all" on floors for all using (true) with check (true);
create policy "single_org_all" on rooms for all using (true) with check (true);
create policy "single_org_all" on racks for all using (true) with check (true);

-- Seed the single default organization.
insert into organizations (code, name) values ('DEFAULT', 'Default Organization');
```

- [ ] **Step 4: Start local Supabase and apply the migration**

Run:
```bash
npx supabase start
```
Expected: prints local service URLs and keys (API URL `http://127.0.0.1:54321`, plus `anon key` and `service_role key`). Migrations in `supabase/migrations` are applied automatically on start.

- [ ] **Step 5: Populate `.env.local` from the printed keys**

Create `network-doc-platform/.env.local` using the values from `npx supabase status`:
```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
```

- [ ] **Step 6: Verify tables and seed exist**

Run:
```bash
npx supabase status
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select code, name from organizations;"
```
Expected: one row — `DEFAULT | Default Organization`. (If `psql` is unavailable, open Supabase Studio at the URL from `supabase status` and confirm the five tables exist.)

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml supabase/migrations/0001_location_hierarchy.sql .gitignore
git commit -m "feat: add location hierarchy schema, RLS, and default org seed"
```

---

### Task 6: Supabase client + location repository (integration-tested)

**Files:**
- Create: `network-doc-platform/src/lib/supabase/types.ts`
- Create: `network-doc-platform/src/lib/supabase/server.ts`
- Create: `network-doc-platform/src/features/locations/repository.ts`
- Test: `network-doc-platform/src/features/locations/repository.integration.test.ts`

**Interfaces:**
- Consumes: `buildLabel` (Task 3); `RoomType` (Task 4); local Supabase (Task 5).
- Produces:
  - `function createServiceClient(): SupabaseClient` (server-only; service role).
  - Row types: `OrganizationRow`, `SiteRow`, `FloorRow`, `RoomRow`, `RackRow`.
  - `interface RackWithPath { id: string; label: string; siteCode: string; floorCode: string; roomCode: string; roomType: RoomType; rackCode: string; heightU: number; }`
  - Repository functions (all take `db: SupabaseClient` as first arg):
    - `getDefaultOrganization(db): Promise<OrganizationRow>`
    - `createSite(db, { code, name, address? }): Promise<SiteRow>`
    - `createFloor(db, { siteId, code, name?, sortOrder? }): Promise<FloorRow>`
    - `createRoom(db, { floorId, code, name?, type }): Promise<RoomRow>`
    - `createRack(db, { roomId, code, name?, heightU }): Promise<RackRow>`
    - `listRacksWithPath(db): Promise<RackWithPath[]>`

- [ ] **Step 1: Create row types**

`src/lib/supabase/types.ts`:
```ts
import type { RoomType } from "@/domain/hierarchy";

export interface OrganizationRow {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface SiteRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  address: string | null;
  created_at: string;
}

export interface FloorRow {
  id: string;
  site_id: string;
  code: string;
  name: string | null;
  sort_order: number;
  created_at: string;
}

export interface RoomRow {
  id: string;
  floor_id: string;
  code: string;
  name: string | null;
  type: RoomType;
  created_at: string;
}

export interface RackRow {
  id: string;
  room_id: string;
  code: string;
  name: string | null;
  height_u: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Create the service client**

`src/lib/supabase/server.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only. Phase 1 uses the service role because there is no auth yet.
// Replace with a user-scoped client when authentication lands.
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
```

- [ ] **Step 3: Write the failing integration test**

`src/features/locations/repository.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getDefaultOrganization,
  createSite,
  createFloor,
  createRoom,
  createRack,
  listRacksWithPath,
} from "./repository";

function testDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const db = testDb();

async function cleanup() {
  // Cascades from sites down to racks.
  await db.from("sites").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

describe("location repository (integration)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("returns the seeded default organization", async () => {
    const org = await getDefaultOrganization(db);
    expect(org.code).toBe("DEFAULT");
  });

  it("creates a full hierarchy and lists racks with a derived path", async () => {
    const org = await getDefaultOrganization(db);
    const site = await createSite(db, { code: "HQ", name: "Headquarters" });
    expect(site.organization_id).toBe(org.id);
    const floor = await createFloor(db, { siteId: site.id, code: "28" });
    const room = await createRoom(db, { floorId: floor.id, code: "SL", type: "MDF" });
    const rack = await createRack(db, { roomId: room.id, code: "RK001_M", heightU: 42 });
    expect(rack.height_u).toBe(42);

    const rows = await listRacksWithPath(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("HQ/28/SL/RK001_M");
    expect(rows[0].roomType).toBe("MDF");
    expect(rows[0].heightU).toBe(42);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- repository`
Expected: FAIL — cannot find module `./repository`.

- [ ] **Step 5: Write minimal implementation**

`src/features/locations/repository.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import { buildLabel } from "@/domain/naming";
import type {
  OrganizationRow,
  SiteRow,
  FloorRow,
  RoomRow,
  RackRow,
} from "@/lib/supabase/types";

export interface RackWithPath {
  id: string;
  label: string;
  siteCode: string;
  floorCode: string;
  roomCode: string;
  roomType: RoomType;
  rackCode: string;
  heightU: number;
}

export async function getDefaultOrganization(db: SupabaseClient): Promise<OrganizationRow> {
  const { data, error } = await db
    .from("organizations")
    .select("*")
    .eq("code", "DEFAULT")
    .single();
  if (error) throw new Error(`getDefaultOrganization: ${error.message}`);
  return data as OrganizationRow;
}

export async function createSite(
  db: SupabaseClient,
  input: { code: string; name: string; address?: string }
): Promise<SiteRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db
    .from("sites")
    .insert({
      organization_id: org.id,
      code: input.code,
      name: input.name,
      address: input.address ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createSite: ${error.message}`);
  return data as SiteRow;
}

export async function createFloor(
  db: SupabaseClient,
  input: { siteId: string; code: string; name?: string; sortOrder?: number }
): Promise<FloorRow> {
  const { data, error } = await db
    .from("floors")
    .insert({
      site_id: input.siteId,
      code: input.code,
      name: input.name ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createFloor: ${error.message}`);
  return data as FloorRow;
}

export async function createRoom(
  db: SupabaseClient,
  input: { floorId: string; code: string; name?: string; type: RoomType }
): Promise<RoomRow> {
  const { data, error } = await db
    .from("rooms")
    .insert({
      floor_id: input.floorId,
      code: input.code,
      name: input.name ?? null,
      type: input.type,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createRoom: ${error.message}`);
  return data as RoomRow;
}

export async function createRack(
  db: SupabaseClient,
  input: { roomId: string; code: string; name?: string; heightU: number }
): Promise<RackRow> {
  const { data, error } = await db
    .from("racks")
    .insert({
      room_id: input.roomId,
      code: input.code,
      name: input.name ?? null,
      height_u: input.heightU,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createRack: ${error.message}`);
  return data as RackRow;
}

interface RackJoinRow {
  id: string;
  code: string;
  height_u: number;
  rooms: {
    code: string;
    type: RoomType;
    floors: {
      code: string;
      sites: { code: string };
    };
  };
}

export async function listRacksWithPath(db: SupabaseClient): Promise<RackWithPath[]> {
  const { data, error } = await db
    .from("racks")
    .select("id, code, height_u, rooms!inner(code, type, floors!inner(code, sites!inner(code)))")
    .order("code", { ascending: true });
  if (error) throw new Error(`listRacksWithPath: ${error.message}`);

  const rows = (data ?? []) as unknown as RackJoinRow[];
  return rows.map((r) => {
    const siteCode = r.rooms.floors.sites.code;
    const floorCode = r.rooms.floors.code;
    const roomCode = r.rooms.code;
    return {
      id: r.id,
      label: buildLabel({ site: siteCode, floor: floorCode, room: roomCode, rack: r.code }),
      siteCode,
      floorCode,
      roomCode,
      roomType: r.rooms.type,
      rackCode: r.code,
      heightU: r.height_u,
    };
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- repository`
Expected: PASS — 2 tests passed. (Local Supabase from Task 5 must be running; env vars come from `.env.local`. If Vitest doesn't see them, prefix with `env $(grep -v '^#' .env.local | xargs) npm test -- repository` or add `import "dotenv/config"` behavior via `test.env` — simplest: run `set -a; source .env.local; set +a; npm test -- repository`.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase/ src/features/locations/repository.ts src/features/locations/repository.integration.test.ts
git commit -m "feat: add location repository with derived-path rack listing"
```

---

### Task 7: Workspace shell, create forms, and synced rack grid

**Files:**
- Create: `network-doc-platform/src/features/locations/actions.ts`
- Create: `network-doc-platform/src/features/grid/RackGrid.tsx`
- Test: `network-doc-platform/src/features/grid/RackGrid.test.tsx`
- Create: `network-doc-platform/src/features/locations/CreateRackForm.tsx`
- Modify: `network-doc-platform/src/app/page.tsx`

**Interfaces:**
- Consumes: repository functions + `RackWithPath` (Task 6); `isValidCode`, `isValidRackHeight`, `ROOM_TYPES` (Task 4).
- Produces:
  - `RackGrid({ racks }: { racks: RackWithPath[] })` — client component with a search box (filters on `label`) and clickable column headers that sort by `label`, `roomType`, or `heightU`.
  - Server actions in `actions.ts`: `createRackWithHierarchyAction(formData: FormData): Promise<{ ok: boolean; error?: string }>` — creates site/floor/room/rack in one go (finds-or-creates each level by code within the default org), used by the Phase 1 create form.

- [ ] **Step 1: Write the failing component test**

`src/features/grid/RackGrid.test.tsx`:
```tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- RackGrid`
Expected: FAIL — cannot find module `./RackGrid`.

- [ ] **Step 3: Write the grid component**

`src/features/grid/RackGrid.tsx`:
```tsx
"use client";

import { useMemo, useState } from "react";
import type { RackWithPath } from "@/features/locations/repository";

type SortKey = "label" | "roomType" | "heightU";

export function RackGrid({ racks }: { racks: RackWithPath[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("label");

  const rows = useMemo(() => {
    const filtered = racks.filter((r) =>
      r.label.toLowerCase().includes(query.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      if (sortKey === "heightU") return a.heightU - b.heightU;
      return String(a[sortKey]).localeCompare(String(b[sortKey]));
    });
  }, [racks, query, sortKey]);

  return (
    <div className="space-y-3">
      <input
        className="w-full max-w-sm rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        placeholder="Search racks…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-400">
          <tr>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("label")}>Label</button>
            </th>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("roomType")}>Room type</button>
            </th>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("heightU")}>Height (U)</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td className="p-2 font-mono">{r.label}</td>
              <td className="p-2">{r.roomType}</td>
              <td className="p-2">{r.heightU}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="text-sm text-neutral-500">No racks yet. Create one above.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- RackGrid`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Write the server action (find-or-create hierarchy + rack)**

`src/features/locations/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidCode, isValidRackHeight, type RoomType } from "@/domain/hierarchy";
import {
  getDefaultOrganization,
  createSite,
  createFloor,
  createRoom,
  createRack,
} from "./repository";
import type { SupabaseClient } from "@supabase/supabase-js";

async function findOrCreateSite(db: SupabaseClient, code: string) {
  const org = await getDefaultOrganization(db);
  const { data } = await db
    .from("sites")
    .select("*")
    .eq("organization_id", org.id)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createSite(db, { code, name: code });
}

async function findOrCreateFloor(db: SupabaseClient, siteId: string, code: string) {
  const { data } = await db
    .from("floors")
    .select("*")
    .eq("site_id", siteId)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createFloor(db, { siteId, code });
}

async function findOrCreateRoom(
  db: SupabaseClient,
  floorId: string,
  code: string,
  type: RoomType
) {
  const { data } = await db
    .from("rooms")
    .select("*")
    .eq("floor_id", floorId)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createRoom(db, { floorId, code, type });
}

export async function createRackWithHierarchyAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const siteCode = String(formData.get("siteCode") ?? "");
  const floorCode = String(formData.get("floorCode") ?? "");
  const roomCode = String(formData.get("roomCode") ?? "");
  const roomType = String(formData.get("roomType") ?? "other") as RoomType;
  const rackCode = String(formData.get("rackCode") ?? "");
  const heightU = Number(formData.get("heightU") ?? 0);

  for (const [name, code] of [
    ["site", siteCode],
    ["floor", floorCode],
    ["room", roomCode],
    ["rack", rackCode],
  ] as const) {
    if (!isValidCode(code)) return { ok: false, error: `Invalid ${name} code` };
  }
  if (!isValidRackHeight(heightU)) return { ok: false, error: "Invalid rack height" };

  const db = createServiceClient();
  try {
    const site = await findOrCreateSite(db, siteCode);
    const floor = await findOrCreateFloor(db, site.id, floorCode);
    const room = await findOrCreateRoom(db, floor.id, roomCode, roomType);
    await createRack(db, { roomId: room.id, code: rackCode, heightU });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/");
  return { ok: true };
}
```

- [ ] **Step 6: Write the create form component**

`src/features/locations/CreateRackForm.tsx`:
```tsx
"use client";

import { useState } from "react";
import { ROOM_TYPES } from "@/domain/hierarchy";
import { createRackWithHierarchyAction } from "./actions";

export function CreateRackForm() {
  const [error, setError] = useState<string | null>(null);

  async function action(formData: FormData) {
    setError(null);
    const result = await createRackWithHierarchyAction(formData);
    if (!result.ok) setError(result.error ?? "Failed");
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="siteCode" placeholder="Site (HQ)" className="input" required />
      <input name="floorCode" placeholder="Floor (28)" className="input" required />
      <input name="roomCode" placeholder="Room (SL)" className="input" required />
      <select name="roomType" className="input" defaultValue="other">
        {ROOM_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <input name="rackCode" placeholder="Rack (RK001_M)" className="input" required />
      <input name="heightU" type="number" placeholder="U" defaultValue={42} className="input w-20" required />
      <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">
        Add rack
      </button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </form>
  );
}
```

Add the shared `.input` utility to `src/app/globals.css` (append):
```css
.input {
  border: 1px solid #3a3a45;
  background: #16161c;
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
}
```

- [ ] **Step 7: Wire the workspace page**

Replace `src/app/page.tsx`:
```tsx
import { createServiceClient } from "@/lib/supabase/server";
import { listRacksWithPath } from "@/features/locations/repository";
import { RackGrid } from "@/features/grid/RackGrid";
import { CreateRackForm } from "@/features/locations/CreateRackForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = createServiceClient();
  const racks = await listRacksWithPath(db);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Racks</h1>
        <p className="text-sm text-neutral-400">
          Create the location hierarchy and see every rack with its derived label.
        </p>
      </header>
      <CreateRackForm />
      <RackGrid racks={racks} />
    </main>
  );
}
```

- [ ] **Step 8: Run the full unit/component suite**

Run: `npm test`
Expected: PASS — all tests (smoke, naming, hierarchy, RackGrid) pass. (The `repository.integration.test.ts` also runs; keep local Supabase up, or run `npm test -- --exclude "**/*.integration.test.ts"` for the non-DB subset.)

- [ ] **Step 9: Manually verify end-to-end in the browser**

Run: `npm run dev`, open `http://localhost:3000`, add a rack (Site `HQ`, Floor `28`, Room `SL`/MDF, Rack `RK001_M`, U `42`).
Expected: the grid shows a row `HQ/28/SL/RK001_M · MDF · 42`; searching `RK001` keeps it, searching `ZZZ` empties the grid.

- [ ] **Step 10: Commit**

```bash
git add src/features/ src/app/page.tsx src/app/globals.css
git commit -m "feat: workspace shell with create-rack form and synced rack grid"
```

---

### Task 8: Playwright E2E smoke test

**Files:**
- Modify: `network-doc-platform/package.json` (add Playwright dev dep — already scripted)
- Create: `network-doc-platform/playwright.config.ts`
- Create: `network-doc-platform/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: the running app from Task 7.
- Produces: an E2E smoke test proving the workspace loads and the grid renders.

- [ ] **Step 1: Install Playwright**

Run:
```bash
npm install -D @playwright/test@^1.48
npx playwright install chromium
```
Expected: Chromium browser downloaded.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 3: Write the failing E2E test**

`e2e/smoke.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("workspace loads and shows the Racks heading and search box", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Racks" })).toBeVisible();
  await expect(page.getByPlaceholder(/search racks/i)).toBeVisible();
});
```

- [ ] **Step 4: Run the E2E test**

Run: `npm run test:e2e`
Expected: PASS — 1 test passed. (Local Supabase must be running so the page's server fetch succeeds.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json playwright.config.ts e2e/smoke.spec.ts
git commit -m "test: add Playwright E2E smoke test for workspace"
```

---

## Self-Review

**Spec coverage (Phase 1 subset of the design spec):**
- §2 location hierarchy (Site→Floor→Room→Rack) → Tasks 5, 6, 7. ✓
- §3 architecture: Next.js + Supabase, SVG rendering deferred, normalized source of truth with grid as a view → Tasks 1, 6, 7 (SVG builder is Phase 2, correctly deferred). ✓
- §4 data model (organization_id on all tables, room type enum, rack height check) → Task 5. ✓
- §5 naming (auto-derived, fixed-format, `code` pattern) → Tasks 3, 4; enforced in the grid label and validated on create. Cable free-text is Phase 3, out of scope here. ✓
- §6 synced data grid (search/sort) → Task 7. ✓
- §7 entry paths: manual entry via the create form → Task 7 (CSV import is Phase 6; visual-first is Phase 2). ✓
- §10 concurrency `updated_at` guard → column added in Task 5; enforcement arrives with edit flows in later phases (no edit path in Phase 1, so nothing to guard yet). ✓
- §11 testing (unit + integration + component + E2E) → Tasks 2, 3, 4, 6, 7, 8. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" left; every code step contains complete code. ✓

**Type consistency:** `RackWithPath`, `RoomType`, `buildLabel`, `HierarchyCodes`, `createServiceClient`, and all repository signatures are defined once (Tasks 3, 4, 6) and referenced with identical names/shapes in Tasks 6, 7. `createRackWithHierarchyAction` returns `{ ok, error? }` consistently between `actions.ts` and `CreateRackForm.tsx`. ✓

**Out-of-scope-but-noted:** SVG rack rendering, ports/connectivity, faceplates, planned/as-built, CSV import, reports — all deferred to their phase plans per the roadmap.
