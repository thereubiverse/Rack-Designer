import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceLine } from "./FaceLine";

it("renders a line at its endpoints", () => {
  const el = { id: "l", kind: "line" as const, x1: 10, y1: 5, x2: 70, y2: 5, stroke: "#111418", strokeWidth: 2 };
  const { container } = render(<svg><FaceLine el={el} /></svg>);
  const line = container.querySelector('[data-testid="face-line"]');
  expect(line?.getAttribute("x1")).toBe("10");
  expect(line?.getAttribute("x2")).toBe("70");
});
