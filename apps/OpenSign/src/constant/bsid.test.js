import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Parse from "parse";
import { BSID_CALLBACK_PATH, bsIdRedirectUri, signInButtonOptions } from "./bsid";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));

const run = Parse.Cloud.run;

beforeEach(() => {
  run.mockReset();
  delete window.RUNTIME_ENV;
});
afterEach(() => delete window.RUNTIME_ENV);

describe("signInButtonOptions (this site's settings for the button)", () => {
  it("uses bs-id's production URL and this app's client by default", () => {
    const o = signInButtonOptions();
    expect(o.bsIdUrl).toBe("https://id.betterid.net");
    expect(o.clientId).toBe("bs-opensign");
    expect(o.redirectUri).toBe(window.location.origin + BSID_CALLBACK_PATH);
    expect(o.redirectUri).toBe(bsIdRedirectUri());
  });

  it("takes bs-id's URL and client from the runtime env", () => {
    window.RUNTIME_ENV = {
      REACT_APP_BS_ID_URL: "http://localhost:8788/",
      REACT_APP_BS_ID_CLIENT_ID: "bs-opensign-dev"
    };
    const o = signInButtonOptions();
    expect(o.bsIdUrl).toBe("http://localhost:8788");
    expect(o.clientId).toBe("bs-opensign-dev");
  });

  it("gets the challenge from bsextchallenge and sends its id to bsextlogin", async () => {
    const o = signInButtonOptions();
    run.mockResolvedValueOnce({ challengeId: "ch1", challenge: "CHAL" });
    expect(await o.getChallenge()).toBe("CHAL");
    expect(run).toHaveBeenLastCalledWith("bsextchallenge");

    const session = { sessionToken: "r:1", objectId: "u1", bettersign: true };
    run.mockResolvedValueOnce(session);
    expect(await o.completeExtension({ statement: "st", vladSig: "sig", challenge: "CHAL" })).toBe(session);
    expect(run).toHaveBeenLastCalledWith("bsextlogin", { challengeId: "ch1", statement: "st", vladSig: "sig" });
  });

  it("keeps each button's challenge id to itself", async () => {
    const first = signInButtonOptions();
    const second = signInButtonOptions();
    run.mockResolvedValueOnce({ challengeId: "A", challenge: "a" });
    await first.getChallenge();
    run.mockResolvedValueOnce({ challengeId: "B", challenge: "b" });
    await second.getChallenge();
    run.mockResolvedValue({});
    await first.completeExtension({ statement: "s", vladSig: "v" });
    expect(run).toHaveBeenLastCalledWith("bsextlogin", { challengeId: "A", statement: "s", vladSig: "v" });
  });

  it("finishes the passkey through bsidlogin", async () => {
    const o = signInButtonOptions();
    const session = { sessionToken: "r:2", objectId: "u1", bettersign: true };
    run.mockResolvedValueOnce(session);
    const cb = { code: "c", codeVerifier: "v", nonce: "n", redirectUri: bsIdRedirectUri() };
    expect(await o.completePasskey(cb)).toBe(session);
    expect(run).toHaveBeenLastCalledWith("bsidlogin", cb);
  });

  it("passes server errors through to the button (which reports them)", async () => {
    const o = signInButtonOptions();
    run.mockRejectedValueOnce(new Error("This BetterSign identity isn't linked"));
    await expect(o.completeExtension({ statement: "s", vladSig: "v" })).rejects.toThrow(/isn't linked/);
  });
});
