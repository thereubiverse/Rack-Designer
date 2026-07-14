"use client";

import { useEffect, useState } from "react";
import { getIcon, loadIcon, type IconifyIcon } from "@iconify/react";
import type { IconElement } from "@/domain/faceplate";

/** Renders a placed icon element inside the faceplate SVG as a nested <svg> holding the icon's
 *  raw body, scaled to the element's box. Icon data is fetched on-demand from Iconify (cached
 *  after the first load); a dashed placeholder shows while it loads or if the name is unknown. */
export function FaceIcon({ el }: { el: IconElement }) {
  const [data, setData] = useState<IconifyIcon | null>(() => getIcon(el.iconName) ?? null);

  useEffect(() => {
    const cached = getIcon(el.iconName);
    if (cached) { setData(cached); return; }
    let alive = true;
    loadIcon(el.iconName)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [el.iconName]);

  const cx = el.gridX + el.w / 2, cy = el.gridY + el.h / 2;
  const transform = el.rotation ? `rotate(${el.rotation} ${cx} ${cy})` : undefined;
  if (!data) {
    return (
      <rect data-testid="face-icon-loading" x={el.gridX} y={el.gridY} width={el.w} height={el.h}
        rx={2} fill="none" stroke="#e5e7eb" strokeDasharray="3 3" transform={transform} />
    );
  }
  const left = data.left ?? 0, top = data.top ?? 0, iw = data.width ?? 16, ih = data.height ?? 16;
  return (
    <svg
      data-testid="face-icon"
      data-icon={el.iconName}
      x={el.gridX}
      y={el.gridY}
      width={el.w}
      height={el.h}
      viewBox={`${left} ${top} ${iw} ${ih}`}
      opacity={el.opacity ?? 1}
      transform={transform}
      style={{ color: el.color ?? "#111418" }}
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
}
