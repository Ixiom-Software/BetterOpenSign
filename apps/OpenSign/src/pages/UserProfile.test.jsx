import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import UserProfile from "./UserProfile";

vi.mock("parse", () => ({
  default: {
    User: {
      current: () => ({ objectId: "u1", emailVerified: true })
    }
  }
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k })
}));
vi.mock("../components/pdf/SelectLanguage", () => ({ default: () => null }));
vi.mock("../components/MailInboxCard", () => ({
  default: () => <div data-testid="mail-inbox-card" />
}));
vi.mock("../constant/Utils", () => ({
  getSecureUrl: vi.fn(),
  handleSendOTP: vi.fn()
}));
vi.mock("../constant/saveFileSize", () => ({ SaveFileSize: vi.fn() }));
vi.mock("../utils", () => ({
  compressImage: vi.fn(),
  sanitizeFileName: (n) => n,
  withSessionValidation: (fn) => fn
}));

// Newer Node versions define their own, empty localStorage global, which
// shadows jsdom's (as in PhoneSign.test.jsx). Use an in-memory one.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}
vi.stubGlobal("localStorage", memoryStorage());

describe("UserProfile", () => {
  beforeEach(() => {
    localStorage.setItem(
      "UserInformation",
      JSON.stringify({ name: "Ada", email: "ada@example.com", phone: "" })
    );
    localStorage.setItem(
      "Extand_Class",
      JSON.stringify([{ objectId: "e1", Company: "Acme", JobTitle: "CEO" }])
    );
    localStorage.setItem("username", "Ada");
    // Signed in (otherwise the page redirects to /).
    localStorage.setItem("accesstoken", "r:session");
  });

  it("shows the Email PDFs card under the profile", async () => {
    render(<UserProfile />);
    const email = await screen.findByText("ada@example.com");
    const card = screen.getByTestId("mail-inbox-card");
    // After the profile card in the page.
    expect(
      email.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
