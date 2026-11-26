/**
 * Email PDFs to Better DocSign (cloud/customRoute/inboundMail.js,
 * cloud/parsefunction/mailInbox.js), both master key only: bs_MailInbox, a
 * user's secret address (<Token>@in.betterid.net) and who may send to it,
 * and bs_InboundMail, one email received at an address (per Kind, document
 * or template) and what it made.
 *
 * @param {Parse} Parse
 */

const { ensureMasterOnly } = require('../migrationUtils.cjs');

exports.up = async Parse => {
  await ensureMasterOnly(Parse, 'bs_MailInbox', s => {
    s.addPointer('UserId', '_User');
    s.addPointer('ExtUserPtr', 'contracts_Users');
    s.addString('Token');
    s.addBoolean('IsActive');
    s.addArray('AllowedSenders');
    s.addIndex('Token_1', { Token: 1 });
    s.addIndex('UserId_1', { _p_UserId: 1 });
  });
  await ensureMasterOnly(Parse, 'bs_InboundMail', s => {
    s.addPointer('InboxId', 'bs_MailInbox');
    s.addString('MessageId');
    s.addString('Kind');
    s.addString('From');
    s.addString('To');
    s.addString('Subject');
    s.addString('Status');
    s.addString('Reason');
    s.addNumber('PdfCount');
    s.addArray('Created');
    s.addArray('Skipped');
    s.addIndex('InboxId_MessageId_Kind_1', { _p_InboxId: 1, MessageId: 1, Kind: 1 });
  });
};

/**
 *
 * @param {Parse} Parse
 */
exports.down = async Parse => {
  for (const className of ['bs_MailInbox', 'bs_InboundMail']) {
    const schema = new Parse.Schema(className);
    await schema.purge().then(() => schema.delete());
  }
};
