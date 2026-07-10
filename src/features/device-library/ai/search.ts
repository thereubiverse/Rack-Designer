import "server-only";
import { searchImages, search, SafeSearchType } from "duck-duck-scrape";
import type { DeviceMatch } from "./aiDetect";

export interface SearchHit { title: string; description: string; imageUrl: string; source: string }
export interface Searcher { find(modelName: string): Promise<SearchHit | null> }

// Small, extensible brand list; matched case-insensitively against the result title.
const KNOWN_BRANDS = ["Cisco", "Ubiquiti", "Netgear", "HPE", "Aruba", "Juniper", "MikroTik", "Dell", "TP-Link", "Fortinet", "Palo Alto", "Meraki", "Brocade", "Arista"];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function parseDeviceMatch(hit: SearchHit, modelName: string): DeviceMatch {
  const text = `${hit.title} ${hit.description}`;
  const brand = KNOWN_BRANDS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(text)) ?? "";
  const ruMatch = text.match(/(\d+)\s?(?:U|RU)\b/i);
  const rackUnits = ruMatch ? clamp(parseInt(ruMatch[1], 10), 1, 4) : 1;
  const name = hit.title.trim() || modelName;
  return { name, brand, widthIn: 17.5, rackUnits, imageUrl: hit.imageUrl, source: hit.source };
}

export const duckDuckGoSearcher: Searcher = {
  async find(modelName) {
    const query = `${modelName} network device front panel`;
    const imgs = await searchImages(query, { safeSearch: SafeSearchType.MODERATE });
    const first = imgs.results?.[0];
    if (!first?.image) return null;
    let description = "";
    let title = first.title ?? modelName;
    try {
      const web = await search(modelName);
      const w = web.results?.[0];
      if (w) { description = w.description ?? ""; if (!first.title) title = w.title ?? title; }
    } catch { /* web result is optional; image + model name are enough */ }
    return { title, description, imageUrl: first.image, source: "duckduckgo" };
  },
};
