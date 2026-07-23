import { describe, it, expect } from "vitest";
import { readPngDimensions } from "./pngHeader";

// A real 1x1 PNG, hex literal — only the first 24 bytes matter for the parse (signature + chunk
// length + "IHDR" + width + height), but we supply the full 33 bytes through the IHDR CRC so the
// fixture is a byte-accurate PNG header, not just a synthetic prefix.
const ONE_BY_ONE_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489";

// Valid PNG signature, valid IHDR tag, but width = 0 (offsets 16–19: 00 00 00 00)
const PNG_ZERO_WIDTH_HEX =
  "89504e470d0a1a0a0000000d49484452000000000000000108060000001f15c489";

// Valid PNG signature, but first chunk type is IDAT (not IHDR) at offsets 12–15
const PNG_NON_IHDR_CHUNK_HEX =
  "89504e470d0a1a0a0000000d49444154000000010000000108060000001f15c489";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

describe("readPngDimensions", () => {
  it("decodes width/height (big-endian) from a real PNG header", () => {
    const bytes = hexToBytes(ONE_BY_ONE_PNG_HEX);
    expect(readPngDimensions(bytes)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for an empty buffer", () => {
    expect(readPngDimensions(new Uint8Array(0))).toBeNull();
  });

  it("returns null for a buffer truncated to just the signature (8 bytes)", () => {
    expect(readPngDimensions(hexToBytes("89504e470d0a1a0a"))).toBeNull();
  });

  it("returns null for a buffer truncated before the height field (20 bytes)", () => {
    expect(readPngDimensions(hexToBytes(ONE_BY_ONE_PNG_HEX).slice(0, 20))).toBeNull();
  });

  it("returns null for JPEG magic bytes", () => {
    const jpeg = hexToBytes("ffd8ffe000104a46494600010100000100010000ffdb0043");
    expect(readPngDimensions(jpeg)).toBeNull();
  });

  it("returns null for garbage input, never throwing", () => {
    expect(() => readPngDimensions(new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(readPngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    const random = new Uint8Array(40).fill(0xab);
    expect(() => readPngDimensions(random)).not.toThrow();
    expect(readPngDimensions(random)).toBeNull();
  });

  it("returns null when width is 0 (guards against 0-width PNG upload)", () => {
    const bytes = hexToBytes(PNG_ZERO_WIDTH_HEX);
    expect(readPngDimensions(bytes)).toBeNull();
  });

  it("returns null when the first chunk is not IHDR", () => {
    const bytes = hexToBytes(PNG_NON_IHDR_CHUNK_HEX);
    expect(readPngDimensions(bytes)).toBeNull();
  });
});
