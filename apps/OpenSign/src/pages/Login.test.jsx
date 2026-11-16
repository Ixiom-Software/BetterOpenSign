import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import Login from "./Login";
import { signInWithBetterSign } from "../constant/bsid";
import { markBetterSignSession } from "../components/pdf/PhoneSign";

vi.mock("parse", () => ({
  default: { Cloud: { run: vi.fn(async () => null) }, User: { become: vi.fn(async () => ({})) } }
}));
vi.mock("axios", () => ({ default: { get: vi.fn() } }));
vi.mock("react-redux", () => ({ useDispatch: () => vi.fn() }));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "", state: null })
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: "en" } })
}));
vi.mock("../constant/Utils", () => ({
  getAppLogo: vi.fn(async () => ({ logo: "" })),
  saveLanguageInLocal: vi.fn(),
  getEnv: () => ({})
}));
vi.mock("../redux/reducers/infoReducer", () => ({ fetchAppInfo: () => ({ type: "x" }) }));
vi.mock("../components/BrandHero", () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock("../components/pdf/SelectLanguage", () => ({ default: () => null }));
vi.mock("../components/pdf/PhoneSign", () => ({ markBetterSignSession: vi.fn() }));
vi.mock("../constant/bsid", () => ({
  BSID_CALLBACK_PATH: "/auth/bettersign/callback",
  signInWithBetterSign: vi.fn(),
  takeBsIdCallback: vi.fn()
}));

// Newer Node versions shadow jsdom's localStorage with an empty one.
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

const button = () => screen.findByRole("button", { name: /Sign in with BetterSign/ });

beforeEach(() => {
  localStorage.clear();
  signInWithBetterSign.mockReset();
  markBetterSignSession.mockReset();
  axios.get.mockReset();
});

describe("Sign in with BetterSign button", () => {
  it("shows the phone status while waiting, and stays busy", async () => {
    let finish;
    signInWithBetterSign.mockImplementation(({ onStatus }) => {
      onStatus("Approve on your phone…");
      return new Promise((r) => (finish = r));
    });
    render(<Login />);
    fireEvent.click(await button());
    expect(await screen.findByRole("status")).toHaveTextContent("Approve on your phone…");
    expect(await button()).toBeDisabled();
    finish({ result: "denied" });
    await waitFor(async () => expect(await button()).toBeEnabled());
  });

  it("signed in through the extension: marks the session and finishes the sign-in", async () => {
    const value = { sessionToken: "r:ext", objectId: "u1", bettersign: true };
    signInWithBetterSign.mockResolvedValue({ result: "ok", value });
    axios.get.mockResolvedValue({ data: null });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(() => expect(markBetterSignSession).toHaveBeenCalledWith(value));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(axios.get.mock.calls[0][1].headers["X-Parse-Session-Token"]).toBe("r:ext");
  });

  it("denied on the phone: says so", async () => {
    signInWithBetterSign.mockResolvedValue({ result: "denied" });
    render(<Login />);
    fireEvent.click(await button());
    expect(await screen.findByText("Sign-in was denied on your phone.")).toBeInTheDocument();
    expect(markBetterSignSession).not.toHaveBeenCalled();
  });

  it("refused by the server: shows its message", async () => {
    signInWithBetterSign.mockResolvedValue({
      result: "failed",
      error: new Error("This BetterSign identity isn't linked to an account.")
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Login />);
    fireEvent.click(await button());
    expect(await screen.findByText(/isn't linked to an account/)).toBeInTheDocument();
  });

  it("going to bs-id for the passkey: stays busy until the page leaves", async () => {
    signInWithBetterSign.mockResolvedValue({ result: "redirecting" });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(() => expect(signInWithBetterSign).toHaveBeenCalled());
    expect(await button()).toBeDisabled();
  });
});
