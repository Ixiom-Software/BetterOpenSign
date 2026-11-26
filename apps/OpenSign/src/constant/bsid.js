// "Sign in with BetterID": this site's settings for the shared sign-in
// button (src/vendor/signInWithBetterIDButton/button.js, the
// <betterid-sign-in> element, vendored from BetterSignApps
// server/signInWithBetterIDButton). components/BetterIDSignInButton.jsx
// mounts it with signInButtonOptions().
//
// The button tries the BetterID extension first: if this browser was linked
// to this site ("Remember this browser" at the first passkey sign-in), the
// phone approves with a tap, no QR. The server half is the `bsextchallenge`
// and `bsextlogin` cloud functions
// (apps/OpenSignServer/cloud/parsefunction/bsextlogin.js).
//
// Otherwise it redirects to bs-id (https://id.betterid.net) for the passkey:
// an authorization-code + PKCE flow. bs-id sends the browser back to
// BSID_CALLBACK_PATH, where the button (on Login.jsx) finishes by itself
// through the `bsidlogin` cloud function
// (apps/OpenSignServer/cloud/parsefunction/bsidlogin.js), which exchanges the
// code, verifies the id_token and returns a session.
//
// It asks bs-id for scope `openid email`: the id_token then carries the
// email the person linked and verified in the BetterID app (Settings →
// Account → Link an email address), which self sign-up (server
// BS_SELF_SIGNUP) needs to make an account for a new VLAD. The extension
// carries no email, so when bsextlogin answers USE_PASSKEY_CODE (a VLAD with
// no account, self sign-up on), this goes on to bs-id's passkey page instead.

import Parse from "parse";
import { getEnv } from "./Utils";
import { startPasskeySignIn } from "../vendor/signInWithBetterIDButton/browser";

export const BSID_CALLBACK_PATH = "/auth/bettersign/callback";
export const BSID_SCOPE = "openid email";
// apps/OpenSignServer/utils/bsSignInDecision.js USE_PASSKEY_CODE
export const USE_PASSKEY_CODE = 4201;

function config() {
  const env = typeof getEnv === "function" ? getEnv() : null;
  const url =
    env?.REACT_APP_BS_ID_URL ||
    process.env.REACT_APP_BS_ID_URL ||
    "https://id.betterid.net";
  const clientId =
    env?.REACT_APP_BS_ID_CLIENT_ID ||
    process.env.REACT_APP_BS_ID_CLIENT_ID ||
    "bs-opensign";
  return { bsIdUrl: url.replace(/\/$/, ""), clientId };
}

export const bsIdRedirectUri = () =>
  window.location.origin + BSID_CALLBACK_PATH;

/**
 * Options for the kit's mountSignInButton(): bs-id and this site's client,
 * and the hooks that send each step to the Parse cloud functions instead of
 * the kit's default /betterid routes. Each resolves to what the cloud
 * function returned ({ sessionToken, objectId, betterid: true }).
 */
export function signInButtonOptions() {
  // One button signs in once at a time, so the challenge id from
  // getChallenge is the one completeExtension needs.
  let challengeId;
  const c = config();
  return {
    ...c,
    redirectUri: bsIdRedirectUri(),
    scope: BSID_SCOPE,
    getChallenge: async () => {
      const r = await Parse.Cloud.run("bsextchallenge");
      challengeId = r.challengeId;
      return r.challenge;
    },
    completeExtension: async ({ statement, vladSig }) => {
      try {
        return await Parse.Cloud.run("bsextlogin", {
          challengeId,
          statement,
          vladSig
        });
      } catch (e) {
        if (e?.code !== USE_PASSKEY_CODE) throw e;
        // First sign-in of a new VLAD: bs-id can make the account. The page
        // leaves for bs-id, so this never settles.
        await startPasskeySignIn({
          ...c,
          redirectUri: bsIdRedirectUri(),
          scope: BSID_SCOPE
        });
        return new Promise(() => {});
      }
    },
    completePasskey: ({ code, codeVerifier, nonce, redirectUri }) =>
      Parse.Cloud.run("bsidlogin", { code, codeVerifier, nonce, redirectUri })
  };
}
