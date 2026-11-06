// "Sign in with BetterSign" through bs-id (the BetterSign OIDC provider,
// https://id.bettersign.ing): the browser half of an authorization-code + PKCE
// sign-in. The server half is the `bsidlogin` cloud function
// (apps/OpenSignServer/cloud/parsefunction/bsidlogin.js), which exchanges the
// code, verifies the id_token and returns a Parse session token.
//
// startBsIdLogin() keeps state, nonce and the PKCE verifier in sessionStorage
// and redirects to bs-id. bs-id sends the browser back to CALLBACK_PATH, where
// Login.jsx calls takeBsIdCallback() and then `bsidlogin`.

import { getEnv } from "./Utils";

export const BSID_CALLBACK_PATH = "/auth/bettersign/callback";
const FLOW_KEY = "bsid_flow";

function config() {
  const env = typeof getEnv === "function" ? getEnv() : null;
  const url =
    env?.REACT_APP_BS_ID_URL ||
    process.env.REACT_APP_BS_ID_URL ||
    "https://id.bettersign.ing";
  const clientId =
    env?.REACT_APP_BS_ID_CLIENT_ID ||
    process.env.REACT_APP_BS_ID_CLIENT_ID ||
    "bs-opensign";
  return { url: url.replace(/\/$/, ""), clientId };
}

function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const randomB64url = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function s256(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return b64url(new Uint8Array(digest));
}

export const bsIdRedirectUri = () =>
  window.location.origin + BSID_CALLBACK_PATH;

/** Redirect to bs-id to sign in. */
export async function startBsIdLogin() {
  const c = config();
  const flow = {
    state: randomB64url(32),
    nonce: randomB64url(16),
    verifier: randomB64url(32) // 43 chars, as bs-id requires
  };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  const dest = new URL(c.url + "/authorize");
  dest.search = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: bsIdRedirectUri(),
    scope: "openid",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await s256(flow.verifier),
    code_challenge_method: "S256"
  }).toString();
  window.location.assign(dest.toString());
}

/**
 * Read bs-id's redirect back. Consumes the stored flow (single use) and checks
 * `state`, so a callback this browser didn't start is refused.
 * Returns { code, codeVerifier, nonce, redirectUri } or { error }.
 */
export function takeBsIdCallback(search) {
  const q = new URLSearchParams(search);
  const raw = sessionStorage.getItem(FLOW_KEY);
  sessionStorage.removeItem(FLOW_KEY);
  if (q.get("error")) {
    return { error: q.get("error_description") || q.get("error") };
  }
  let flow;
  try {
    flow = JSON.parse(raw || "");
  } catch {
    flow = null;
  }
  if (!flow || !q.get("state") || q.get("state") !== flow.state) {
    return { error: "This sign-in link has expired. Please try again." };
  }
  if (!q.get("code")) return { error: "BetterSign returned no sign-in code." };
  return {
    code: q.get("code"),
    codeVerifier: flow.verifier,
    nonce: flow.nonce,
    redirectUri: bsIdRedirectUri()
  };
}
