"use client";

// Leaflet's stylesheet is required — without it the map renders as a broken grey box with
// misplaced tiles.
import "leaflet/dist/leaflet.css";

import { useEffect, useRef } from "react";
import L from "leaflet";
import Link from "next/link";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import { boundsOf, type Blip, type LatLngBounds } from "./sitesMapOps";

// CARTO Positron is a key-free, near-greyscale basemap (Mapbox Light's usage-free equivalent).
// Both OpenStreetMap (source data) and CARTO (tile styling/hosting) require attribution on the
// map itself — this isn't optional styling, it's each provider's usage policy.
const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

// A black teardrop pin with a white building glyph knocked out of the centre, matching
// PatchDocs' marker aesthetic (drawn from scratch here, not lifted from their asset). Inline SVG
// via L.divIcon keeps this self-contained: no extra network request, no CDN, no bundler asset
// pipeline the way the old self-hosted `public/leaflet/*.png` icons needed.
const SITE_PIN_SVG = `
<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.268 21.732 0 14 0z" fill="#171717"/>
  <rect x="9" y="7" width="10" height="13" rx="1" fill="#ffffff"/>
  <rect x="11" y="9.5" width="2" height="2" fill="#171717"/>
  <rect x="15" y="9.5" width="2" height="2" fill="#171717"/>
  <rect x="11" y="13" width="2" height="2" fill="#171717"/>
  <rect x="15" y="13" width="2" height="2" fill="#171717"/>
  <rect x="12" y="16.5" width="4" height="3.5" fill="#171717"/>
</svg>`;

const siteIcon = L.divIcon({
  html: SITE_PIN_SVG,
  // Overrides Leaflet's default divIcon className ("leaflet-div-icon", which carries a white
  // background + grey border) so no box renders behind the pin — see the matching rule in
  // globals.css that also neutralises it defensively.
  className: "site-pin-icon",
  iconSize: [28, 38],
  // The anchor is the pin's tip, not its centre/bounding-box corner — otherwise every site would
  // render offset from its true coordinate.
  iconAnchor: [14, 38],
  popupAnchor: [0, -34],
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

interface FitBoundsProps {
  bounds: LatLngBounds;
}

/** Refits the map viewport whenever `bounds` changes — e.g. a site gains coordinates after
 *  Locate, or `SitesMap` is reused across a client navigation. `MapContainer`'s `bounds` prop
 *  only applies at mount, so without this the map would stay frozen on its initial fit forever.
 *
 *  Must live inside `MapContainer`: `useMap()` only works within its context, which is why this
 *  is a child component rather than logic inlined into `SitesMap` itself.
 *
 *  The effect is keyed on `key`, a stable string built from the bounds' four numbers — NOT on
 *  `bounds` itself. `boundsOf` returns a fresh array every render, so depending on the array
 *  identity would refit on every render, fighting the user's own panning/zooming. Depending on
 *  the primitive value means the effect only fires when the actual box changes. */
function FitBounds({ bounds }: FitBoundsProps) {
  const map = useMap();
  const key = bounds.flat().join(",");

  useEffect(() => {
    // maxZoom guards the single-site case: boundsOf returns a zero-area (degenerate) box when
    // there is exactly one blip. With zoomSnap={0} allowing fractional zoom, fitBounds on a
    // zero-area box can otherwise drive the zoom to the map's maximum (20, per the TileLayer),
    // slamming a single-site client to street level. 16 is a reasonable "one building" zoom.
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    // `bounds` is intentionally omitted: its identity changes every render, but `key` already
    // captures every value it could vary by.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
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
      <MapContainer
        bounds={bounds}
        zoomSnap={0}
        zoomDelta={0.5}
        className="h-[480px] w-full"
        scrollWheelZoom
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={20}
          attribution={MAP_ATTRIBUTION}
        />
        <FitBounds bounds={bounds} />
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
