import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Parse from "parse";
import * as kit from "../vendor/signInWithBetterSignButton/browser";
import {
  BSID_CALLBACK_PATH,
  bsIdRedirectUri,
  signInWithBetterSign,
  takeBsIdCallback
} from "./bsid";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("../vendor/signInWithBetterSignButton/browser", () => ({
  signInWithBetterSign: vi.fn(async () => ({ result: "redirecting" })),
  takePasskeyCallback: vi.fn(() => ({ code: "c" }))
}));

const run = Parse.Cloud.run;
const optionsOf = () => kit.signInWithBetterSign.mock.calls.at(-1)[0];

beforeEach(() => {
  run.mockReset();
  kit.signInWithBetterSign.mockClear();
  kit.takePasskeyCallback.mockClear();
  delete window.RUNTIME_ENV;
});
afterEach(() => delete window.RUNTIME_ENV);

describe("signInWithBetterSign (this site's settings for the kit)", () => {
  it("uses bs-id's production URL and this app's client by default", async () => {
    const onStatus = vi.fn();
    await signInWithBetterSign({ onStatus });
    const o = optionsOf();
    expect(o.bsIdUrl).toBe("https://id.bettersign.ing");
    expect(o.clientId).toBe("bs-opensign");
    expect(o.redirectUri).toBe(window.location.origin + BSID_CALLBACK_PATH);
    expect(o.redirectUri).toBe(bsIdRedirectUri());
    expect(o.onStatus).toBe(onStatus);
  });

  it("takes bs-id's URL and client from the runtime env", async () => {
    window.RUNTIME_ENV = {
      REACT_APP_BS_ID_URL: "http://localhost:8788/",
      REACT_APP_BS_ID_CLIENT_ID: "bs-opensign-dev"
    };
    await signInWithBetterSign();
    expect(optionsOf().bsIdUrl).toBe("http://localhost:8788");
    expect(optionsOf().clientId).toBe("bs-opensign-dev");
  });

  it("gets the challenge from bsextchallenge and sends its id to bsextlogin", async () => {
    await signInWithBetterSign();
    const o = optionsOf();
    run.mockResolvedValueOnce({ challengeId: "ch1", challenge: "CHAL" });
    expect(await o.getChallenge()).toBe("CHAL");
    expect(run).toHaveBeenLastCalledWith("bsextchallenge");

    const session = { sessionToken: "r:1", objectId: "u1", bettersign: true };
    run.mockResolvedValueOnce(session);
    expect(await o.complete({ statement: "st", vladSig: "sig", challenge: "CHAL" })).toBe(session);
    expect(run).toHaveBeenLastCalledWith("bsextlogin", { challengeId: "ch1", statement: "st", vladSig: "sig" });
  });

  it("keeps each sign-in's challenge id to itself", async () => {
    await signInWithBetterSign();
    const first = optionsOf();
    await signInWithBetterSign();
    const second = optionsOf();
    run.mockResolvedValueOnce({ challengeId: "A", challenge: "a" });
    await first.getChallenge();
    run.mockResolvedValueOnce({ challengeId: "B", challenge: "b" });
    await second.getChallenge();
    run.mockResolvedValue({});
    await first.complete({ statement: "s", vladSig: "v" });
    expect(run).toHaveBeenLastCalledWith("bsextlogin", { challengeId: "A", statement: "s", vladSig: "v" });
  });

  it("passes server errors through to the kit (which reports 'failed')", async () => {
    await signInWithBetterSign();
    run.mockRejectedValueOnce(new Error("This BetterSign identity isn't linked"));
    await expect(optionsOf().complete({ statement: "s", vladSig: "v" })).rejects.toThrow(/isn't linked/);
  });
});

describe("takeBsIdCallback", () => {
  it("reads the callback against this site's redirect URI", () => {
    expect(takeBsIdCallback("?code=c&state=s")).toEqual({ code: "c" });
    expect(kit.takePasskeyCallback).toHaveBeenCalledWith("?code=c&state=s", {
      redirectUri: window.location.origin + BSID_CALLBACK_PATH
    });
  });
});
