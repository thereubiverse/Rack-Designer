"use client";

import { useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";

export interface SheetTab {
  id: string;
  label: string;
  content: ReactNode;
}

// Peek height shows just the grab handle + tab bar; expanded height covers the lower part of the
// plan while clearing the top-left control stack (~230px) so those buttons stay uncovered.
const COLLAPSED_H = 64;
const EXPANDED_H = 320;
const DRAG_SLOP = 4;

/** A slide-up sheet that overlays the bottom of the plan. It peeks as a handle + tab bar; the user
 *  drags the handle up (or taps it / a tab) to expand it over the plan for managing the floor, and
 *  collapses it to give the plan back. Anchored to a `relative` parent (the plan wrapper), so it
 *  floats over the canvas rather than pushing the page down. */
export function PlanBottomSheet({ tabs }: { tabs: SheetTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const [height, setHeight] = useState(COLLAPSED_H);
  const [dragging, setDragging] = useState(false);

  const expanded = height > COLLAPSED_H + DRAG_SLOP * 4;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const clampH = (h: number) => Math.min(EXPANDED_H, Math.max(COLLAPSED_H, h));

  // Drag via window listeners rather than setPointerCapture: capture can throw or drop the
  // pointer-up when it lands off the handle (over the plan), which would strand the sheet
  // mid-drag. Window listeners always see the whole gesture. A press that never travels past the
  // slop is a tap → toggle; a real drag snaps to whichever stop it ended nearer.
  function onHandlePointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let moved = false;
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY;
      if (Math.abs(dy) > DRAG_SLOP) moved = true;
      setHeight(clampH(startH + dy));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      if (!moved) {
        setHeight(startH > COLLAPSED_H + DRAG_SLOP * 4 ? COLLAPSED_H : EXPANDED_H);
        return;
      }
      const finalH = clampH(startH + (startY - ev.clientY));
      setHeight(finalH > (COLLAPSED_H + EXPANDED_H) / 2 ? EXPANDED_H : COLLAPSED_H);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      data-testid="plan-sheet"
      className="absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-t-2xl border border-neutral-200 bg-white shadow-[0_-6px_24px_rgba(0,0,0,0.12)]"
      style={{ height, transition: dragging ? "none" : "height 0.25s ease" }}
    >
      <div
        data-testid="plan-sheet-handle"
        className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2 active:cursor-grabbing"
        onPointerDown={onHandlePointerDown}
      >
        <span className="h-1.5 w-10 rounded-full bg-neutral-300" />
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-100 px-3 pb-2">
        {tabs.map((t) => {
          const isActive = active?.id === t.id;
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`sheet-tab-${t.id}`}
              aria-pressed={isActive}
              onClick={() => {
                setActiveId(t.id);
                if (!expanded) setHeight(EXPANDED_H);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                isActive ? "bg-neutral-100 text-neutral-900" : "text-neutral-500 hover:bg-neutral-50"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Every tab stays mounted (only the active one is shown) so switching tabs preserves each
          tab's scroll position and any open state, and off-tab content is still queryable. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tabs.map((t) => (
          <div key={t.id} className={t.id === active?.id ? "" : "hidden"}>
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
