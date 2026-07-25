# Floor Plan AI Discovery (Slice C) — Design

## 0. Where this sits — the four-slice roadmap

| Slice | Delivers | Status |
|---|---|---|
| A | Floor tabs, floor/room CRUD, `floor_devices` inventory | **MERGED** (a029832, 2026-07-22) |
| B | Plan upload + storage + manual mapping editor | **MERGED** (2026-07-23; polished through 2026-07-25) |
| **C (this spec)** | AI discovery: Gemini reads the plan, proposes room polygons/names and device pins; user fine-tunes and accepts in B's editor | designing |
| D | Port linkage: ports reference floor devices; room/device picker in port settings; `described`-endpoint migration | after A (UI benefits from B) |

Binding facts this slice builds on:

- **B's canvas is a projection.** Rooms carry `plan_polygon` (normalized `[x,y]` 0..1 vertices); placed devices carry `x,y` (normalized 0..1). Placement is **both-non-null** (`!= null`, never falsy — `x === 0` is a real placement). Clearing a placement never deletes a row.
- **Devices are a unified inventory** (Slice A). A `floor_device` exists whether or not it is placed. Devices never silently vanish — the Slice A lists are the backstop.
- **A device must reference a `category='floor'` device type.** The seeded floor types are `CAM, AP, TO, RK, ACP, PH, PR, SCR, DP, LP, 3DP, ISP`. Codes are site-unique, prefix + zero-padded number (`suggestDeviceCode`).
- **Rooms** carry `{ code, name?, type: MDF|IDF|other }` plus the optional polygon.
- **The AI stack already exists** and is reused wholesale: `@google/generative-ai`, model `gemini-3-flash-preview`, a `server-only` structured-JSON backend with 503/429 retry+backoff and a prompt-injection guard, and a validate/normalize discipline (`aiDetect.ts`) that clamps every number, coerces enums, drops junk, and defaults confidence to `low`. Key resolved via `resolveGeminiKey(dbSettingsStore)` (DB settings, `GEMINI_API_KEY` env fallback); missing key surfaces as `no-key`.

## 1. Decisions taken

