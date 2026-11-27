// Users page: Team seats. The license service (bs-license) keeps who holds
// a seat; these functions call its product API (utils/bsLicense.js
// productApi) acting as the signed-in admin's VLAD, so the service decides
// which teams they may see and change: the ones the VLAD is an admin of.
// Here, the caller must also be an Admin or OrgAdmin (adminScope).
//
//   bslicenseteams   {}               -> { configured, teams: [team + { organization }] }
//   bslicenseteam    { id }           -> { team, seats: [seat + { account }] }
//   bslicenseremove  { id, vlad }     -> the service's answer
//   bslicenseapprove { id, vlad }     -> the service's answer
//   bslicenserotate  { id }           -> { join_code }
//
// The acting VLAD is the one this session signed in with (bsWebSession), or
// else the caller's only active BetterID link.

import { VLAD_HEX_RE } from '../../utils/bsIdentity.js';
import { bsIdSessionVlad } from '../../utils/bsWebSession.js';
import { LicenseApiError, isTeamId, licenseConfig, productApi } from '../../utils/bsLicense.js';
import { mappedTeams } from '../../utils/bsLicenseAccounts.js';
import { adminScope } from './bsIdentityAdmin.js';

const userPtr = id => ({ __type: 'Pointer', className: '_User', objectId: id });

// The VLAD to act as, or a Parse.Error.
async function actingVlad(request) {
  const fromSession = await bsIdSessionVlad(request).catch(() => null);
  if (fromSession) return fromSession;
  const rows = await new Parse.Query('bs_Identity')
    .equalTo('UserId', userPtr(request.user.id))
    .equalTo('Active', true)
    .descending('LastSeenAt')
    .addDescending('updatedAt')
    .limit(10)
    .find({ useMasterKey: true });
  if (rows.length !== 1) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      rows.length
        ? 'Sign in with BetterID to manage team seats.'
        : 'Your account has no BetterID identity. Team seats are managed with the BetterID identity that administers the team.'
    );
  }
  return rows[0].get('vlad');
}

function parseError(e) {
  if (!(e instanceof LicenseApiError)) return e;
  console.log(JSON.stringify({ event: 'bslicense_api_error', status: e.status, code: e.code }));
  if (e.code === 'not_configured') {
    return new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, "Team seats aren't set up here.");
  }
  if (e.status === 0) {
    return new Parse.Error(
      Parse.Error.CONNECTION_FAILED,
      "Couldn't reach the license service. Try again."
    );
  }
  if (e.status === 401 || e.status === 403) {
    return new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      "Your BetterID identity isn't an admin of this team."
    );
  }
  if (e.status === 404) return new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Team not found.');
  return new Parse.Error(Parse.Error.VALIDATION_ERROR, e.message);
}

// adminScope, the acting VLAD and an API client; runs fn with them.
async function withApi(request, fn) {
  const scope = await adminScope(request);
  const vlad = await actingVlad(request);
  try {
    return await fn({ api: productApi(licenseConfig()), vlad, scope });
  } catch (e) {
    throw parseError(e);
  }
}

const teamIdParam = request => {
  const id = request.params?.id;
  if (!isTeamId(id)) throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing team.');
  return id;
};

const holderParam = request => {
  const vlad = String(request.params?.vlad || '').toLowerCase();
  if (!VLAD_HEX_RE.test(vlad) || vlad.length > 8192) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing VLAD.');
  }
  return vlad;
};

const logged = (request, event, fields) =>
  console.log(JSON.stringify({ event, by: request.user.id, ...fields }));

export async function listLicenseTeams(request) {
  // Without a product token (a self-hosted site, say) there's nothing to
  // show: say so, and the page leaves the card out.
  if (!licenseConfig().productToken) {
    await adminScope(request);
    return { configured: false, teams: [] };
  }
  return withApi(request, async ({ api, vlad }) => {
    const res = await api.teams(vlad);
    const teams = Array.isArray(res.teams) ? res.teams : [];
    const mapped = await mappedTeams(teams.map(t => t.id).filter(isTeamId));
    return {
      configured: true,
      teams: teams.map(t => ({ ...t, organization: mapped[t.id] || null })),
    };
  });
}

export async function getLicenseTeam(request) {
  const id = teamIdParam(request);
  return withApi(request, async ({ api, vlad, scope }) => {
    const res = await api.team(vlad, id);
    const seats = Array.isArray(res.seats) ? res.seats : [];
    // Name the holders that have an account in the caller's tenant.
    const vlads = seats.map(s => String(s.vlad || '').toLowerCase()).filter(Boolean);
    const links = vlads.length
      ? await new Parse.Query('bs_Identity')
          .containedIn('vlad', vlads)
          .equalTo('Active', true)
          .limit(1000)
          .find({ useMasterKey: true })
      : [];
    const byVlad = {};
    for (const l of links) {
      const account = scope.accounts[l.get('UserId')?.id];
      if (account) byVlad[l.get('vlad')] = { name: account.name, email: account.email };
    }
    const mapped = await mappedTeams([id]);
    return {
      team: { ...res.team, organization: mapped[id] || null },
      seats: seats.map(s => ({
        ...s,
        account: byVlad[String(s.vlad || '').toLowerCase()] || null,
      })),
    };
  });
}

export async function removeLicenseSeat(request) {
  const id = teamIdParam(request);
  const holder = holderParam(request);
  return withApi(request, async ({ api, vlad }) => {
    const res = await api.remove(vlad, id, holder);
    logged(request, 'bslicense_seat_removed', { team: id, vlad: holder.slice(0, 16) });
    return res;
  });
}

export async function approveLicenseSeat(request) {
  const id = teamIdParam(request);
  const holder = holderParam(request);
  return withApi(request, async ({ api, vlad }) => {
    const res = await api.approve(vlad, id, holder);
    logged(request, 'bslicense_seat_approved', { team: id, vlad: holder.slice(0, 16) });
    return res;
  });
}

export async function rotateLicenseCode(request) {
  const id = teamIdParam(request);
  return withApi(request, async ({ api, vlad }) => {
    const res = await api.rotateCode(vlad, id);
    logged(request, 'bslicense_code_rotated', { team: id });
    return { join_code: res.join_code };
  });
}
