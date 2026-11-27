// Team seat licenses (BetterSignApps docs/Technical/license-seats-design.md):
// the parts that don't touch the database.
//
// - licenseFromClaims: is the license bs-id put in a sign-in's id_token one
//   that gives a Better DocSign seat?
// - signInDecision: sign in, create the account, or refuse.
// - productApi: the license service's product API (bs-license /v1/product/*),
//   which the Team seats page uses acting for the signed-in admin's VLAD.
//
// bs-id (client bs-opensign, with a `license` setting) checks the app's
// license presentation offline and puts, in the id_token:
//   license: { jti, team, team_name, product, plan, exp }
//   entitlements: ["docsign.send", ...]
//   team: "<team id>"
// The id_token's own signature (bsidlogin.js verifyIdToken) is what we trust;
// nothing here re-checks the license JWS.
//
// Env:
//   BS_LICENSE_PROVISIONING  "true": a VLAD with no account but a valid seat
//                            gets one on its first sign-in. Default off.
//   BS_LICENSE_REQUIRED      "true": an account in a team's organization
//                            can't sign in without a valid seat for that team.
//                            Default off.
//   BS_LICENSE_TENANT_ID     The tenant team organizations are created in.
//                            Default: the tenant of the only tenant admin.
//   LICENSE_URL              The license service. Default https://license.betterid.net
//   LICENSE_PRODUCT_TOKEN    Bearer token for its product API.

import crypto from 'node:crypto';

export const LICENSE_PRODUCT = 'docsign';
export const SEND_ENTITLEMENT = 'docsign.send';
export const PLACEHOLDER_EMAIL_DOMAIN = 'users.betterid.invalid';

const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 100;

export function licenseConfig(env = process.env) {
  return {
    provisioning: env.BS_LICENSE_PROVISIONING === 'true',
    required: env.BS_LICENSE_REQUIRED === 'true',
    tenantId: env.BS_LICENSE_TENANT_ID || '',
    url: (env.LICENSE_URL || 'https://license.betterid.net').replace(/\/+$/, ''),
    productToken: env.LICENSE_PRODUCT_TOKEN || '',
  };
}

