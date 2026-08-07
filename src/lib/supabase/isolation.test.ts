import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mintTenantToken } from "./tenant";

const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";
const REST = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function psql(query: string): string {
  return execFileSync("docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }).trim();
}

async function get(path: string, token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${REST}${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.text() };
}

let orgA = "", orgB = "";

beforeAll(() => {
  // Distinctive codes so a leak is unmistakable, and so cleanup can find them.
  // Wrapped in a CTE (rather than a bare INSERT ... RETURNING) so psql -tAc emits only the
  // returned id — a bare INSERT also prints an "INSERT 0 1" command-tag line that would land in
  // the same captured string and corrupt the uuid used below.
  orgA = psql(`with ins as (insert into organisations (name) values ('ISO-TEST-A') returning id) select id from ins`);
  orgB = psql(`with ins as (insert into organisations (name) values ('ISO-TEST-B') returning id) select id from ins`);
  psql(`insert into clients (code, name, org_id) values ('ISOA','Iso A','${orgA}')`);
  psql(`insert into clients (code, name, org_id) values ('ISOB','Iso B','${orgB}')`);
});

afterAll(() => {
  // Deletes only what this file created — never a blanket delete.
  psql(`delete from clients where code in ('ISOA','ISOB')`);
  psql(`delete from organisations where name in ('ISO-TEST-A','ISO-TEST-B')`);
});

describe("cross-organisation access", () => {
  it("sees its own organisation's client", async () => {
    const { body } = await get("/rest/v1/clients?code=eq.ISOA&select=code", mintTenantToken(orgA));
    expect(body).toContain("ISOA");
  });

  it("cannot see another organisation's client", async () => {
    const { body } = await get("/rest/v1/clients?code=eq.ISOB&select=code", mintTenantToken(orgA));
    expect(JSON.parse(body)).toEqual([]);
  });

  it("returns NOTHING for a token carrying no organisation", async () => {
    // The property the whole slice rests on. A bug here reads as "the app is empty", not as an
    // error, so it is asserted directly rather than inferred.
    const token = mintTenantToken(orgA).split(".");
    const claims = JSON.parse(Buffer.from(token[1], "base64url").toString());
    delete claims.org_id;
    // Re-sign without org_id, using the same helper's secret.
    const { createHmac } = await import("node:crypto");
    const h = token[0];
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const s = createHmac("sha256", process.env.SUPABASE_JWT_SECRET!).update(`${h}.${p}`).digest("base64url");
    const { body } = await get("/rest/v1/clients?select=code", `${h}.${p}.${s}`);
    expect(JSON.parse(body)).toEqual([]);
  });

  it("refuses a write into another organisation", async () => {
    const res = await fetch(`${REST}/rest/v1/clients`, {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${mintTenantToken(orgA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "ISOX", name: "Cross", org_id: orgB }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("row-level security");
  });

  it("still refuses the publishable key everything", async () => {
    const { status } = await get("/rest/v1/clients?select=code", ANON);
    expect(status).toBe(401);
  });
});
