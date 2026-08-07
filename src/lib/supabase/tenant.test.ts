import { describe, it, expect, beforeEach } from "vitest";
import { mintTenantToken } from "./tenant";

const SECRET = "test-secret-at-least-32-characters-long!!";

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("mintTenantToken", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });

  it("names the app_tenant role and the organisation", () => {
    const claims = decode(mintTenantToken("11111111-1111-1111-1111-111111111111"));
    expect(claims.role).toBe("app_tenant");
    expect(claims.org_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("expires 60 seconds out", () => {
    const claims = decode(mintTenantToken("11111111-1111-1111-1111-111111111111", 1_000_000));
    expect(claims.exp).toBe(1_000_060);
  });

  it("refuses to mint without an organisation, rather than minting a token with none", () => {
    // A token carrying no org_id reads nothing, so this would present as an empty application
    // rather than an error. Fail at the source instead.
    expect(() => mintTenantToken("")).toThrow(/organisation/i);
  });

  it("refuses to mint with no secret configured", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => mintTenantToken("11111111-1111-1111-1111-111111111111")).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("produces a token whose signature verifies", () => {
    const token = mintTenantToken("11111111-1111-1111-1111-111111111111");
    const [h, p, s] = token.split(".");
    const crypto = require("node:crypto");
    const expected = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });
});
