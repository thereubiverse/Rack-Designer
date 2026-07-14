import type { ShapeElement } from "@/domain/faceplate";

export function FaceShape({ el }: { el: ShapeElement }) {
  const fill = el.fill ?? "none";
  const stroke = el.stroke ?? "#111418";
  const strokeWidth = el.strokeWidth ?? 1.5;
  const opacity = el.opacity ?? 1;
  const cx = el.gridX + el.w / 2, cy = el.gridY + el.h / 2;
  const transform = el.rotation ? `rotate(${el.rotation} ${cx} ${cy})` : undefined;
  if (el.shape === "ellipse") {
    return (
      <ellipse data-testid="face-shape" cx={cx} cy={cy}
        rx={el.w / 2} ry={el.h / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth}
        opacity={opacity} transform={transform} />
    );
  }
  return (
    <rect data-testid="face-shape" x={el.gridX} y={el.gridY} width={el.w} height={el.h}
      rx={2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} opacity={opacity} transform={transform} />
  );
}
