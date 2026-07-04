"use client";

import { useRef, useState, useEffect } from "react";
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media } from "@/domain/faceplate";
import type { Pos } from "./portGroupOps";

const SEL_PAD = 6; // visual padding so the selection box wraps the number labels

export interface EditorCanvasProps {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
  selectedGroupId?: string | null;
  onCreate?: (media: Media, pos: Pos) => void;
  onSelect?: (id: string | null) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
  onMove?: (id: string, pos: Pos) => void;
}

export function EditorCanvas(props: EditorCanvasProps) {
  const { face, widthIn, rackUnits, rackMounted, side } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const editing = Boolean(props.onSelect || props.onCreate);
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const earX = dims.earWidthPx;

  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!drag) return;
    function onUp(e: PointerEvent) {
      const dx = e.clientX - drag!.startX;
      const dy = e.clientY - drag!.startY;
      // Only commit an actual move — a plain select-click (no movement) must not
      // mutate the face (avoids a redundant re-render and off-grid re-snapping).
      if (dx !== 0 || dy !== 0) {
        props.onMove?.(drag!.id, { x: drag!.origX + dx, y: drag!.origY + dy });
      }
      setDrag(null);
    }
    function onCancel() {
      setDrag(null);
    }
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag, props]);

  function dropPos(e: React.DragEvent): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    const left = rect ? rect.left : 0;
    const top = rect ? rect.top : 0;
    return { x: e.clientX - left - earX, y: e.clientY - top };
  }

  return (
    <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
      <Faceplate face={face} widthIn={widthIn} rackUnits={rackUnits} rackMounted={rackMounted} side={side} />

      {editing && (
        <div
          ref={overlayRef}
          data-testid="editor-overlay"
          style={{ position: "absolute", inset: 0 }}
          onClick={() => props.onSelect?.(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const media = e.dataTransfer.getData("text/plain") as Media;
            if (props.onCreate && (MEDIA as string[]).includes(media)) {
              props.onCreate(media, dropPos(e));
            }
          }}
        >
          {face.portGroups.map((g) => {
            const laid = layoutPortGroup(g);
            const selected = g.id === props.selectedGroupId;
            const left = earX + g.gridX;
            return (
              <div
                key={g.id}
                data-testid={`group-box-${g.id}`}
                data-selected={selected ? "true" : "false"}
                onClick={(e) => { e.stopPropagation(); props.onSelect?.(g.id); }}
                onPointerDown={(e) => {
                  if (!props.onMove) return;
                  e.stopPropagation();
                  setDrag({ id: g.id, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY });
                }}
                style={{
                  position: "absolute",
                  left: left - SEL_PAD,
                  top: g.gridY - SEL_PAD,
                  width: laid.width + SEL_PAD * 2,
                  height: laid.height + SEL_PAD * 2,
                  cursor: props.onMove ? "move" : "pointer",
                  borderRadius: 6,
                  border: selected ? "1.5px solid #2d5bff" : "1.5px solid transparent",
                  background: selected ? "rgba(45,91,255,0.06)" : "transparent",
                }}
              >
                {selected && (
                  <>
                    <button
                      type="button"
                      data-testid="chevron-col"
                      title="Add a column of ports"
                      onClick={(e) => { e.stopPropagation(); props.onAddColumn?.(g.id); }}
                      style={chevronStyle({ right: -8, top: "50%", translate: "0 -50%" })}
                    >›</button>
                    <button
                      type="button"
                      data-testid="chevron-row"
                      title="Add a row of ports"
                      onClick={(e) => { e.stopPropagation(); props.onAddRow?.(g.id); }}
                      style={chevronStyle({ bottom: -8, left: "50%", translate: "-50% 0" })}
                    >⌄</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function chevronStyle(pos: React.CSSProperties & { translate?: string }): React.CSSProperties {
  return {
    position: "absolute",
    width: 16, height: 16, borderRadius: "50%",
    background: "#fff", border: "1.5px solid #2d5bff", color: "#2d5bff",
    fontSize: 11, lineHeight: "13px", padding: 0, cursor: "pointer", zIndex: 6,
    ...pos,
  };
}
