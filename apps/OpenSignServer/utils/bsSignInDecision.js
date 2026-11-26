// What to do with a VLAD that has proved itself (bs-id's id_token in
// bsidlogin, or the phone's signature in bsextlogin): sign in to its linked
// account, make it an account (self sign-up), or refuse. Pure: the callers
// (cloud/parsefunction/bsidlogin.js signInVlad) do the lookups and the work.
// Tests: spec/bsapi/signInDecision.spec.js.
//
// Self sign-up (BS_SELF_SIGNUP=true) gives a VLAD with no link a new account
// of its own, but only when
//   - it came through bs-id with a verified email (scope `email`: `email`,
//     `email_verified: true`); the extension path carries no email, so it's
//     sent to bs-id instead ('use_passkey'),
//   - no link of its was turned off by an admin (that's a block),
//   - no OpenSign account uses that email. An account with it isn't linked
//     automatically: whoever holds the email isn't proven to be its owner's
//     VLAD (takeover). A recipient-only _User (OpenSign makes one for every
//     contact, with no contracts_Users row) isn't an account: it's reused.

export const SIGNUP_ENV = 'BS_SELF_SIGNUP';

// The error code bsextlogin answers with when the browser should do this
// first sign-in through bs-id instead (constant/bsid.js in the frontend
// switches to the passkey on it). Outside Parse's own codes.
export const USE_PASSKEY_CODE = 4201;

export const selfSignupEnabled = (env = process.env) =>
  String(env[SIGNUP_ENV] || '').toLowerCase() === 'true';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The verified email from id_token claims, lower-cased, or null.
export function verifiedEmail(claims) {
  if (!claims || claims.email_verified !== true || typeof claims.email !== 'string') return null;
  const email = claims.email.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

// A display name: the token's, else the email's local part ("jane.doe" ->
// "Jane Doe"). The user can change it in their profile.
export function signupName(claims, email) {
  for (const k of ['name', 'preferred_username']) {
    const v = typeof claims?.[k] === 'string' ? claims[k].trim() : '';
    if (v) return v.slice(0, 100);
  }
  const local = String(email || '').split('@')[0];
  const words = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1));
  return (words.join(' ') || local || 'BetterID user').slice(0, 100);
}

/**
 * account     accountForVlad()'s answer: { user } or { reason, turnedOff? }
 * selfSignup  BS_SELF_SIGNUP is on
 * via         'bsid' (bs-id's id_token) or 'extension' (bsextlogin)
 * email       verifiedEmail(claims), or null
 * emailOwner  undefined until looked up; then { kind: 'none' } |
 *             { kind: 'contact', userId } | { kind: 'account' }
 *
 * Returns one of
 *   { action: 'sign_in' }
 *   { action: 'lookup_email' }   look up emailOwner and ask again
 *   { action: 'create', reuseUserId }
 *   { action: 'refuse', reason, record }   record: list the VLAD on the
 *     Users page for an admin (recordSignInAttempt)
 * with reason 'no_account' | 'not_linked' | 'use_passkey' | 'no_email' |
 * 'email_taken'.
 */
export function decideSignIn({ account, selfSignup, via, email, emailOwner }) {
  if (account?.user) return { action: 'sign_in' };
  const refuse = (reason, record) => ({ action: 'refuse', reason, record });
  const reason = account?.reason;
  // The link's account is gone, or there's more than one active link: an
  // admin has to fix it, and it's already on their page.
  if (reason === 'no_account') return refuse('no_account', false);
  if (reason === 'ambiguous') return refuse('not_linked', false);
  const pending = reason === 'not_linked' || reason === 'inactive';
  // Without self sign-up, or with a link an admin turned off: as before.
  if (!selfSignup || !pending || account.turnedOff) return refuse('not_linked', true);
  // The extension can't say which email; bs-id can. The passkey sign-in that
  // follows records the attempt if it's refused, so not here.
  if (via !== 'bsid') return refuse('use_passkey', false);
  // Still recorded: an admin may want to link someone who has no email.
  if (!email) return refuse('no_email', true);
  if (emailOwner === undefined) return { action: 'lookup_email' };
  if (emailOwner.kind === 'none') return { action: 'create', reuseUserId: null };
  if (emailOwner.kind === 'contact' && emailOwner.userId) {
    return { action: 'create', reuseUserId: emailOwner.userId };
  }
  return refuse('email_taken', true);
}
