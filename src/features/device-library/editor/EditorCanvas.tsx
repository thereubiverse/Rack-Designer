import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { Face } from "@/domain/faceplate";

export function EditorCanvas({
  face, widthIn, rackUnits, rackMounted, side,
}: {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
}) {
  // position:relative is the overlay origin 3b/3c will mount controls into.
  return (
    <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
      <Faceplate
        face={face}
        widthIn={widthIn}
        rackUnits={rackUnits}
        rackMounted={rackMounted}
        side={side}
      />
    </div>
  );
}
