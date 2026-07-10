# Device Wizard — Name Lookup via Gemini Knowledge Plan

> Replace the blocked DuckDuckGo search with a free Gemini knowledge lookup. Execute inline with TDD.

**Goal:** Model-name search returns a `DetectedFace` generated from Gemini's knowledge (plain call, free), same validation/layout/apply as the photo path; no image, no grounding, no DuckDuckGo.

## Global Constraints
- Reuse the existing `DetectedFace` schema/validation/layout; plain `gemini-3-flash-preview` (free), retry-on-503.
- Untrusted: the model name is data, never an instruction. Key server-side only.
- Tests co-located; `npx vitest run <path>`.

## Task 1 — Name-lookup backend — `visionBackend.ts`
- Add `export async function geminiNameLookup(modelName: string, apiKey: string): Promise<unknown>` — plain call, model `gemini-3-flash-preview`, `generationConfig: { responseMimeType: "application/json", responseSchema }` (the existing schema), prompt (spec's name-lookup prompt) with the model name interpolated as data. Reuse the same 503-retry loop as `geminiVisionBackend.detect` (extract a shared `generateWithRetry(model, parts)` helper, or duplicate the small loop). Return `JSON.parse(result.response.text())`.
- `tsc` clean. (No unit test — network wrapper, mocked at the pipeline layer.)
- Commit: `feat(device-wizard): Gemini name-lookup backend`

## Task 2 — Pipeline orchestrator — `pipeline.ts` (+ test)
- Add `export async function runLookupByName(lookup: (modelName: string) => Promise<unknown>, modelName: string): Promise<DetectResult>` — mirror `runDetectPorts`: try `lookup(modelName)` (catch → busy/friendly error via the same categorization), then `validateDetectedFace` (catch → `"Couldn't identify this model — try a different name or upload a photo."`).
- Remove `runIdentifyDevice` + `IdentifyResult` + the `parseDeviceMatch`/`Searcher` import (now unused).
- Test: replace the `runIdentifyDevice` describe with `runLookupByName` — good raw → ok DetectResult with groups; unreadable raw → typed error; lookup throws → typed error.
- Commit: `feat(device-wizard): runLookupByName pipeline orchestrator`

## Task 3 — Action rewire + remove DuckDuckGo — `ai/actions.ts`, delete `search.ts`/`search.test.ts`, drop dep
- `identifyDeviceAction(modelName: string): Promise<DetectResult>`: `const name = modelName.trim(); if (!name) return { ok:false, error:"Enter a model name." }; const key = await resolveGeminiKey(dbSettingsStore); if (!key) return { ok:false, error:"no-key" }; return runLookupByName((n) => geminiNameLookup(n, key), name);`
- Remove `fetchImageAsBase64`, the `duckDuckGoSearcher`/`runIdentifyDevice`/`IdentifyResult` imports; import `geminiNameLookup`, `runLookupByName`.
- Delete `src/features/device-library/ai/search.ts` and `search.test.ts`. Remove `duck-duck-scrape` from `package.json` (`npm uninstall duck-duck-scrape`). Remove the `server-only`→shim vitest alias only if nothing else needs it (visionBackend still imports `server-only`, so KEEP the alias).
- `tsc` clean; `npx vitest run src/features/device-library/ai`.
- Commit: `feat(device-wizard): name search uses Gemini lookup; remove DuckDuckGo`

## Task 4 — Wizard search flow — `DeviceWizard.tsx` (+ test)
- `runIdentify?: (modelName: string) => Promise<DetectResult>` (import `DetectResult` type or inline). Default stays `identifyDeviceAction`.
- `search()`: `const r = await runIdentify(modelName); if (!r.ok) { setError(r.error); setPhase("error"); return; } setDetected(r.face); setPhase("review");`
- Remove the `candidate` phase from `Phase`, the `candidate` JSX block, and the `match`/`image` state (upload's `onFile` passes base64 straight to `detect`, so `image` state is unused). `apply()` → `onApply({ detected })`. `WizardApply` → `{ detected: DetectedFace }` (drop `match`); remove the `DeviceMatch` import.
- Update `DeviceWizard.test.tsx`: the search test now goes search → review → apply (no Confirm step); make the `okIdentify` fake return `{ ok: true, face: <detected> }`; assert `onApply` receives `{ detected }` with groups. Keep the disabled-while-detecting and no-key tests.
- Because `WizardApply` drops `match`, update `RackDeviceEditor.applyWizard` to use `a.detected` only (drop `a.match?.…` fallbacks) and its test mock's payload accordingly.
- `tsc` clean; run `DeviceWizard.test.tsx` + `RackDeviceEditor.test.tsx` + full suite.
- Commit: `feat(device-wizard): wizard name search shows detected ports directly (no image candidate)`

## Verify
- `npx vitest run` green; `tsc` clean. Browser: type a known model (e.g. "Cisco Catalyst 9200-24T") → Search → detected ports appear → Apply. Confirm metadata (name/brand/rack-units) fills.
