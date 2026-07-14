import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextSettings } from "./TextSettings";

it("edits content and alignment", async () => {
  const user = userEvent.setup();
  const onContent = vi.fn(); const onAlignment = vi.fn();
  render(<TextSettings count={1} content="Hi" alignment="center" fontSize={11} color={undefined}
    onContent={onContent} onAlignment={onAlignment} onFontSize={vi.fn()} onColor={vi.fn()} onOpacity={vi.fn()} onDelete={vi.fn()} />);
  await user.type(screen.getByTestId("text-content"), "!");
  expect(onContent).toHaveBeenCalled();
  await user.click(screen.getByTestId("text-align-left"));
  expect(onAlignment).toHaveBeenCalledWith("left");
});
