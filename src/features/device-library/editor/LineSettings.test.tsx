import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LineSettings } from "./LineSettings";

it("changes thickness", async () => {
  const user = userEvent.setup();
  const onWidth = vi.fn();
  render(<LineSettings count={1} stroke="#111418" strokeWidth={1.5} onStroke={vi.fn()} onStrokeWidth={onWidth} onOpacity={vi.fn()} onDelete={vi.fn()} />);
  await user.clear(screen.getByTestId("line-width"));
  await user.type(screen.getByTestId("line-width"), "3");
  expect(onWidth).toHaveBeenCalled();
});
