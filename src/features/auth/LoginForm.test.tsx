import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LoginForm } from "./LoginForm";

vi.mock("./authActions", () => ({
  signInWithPasswordAction: vi.fn(async () => ({ ok: true })),
  oauthUrlAction: vi.fn(async () => ({ ok: true, url: "https://accounts.google.com/x" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { signInWithPasswordAction, oauthUrlAction } from "./authActions";

beforeEach(() => vi.clearAllMocks());

describe("LoginForm", () => {
  it("offers all three ways in", () => {
    render(<LoginForm />);
    expect(screen.getByTestId("login-email")).toBeInTheDocument();
    expect(screen.getByTestId("login-password")).toBeInTheDocument();
    expect(screen.getByTestId("login-google")).toBeInTheDocument();
    expect(screen.getByTestId("login-microsoft")).toBeInTheDocument();
  });

  it("submits the typed credentials", async () => {
    render(<LoginForm />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "bob@example.com" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "hunter2" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    const sent = vi.mocked(signInWithPasswordAction).mock.calls[0][0] as FormData;
    expect(sent.get("email")).toBe("bob@example.com");
    expect(sent.get("password")).toBe("hunter2");
  });

  it("shows the refusal instead of failing silently", async () => {
    vi.mocked(signInWithPasswordAction).mockResolvedValueOnce({ ok: false, error: "nope" });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-error").textContent).toContain("nope");
  });

  it("announces the error to assistive tech", async () => {
    vi.mocked(signInWithPasswordAction).mockResolvedValueOnce({ ok: false, error: "nope" });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-error")).toHaveAttribute("role", "alert");
  });

  it("asks the server for the provider URL rather than hard-coding one", async () => {
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-google"));
    });
    const sent = vi.mocked(oauthUrlAction).mock.calls[0][0] as FormData;
    expect(sent.get("provider")).toBe("google");
  });

  it("tells the user when a provider is not configured yet", async () => {
    // Google and Microsoft credentials are the user's to create; until they exist the button must
    // explain itself rather than dead-ending.
    vi.mocked(oauthUrlAction).mockResolvedValueOnce({ ok: false, error: "Google sign-in isn't configured yet." });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-microsoft"));
    });
    expect(screen.getByTestId("login-error").textContent).toContain("isn't configured");
  });

  it("disables the submit while a sign-in is in flight", async () => {
    let release: (v: { ok: boolean }) => void = () => {};
    vi.mocked(signInWithPasswordAction).mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }) as Promise<{ ok: boolean }>
    );
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-submit")).toBeDisabled();
    await act(async () => {
      release({ ok: true });
    });
  });
});
