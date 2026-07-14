import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShapeSettings } from "./ShapeSettings";

it("switches shape and toggles fill", async () => {
  const user = userEvent.setup();
  const onShape = vi.fn();
  render(<ShapeSettings count={1} shape="rect" fill={undefined} stroke={undefined} strokeWidth={1.5}
    onShape={onShape} onFill={vi.fn()} onStroke={vi.fn()} onStrokeWidth={vi.fn()} onOpacity={vi.fn()} onDelete={vi.fn()} />);
  await user.click(screen.getByTestId("shape-ellipse"));
  expect(onShape).toHaveBeenCalledWith("ellipse");
});
