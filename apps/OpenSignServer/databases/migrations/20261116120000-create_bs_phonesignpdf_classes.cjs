/**
 * Sign on phone v2 (cloud/parsefunction/bsPhoneSignPdf.js), both master key
 * only: bs_PhoneSignPdf, one attempt at signing a document on the phone (its
 * steps, the PDFs it served and the statements that approved them), and
 * bs_PhoneSignCert, the certificates the phone's keys got (its root per root
 * key, its signing certificate per document key). Also contracts_Document's
 * PhoneSignLockId / PhoneSignLockUntil, the hold an attempt keeps on the
 * document; they're written through the database controller, which doesn't
 * extend the schema.
 *
 * @param {Parse} Parse
 */

const { ensureMasterOnly } = require('../migrationUtils.cjs');

exports.up = async Parse => {
  await ensureMasterOnly(Parse, 'bs_PhoneSignPdf', s => {
    s.addString('ApproveReqId');
    s.addPointer('UserId', '_User');
    s.addString('vlad');
    s.addString('DocId');
    s.addString('FieldName');
    s.addString('SignerId');
    s.addString('SignerClass');
    s.addString('SignerName');
    s.addString('Caption');
    s.addString('Challenge');
    s.addString('BaseUrl');
    s.addString('BaseSha256');
    s.addNumber('BaseLen');
    s.addNumber('BaseRevision');
    s.addString('IpAddress');
    s.addString('PublicUrl');
    s.addDate('ApprovalUntil');
    s.addDate('LockUntil');
    s.addNumber('LeaseUntil');
    s.addString('LeaseId');
    s.addBoolean('CancelRequested');
    // The current step and its relay request.
    s.addString('Step');
    s.addString('Status');
    s.addString('Reason');
    s.addString('Message');
    s.addBoolean('Answered');
    s.addString('StepReqId');
    s.addObject('StepRequest');
    s.addString('EphSecret');
    s.addDate('StepIssuedAt');
    s.addDate('StepExpiresAt');
    // What the phone answered.
    s.addString('Image');
    s.addString('DocKey');
    s.addString('RootKey');
    s.addString('Purpose');
    s.addObject('CertifyInputs');
    s.addString('CertifyIssuer');
    s.addString('CertifySignature');
    s.addString('Certificate');
    s.addString('Root');
    s.addNumber('SigningTime');
    s.addString('PreparedUrl');
    s.addString('PreparedSha256');
    s.addNumber('PreparedLen');
    s.addString('SignedAttributes');
    s.addString('Signature');
    s.addArray('Statements');
    s.addString('SignedSha256');
    s.addDate('SignedAt');
    s.addDate('FinishedAt');
    s.addIndex('ApproveReqId_1', { ApproveReqId: 1 });
    s.addIndex('StepReqId_1', { StepReqId: 1 });
  });
  await ensureMasterOnly(Parse, 'bs_PhoneSignCert', s => {
    s.addString('vlad');
    s.addString('Kind');
    s.addString('PublicKey');
    s.addString('RootKey');
    s.addString('IssuerSerial');
    s.addString('Certificate');
    s.addString('Serial');
    s.addDate('NotBefore');
    s.addDate('NotAfter');
    s.addIndex('vlad_Kind_PublicKey_1', { vlad: 1, Kind: 1, PublicKey: 1 });
  });

  const current = await new Parse.Schema('contracts_Document').get().catch(() => null);
  const existing = current?.fields || {};
  const doc = new Parse.Schema('contracts_Document');
  if (!existing.PhoneSignLockId) doc.addString('PhoneSignLockId');
  if (!existing.PhoneSignLockUntil) doc.addDate('PhoneSignLockUntil');
  await (current ? doc.update() : doc.save());
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  for (const className of ['bs_PhoneSignPdf', 'bs_PhoneSignCert']) {
    const schema = new Parse.Schema(className);
    await schema.purge().then(() => schema.delete());
  }
};
