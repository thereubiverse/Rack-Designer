import type { TextElement } from "@/domain/faceplate";

/** Renders a placed text element inside the faceplate SVG. Anchored by `alignment`; vertically
 *  centred in its box. Colour defaults to the faceplate label ink. */
export function FaceText({ el }: { el: TextElement }) {
  const anchor = el.alignment === "left" ? "start" : el.alignment === "right" ? "end" : "middle";
  const x = el.alignment === "left" ? el.gridX : el.alignment === "right" ? el.gridX + el.w : el.gridX + el.w / 2;
  return (
    <text
      data-testid="face-text"
      x={x}
      y={el.gridY + el.h / 2}
      textAnchor={anchor}
      dominantBaseline="central"
      fontSize={el.fontSize}
      fontFamily="Inter, system-ui, sans-serif"
      fill={el.color ?? "#4b5563"}
    >
      {el.content}
    </text>
  );
}
