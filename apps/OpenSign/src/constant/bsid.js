// "Sign in with BetterSign": this site's settings for the shared sign-in
// button (src/vendor/signInWithBetterSignButton/button.js, the
// <bettersign-sign-in> element, vendored from BetterSignApps
// server/signInWithBetterSignButton). components/BetterSignSignInButton.jsx
// mounts it with signInButtonOptions().
//
// The button tries the BetterSign extension first: if this browser was linked
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

import Parse from "parse";
import { getEnv } from "./Utils";

export const BSID_CALLBACK_PATH = "/auth/bettersign/callback";

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
 * the kit's default /bettersign routes. Each resolves to what the cloud
 * function returned ({ sessionToken, objectId, bettersign: true }).
 */
export function signInButtonOptions() {
  // One button signs in once at a time, so the challenge id from
  // getChallenge is the one completeExtension needs.
  let challengeId;
  return {
    ...config(),
    redirectUri: bsIdRedirectUri(),
    getChallenge: async () => {
      const r = await Parse.Cloud.run("bsextchallenge");
      challengeId = r.challengeId;
      return r.challenge;
    },
    completeExtension: ({ statement, vladSig }) =>
      Parse.Cloud.run("bsextlogin", { challengeId, statement, vladSig }),
    completePasskey: ({ code, codeVerifier, nonce, redirectUri }) =>
      Parse.Cloud.run("bsidlogin", { code, codeVerifier, nonce, redirectUri })
  };
}