| Decision | Choice |
|---|---|
| Entry point | A **Wizard** button (wand icon) in the plan's left toolbar, opening a dropdown with **two independent passes**: *Discover rooms* and *Discover devices*. Separate calls with focused prompts — the user's explicit call, for accuracy over a single combined pass |
| What the AI returns | Normalized **0..1** geometry (fractions of the plan image): rooms as polygon vertex arrays + a name and a type guess; devices as a point + a floor-type guess + the `label` text read off the plan + a confidence |
| Where results land | **Staged review layer** — proposals render as a distinct ghost overlay, committed to NOTHING until accepted (Approach A below). Client-held, ephemeral |
| Fine-tuning while staged | Proposals are **editable in place** before accept: drag a proposed pin; edit proposed room walls (vertex drag / insert / delete, reusing B's vertex tooling); edit name / type / code in a proposal panel |
| Accept / dismiss | Per-proposal **Accept** / **Dismiss**, plus **Accept all** / **Dismiss all** in the wizard panel |
| Device matching (accept) | **Match existing, create the rest.** The proposal's `label` is matched (case-insensitive) against existing **unplaced** inventory device codes → place that device, keep its code. No match → create a new device (inferred type, `status:'planned'`, code = the plan label if free & well-formed, else `suggestDeviceCode`) then place it |
| Room matching (accept) | Match the proposal name (case-insensitive) against existing rooms **lacking a polygon** → attach the polygon. No match → create a new room (name from label, `type:'other'` unless it reads clearly as MDF/IDF) then set its polygon |
| Unknown device type | Coerce to a known floor type; unrecognized → **`TO`** (a safe, common default the user re-types in staging) |
| Schema / storage | **No migration.** Slice B's tables cover everything; proposals never touch the DB until accepted, and then only via existing create/placement actions |
| Missing Gemini key | Same `no-key` path as the device wizard — point the user to Settings; no discovery attempted |
| Proposal cap | Each pass caps at **40 proposals** (drop the tail, `log`/console the count dropped) so a noisy plan can't flood the overlay |
| Accuracy posture | Vision models localize roughly on dense CAD plans. Proposals are a **starting point**; the edit-while-staged step is what makes the slice useful. The prompt and copy set this expectation |

## 2. Architecture — Approach A (client-held ephemeral proposals)

The discovery action calls Gemini, validates/normalizes, and **returns** a proposal set. It writes nothing. Proposals live in React state inside `FloorPlanCanvas` (or a thin sibling) as editable ghost objects. **Accept** commits through the existing Slice A/B actions (`createRoom`, `setRoomPolygon`, `createFloorDevice`, `placeFloorDevice`); **Dismiss** drops from state. Reloading the page discards un-accepted proposals — re-running a pass is cheap and is the intended way to "start over".

Rejected alternatives:

- **Persisted `plan_proposals` table** — survives reload, but a migration + extra actions + cleanup for a fundamentally throwaway artifact. Overkill.
- **Direct-create with a `proposed` flag** — pollutes the Slice A inventory lists with un-accepted guesses and fights the never-vanish invariant. Rejected.

Proposal shapes (client types, no DB):

```ts
type RoomProposal = {
  id: string;              // client-generated (crypto.randomUUID) — overlay key, not a DB id
  name: string;            // editable; from the plan label
  roomType: RoomType;      // MDF | IDF | other — editable
  polygon: NormPoint[];    // editable via vertex tooling
  confidence: "high" | "medium" | "low";
};

type DeviceProposal = {
  id: string;              // client-generated
  label: string;           // editable; the code read off the plan (drives matching)
  typeCode: string;        // a category='floor' type code — editable
  point: NormPoint;        // editable via drag
  confidence: "high" | "medium" | "low";
  // Resolved at accept time, not stored: match against unplaced inventory by label.
};
```

## 3. Server layer

Two `"use server"` actions in `src/features/clients/discoverActions.ts`:

- `discoverRoomsAction(floorId: string): Promise<DiscoverRoomsResult>`
- `discoverDevicesAction(floorId: string): Promise<DiscoverDevicesResult>`

Each:

1. Loads the floor's plan row (`getFloorPlan`); no plan → `{ ok:false, error:"Upload a plan first." }`.
2. Resolves the Gemini key (`resolveGeminiKey`); missing → `{ ok:false, error:"no-key" }`.
3. Fetches the stored PNG bytes and base64-encodes them (via a `createPlanSignedUrl` fetch, or a direct storage download helper `downloadPlanObject` in `planStorage.ts`, server-side).
4. Calls `planVisionBackend.discoverRooms` / `.discoverDevices` (new `src/features/clients/ai/planVisionBackend.ts`, `server-only`), mirroring `visionBackend.ts`: `gemini-3-flash-preview`, `generationConfig.responseSchema`, 503/429 `TRANSIENT` retry with the same backoff.
5. Validates/normalizes via `planDetect.ts` (§4) and returns `{ ok:true, proposals }`, capped at 40.

**Trust posture (non-negotiable, same as Slice B):**

- `floorId` is the only client input; the plan (and its `site_id`) is derived from the floor row server-side.
- **All plan text is data, never instructions.** The prompt states this explicitly (injection guard) and the label text is only ever transcribed, never executed.
- Every returned coordinate is clamped to 0..1 and every device type coerced to the known floor-type set. Nothing geometry- or type-shaped is trusted raw.

**Prompts (focused, one per pass).** Rooms: "You are reading an architectural/telecom floor plan. Identify enclosed rooms/spaces. For each, return its polygon as an ordered list of `[x,y]` vertices in 0..1 fractions of the WHOLE image (0,0 = top-left), the room's printed name/label, and a type (`MDF`/`IDF`/`other`)…". Devices: "Identify network/telecom device symbols (cameras, access points, telecom outlets, racks, phones, screens, printers, access-control panels…). For each, return a single point `[x,y]` in 0..1 fractions of the whole image, the printed label if any, the device type as one of `[CAM, AP, TO, RK, ACP, PH, PR, SCR, DP, LP, 3DP, ISP]`, and a confidence…". Both prompts end with the injection guard and "if unsure, use lower confidence".

**Structured `responseSchema`** (per pass): rooms → `{ rooms: [{ name, roomType, polygon: [[number,number]…], confidence }], notes }`; devices → `{ devices: [{ label, typeCode, x, y, confidence }], notes }`. `required` kept minimal (the validator fills the rest); the model is free-tier and may return shape-valid, value-wrong output — the validator is the guard.

## 4. Validation / normalization — `planDetect.ts` (pure, TDD)

Mirrors `aiDetect.ts`. Never throws on any input.

- `FLOOR_TYPE_CODES` = the seeded floor-type set. `coerceTypeCode(v)` → a known code, unknown/junk → `"TO"`. Case-insensitive; a few synonyms (`accesspoint→AP`, `wap→AP`, `outlet→TO`, `screen→SCR`, `display→SCR`).
- `coercePoint(v)` → `[clamp01(x), clamp01(y)]` or null if not two finite numbers.
- `coercePolygon(v)` → array of coerced points, dropping non-pairs; **null if fewer than 3 valid vertices** (reuses B's `isValidPolygon` threshold).
- `coerceConfidence(v)` → `high|medium|low`, default `low`.
- `validateRoomDiscovery(raw): RoomProposal[]` / `validateDeviceDiscovery(raw): DeviceProposal[]` — map + drop invalid, assign client ids, cap at 40.
- 0-edge coordinates are **valid** (`[0,0]` is a real point — the Null Island tripwire, tested at this layer).

## 5. Review overlay, editing, and commit

**Overlay (in `FloorPlanCanvas`).** A `proposals` state (`{ rooms: RoomProposal[]; devices: DeviceProposal[] }`). Rendered as a visually distinct layer above committed shapes: rooms as dashed translucent polygons with a "proposed" tint; devices as ghost pins. Never confusable with committed rooms/pins. Each proposal is selectable; a lightweight proposal panel shows its editable fields (name/type/code) + **Accept** / **Dismiss**. The wizard panel shows the pass result, a confidence summary, and **Accept all** / **Dismiss all**.

**Editing while staged** reuses B's machinery on proposal objects rather than DB rows:

- Device pin drag → updates `proposal.point` (no action call; it's not committed yet).
- Room vertex drag / edge-insert / vertex-delete → updates `proposal.polygon` (same handlers, writing to proposal state).
- Name / type / code edits → update the proposal object.

**Commit (Accept).** Client-side, using existing actions; each accept removes that proposal from state on success, and `router.refresh()` after a batch so the committed rooms/pins re-render as real:

- *Device:* find an existing device whose `code` equals `proposal.label` (case-insensitive). If it exists and is **unplaced** → `placeFloorDeviceAction(id, point)`. If it exists and is **already placed** → treat as a duplicate: skip the commit and dismiss with a small "already on the plan" notice (never create — the site-unique code would collide). If no such code exists → `createFloorDeviceAction` (floorId, typeCode's type id, code = label if free & `^[A-Za-z0-9_-]+$` else `suggestDeviceCode(typeCode, existingCodes)`, `status:'planned'`) → then `placeFloorDeviceAction(newId, point)`.
- *Room:* find an existing room with `plan_polygon == null` whose `name`/`code` matches → `setRoomPolygonAction(roomId, polygon)`. Else `createRoomAction` (floorId, code from a normalized label or `suggest`, name, roomType) → `setRoomPolygonAction(newId, polygon)`.

"Accept all" runs these sequentially (bounded by the 40-cap), surfacing a single inline error if any commit fails and leaving the failed proposal staged.

## 6. UI entry point

- Wizard `IconButton` (`tabler:wand` or `tabler:sparkles`, tip "AI discovery") in the plan's left toolbar stack (same `IconButton`/`Tip` components as Slice B). Click opens a small dropdown/menu: **Discover rooms** / **Discover devices**.
- During a pass: a spinner/disabled state on the menu; the plan stays interactive.
- `no-key` result → an inline notice linking to Settings (reuse the device-wizard copy pattern), not a hard error.
- Result with 0 proposals → a gentle "Nothing found — try a clearer plan or place items manually" notice; the overlay stays empty.

## 7. Testing conventions

- **Pure `planDetect.test.ts`** (TDD, RED→GREEN): type coercion incl. synonyms and unknown→`TO`; point clamping incl. the `[0,0]` edge; polygon <3 vertices dropped; confidence default `low`; garbage (null/string/NaN/Infinity/half-pairs) never throws; the 40-cap.
- **Actions DB-free** (`discoverActions.test.ts`): faked `planVisionBackend` + faked storage/key. Assert: no plan → `{ok:false}` and backend never called; `no-key` short-circuits; a valid backend payload → normalized proposals returned (feed a payload whose coords exceed 1 and prove they're clamped; feed an unknown type and prove `TO`); the plan-text-is-data guard is present in the prompt string.
- **Commit matching** (component-level, mocking the four Slice A/B actions + `next/navigation`): a device proposal whose label matches an unplaced inventory device (non-first fixture) → `placeFloorDeviceAction` with THAT id, no create; a non-matching proposal → `createFloorDeviceAction` then place; a room proposal matching a polygon-less room → `setRoomPolygonAction`; non-match → create then set.
- **Overlay/editing/live** browser-verified per the canvas convention (jsdom renders no images): run a real pass on the CELLAR test plan, fine-tune a pin and a room wall, accept a mix, confirm committed rooms/pins persist after reload and un-accepted ones are gone.
- **NEVER run vitest against a directory or glob** — integration tests wipe the local DB. Explicit filenames only. Typecheck with `./node_modules/.bin/tsc --noEmit`.

## 8. Out of scope

Persisted/resumable proposals; a combined single-pass "discover everything"; real-world scale/measurement; deskew/rotation; multi-page reasoning; auto-linking discovered devices to rack ports (Slice D); confidence-threshold auto-accept; re-running discovery as a diff/merge against existing placements (each pass is additive; the user dismisses duplicates).

## 9. Open questions for the builder

None blocking. Two niceties left to the planner: (a) whether the wizard opens a dropdown menu vs two adjacent toolbar buttons (either; pick what fits the toolbar); (b) whether low-confidence proposals render dimmer than high-confidence ones (nice, cheap, optional).
