"use client";

import { PortGlyph } from "@/features/device-library/faceplate/portGlyphs";
import type { Media } from "@/domain/faceplate";

// Chevron matching the Width-field stepper (RackDeviceEditor): 9px, strokeWidth 3.
function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d={up ? "M6 15l6 -6l6 6" : "M6 9l6 6l6 -6"} />
    </svg>
  );
}

/** Compact row picker for a port group. The stepper cycles through the group's rows (starting at
 *  the top) and selects every port in the active row — so the batch panel's Rotate acts on the whole
 *  row. Clicking the glyph flips the selected row's label side; a bar drawn above/below the glyph
 *  mirrors which side the label currently sits on. */
export function PortGroupLayout({
  media, rows, activeRow, labelPos, onSelectRow, onToggleLabel,
}: {
  media: Media;
  rows: number;
  activeRow: number | null;
  labelPos: "top" | "bottom" | null;
  onSelectRow: (row: number) => void;
  onToggleLabel: () => void;
}) {
  // The first arrow click (nothing selected yet) picks the top row; after that the arrows step one
  // row at a time without wrapping, and the end-stop arrow is disabled.
  const active = activeRow != null;
  const prev = activeRow == null ? 0 : Math.max(0, activeRow - 1);
  const next = activeRow == null ? 0 : Math.min(rows - 1, activeRow + 1);
  const upDisabled = activeRow === 0;
  const downDisabled = activeRow === rows - 1;
  // A thin bar standing in for the row's label text, drawn on the same side the real label sits.
  const labelBar = <span className="h-[3px] w-4 rounded-full bg-neutral-400" />;
  return (
    // A plain <div>, not a <label>: a <label> wrapping multiple buttons forwards its clicks and
    // :hover to the first one (the up stepper), so hovering the glyph would also light it up.
    <div className="flex flex-col text-xs font-semibold text-neutral-600">
      <span>Edit rows</span>
      <div className="mt-1 flex h-9 items-center gap-2">
        {/* Same up/down stepper as the Width field, sized to h-9 so its outline lines up with the
            ID prefix / Counting Direction / Connector type fields. */}
        <div className="flex h-9 w-5 flex-col overflow-hidden rounded border border-neutral-200">
          <button type="button" data-testid="pg-row-prev" tabIndex={-1} aria-label="Previous row"
            disabled={upDisabled}
            className={`flex flex-1 items-center justify-center transition-colors ${upDisabled ? "text-neutral-200" : "text-neutral-500 hover:bg-neutral-100"}`}
            onClick={() => onSelectRow(prev)}>
            <Chevron up />
          </button>
          <button type="button" data-testid="pg-row-next" tabIndex={-1} aria-label="Next row"
            disabled={downDisabled}
            className={`flex flex-1 items-center justify-center border-t border-neutral-200 transition-colors ${downDisabled ? "text-neutral-200" : "text-neutral-500 hover:bg-neutral-100"}`}
            onClick={() => onSelectRow(next)}>
            <Chevron up={false} />
          </button>
        </div>
        <button
          type="button" data-testid="pg-layout-cell"
          aria-label={active ? "Flip the selected row's label" : "Select the top row"}
          title={active ? "Flip the selected row's label" : "Pick a row with the arrows"}
          onClick={() => (active ? onToggleLabel() : onSelectRow(0))}
          className="flex h-8 w-9 flex-col items-center justify-center gap-[2px] rounded-md transition-colors hover:bg-neutral-100"
        >
          {active && labelPos === "top" && labelBar}
          <span className="flex origin-center scale-[0.6] text-neutral-900">
            <PortGlyph media={media} />
          </span>
          {active && labelPos === "bottom" && labelBar}
        </button>
      </div>
    </div>
  );
}
