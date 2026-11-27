// Team seat licenses, the database side (see utils/bsLicense.js for the rules).
//
// Each license team (bs-license's team id) gets its own organization here,
// under the one tenant of the hosted site, with an "All Users" team, as
// upstream's AddAdmin makes for a tenant admin. The mapping is the
// bs_LicenseTeam class (master key only):
//   { LicenseTeam (license team id, unique), Name, Product, Plan,
//     TenantId -> partners_Tenant, OrganizationId -> contracts_Organizations,
//     TeamId -> contracts_Teams, LastSeenAt }
// The first sign-in with a seat in a new license team creates it. Members get
// the role contracts_User; the tenant admin (or an org admin they appoint)
// manages them as any other organization's users.

import crypto from 'node:crypto';
import { ATTEMPT_LABEL } from './bsIdentity.js';
import { accountDetails } from './bsLicense.js';

const CLASS = 'bs_LicenseTeam';
export const SEAT_LABEL = 'BetterID team seat';

// Pointers as Parse objects, so a saved row's get(...).id works before a re-fetch.
const ptr = (className, objectId) =>
  className === '_User'
    ? Parse.User.createWithoutData(objectId)
    : Parse.Object.extend(className).createWithoutData(objectId);

let uniquePending = null;
// Once per process: two first sign-ins of a new team can't both map it.
function ensureUniqueTeam() {
  uniquePending ??= Parse.Server.database.adapter
    .ensureUniqueness(CLASS, { fields: { LicenseTeam: { type: 'String' } } }, ['LicenseTeam'])
    .catch(e => {
      console.log(JSON.stringify({ event: 'bslicense_team_not_unique', error: e.message }));
    });
  return uniquePending;
}

const mappingFor = licenseTeam =>
  new Parse.Query(CLASS)
    .equalTo('LicenseTeam', licenseTeam)
    .ascending('createdAt')
    .first({ useMasterKey: true });

// The license team id whose organization this account is in, or null.
export async function licenseTeamOfUser(userId) {
  const ext = await new Parse.Query('contracts_Users')
    .equalTo('UserId', ptr('_User', userId))
    .first({ useMasterKey: true });
  const orgId = ext?.get('OrganizationId')?.id;
  if (!orgId) return null;
  const row = await new Parse.Query(CLASS)
    .equalTo('OrganizationId', ptr('contracts_Organizations', orgId))
    .first({ useMasterKey: true });
  return row?.get('LicenseTeam') || null;
}

// License team ids -> { name, organizationId } for the teams mapped here.
export async function mappedTeams(licenseTeams) {
  if (!licenseTeams.length) return {};
  const rows = await new Parse.Query(CLASS)
    .containedIn('LicenseTeam', licenseTeams)
    .include('OrganizationId')
    .limit(1000)
    .find({ useMasterKey: true });
  return Object.fromEntries(
    rows.map(r => [
      r.get('LicenseTeam'),
      {
        organizationId: r.get('OrganizationId')?.id || null,
        organizationName: r.get('OrganizationId')?.get?.('Name') || r.get('Name') || '',
      },
    ])
  );
}

// The tenant team organizations go in: BS_LICENSE_TENANT_ID, or the tenant of
// the only tenant admin (the hosted site has one). Throws if it can't tell.
export async function licenseTenant(config) {
  if (config.tenantId) {
    const t = await new Parse.Query('partners_Tenant')
      .get(config.tenantId, { useMasterKey: true })
      .catch(() => null);
    if (!t) throw new Error(`BS_LICENSE_TENANT_ID ${config.tenantId} is not a tenant`);
    return config.tenantId;
  }
  const admins = await new Parse.Query('contracts_Users')
    .equalTo('UserRole', 'contracts_Admin')
    .notEqualTo('IsDisabled', true)
    .limit(100)
    .find({ useMasterKey: true });
  const tenants = [...new Set(admins.map(a => a.get('TenantId')?.id).filter(Boolean))];
  if (tenants.length !== 1) {
    throw new Error(
      `${tenants.length} tenants have an admin; set BS_LICENSE_TENANT_ID to the one for team seats`
    );
  }
  return tenants[0];
}

// The tenant's admin (contracts_Users), who's recorded as creating the
// team organizations. Null if it has none.
const tenantAdmin = tenantId =>
  new Parse.Query('contracts_Users')
    .equalTo('TenantId', ptr('partners_Tenant', tenantId))
    .equalTo('UserRole', 'contracts_Admin')
    .ascending('createdAt')
    .first({ useMasterKey: true });

