// bsidlogin — "Sign in with BetterID" through bs-id (the BetterID OIDC
// provider, BetterSignApps apps/Experiments/bs-id, https://id.betterid.net).
//
// The browser runs the authorization-code + PKCE redirect (see
// apps/OpenSign/src/constant/bsid.js) and hands us the code. We:
//   1. exchange it at bs-id /token (public client: code_verifier, no secret),
//   2. verify the id_token (ES256 against bs-id /jwks; iss, aud, nonce, exp),
//   3. map its `vlad` to its OpenSign account (the bs_Identity class,
//      utils/bsIdentity.js), or, with self sign-up on, make one for it,
//   4. mint a Parse session for that account (same /loginAs path as
//      betteridlogin), which Login.jsx finishes with thirdpartyLoginfn.
//
// Who gets in (utils/bsSignInDecision.js):
//   - a VLAD with an active link signs in to the linked account;
//   - with BS_SELF_SIGNUP=true, a VLAD with no link whose id_token carries a
//     verified email (the browser asks for scope `openid email`) gets a new
//     account of its own, made as OpenSign's sign-up makes one, and is linked
//     to it (utils/bsSelfSignup.js). Not if an account already uses that
//     email (it's never linked automatically), and not if an admin turned the
//     VLAD's link off;
//   - everyone else is refused, and the VLAD is recorded on the Users page for
//     an admin to link. No email: the message says how to link one in the
//     BetterID app.
//
// Env:
//   BS_ID_URL        bs-id origin (= the id_token `iss`). Default https://id.betterid.net
//   BS_ID_CLIENT_ID  this app's client_id at bs-id. Default bs-opensign
//   BS_SELF_SIGNUP   `true` turns self sign-up on. Default off
//
// Params: { code, codeVerifier, redirectUri, nonce }
// Returns: { sessionToken, objectId, email, betterid, created } (betterid: the
// session was recorded as a BetterID one; created: the account was just made)

import crypto from 'node:crypto';
import axios from 'axios';
import { sessionViaLoginAs } from './betteridlogin.js';
import { accountForVlad, recordSignInAttempt } from '../../utils/bsIdentity.js';
import {
  USE_PASSKEY_CODE,
  decideSignIn,
  selfSignupEnabled,
  signupName,
  verifiedEmail,
} from '../../utils/bsSignInDecision.js';
import { SignupLost, createAccountForVlad, emailOwner } from '../../utils/bsSelfSignup.js';
import { recordBsIdSession } from '../../utils/bsWebSession.js';

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const JWKS_TTL_MS = 10 * 60 * 1000;

function config() {
  return {
    url: (process.env.BS_ID_URL || 'https://id.betterid.net').replace(/\/$/, ''),
    clientId: process.env.BS_ID_CLIENT_ID || 'bs-opensign',
  };
}

const fail = msg => new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, msg);
const b64urlJson = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// --- id_token verification (bs-id, ES256) -------------------------------------

let jwksCache = null; // { url, at, keys }

async function bsIdKey(c, kid) {
  const url = c.url + '/jwks';
  if (
    !jwksCache ||
    jwksCache.url !== url ||
    Date.now() - jwksCache.at > JWKS_TTL_MS ||
    !jwksCache.keys.some(k => k.kid === kid)
  ) {
    const res = await axios.get(url, { timeout: 10000 });
    jwksCache = { url, at: Date.now(), keys: res.data?.keys || [] };
  }
  const jwk = jwksCache.keys.find(k => k.kid === kid);
  if (!jwk) throw new Error('id_token kid not in bs-id jwks');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    format: 'jwk',
  });
}

export async function verifyIdToken(c, idToken, nonce) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || !parts.every(p => B64URL_RE.test(p))) {
    throw new Error('id_token is not a JWS');
  }
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'ES256' || !header.kid) throw new Error('id_token must be ES256 with a kid');
  const key = await bsIdKey(c, header.kid);
  const ok = crypto.verify(
    'sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key, dsaEncoding: 'ieee-p1363' }, // JWS ES256 is raw r||s
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw new Error('id_token signature does not verify');
  const p = b64urlJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (p.iss !== c.url) throw new Error(`id_token iss ${p.iss} is not ${c.url}`);
  if (p.aud !== c.clientId) throw new Error('id_token aud is not this app');
  if (p.nonce !== nonce) throw new Error('id_token nonce does not match this sign-in');
  if (typeof p.exp !== 'number' || p.exp < now - 30) throw new Error('id_token expired');
  if (typeof p.iat !== 'number' || p.iat > now + 60)
    throw new Error('id_token iat is in the future');
  if (typeof p.sub !== 'string' || !p.sub) throw new Error('id_token has no sub');
  if (typeof p.vlad !== 'string' || !/^[0-9a-f]+$/i.test(p.vlad))
    throw new Error('id_token has no vlad');
  return p;
}

// --- cloud function -------------------------------------------------------------

export default async function bsidlogin(request) {
  const { code, codeVerifier, redirectUri, nonce } = request.params || {};
  if (![code, codeVerifier, nonce].every(v => typeof v === 'string' && B64URL_RE.test(v))) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing or malformed sign-in parameters.');
  }
  if (typeof redirectUri !== 'string' || !/^https?:\/\//.test(redirectUri)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing redirect URI.');
  }
  const c = config();

  // 1. Code -> tokens. bs-id checks client_id, redirect_uri and PKCE.
  let tokens;
  try {
    const res = await axios.post(
      c.url + '/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: c.clientId,
        code_verifier: codeVerifier,
      }).toString(),
      { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    tokens = res.data;
  } catch (e) {
    console.log('bsidlogin: token exchange failed', e?.response?.data || e?.message);
    throw fail('BetterID sign-in failed. Please try again.');
  }

  // 2. Verify the id_token.
  let claims;
  try {
    claims = await verifyIdToken(c, tokens?.id_token, nonce);
  } catch (e) {
    console.log('bsidlogin: id_token rejected:', e.message);
    throw fail('BetterID sign-in could not be verified.');
  }

  // 3 and 4: the account and its session.
  return signInVlad(claims.vlad.toLowerCase(), 'bsidlogin', { claims });
}

