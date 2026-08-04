import { describe, it, expect } from "vitest";
import { isPublicPath } from "./middleware";

describe("isPublicPath", () => {
  it("lets an unauthenticated visitor reach the login page and the OAuth callback", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("protects everything else", () => {
    for (const p of ["/", "/clients", "/clients/URI/HQ", "/settings", "/settings/archive", "/device-library"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("does not let a lookalike path through", () => {
    // "/loginish" and "/auth-ish" must NOT be treated as the login routes.
    expect(isPublicPath("/loginish")).toBe(false);
    expect(isPublicPath("/authx/callback")).toBe(false);
  });
});
