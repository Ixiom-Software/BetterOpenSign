/**
 * Published certificates (cloud/customRoute/bsapi/certs.js), master key only:
 * bs_PublishedCert, one row per certificate a BetterID identity signed a
 * completed document with (or a CA above one), read from the signed PDF. The
 * public routes serve it with the master key. Sha256 is made unique when the
 * server first stores one (Parse's schema API can't declare a unique index).
 *
 * @param {Parse} Parse
 */

const { ensureMasterOnly } = require('../migrationUtils.cjs');

exports.up = async Parse => {
  await ensureMasterOnly(Parse, 'bs_PublishedCert', s => {
    s.addString('Sha256');
    s.addString('Der');
    s.addString('SubjectCN');
    s.addString('IssuerCN');
    s.addString('Serial');
    s.addBoolean('IsCA');
    s.addString('Vlad');
    s.addString('IssuerSha256');
    s.addDate('NotBefore');
    s.addDate('NotAfter');
    s.addString('FirstSeenDoc');
    s.addDate('FirstSeenAt');
    s.addIndex('Vlad_1', { Vlad: 1 });
  });
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  const schema = new Parse.Schema('bs_PublishedCert');
  await schema.purge().then(() => schema.delete());
};
