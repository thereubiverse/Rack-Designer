# Rack Device Editor — Multi-Select (ports & groups)

_Design spec. Built and browser-verified on branch `phase-2a-slice-3f` (2026-07-06). Written
after a prototype-for-evaluation was approved, so it documents the shipped design._

## Goal
Let the user edit rotation and label position across many ports at once, instead of one port
at a time. Two selection modes:

1. **Multi-port** — shift+click ports **within a single group** to build a set, then apply
   rotation / label position to all of them.
2. **Multi-group** — shift+click whole group boxes to select several groups, then apply
   rotation / label position to **every port in each selected group**, delete them together,
   or press Delete.

## Selection model
Replaces the two single-value states with two arrays (`RackDeviceEditor`):
- `selectedGroupIds: string[]`
- `selectedPortIndices: number[]` — only meaningful when **exactly one** group is selected
  (ports are always scoped to a single group).

Port-multi and group-multi are **mutually exclusive**.

| Action | Result |
|---|---|
| Click a group box | select just that group, clear ports |
| Shift+click a group box | toggle it in the set; clear ports → multi-group |
| Click a port | select that one port (its group becomes the single selected group) |
| Shift+click a port in the current single group | toggle it in the port set → multi-port |
| Shift+click a port elsewhere / while multi-group | reset to that port's group + just that port |
| Click empty canvas | clear everything |

## Settings panel states
- **Nothing** → hint copy.
- **1 group, 0 ports** → group settings + "Select a port…".
- **1 group, 1 port** → group settings + full `PortSettings` (name, connector, Flip, Label).
- **1 group, 2+ ports** → group settings + `BatchSettings` (Flip + Label only), "*N ports selected*".
- **2+ groups** → `BatchSettings` only (Flip + Label + **Delete groups**), "*N groups selected*".
  Per-group settings (prefix/counting/connector) are hidden — they don't batch.

## Batch semantics
Targets = the selected ports (multi-port) **or** every port in every selected group (multi-group),
computed by `targetRefs()`.
- **Flip** toggle: "on" iff *all* targets are at 180°. Click → all→0° if currently all-on,
  else all→180° (converges a "mixed" selection to uniform).
- **Label** button: shows Top / Bottom if uniform, else "Mixed". Click → all→Bottom unless all
  already Bottom → all Top.
- **Top Rotate toolbar button** rotates each target +180° (one, many, or whole groups);
  `canRotate` is enabled whenever anything rotatable is selected.

## Delete
- Batch panel's delete button reads **"Delete groups"** and removes all selected groups.
- **Delete / Backspace** key removes the selected group(s) — ignored while focus is in an
  `input` / `textarea` / `select` / contenteditable (so it doesn't fire while editing a name).
  Both keys handled because on macOS the "delete" key reports as Backspace.

## Implementation surface
- **Pure ops** (`portGroupOps.ts`, unit-tested): `PortRef`, `allPortIndices`, `patchPorts`,
  `rotatePorts`, `deletePortGroups`.
- **`Faceplate`**: `highlight` now accepts `HighlightPort | HighlightPort[] | null` so several
  ports recolor at once (still a pure rendering hint).
- **`EditorCanvas`**: `selectedGroupIds` / `selectedPortIndices` props; `onSelect` /
  `onSelectPort` carry the shift flag; the selection box renders for every selected group, while
  chevrons / spacing handle / port targets render only in single-group mode (`singleSelected`).
- **`PortSettings`**: new exported `BatchSettings` component (Flip + Label + optional Delete).
- **`RackDeviceEditor`**: array selection state, interaction rules, batch wiring, keyboard delete.

## Testing
- Pure batch ops: unit tests in `portGroupOps.test.ts`.
- Interaction: component tests in `RackDeviceEditor.test.tsx` (shift+click port/group selection,
  batch Flip on ports and on whole groups, Delete-groups button, Delete key).
- Browser-verified: shift+clicking ports highlights all selected and shows the batch panel.