// The organization and team for a license team, making them on its first
// sign-in. Returns the bs_LicenseTeam row.
export async function ensureLicenseTeam(license, config) {
  await ensureUniqueTeam();
  const existing = await mappingFor(license.team);
  if (existing) {
    if (license.teamName && existing.get('Name') !== license.teamName) {
      existing.set('Name', license.teamName);
    }
    existing.set('Plan', license.plan);
    existing.set('LastSeenAt', new Date());
    await existing.save(null, { useMasterKey: true }).catch(() => {});
    return existing;
  }

  const tenantId = await licenseTenant(config);
  const admin = await tenantAdmin(tenantId);
  const name = license.teamName || `Team ${license.team.slice(0, 8)}`;

  const org = new Parse.Object('contracts_Organizations');
  org.set('Name', name);
  org.set('IsActive', true);
  org.set('TenantId', ptr('partners_Tenant', tenantId));
  if (admin) {
    org.set('ExtUserId', ptr('contracts_Users', admin.id));
    if (admin.get('UserId')) org.set('CreatedBy', ptr('_User', admin.get('UserId').id));
  }
  await org.save(null, { useMasterKey: true });
  const team = new Parse.Object('contracts_Teams');
  team.set('Name', 'All Users');
  team.set('OrganizationId', ptr('contracts_Organizations', org.id));
  team.set('IsActive', true);
  await team.save(null, { useMasterKey: true });

  const row = new Parse.Object(CLASS);
  row.set('LicenseTeam', license.team);
  row.set('Name', name);
  row.set('Product', license.product);
  row.set('Plan', license.plan);
  row.set('TenantId', ptr('partners_Tenant', tenantId));
  row.set('OrganizationId', ptr('contracts_Organizations', org.id));
  row.set('TeamId', ptr('contracts_Teams', team.id));
  row.set('LastSeenAt', new Date());
  row.setACL(new Parse.ACL());
  try {
    await row.save(null, { useMasterKey: true });
  } catch (e) {
    // Another sign-in mapped it first: use theirs, drop ours.
    const winner = await mappingFor(license.team);
    if (!winner) throw e;
    await Parse.Object.destroyAll([team, org], { useMasterKey: true }).catch(() => {});
    return winner;
  }
  console.log(
    JSON.stringify({ event: 'bslicense_team_created', team: license.team, org: org.id, tenantId })
  );
  return row;
}

const emailTaken = async email =>
  !!(await Parse.Query.or(
    new Parse.Query(Parse.User).equalTo('username', email),
    new Parse.Query(Parse.User).equalTo('email', email)
  ).first({ useMasterKey: true }));

// A new account for `vlad` in its license team's organization, linked to the
// VLAD. Returns { user, email }. Undoes what it made if a step fails.
export async function provisionAccount(vlad, claims, license, config) {
  const mapping = await ensureLicenseTeam(license, config);
  const tenantId = mapping.get('TenantId').id;
  const orgId = mapping.get('OrganizationId').id;
  const teamId = mapping.get('TeamId').id;

  const details = accountDetails(claims, vlad);
  // Never sign in to someone else's account by email: if the id_token's email
  // already has an account, the new one gets the placeholder instead.
  let email = details.email;
  if (!email || (await emailTaken(email))) email = details.placeholder;
  if (await emailTaken(email)) {
    // This VLAD had an account here that's no longer linked: an admin's call.
    throw new Error('the placeholder email already has an account');
  }

  const made = [];
  try {
    const user = new Parse.User();
    user.set('username', email);
    user.set('email', email);
    user.set('name', details.name);
    // Never used: password sign-in is off (cloud/main.js beforeLogin).
    user.set('password', crypto.randomBytes(32).toString('base64url'));
    await user.save(null, { useMasterKey: true });
    made.push(user);

    const admin = await tenantAdmin(tenantId);
    const ext = new Parse.Object('contracts_Users');
    ext.set('Name', details.name);
    ext.set('Email', email);
    ext.set('UserRole', 'contracts_User');
    ext.set('UserId', ptr('_User', user.id));
    ext.set('CreatedBy', ptr('_User', user.id));
    ext.set('TenantId', ptr('partners_Tenant', tenantId));
    ext.set('OrganizationId', ptr('contracts_Organizations', orgId));
    ext.set('TeamIds', [ptr('contracts_Teams', teamId)]);
    ext.set('Company', mapping.get('Name'));
    const acl = new Parse.ACL();
    acl.setReadAccess(user.id, true);
    acl.setWriteAccess(user.id, true);
    const adminUserId = admin?.get('UserId')?.id;
    if (adminUserId) {
      acl.setReadAccess(adminUserId, true);
      acl.setWriteAccess(adminUserId, true);
    }
    ext.setACL(acl);
    await ext.save(null, { useMasterKey: true });
    made.push(ext);

    // Link the VLAD: take over its recorded sign-in attempt if it has one.
    const attempts = await new Parse.Query('bs_Identity')
      .equalTo('vlad', vlad)
      .doesNotExist('UserId')
      .ascending('createdAt')
      .find({ useMasterKey: true });
    const link = attempts[0] || new Parse.Object('bs_Identity');
    if (!attempts[0]) {
      link.set('vlad', vlad);
      link.setACL(new Parse.ACL());
    }
    const label = link.get('Label');
    if (!label || label === ATTEMPT_LABEL) link.set('Label', SEAT_LABEL);
    link.set('UserId', Parse.User.createWithoutData(user.id));
    link.set('Active', true);
    link.set('LastSeenAt', new Date());
    await link.save(null, { useMasterKey: true });
    if (attempts.length > 1) {
      await Parse.Object.destroyAll(attempts.slice(1), { useMasterKey: true }).catch(() => {});
    }

    console.log(
      JSON.stringify({
        event: 'bslicense_account_created',
        vlad: vlad.slice(0, 16),
        userId: user.id,
        team: license.team,
        org: orgId,
        placeholderEmail: email === details.placeholder,
      })
    );
    return { user, email };
  } catch (e) {
    await Parse.Object.destroyAll(made.reverse(), { useMasterKey: true }).catch(() => {});
    throw e;
  }
}
