"use client";

// Leaflet's stylesheet is required — without it the map renders as a broken grey box with
// misplaced tiles.
import "leaflet/dist/leaflet.css";

import { useEffect, useRef } from "react";
import L from "leaflet";
import Link from "next/link";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { boundsOf, type Blip } from "./sitesMapOps";

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Leaflet's default marker icon resolves its image URLs relative to leaflet.css at load time.
 *  Bundlers (Next.js/webpack) rewrite asset paths, so that relative lookup 404s and the default
 *  markers render invisibly. Self-hosting the same images under `public/leaflet/` (copied from
 *  the installed `leaflet` package) sidesteps the broken default resolution without needing
 *  bundler-specific asset-import configuration or a runtime dependency on a third-party CDN. */
const siteIcon = L.icon({
  iconUrl: "/leaflet/marker-icon.png",
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  shadowUrl: "/leaflet/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface SiteMarkerProps {
  blip: Blip;
  clientCode: string;
  selected: boolean;
  onSelect: (id: string) => void;
}

function SiteMarker({ blip, clientCode, selected, onSelect }: SiteMarkerProps) {
  const markerRef = useRef<L.Marker>(null);

  // Lets a selection made elsewhere on the page (e.g. a site list) open this marker's popup.
  useEffect(() => {
    if (selected) {
      markerRef.current?.openPopup();
    }
  }, [selected]);

  const href = `/clients/${encodeURIComponent(clientCode)}/${encodeURIComponent(blip.code)}`;

  return (
    <Marker
      ref={markerRef}
      position={[blip.lat, blip.lng]}
      icon={siteIcon}
      eventHandlers={{ click: () => onSelect(blip.id) }}
    >
      <Popup>
        <div className="space-y-1">
          <p className="font-semibold text-neutral-900">
            {blip.name} <span className="text-neutral-500">({blip.code})</span>
          </p>
          <p className="text-neutral-600">
            {blip.rackCount} {blip.rackCount === 1 ? "rack" : "racks"}
          </p>
          <Link href={href} className="text-blue-700 hover:underline">
            Open site
          </Link>
        </div>
      </Popup>
    </Marker>
  );
}

export interface SitesMapProps {
  blips: Blip[];
  clientCode: string;
  selectedId?: string | null;
  onSelect: (id: string) => void;
}

/** The map itself. Leaflet does not render meaningfully in jsdom, so this component is verified in
 *  a real browser in Task 7 rather than unit-tested here — all the logic worth asserting against
 *  (which sites become blips, what box the map should fit to) lives in `sitesMapOps.ts` and is
 *  covered there. */
export function SitesMap({ blips, clientCode, selectedId, onSelect }: SitesMapProps) {
  const bounds = boundsOf(blips);

  if (!bounds) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      {/* Leaflet collapses to nothing in a container with no explicit height. */}
      <MapContainer bounds={bounds} className="h-[480px] w-full" scrollWheelZoom>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution={OSM_ATTRIBUTION}
        />
        {blips.map((blip) => (
          <SiteMarker
            key={blip.id}
            blip={blip}
            clientCode={clientCode}
            selected={selectedId === blip.id}
            onSelect={onSelect}
          />
        ))}
      </MapContainer>
    </div>
  );
}
