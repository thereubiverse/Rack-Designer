import { describe, it, expect, afterEach, vi } from "vitest";
import { geocodeAddress } from "./geocode";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  };
}

describe("geocodeAddress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits a vague address to not_found without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St");

    expect(result).toEqual({ status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the Nominatim-required User-Agent header for a good address", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ lat: "53.4808", lon: "-2.2426" }])
    );
    vi.stubGlobal("fetch", fetchMock);

    await geocodeAddress("12 Main St, Manchester, UK");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["User-Agent"]).toBe("rack-designer/1.0");
  });

  it("resolves ok with the parsed coordinates for a well-formed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ lat: "53.4808", lon: "-2.2426" }])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result).toEqual({ status: "ok", lat: 53.4808, lng: -2.2426 });
  });

  it("returns failed on a non-OK HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(null, { ok: false, status: 429 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result.status).toBe("failed");
  });

  it("returns failed rather than throwing when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result.status).toBe("failed");
  });

  it("returns failed rather than throwing when fetch aborts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result.status).toBe("failed");
  });
});
