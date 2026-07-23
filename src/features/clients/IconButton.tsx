"use client";

import { Icon } from "@iconify/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export type TipSide = "top" | "right" | "bottom" | "left";

const SIDE_POS: Record<TipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
};

/** Hover tooltip wrapper. Wraps any trigger (button, or a <label> for file inputs) in a relative
 *  inline group and reveals a small dark bubble on hover — no browser delay, styled to match the
 *  app. Uses a NAMED group (`group/tip`) so it never reacts to unrelated `group` hovers elsewhere
 *  (e.g. the plan's room-label groups). Pick `side` to point the bubble away from any clipping
 *  edge: inside the overflow-hidden plan pane, top-left controls use "right" and bottom-right
 *  controls use "left" so the bubble opens into the pane rather than being cut off. */
export function Tip({
  label,
  side = "top",
  children,
}: {
  label: string;
  side?: TipSide;
  children: ReactNode;
}) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-40 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity duration-100 group-hover/tip:opacity-100 ${SIDE_POS[side]}`}
      >
        {label}
      </span>
    </span>
  );
}

const VARIANTS = {
  // In-flow ghost actions (table rows, panel headers).
  default: "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800",
  danger: "text-neutral-400 hover:bg-red-50 hover:text-red-600",
  primary: "bg-blue-600 text-white hover:bg-[#376ad9]",
  // Floating controls layered over the plan pane — a white card with the same soft shadow the
  // zoom controls use, so the embedded toolbar reads as one family.
  floating:
    "bg-white text-neutral-600 shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.08)] hover:bg-neutral-50",
  floatingActive:
    "bg-blue-600 text-white shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.08)] hover:bg-[#376ad9]",
  floatingDanger:
    "bg-white text-red-600 shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.08)] hover:bg-red-50",
} as const;

type IconButtonProps = {
  icon: string;
  /** Tooltip text; also the button's accessible name, since there's no visible label. */
  tip: string;
  tipSide?: TipSide;
  variant?: keyof typeof VARIANTS;
  className?: string;
  iconSize?: number;
  "data-testid"?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-label">;

/** A square icon button with a hover tooltip. The tooltip label doubles as `aria-label` so the
 *  control keeps an accessible name once its text is gone. */
export function IconButton({
  icon,
  tip,
  tipSide = "top",
  variant = "default",
  className = "",
  iconSize = 18,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tip label={tip} side={tipSide}>
      <button
        type={type}
        aria-label={tip}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${VARIANTS[variant]} ${className}`}
        {...rest}
      >
        <Icon icon={icon} width={iconSize} height={iconSize} />
      </button>
    </Tip>
  );
}
