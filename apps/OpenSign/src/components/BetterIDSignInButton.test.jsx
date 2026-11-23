import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import BetterIDSignInButton from "./BetterIDSignInButton";
import * as kit from "../vendor/signInWithBetterIDButton/browser";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("../constant/Utils", () => ({ getEnv: () => ({}) }));
vi.mock("../vendor/signInWithBetterIDButton/browser", () => ({
  extensionSignIn: vi.fn(),
  hasPendingPasskeySignIn: vi.fn(() => false),
  startPasskeySignIn: vi.fn(),
  takePasskeyCallback: vi.fn()
}));

const shadow = () => within(document.querySelector("betterid-sign-in").shadowRoot);

describe("BetterIDSignInButton", () => {
  it("shows the given label, and `texts` in place of the button's English", async () => {
    kit.extensionSignIn.mockImplementation(({ onStatus }) => {
      onStatus("Approve on your phone…");
      return new Promise(() => {});
    });
    render(
      <BetterIDSignInButton
        label="Mit BetterID anmelden"
        texts={{
          "Approve on your phone…": "Bestätigen Sie auf Ihrem Smartphone…",
          "Use passkey instead": "Stattdessen Passkey verwenden"
        }}
      />
    );
    const button = shadow().getByRole("button", { name: "Mit BetterID anmelden" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(shadow().getByRole("status")).toHaveTextContent("Bestätigen Sie auf Ihrem Smartphone…")
    );
    expect(shadow().getByRole("button", { name: "Stattdessen Passkey verwenden" })).toBeVisible();
  });

  it("follows the label and disabled props", () => {
    const { rerender } = render(<BetterIDSignInButton label="A" />);
    rerender(<BetterIDSignInButton label="B" disabled />);
    expect(shadow().getByRole("button", { name: "B" })).toBeDisabled();
  });
});
