/**
 * Team seat licenses (utils/bsLicenseAccounts.js), master key only:
 * bs_LicenseTeam maps a license team (bs-license's team id, LicenseTeam) to
 * the organization and team its members' accounts are made in. LicenseTeam
 * is made unique when the server first maps a team (Parse's schema API can't
 * declare a unique index).
 *
 * @param {Parse} Parse
 */

const { ensureMasterOnly } = require('../migrationUtils.cjs');

exports.up = async Parse => {
  await ensureMasterOnly(Parse, 'bs_LicenseTeam', s => {
    s.addString('LicenseTeam');
    s.addString('Name');
    s.addString('Product');
    s.addString('Plan');
    s.addPointer('TenantId', 'partners_Tenant');
    s.addPointer('OrganizationId', 'contracts_Organizations');
    s.addPointer('TeamId', 'contracts_Teams');
    s.addDate('LastSeenAt');
    s.addIndex('LicenseTeam_1', { LicenseTeam: 1 });
    s.addIndex('OrganizationId_1', { _p_OrganizationId: 1 });
  });
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('bs_LicenseTeam');
  await schema.purge().then(() => schema.delete());
};
