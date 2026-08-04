import { describe, it, expect } from "vitest";
import {
  cleanProfileFields, checkAvatar, checkNewPassword,
  MAX_AVATAR_BYTES, MIN_PASSWORD_LENGTH,
} from "./profileRules";

describe("cleanProfileFields", () => {
  it("trims every field and turns anything missing into an empty string", () => {
    expect(cleanProfileFields({ name: "  Reuben Singh  ", phone: undefined }))
      .toEqual({ name: "Reuben Singh", phone: "", position: "", address: "" });
  });

  it("keeps interior whitespace, because addresses have line breaks and names have spaces", () => {
    const out = cleanProfileFields({ address: "  12 Main St\nSuite 4  " });
    expect(out.address).toBe("12 Main St\nSuite 4");
  });
});

describe("checkAvatar", () => {
  it("accepts an ordinary image", () => {
    expect(checkAvatar({ size: 1024, type: "image/png" })).toBeNull();
  });

  it("rejects one byte over the cap", () => {
    expect(checkAvatar({ size: MAX_AVATAR_BYTES + 1, type: "image/png" })).toMatch(/2 MB/);
  });

  it("accepts exactly the cap, so the boundary is not off by one", () => {
    expect(checkAvatar({ size: MAX_AVATAR_BYTES, type: "image/jpeg" })).toBeNull();
  });

  it("rejects a non-image even when it is small", () => {
    expect(checkAvatar({ size: 10, type: "text/plain" })).toMatch(/image/i);
  });

  it("rejects an empty file, which is what an aborted upload looks like", () => {
    expect(checkAvatar({ size: 0, type: "image/png" })).not.toBeNull();
  });
});

describe("checkNewPassword", () => {
  it("accepts a valid change", () => {
    expect(checkNewPassword("oldpass", "newpass", "newpass")).toBeNull();
  });

  it("requires the current password, so the re-authentication has something to check", () => {
    expect(checkNewPassword("", "newpass", "newpass")).not.toBeNull();
  });

  it("rejects a mismatched confirmation", () => {
    expect(checkNewPassword("oldpass", "newpass", "newpazz")).toMatch(/match/i);
  });

  it("rejects a new password shorter than the minimum", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(checkNewPassword("oldpass", short, short)).toMatch(new RegExp(String(MIN_PASSWORD_LENGTH)));
  });

  it("rejects reusing the current password", () => {
    expect(checkNewPassword("samepass", "samepass", "samepass")).toMatch(/different/i);
  });
});
