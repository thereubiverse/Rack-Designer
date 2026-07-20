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

  it("returns failed rather than throwing when fetch rejects with a plain network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result.status).toBe("failed");
  });

  it("aborts via the real AbortController after exactly TIMEOUT_MS and returns failed", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves on its own — only rejects if the signal the implementation handed us
      // actually fires its abort event. This proves the real AbortController drives the
      // rejection, not the mock deciding independently.
      const fetchMock = vi.fn().mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      let settled = false;
      const resultPromise = geocodeAddress("12 Main St, Manchester, UK").then((result) => {
        settled = true;
        return result;
      });

      // Just under the timeout: must still be pending.
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      // Cross the 5000ms threshold: must now settle to failed.
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(settled).toBe(true);
      expect(result.status).toBe("failed");

      const [, options] = fetchMock.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("URL-encodes the address into the Nominatim search endpoint with format=jsonv2 and limit=1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ lat: "51.5238", lon: "-0.1586" }])
    );
    vi.stubGlobal("fetch", fetchMock);

    await geocodeAddress("221B Baker St, London, UK");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("https://nominatim.openstreetmap.org/search?");
    expect(url).toContain("format=jsonv2");
    expect(url).toContain("limit=1");
    expect(url).toContain(encodeURIComponent("221B Baker St, London, UK"));
  });

  it("returns failed rather than throwing when the response body fails to parse as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main St, Manchester, UK");

    expect(result).toEqual({ status: "failed", error: "Unexpected token in JSON" });
  });
});