const LINK_EMAIL =
  'In the BetterID app, open Settings → Account → Link an email address, then sign in again.';

function refusal(reason, vlad, email) {
  const short = `VLAD ${vlad.slice(0, 16)}…`;
  switch (reason) {
    case 'no_account':
      return fail('The account linked to this BetterID identity does not exist.');
    case 'use_passkey':
      return new Parse.Error(
        USE_PASSKEY_CODE,
        'Your first sign-in to Better DocSign needs your passkey. Continuing with BetterID…'
      );
    case 'no_email':
      return fail(
        `To create a Better DocSign account, your BetterID needs a verified email address. ${LINK_EMAIL}`
      );
    case 'email_taken':
      return fail(
        `A Better DocSign account already uses ${email}, but it isn't linked to this BetterID identity. Ask an admin of that account to link it (${short}).`
      );
    case 'busy':
      return fail('Your Better DocSign account is still being set up. Sign in again in a moment.');
    default:
      return fail(
        `This BetterID identity isn't linked to an account. Ask an admin to add it (${short}).`
      );
  }
}

// Another sign-in of the same VLAD is making its account: wait for its link.
async function waitForLink(vlad) {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const account = await accountForVlad(vlad);
    if (account.user) return account;
  }
  return null;
}

// Self sign-up (decision.action === 'create'). Returns accountForVlad()'s
// answer for the new (or the racing sign-in's) account, or throws a refusal.
async function selfSignUp(vlad, event, decision, email, claims) {
  try {
    const { userId } = await createAccountForVlad({
      vlad,
      email,
      name: signupName(claims, email),
      reuseUserId: decision.reuseUserId,
    });
    console.log(
      JSON.stringify({
        event: `${event}_account_created`,
        vlad: vlad.slice(0, 16),
        userId,
        reusedRecipient: !!decision.reuseUserId,
      })
    );
  } catch (e) {
    const reason = e instanceof SignupLost ? e.reason : 'error';
    console.log(
      JSON.stringify({
        event: `${event}_signup_lost`,
        vlad: vlad.slice(0, 16),
        reason,
        error: e.message,
      })
    );
    if (reason === 'email_taken') {
      await recordSignInAttempt(vlad);
      throw refusal('email_taken', vlad, email);
    }
    // 'busy', or it failed (maybe because the VLAD got linked meanwhile).
    const account = reason === 'busy' ? await waitForLink(vlad) : await accountForVlad(vlad);
    if (account?.user) return { ...account, created: false };
    if (reason === 'busy') throw refusal('busy', vlad);
    throw fail('Your Better DocSign account could not be created. Please try again.');
  }
  const account = await accountForVlad(vlad);
  if (!account.user)
    throw fail('Your Better DocSign account could not be created. Please try again.');
  return { ...account, created: true };
}

// A VLAD that has proved itself (bs-id's id_token, or the phone's signature
// in bsextlogin.js) -> a session for its account. `event` prefixes the log
// lines. `claims`: bs-id's verified id_token claims (the verified email for
// self sign-up); absent for the extension.
export async function signInVlad(vlad, event, { claims } = {}) {
  // 3. VLAD -> account.
  let account = await accountForVlad(vlad);
  const email = verifiedEmail(claims);
  const facts = {
    account,
    selfSignup: selfSignupEnabled(),
    via: claims ? 'bsid' : 'extension',
    email,
  };
  let decision = decideSignIn(facts);
  if (decision.action === 'lookup_email') {
    decision = decideSignIn({ ...facts, emailOwner: await emailOwner(email) });
  }
  if (decision.action === 'refuse') {
    const { reason, record } = decision;
    const ev = reason === 'no_account' ? `${event}_no_account` : `${event}_denied`;
    console.log(JSON.stringify({ event: ev, vlad, reason, linkReason: account.reason }));
    // The VLAD proved itself: list it on the Users page for an admin.
    if (record) await recordSignInAttempt(vlad);
    throw refusal(reason, vlad, email);
  }
  let created = false;
  if (decision.action === 'create') {
    account = await selfSignUp(vlad, event, decision, email, claims);
    created = account.created;
  }
  const { user, email: accountEmail } = account;

  // 4. Session for that account, remembered as a BetterID session (for
  // "Sign on phone", utils/bsWebSession.js). The sign-in doesn't depend on
  // that: if it can't be recorded, the session just isn't a BetterID one.
  const login = await sessionViaLoginAs(user.id);
  let betterid = true;
  try {
    await recordBsIdSession(login.sessionToken, vlad, user.id);
  } catch (e) {
    betterid = false;
    console.log(JSON.stringify({ event: `${event}_session_not_recorded`, error: e.message }));
  }
  console.log(JSON.stringify({ event, vlad: vlad.slice(0, 16), userId: user.id }));
  return {
    sessionToken: login.sessionToken,
    objectId: user.id,
    email: accountEmail,
    betterid,
    created,
  };
}
