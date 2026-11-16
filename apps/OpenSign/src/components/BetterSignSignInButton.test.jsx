import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import BetterSignSignInButton from "./BetterSignSignInButton";
import * as kit from "../vendor/signInWithBetterSignButton/browser";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("../constant/Utils", () => ({ getEnv: () => ({}) }));
vi.mock("../vendor/signInWithBetterSignButton/browser", () => ({
  extensionSignIn: vi.fn(),
  hasPendingPasskeySignIn: vi.fn(() => false),
  startPasskeySignIn: vi.fn(),
  takePasskeyCallback: vi.fn()
}));

const shadow = () => within(document.querySelector("bettersign-sign-in").shadowRoot);

describe("BetterSignSignInButton", () => {
  it("shows the given label, and `texts` in place of the button's English", async () => {
    kit.extensionSignIn.mockImplementation(({ onStatus }) => {
      onStatus("Approve on your phone…");
      return new Promise(() => {});
    });
    render(
      <BetterSignSignInButton
        label="Mit BetterSign anmelden"
        texts={{
          "Approve on your phone…": "Bestätigen Sie auf Ihrem Smartphone…",
          "Use passkey instead": "Stattdessen Passkey verwenden"
        }}
      />
    );
    const button = shadow().getByRole("button", { name: "Mit BetterSign anmelden" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(shadow().getByRole("status")).toHaveTextContent("Bestätigen Sie auf Ihrem Smartphone…")
    );
    expect(shadow().getByRole("button", { name: "Stattdessen Passkey verwenden" })).toBeVisible();
  });

  it("follows the label and disabled props", () => {
    const { rerender } = render(<BetterSignSignInButton label="A" />);
    rerender(<BetterSignSignInButton label="B" disabled />);
    expect(shadow().getByRole("button", { name: "B" })).toBeDisabled();
  });
});
