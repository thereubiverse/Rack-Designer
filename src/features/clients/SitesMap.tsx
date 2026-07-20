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

/** Shared by MapContainer's mount fit and FitBounds' later refits — they must agree, or the map
 *  would jump the first time the bounds changed.
 *
 *  Padding is ASYMMETRIC because the pin is a teardrop anchored at its TIP: its 38px body extends
 *  upward from the coordinate and nothing extends below it. Symmetric padding smaller than the
 *  icon height clipped the topmost pin clean off the map.
 *
 *  maxZoom guards the single-site case: boundsOf returns a zero-area (degenerate) box for one
 *  blip, and with zoomSnap={0} allowing fractional zoom, fitting a zero-area box would otherwise
 *  drive to the tile layer's max (20), slamming a single-site client to street level. */
const FIT_OPTIONS = {
  paddingTopLeft: [32, 48],
  paddingBottomRight: [32, 16],
  maxZoom: 16,
} satisfies L.FitBoundsOptions;

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
  const first = useRef(true);

  useEffect(() => {
    const fit = () => map.fitBounds(bounds, FIT_OPTIONS);

    // The mount fit is done by MapContainer's own `bounds`/`boundsOptions`, so skip it here.
    // Re-fitting immediately after mount is not merely redundant — Leaflet treats fitBounds as
    // a NO-OP when the target view is already close to the current one, and that swallowed the
    // padding: pins ended up clipped off the top edge, and the bug only disappeared if the
    // seeded zoom happened to be far from the answer. Owning the mount fit in exactly one place
    // makes the padded fit unconditional rather than correct by luck.
    if (first.current) {
      first.current = false;
    } else {
      fit();
    }

    // Refit when the container changes size (sidebar collapse, window resize). Leaflet has
    // already re-measured by the time it emits `resize`, so this must not call invalidateSize
    // itself — that would re-emit `resize` and refit against transient mid-layout sizes.
    map.on("resize", fit);
    return () => {
      map.off("resize", fit);
    };
    // `bounds` is intentionally omitted: its identity changes every render, but `key` already
    // captures every value it could vary by.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);

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
      {/* `boundsOptions` is the load-bearing part: without it MapContainer's mount fit runs
          UNPADDED, and a later padded fitBounds is swallowed as a no-op because the view is
          already close — which clipped the topmost pin off the map. Both fits share
          FIT_OPTIONS so they can never drift apart. */}
      <MapContainer
        bounds={bounds}
        boundsOptions={FIT_OPTIONS}
        zoomSnap={0}
        zoomDelta={0.5}
        // Wheel zoom feel. By default every wheel notch fires its own ~250ms eased animation and
        // the map sits frozen between notches — measured as ~225ms of movement followed by ~200ms
        // of nothing, with the easing decelerating so hard that most of each step barely moves.
        // That start-stop cadence is what reads as "slow and choppy"; it was never a frame-rate
        // problem (frames measured at a median 8.3ms with none over 50ms).
        //
        // zoomAnimation is deliberately LEFT ON (Leaflet's default). Turning it off did make the
        // zoom feel immediate, but it also made Leaflet reset the view on every zoom, dropping the
        // old tiles before the new ones loaded — the map blanked completely 14 times during a
        // single fast zoom. The animation is what keeps the existing tiles on screen and CSS-scales
        // them through the transition, so it has to stay.
        //
        // The sluggish feel is fixed instead by shortening Leaflet's stock 0.25s zoom transition to
        // 90ms in globals.css, and by cutting the wheel debounce below, which together give the
        // responsiveness without the blanking.
        wheelDebounceTime={10}
        // Leaflet's default: higher = less zoom per unit of scroll. Left at the default on
        // purpose. Damping the magnitude (80 and 120 were both tried) was only worth doing while
        // the animation was off and each step landed instantly; with the 90ms transition back in
        // place the transition itself does the smoothing, so shrinking the steps as well just
        // makes the map feel sluggish again — measured as 1.13x zoom per gesture at 80 versus
        // 1.86x. This is the one number to tune if the feel is off.
        wheelPxPerZoomLevel={60}
        className="h-[480px] w-full"
        scrollWheelZoom
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={20}
          attribution={MAP_ATTRIBUTION}
          // Don't fetch tiles mid-gesture: while zooming, every intermediate level would request
          // a full screen of tiles that is discarded a frame later. Waiting until the zoom settles
          // removes that churn, and the scaled existing tiles cover the gap.
          updateWhenZooming={false}
          // Keep a wider ring of off-screen tiles (default 2) so there is already-loaded imagery
          // to scale into view instead of blank space.
          keepBuffer={4}
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
