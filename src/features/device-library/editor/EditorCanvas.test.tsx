import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EditorCanvas } from "./EditorCanvas";
import { emptyFace } from "@/domain/faceplate";

describe("EditorCanvas", () => {
  it("renders a relative-positioned wrapper around the Faceplate", () => {
    const { getByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted side="FRONT" />,
    );
    const canvas = getByTestId("editor-canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas.querySelector('[data-testid="faceplate-svg"]')).not.toBeNull();
  });

  it("drops screw holes when not rack-mounted (preview reflects props)", () => {
    const { queryAllByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} side="FRONT" />,
    );
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
  });
});