// id_token claims -> { ok: true, license: { jti, team, teamName, product,
// plan, exp, entitlements } } or { ok: false, reason }. `now` in seconds.
// Reasons: no_license, malformed, wrong_product, no_entitlement, expired,
// team_mismatch.
export function licenseFromClaims(claims, now = Math.floor(Date.now() / 1000)) {
  const l = claims?.license;
  if (l === undefined || l === null) return { ok: false, reason: 'no_license' };
  if (typeof l !== 'object' || Array.isArray(l)) return { ok: false, reason: 'malformed' };
  const { jti, team, product, plan, exp } = l;
  if (
    typeof jti !== 'string' ||
    !jti ||
    typeof team !== 'string' ||
    !TEAM_ID_RE.test(team) ||
    typeof product !== 'string' ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (product !== LICENSE_PRODUCT) return { ok: false, reason: 'wrong_product' };
  const entitlements = Array.isArray(claims.entitlements)
    ? claims.entitlements.filter(e => typeof e === 'string')
    : [];
  if (!entitlements.includes(SEND_ENTITLEMENT)) return { ok: false, reason: 'no_entitlement' };
  if (exp <= now) return { ok: false, reason: 'expired' };
  // The top-level `team` is the same team; if it's there and isn't, something's off.
  if (claims.team !== undefined && claims.team !== team) {
    return { ok: false, reason: 'team_mismatch' };
  }
  const teamName =
    typeof l.team_name === 'string' && l.team_name.trim()
      ? l.team_name.trim().slice(0, MAX_NAME)
      : '';
  return {
    ok: true,
    license: {
      jti,
      team,
      teamName,
      product,
      plan: typeof plan === 'string' ? plan : '',
      exp,
      entitlements,
    },
  };
}

// What to do with a BetterID sign-in.
//   account     accountForVlad's answer (utils/bsIdentity.js)
//   license     licenseFromClaims' answer, or null on a sign-in path that
//               carries no claims (the extension, bsextlogin): never gated,
//               never provisioned
//   accountTeam the license team id the account's organization belongs to,
//               or null if it isn't a team organization
//   config      licenseConfig()
// -> { action: 'sign_in' | 'provision' | 'refuse', reason? }
// 'refuse' with reason 'no_account' (or another accountForVlad reason) is the
// existing refusal; 'no_seat' and 'other_team' are the license gate's.
export function signInDecision({ account, license, accountTeam, config }) {
  if (account?.user) {
    if (!config.required || !license || !accountTeam) return { action: 'sign_in' };
    if (!license.ok) return { action: 'refuse', reason: 'no_seat', detail: license.reason };
    if (license.license.team !== accountTeam) return { action: 'refuse', reason: 'other_team' };
    return { action: 'sign_in' };
  }
  // No account: never linked, or only its recorded sign-in attempts. A link an
  // admin turned off, or a broken one, stays refused.
  const unlinked =
    account?.reason === 'not_linked' || (account?.reason === 'inactive' && account.unassigned);
  if (unlinked && config.provisioning && license?.ok) return { action: 'provision' };
  return { action: 'refuse', reason: account?.reason || 'not_linked' };
}

// The email a provisioned account gets when the id_token has none (or it's
// taken): never deliverable (.invalid, RFC 6761), unique per VLAD. A hash,
// since VLADs share their leading bytes.
export function placeholderEmail(vlad) {
  const h = crypto.createHash('sha256').update(String(vlad).toLowerCase()).digest('hex');
  return `${h.slice(0, 16)}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// { email, name } for a new account from the id_token: its email if it looks
// like one (lower-cased), and its name, else the email's local part, else
// "BetterID user".
export function accountDetails(claims, vlad) {
  const raw = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const email = raw && raw.length <= 254 && EMAIL_RE.test(raw) ? raw : '';
  const claimed = typeof claims?.name === 'string' ? claims.name.trim().slice(0, MAX_NAME) : '';
  return {
    email,
    placeholder: placeholderEmail(vlad),
    name: claimed || (email ? email.split('@')[0] : 'BetterID user'),
  };
}

export const isTeamId = id => typeof id === 'string' && TEAM_ID_RE.test(id);

// --- the license service's product API ------------------------------------------

export class LicenseApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `license service answered ${status}`);
    this.status = status;
    this.code = code || 'error';
  }
}

// Calls bs-license /v1/product/* as `vlad` (a team admin there). Every
// method resolves to the service's JSON or throws LicenseApiError (status 0:
// the service couldn't be reached or answered something that isn't JSON).
export function productApi({ url, productToken, timeoutMs = 15000 } = licenseConfig()) {
  async function call(method, path, vlad, body) {
    if (!productToken)
      throw new LicenseApiError(0, 'not_configured', 'LICENSE_PRODUCT_TOKEN is not set.');
    let res;
    try {
      res = await globalThis.fetch(url + path, {
        method,
        headers: {
          authorization: `Bearer ${productToken}`,
          'x-acting-vlad': vlad,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new LicenseApiError(0, 'unreachable', `License service unreachable: ${e.message}`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    if (!res.ok) {
      throw new LicenseApiError(res.status, json?.error, json?.error_description || json?.error);
    }
    if (!json || typeof json !== 'object') {
      throw new LicenseApiError(0, 'bad_answer', 'License service answer is not JSON.');
    }
    return json;
  }
  const teamPath = id => {
    if (!isTeamId(id)) throw new LicenseApiError(400, 'bad_team', 'Unknown team.');
    return `/v1/product/teams/${encodeURIComponent(id)}`;
  };
  return {
    teams: vlad => call('GET', '/v1/product/teams', vlad),
    team: async (vlad, id) => call('GET', teamPath(id), vlad),
    remove: async (vlad, id, holder) =>
      call('POST', `${teamPath(id)}/remove`, vlad, { vlad: holder }),
    approve: async (vlad, id, holder) =>
      call('POST', `${teamPath(id)}/approve`, vlad, { vlad: holder }),
    rotateCode: async (vlad, id) => call('POST', `${teamPath(id)}/rotate-code`, vlad, {}),
  };
}
