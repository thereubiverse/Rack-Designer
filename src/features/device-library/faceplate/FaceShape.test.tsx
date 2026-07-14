import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceShape } from "./FaceShape";

it("renders a rect for shape=rect and an ellipse for shape=ellipse", () => {
  const base = { id: "s", kind: "shape" as const, gridX: 4, gridY: 6, w: 40, h: 20 };
  const r = render(<svg><FaceShape el={{ ...base, shape: "rect" }} /></svg>);
  expect(r.container.querySelector('[data-testid="face-shape"]')?.tagName.toLowerCase()).toBe("rect");
  const e = render(<svg><FaceShape el={{ ...base, shape: "ellipse" }} /></svg>);
  expect(e.container.querySelector('[data-testid="face-shape"]')?.tagName.toLowerCase()).toBe("ellipse");
});
