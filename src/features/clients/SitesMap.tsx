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

/** Zoom granularity while the user drives. Only the fit itself is fully fractional.
 *
 *  This single number is the entire feel of the wheel zoom, because Leaflet's wheel handler does
 *      d4 = snap ? Math.ceil(d3 / snap) * snap : d3
 *  — Math.ceil, NOT round. Every scroll is forced UP to a whole snap unit, so the snap value is a
 *  hard FLOOR on how small a zoom step can be:
 *      1     -> 100% scale per step (the gentlest flick doubles the map: unusable)
 *      0.25  ->  19% per step (still visibly stepped)
 *      0.1   ->   7% per step  <- here
 *      0     -> continuous, but then pins visibly wiggle: Leaflet positions markers with .round(),
 *               i.e. whole pixels, while tiles scale continuously, so the pins drift against the
 *               map as the zoom changes.
 *
 *  Lower is smoother but edges back toward that wiggle, so this is the dial to turn if the feel is
 *  wrong. Removing the trade-off properly means stopping Leaflet rounding marker positions — that
 *  was attempted (overriding Marker.update and Marker._animateZoom to drop the .round()) and
 *  REVERTED, because measurement could not show it helping and an unproven patch of two library
 *  internals is not worth carrying. */
const INTERACTIVE_ZOOM_SNAP = 0.1;

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

/** Snap used while PINCHING, as opposed to scrolling.
 *
 *  A macOS trackpad pinch is not a touch gesture — it arrives as a wheel event with ctrlKey set,
 *  so Leaflet runs it through the same handler as a scroll wheel. That is a problem, because the
 *  snap value is a FLOOR (Math.ceil), and the two gestures have opposite needs:
 *
 *    scroll — a few large discrete notches. A floor is GOOD: it guarantees each notch does
 *             something visible.
 *    pinch  — a continuous stream of tiny deltas. A floor is BAD: it amplifies each one. A single
 *             pinch event's proportional zoom is around 0.018 levels; the 0.1 scroll floor rounds
 *             that up by roughly 5x, so a gentle pinch tore through 0.84 zoom levels.
 *
 *  A much finer floor lets pinch stay proportional to the fingers while still snapping enough to
 *  keep the pins from drifting the way fully continuous zoom does. */
const PINCH_ZOOM_SNAP = 0.02;

/** Switches the zoom granularity to match the gesture, since Leaflet cannot tell them apart.
 *  Leaflet reads `zoomSnap` inside its debounced `_performZoom`, which runs on a timer AFTER the
 *  wheel event, so setting the option from a wheel listener always lands in time. */
function GestureAwareZoom() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const onWheel = (e: WheelEvent) => {
      map.options.zoomSnap = e.ctrlKey ? PINCH_ZOOM_SNAP : INTERACTIVE_ZOOM_SNAP;
    };
    container.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [map]);

  return null;
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
  const first = useRef(true);

  useEffect(() => {
    // Fit with FRACTIONAL zoom, then hand the map back to the user with INTEGER zoom.
    //
    // These genuinely conflict. zoomSnap=0 is what lets fitBounds pick the exact zoom (it took the
    // fit from 51% to 87% of the frame — snapping rounds DOWN a whole power-of-two level). But
    // leaving it at 0 makes every wheel event complete a fractional zoom, and L.Marker.update()
    // positions markers with `.round()` — integer pixels — while tiles scale continuously. So the
    // pins re-round against smoothly-scaling tiles and visibly wiggle instead of staying welded to
    // the map. It also means a transition restart per wheel event, which Safari composites far
    // worse than Chrome.
    //
    // fitBounds reads zoomSnap synchronously to compute its target zoom, so flipping it around the
    // call gets both: an exact fit, and whole-level zooms for interaction.
    const fit = () => {
      const snap = map.options.zoomSnap;
      map.options.zoomSnap = 0;
      map.fitBounds(bounds, FIT_OPTIONS);
      map.options.zoomSnap = snap;
    };

    // The mount fit is done by MapContainer's own `bounds`/`boundsOptions`, so skip it here.
    // Re-fitting immediately after mount is not merely redundant — Leaflet treats fitBounds as
    // a NO-OP when the target view is already close to the current one, and that swallowed the
    // padding: pins ended up clipped off the top edge, and the bug only disappeared if the
    // seeded zoom happened to be far from the answer. Owning the mount fit in exactly one place
    // makes the padded fit unconditional rather than correct by luck.
    if (first.current) {
      first.current = false;
      // MapContainer's own mount fit already ran, using the zoomSnap={0} prop, so it is exact.
      // Hand interaction back to whole-level zooms now that it's done.
      map.options.zoomSnap = INTERACTIVE_ZOOM_SNAP;
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
    // No `overflow-hidden` here on purpose — see the .leaflet-container rule in globals.css.
    // An ancestor combining overflow:hidden with border-radius forces Safari to re-rasterize a
    // rounded clip over transform-animating descendants (the whole tile grid plus every marker),
    // which Chrome composites cheaply. The rounding is applied to the map element itself instead.
    <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      {/* Leaflet collapses to nothing in a container with no explicit height. */}
      {/* `boundsOptions` is the load-bearing part: without it MapContainer's mount fit runs
          UNPADDED, and a later padded fitBounds is swallowed as a no-op because the view is
          already close — which clipped the topmost pin off the map. Both fits share
          FIT_OPTIONS so they can never drift apart. */}
      <MapContainer
        bounds={bounds}
        boundsOptions={FIT_OPTIONS}
        // zoomSnap=0 applies ONLY to MapContainer's mount fit, which needs fractional zoom to land
        // exactly — snapping rounds down a whole power-of-two level and wasted half the frame
        // (51% of the viewport used, versus 87% now). FitBounds flips it to INTERACTIVE_ZOOM_SNAP
        // immediately after mount; see the long note there for why fractional zoom makes the pins
        // wiggle loose from the map.
        zoomSnap={0}
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
        // 90ms in globals.css.
        //
        // wheelDebounceTime, wheelPxPerZoomLevel and zoomDelta are all left at Leaflet's DEFAULTS
        // on purpose. Earlier versions tuned them (10ms / 80 / 0.5) for CONTINUOUS zoom, where the
        // goal was many tiny instant steps. With whole-level snapping that calculus inverts: a
        // 10ms debounce would let a single flick jump several zoom levels at once. The defaults
        // are the right values for snapped zoom.
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
        <GestureAwareZoom />
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
