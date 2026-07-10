# Device Wizard — AI port detection design

**Date:** 2026-07-09
**Status:** Design approved, pending spec review

## Problem

Building a new rack device today means hand-placing every port group in the
device editor — tedious and error-prone for a switch with 24–48 ports plus SFP
cages. We want an "AI device" affordance: point it at a device and have it
detect the ports (and basic metadata) automatically, producing an editable
draft rather than a finished device.

## Goal

From a **front-panel photo** of a device (uploaded, or best-effort fetched by
model name), produce an **editable device draft** — port groups plus device
name/brand/width/rack-units — that lands in the existing editor for the user to
review, correct, and save. Accuracy to the real panel matters; the user always
has the final say.

## Settled decisions (from brainstorming)

- **Detection source: vision.** A photo of the panel is the source of truth
  (chosen over the model's own knowledge or web/datasheet text).
- **Photo source: both.** Fetch a candidate image by model name *and* allow
  upload. Upload is the reliable core; name-fetch is best-effort convenience and
  is always overridable by upload.
- **Per-face.** The wizard runs on whichever face (front/back) is being edited,
  reusing one pipeline. The back is not auto-detected unless the user runs the
  wizard on the back with a back-panel photo.
- **Architecture: two-stage (Approach A).** The model returns a *semantic*
  description; our own deterministic code does the *geometry*. This is the most
  testable, the safest against bad model output, and keeps AI-built devices
  identical in structure to hand-built ones.
- **Free-leaning stack.** Vision = **Gemini Flash free tier** (behind a
  pluggable `visionBackend`, so a fine-tuned in-code ONNX model can replace it
  later — no accurate off-the-shelf in-code port detector exists today). Search =
  self-hosted **SearXNG** running as a background Docker Compose service (keyless).
  Both free; the only host requirement (Docker) is already met by local Supabase.

## Architecture & data flow

```
[Device editor, editing FRONT or BACK]
        │  click the Device Wizard icon (header)
        ▼
  Device Wizard panel (inline, slides out from behind the icon)
        │  model name  +/or  uploaded image
        ▼
  identifyDevice()  ── "use server"  (queries local SearXNG; best-effort, skippable)
        │  DeviceMatch { name, brand, widthIn, rackUnits, imageUrl, source }
        ▼
  detectPorts()     ── "use server"  (the ONLY unit that calls the vision model)
        │  DetectedFace  (validated semantic JSON — no pixels)
        ▼
  layoutDetectedFace()  ── pure function
        │  Face  (PortGroup[] on the editor grid + FaceElement[])
        ▼
  merge into the current face as an editable DRAFT
        (never auto-saved — reviewed & saved in the editor)
```

### New units (each one job, well-bounded)

| Unit | Kind | Responsibility |
| --- | --- | --- |
| `DeviceWizard.tsx` | client | Icon entry point + slide-out panel; drives the states below. Acts on the current face. |
| `identifyDevice` | server action | Given a model name, query the local **SearXNG** JSON API (keyless) for a `DeviceMatch` (image URL + parsed metadata). Isolated so it can fail/skip independently. |
| `detectPorts` | server action | Given an image (+ optional model hint), call the vision backend (**Gemini Flash**) with structured output, validate, return a `DetectedFace`. Only place that talks to the model. |
| `visionBackend` | server iface | Thin pluggable interface behind `detectPorts` (`detect(image, hint) → DetectedFace`). First impl = Gemini; a local ONNX/fine-tuned impl can drop in later with no caller changes. |
| `layoutDetectedFace.ts` | pure fn | `DetectedFace + dims → Face`. All geometry, deterministic, unit-tested (mirrors `rackOps`). |
| `aiDetect` types + validation | shared | The `DetectedGroup` / `DetectedFace` / `DeviceMatch` contract and validators. |

The existing editor, `PortGroup`/`Face` model, faceplate renderer, and save
flow are **untouched** — the wizard only produces a draft that flows into them.

## The semantic contract

The model never sees our pixel grid. It returns a semantic description we
validate hard, then lay out ourselves.

```ts
interface DetectedGroup {
  media: Media;                 // must be one of MEDIA
  connector: string;            // must be in CONNECTORS[media]
  count: number;                // 1–96 total ports in this block
  rows: number;                 // 1–4, how the block is stacked
  order: CountingDirection;     // ltr | rtl | ttb | btt
  labelPrefix?: string;         // "Gi", "Te" → idPrefix
  // Position as fractions of the device's OWN front panel (0,0 = top-left,
  // 1,1 = bottom-right) so crop/background can't skew it.
  bbox: { x: number; y: number; w: number; h: number };
}

interface DetectedFace {          // from the vision pass on the image
  groups: DetectedGroup[];
  modelText?: string;             // model string read off the panel
  brand?: string;                 // silkscreen brand
  rackUnits?: number;             // from panel proportions
  widthIn?: number;               // body width; defaults full-width if unsure
  labels?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[];
  confidence: "high" | "medium" | "low";
  notes?: string;                 // e.g. "back panel partly obscured"
}

interface DeviceMatch {           // from the name-search/identify step
  name: string;                   // "Catalyst 9200 24-port"
  brand: string;                  // "Cisco"
  widthIn: number;                // body width (inches)
  rackUnits: number;              // height
  imageUrl: string;               // candidate panel image
  source: string;                 // where it came from
}
```

Enforced at the model boundary via **structured output** (Gemini
`responseSchema` JSON mode), so the reply must match this shape — we do not
parse free text. We still validate the parsed result (below), since a free-tier
model can return schema-valid-but-wrong values.

### Validation (in `detectPorts`, before anything reaches the client)

- `media` not in `MEDIA` → drop the group (map obvious synonyms, e.g.
  "ethernet" → `copper`).
- `connector` not in `CONNECTORS[media]` → fall back to that media's first
  connector.
- `count`, `rows` clamped to sane ranges; `bbox` values clamped to 0–1.
- A group whose ports cannot fit the device width is **flagged**, not silently
  placed.
- Malformed output → a typed "couldn't read a device from this image" error,
  never a crash or a half-built device.

## Layout mapping — `layoutDetectedFace` (pure)

```ts
function layoutDetectedFace(face: DetectedFace, dims: { widthIn: number; rackUnits: number }): Face
```

Per detected group:

1. **Columns/rows** — `cols = ceil(count / rows)` (a 24-port 2-row block →
   12×2), matching the editor's own layout.
2. **Grid placement** — `gridX = snap(bbox.x · bodyWidthPx)`,
   `gridY = snap(bbox.y · heightPx)`, snapped to `GRID_PX` (12px). On multi-RU
   devices, set `yOffset` from `bbox.y` so the block sits at the right height.
3. **De-overlap** — snapped boxes that collide (vision boxes are approximate)
   nudge the later group to the next free grid cell along its axis, preserving
   detected order.
4. **Identity** — `idPrefix` from `labelPrefix` (media-based default otherwise);
   `countingDirection` from `order`.
5. **Labels/logo** — `labels` → `TextElement`s at their snapped `bbox`
   positions; a recognized brand becomes a text/icon element when a matching
   brand asset exists.

Output is a normal `Face`, indistinguishable from a hand-built one — so it flows
through the editor, renderer, and save path with zero special-casing.

**Key property:** all geometry lives here, deterministically. The model's job
ends at "what ports, roughly where"; pixel-exact, grid-aligned, non-overlapping
placement is our code — which is why it is testable and consistent.

## UI — entry point, reveal & states

**Entry point:** an **icon-only** Device Wizard button in the editor's top
header row, beside the "Rack Device Editor" title. A **blue** wand/sparkle
glyph — **no text label, no background, no hover highlight**, just the blue
icon. Hover shows a **"Device Wizard"** tooltip.

**Reveal:** on click, a container to the **right of the icon** animates open and
the **search bar + upload button slide out smoothly to the right, from behind
the icon** — an `overflow-hidden` strip transitioning `max-width`/opacity with
the contents `translateX`-easing out from behind the glyph. Clicking the icon
again slides it back.

**States (all within/attached to the opened strip, acting on the current
face):**

- **Input** — model-name search bar + upload button (drag/drop or file-pick).
  Upload is always present as the reliable path.
- **Candidate** (after a name search) — the fetched image + `DeviceMatch`
  fields (name / brand / width / rack-units) with **Confirm** or **Override /
  upload your own**. Confirm pre-fills the draft metadata and runs vision on the
  candidate image; Override lets the user edit any field and/or upload instead.
- **Detecting** — spinner (a few seconds), cancelable.
- **Review** — a summary shown *before* applying: e.g. "Detected 24× RJ45
  (copper), 4× SFP+ — confidence: medium ⚠ back panel partly obscured", with
  **Apply to face** / **Discard**. Low confidence shows a "double-check this"
  warning.
- **Error** — "Couldn't read a device from this image" with retry / upload-again.

**Apply** merges the laid-out `Face` into the draft (replacing that face's
groups) and pre-fills device name/brand/width/rack-units where empty or where a
match was confirmed. The user lands back in the editor with everything editable.
**Nothing is saved** until the user saves the device.

Vision also independently reads brand/model/RU/width off the panel, so a pure
upload (no name search) still attempts auto-fill; where the identify step and
the vision read disagree, `confidence`/`notes` flag it.

## Server actions & dependencies

**Vision — `detectPorts` (Gemini free tier, pluggable):**
- **New dependency:** `@google/generative-ai` and a server-only `GEMINI_API_KEY`
  (free Google AI Studio key). Uses a Gemini Flash **vision** model with JSON
  structured output (`responseSchema`) so the reply matches the `DetectedFace`
  contract. Key stays server-side, never in the browser. Free tier is rate-
  limited but ample for an internal tool.
- Sits behind a thin `visionBackend` interface, so a future **in-code** model
  (fine-tuned Florence-2 / YOLO via `onnxruntime-node`, no external service) can
  replace Gemini without touching `detectPorts`' callers, validation, or the UI.
  No off-the-shelf in-code model classifies network ports accurately today, so
  Gemini is the first backend.

**Search — `identifyDevice` (SearXNG, free & keyless):**
- Runs **SearXNG** as a background service in the existing **Docker Compose**
  stack (alongside local Supabase); no API key, no per-engine limits. The action
  calls its JSON API (`/search?format=json`) with the model name, takes the top
  product-image URL + result title/snippet, parses `DeviceMatch` metadata
  (name/brand, best-effort width/RU), fetches the image server-side, and hands
  it to `detectPorts`.
- Separate action so search and vision stay isolated, independently testable,
  and individually skippable — name-fetch can fail or return a poor candidate
  without blocking the upload path. (If SearXNG is unreachable, the wizard
  degrades to upload-only.)

- **Image storage** in Supabase (to keep a device's source photo) is optional
  and off for the first slice.

## Safety

- **Prompt injection:** the model name, any fetched web page / datasheet text,
  and silkscreen text the vision reads are **untrusted data, never
  instructions.** The actions only extract from them; nothing found in them is
  executed or followed. Detected `labels`/`notes` render as plain text.
- **No side effects from AI:** the pipeline only ever produces a *draft*. Save
  remains a separate, explicit user action.
- **Cost/latency:** internal tool, low volume — a per-call guard plus loading
  states cover it. Uploads are size-capped before send.

## Testing

- `layoutDetectedFace` — pure unit tests: column/row derivation, grid snapping,
  `yOffset` on multi-RU, de-overlap, identity seeding, labels → elements.
- Validation — unit tests for enum coercion/dropping, clamping, over-width
  flagging, malformed-input → typed error.
- Server actions — tested against a mocked `visionBackend` and a mocked SearXNG
  HTTP response (fixture `DetectedFace` / `DeviceMatch`); no live API calls or
  network in tests. Includes the SearXNG-unreachable → upload-only degrade path.
- `DeviceWizard` — component tests for the slide-out reveal, state transitions
  (input → candidate → detecting → review → apply/discard), Confirm/Override,
  and that Apply mutates only the draft (never triggers a save).

## Staging

The first slice ships **both** photo sources:

1. **First slice:** icon + slide-out; **name-fetch (`identifyDevice`) AND
   upload**; candidate/confirm step; `detectPorts`; `layoutDetectedFace`;
   review/apply; metadata auto-fill from both the identify step and the vision
   read. Upload remains the reliable fallback whenever name-fetch returns a poor
   or wrong candidate.
2. **Later (optional):** store source photo in Supabase; bounding-box overlay
   confirmation (brainstorming Approach C) for pixel-accurate placement.

Because name-fetch is in the first slice, `identifyDevice` and `detectPorts` are
built together; the reliability caveat on auto-fetching a clean panel shot is
mitigated by the confirm step and the always-available upload fallback.

## Out of scope

- Detecting both faces from a single photo (per-face by design).
- A curated device database / offline model catalog.
- Auto-saving or bulk import of many devices at once.

## Prerequisites

- Add `@google/generative-ai` + a free server-only `GEMINI_API_KEY` (Google AI
  Studio) for the vision backend.
- Add a **SearXNG** service to the Docker Compose stack (with JSON output
  enabled) for keyless search; the app reaches it over the Compose network.
- Both are free; no per-use billing. The only host requirement (Docker) is
  already met by the local Supabase setup.
