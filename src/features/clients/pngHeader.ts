const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Pure PNG header decoder — nothing geometric about an uploaded plan is ever trusted from the
 *  client; dimensions are derived from the actual bytes. Never throws: any input that isn't a
 *  well-formed PNG (wrong signature, wrong chunk type, or truncated before offset 24) yields null,
 *  rather than raising, so callers can treat "not a PNG" as ordinary data. */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    if (bytes.length < 24) return null;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return null;
    }
    const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkType !== "IHDR") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}
