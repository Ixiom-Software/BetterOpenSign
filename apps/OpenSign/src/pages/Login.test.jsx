import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import axios from "axios";
import Parse from "parse";
import Login from "./Login";
import { markBetterSignSession } from "../components/pdf/PhoneSign";
import * as kit from "../vendor/signInWithBetterSignButton/browser";

vi.mock("parse", () => ({
  default: { Cloud: { run: vi.fn(async () => null) }, User: { become: vi.fn(async () => ({})) } }
}));
vi.mock("axios", () => ({ default: { get: vi.fn() } }));
vi.mock("react-redux", () => ({ useDispatch: () => vi.fn() }));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: window.location.pathname, search: window.location.search, state: null })
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
// The real <bettersign-sign-in> element and constant/bsid.js; only the kit's
// extension and bs-id steps are stand-ins.
vi.mock("../vendor/signInWithBetterSignButton/browser", () => ({
  extensionSignIn: vi.fn(),
  hasPendingPasskeySignIn: vi.fn(() => false),
  startPasskeySignIn: vi.fn(() => new Promise(() => {})),
  takePasskeyCallback: vi.fn()
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

// The button lives in the element's shadow root.
const widget = async () => {
  const el = await waitFor(() => {
    const found = document.querySelector("bettersign-sign-in");
    expect(found).not.toBeNull();
    return found;
  });
  return within(el.shadowRoot);
};
const button = async () => (await widget()).getByRole("button", { name: /Sign in with BetterSign/ });
const status = async () => (await widget()).getByRole("status");

const run = Parse.Cloud.run;
const session = (token) => ({ sessionToken: token, objectId: "u1", bettersign: true });

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
  kit.hasPendingPasskeySignIn.mockReturnValue(false);
  kit.startPasskeySignIn.mockImplementation(() => new Promise(() => {}));
  run.mockImplementation(async () => null);
  axios.get.mockResolvedValue({ data: null });
});

describe("Sign in with BetterSign button", () => {
  it("is the shared widget, for this site's client", async () => {
    render(<Login />);
    await button();
    const el = document.querySelector("bettersign-sign-in");
    expect(el.getAttribute("client-id")).toBe("bs-opensign");
    expect(el.getAttribute("redirect-uri")).toBe(window.location.origin + "/auth/bettersign/callback");
  });

  it("shows the phone status while waiting, and stays busy", async () => {
    let finish;
    kit.extensionSignIn.mockImplementation(({ onStatus }) => {
      onStatus("Approve on your phone…");
      return new Promise((r) => (finish = r));
    });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(async () => expect(await status()).toHaveTextContent("Approve on your phone…"));
    expect(await button()).toBeDisabled();
    finish({ result: "denied" });
    await waitFor(async () => expect(await button()).toBeEnabled());
  });

  it("signed in through the extension: bsextchallenge, bsextlogin, then the session", async () => {
    run.mockImplementation(async (name) =>
      name === "bsextchallenge" ? { challengeId: "ch1", challenge: "CHAL" } : session("r:ext")
    );
    kit.extensionSignIn.mockImplementation(async ({ rp, getChallenge, complete }) => {
      expect(rp).toBe("bs-opensign");
      const challenge = await getChallenge();
      return { result: "ok", value: await complete({ statement: "st", vladSig: "sig", challenge }) };
    });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(() => expect(markBetterSignSession).toHaveBeenCalledWith(session("r:ext")));
    expect(run).toHaveBeenCalledWith("bsextlogin", { challengeId: "ch1", statement: "st", vladSig: "sig" });
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(axios.get.mock.calls[0][1].headers["X-Parse-Session-Token"]).toBe("r:ext");
  });

  it("denied on the phone: says so", async () => {
    kit.extensionSignIn.mockResolvedValue({ result: "denied" });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(async () => expect(await status()).toHaveTextContent("Sign-in was denied on your phone."));
    expect(markBetterSignSession).not.toHaveBeenCalled();
  });

  it("refused by the server: shows its message", async () => {
    kit.extensionSignIn.mockResolvedValue({
      result: "failed",
      error: new Error("This BetterSign identity isn't linked to an account.")
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(async () => expect(await status()).toHaveTextContent(/isn't linked to an account/));
    expect(markBetterSignSession).not.toHaveBeenCalled();
  });

  it("not linked: off to bs-id for the passkey, busy until the page leaves", async () => {
    kit.extensionSignIn.mockResolvedValue({ result: "unavailable" });
    render(<Login />);
    fireEvent.click(await button());
    await waitFor(() => expect(kit.startPasskeySignIn).toHaveBeenCalledWith({
      bsIdUrl: "https://id.bettersign.ing",
      clientId: "bs-opensign",
      redirectUri: window.location.origin + "/auth/bettersign/callback"
    }));
    expect(await button()).toBeDisabled();
  });

  it("back from bs-id: finishes through bsidlogin and leaves the callback path", async () => {
    window.history.replaceState(null, "", "/auth/bettersign/callback?code=c&state=s");
    const cb = { code: "c", codeVerifier: "v", nonce: "n", redirectUri: window.location.origin + "/auth/bettersign/callback" };
    kit.hasPendingPasskeySignIn.mockReturnValue(true);
    kit.takePasskeyCallback.mockReturnValue(cb);
    run.mockImplementation(async (name) => (name === "bsidlogin" ? session("r:pk") : null));
    render(<Login />);
    await waitFor(() => expect(markBetterSignSession).toHaveBeenCalledWith(session("r:pk")));
    expect(run).toHaveBeenCalledWith("bsidlogin", cb);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(axios.get.mock.calls[0][1].headers["X-Parse-Session-Token"]).toBe("r:pk");
  });
});
