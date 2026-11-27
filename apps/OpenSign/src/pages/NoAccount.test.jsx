import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NoAccount from "./NoAccount";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
// English strings from the real locale file, so the tests read like the page.
vi.mock("react-i18next", async () => {
  const en = (await import("../../public/locales/en/translation.json")).default;
  const t = (k, vars = {}) =>
    (k.split(".").reduce((o, p) => o?.[p], en) ?? k).replace(/\{\{(\w+)\}\}/g, (_, v) => vars[v]);
  return { useTranslation: () => ({ t }) };
});
vi.mock("../components/BrandHero", () => ({ default: ({ children }) => <div>{children}</div> }));

describe("No account page", () => {
  it("says there's no account and links to the store", () => {
    render(<NoAccount />);
    expect(screen.getByRole("heading", { name: "You don't have an account yet" })).toBeInTheDocument();
    const store = screen.getByRole("link", { name: "Buy an account at store.betterid.net" });
    expect(store).toHaveAttribute("href", "https://store.betterid.net/");
  });

  it("goes back to sign-in", () => {
    render(<NoAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Back to sign-in" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
