import type { LineElement } from "@/domain/faceplate";

export function FaceLine({ el }: { el: LineElement }) {
  return (
    <line data-testid="face-line" x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
      stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round" opacity={el.opacity ?? 1} />
  );
}
