import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceText } from "./FaceText";

const el = { id: "t1", kind: "text" as const, gridX: 10, gridY: 20, w: 60, h: 20, content: "Uplink", alignment: "center" as const, fontSize: 11 };

it("renders the text content", () => {
  const { getByTestId } = render(<svg><FaceText el={el} /></svg>);
  expect(getByTestId("face-text").textContent).toBe("Uplink");
});
