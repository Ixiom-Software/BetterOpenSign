// A user's address for emailing PDFs to Better DocSign (the profile page's
// "Email PDFs" card, apps/OpenSign src/components/MailInboxCard.jsx). Mail to
// it is taken in by cloud/customRoute/inboundMail.js:
//
//   <token>@in.betterid.net           each PDF becomes a draft document
//   <token>+template@in.betterid.net  each PDF becomes a template
//
// Off until the user turns it on: the first `enabled: true` makes the
// address. The token is the secret: 20 random base32 characters, which the
// user can replace (rotate), so an address that has leaked stops working.
// Mail is also only taken from the account's own email or one of
// AllowedSenders.
//
//   mailinboxget {}                              -> inbox
//   mailinboxupdate { enabled?, allowedSenders? } -> inbox
//   mailinboxrotate {}                           -> inbox, with a new address
//
// inbox: { enabled, addresses: { document, template } | null, accountEmail,
//          allowedSenders, recent: [{ at, from, subject, status, reason, created }] }

import crypto from 'node:crypto';
import { emailRegex } from '../../Utils.js';

const MAX_ALLOWED_SENDERS = 10;
const RECENT = 5;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const ptr = (className, objectId) => ({ __type: 'Pointer', className, objectId });
const fail = (code, message) => new Parse.Error(code, message);

export const mailDomain = () =>
  (process.env.BS_INBOUND_MAIL_DOMAIN || 'in.betterid.net').toLowerCase();

// 100 bits, as 20 lowercase base32 characters (an address is case-insensitive).
export function newToken() {
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, b => BASE32[b & 31]).join('');
}

export const normalEmail = e =>
  String(e || '')
    .trim()
    .toLowerCase();

// The caller's contracts_Users row.
async function callerOf(request) {
  if (!request.user) {
    throw fail(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const q = new Parse.Query('contracts_Users');
  q.equalTo('UserId', ptr('_User', request.user.id));
  q.notEqualTo('IsDisabled', true);
  const ext = await q.first({ useMasterKey: true });
  if (!ext) throw fail(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
  return ext;
}

// The user's inbox: the oldest, if two requests made one each at once.
async function findInbox(user) {
  const q = new Parse.Query('bs_MailInbox');
  q.equalTo('UserId', ptr('_User', user.id));
  q.ascending('createdAt');
  return q.first({ useMasterKey: true });
}

async function makeInbox(user, ext) {
  const inbox = new Parse.Object('bs_MailInbox');
  inbox.set('UserId', ptr('_User', user.id));
  inbox.set('ExtUserPtr', ptr('contracts_Users', ext.id));
  inbox.set('Token', newToken());
  inbox.set('IsActive', false);
  inbox.set('AllowedSenders', []);
  await inbox.save(null, { useMasterKey: true });
  // Another request may have made one too; keep the oldest, drop ours.
  const kept = await findInbox(user);
  if (kept.id !== inbox.id) await inbox.destroy({ useMasterKey: true });
  return kept;
}

async function view(inbox, ext) {
  const base = { accountEmail: ext.get('Email') || '' };
  if (!inbox) return { ...base, enabled: false, addresses: null, allowedSenders: [], recent: [] };
  const q = new Parse.Query('bs_InboundMail');
  q.equalTo('InboxId', ptr('bs_MailInbox', inbox.id));
  q.descending('createdAt');
  q.limit(RECENT);
  const recent = await q.find({ useMasterKey: true });
  const token = inbox.get('Token');
  return {
    ...base,
    enabled: inbox.get('IsActive') === true,
    addresses: {
      document: `${token}@${mailDomain()}`,
      template: `${token}+template@${mailDomain()}`,
    },
    allowedSenders: inbox.get('AllowedSenders') || [],
    recent: recent.map(m => ({
      at: m.createdAt,
      from: m.get('From') || '',
      subject: m.get('Subject') || '',
      status: m.get('Status') || '',
      reason: m.get('Reason') || '',
      created: m.get('Created') || [],
    })),
  };
}

export async function mailinboxget(request) {
  const ext = await callerOf(request);
  return view(await findInbox(request.user), ext);
}

export async function mailinboxrotate(request) {
  const ext = await callerOf(request);
  const inbox = await findInbox(request.user);
  if (!inbox) throw fail(Parse.Error.OBJECT_NOT_FOUND, 'Turn on emailed PDFs first.');
  inbox.set('Token', newToken());
  await inbox.save(null, { useMasterKey: true });
  return view(inbox, ext);
}

export async function mailinboxupdate(request) {
  const ext = await callerOf(request);
  const { enabled, allowedSenders } = request.params || {};
  let inbox = await findInbox(request.user);
  if (!inbox) {
    if (enabled !== true) {
      throw fail(Parse.Error.OBJECT_NOT_FOUND, 'Turn on emailed PDFs first.');
    }
    inbox = await makeInbox(request.user, ext);
  }
  if (enabled !== undefined) inbox.set('IsActive', enabled === true);
  if (allowedSenders !== undefined) {
    if (!Array.isArray(allowedSenders)) {
      throw fail(Parse.Error.INVALID_JSON, 'allowedSenders must be a list of email addresses.');
    }
    const list = [...new Set(allowedSenders.map(normalEmail).filter(Boolean))];
    const bad = list.find(e => !emailRegex.test(e));
    if (bad) throw fail(Parse.Error.INVALID_JSON, `“${bad}” isn’t an email address.`);
    if (list.length > MAX_ALLOWED_SENDERS) {
      throw fail(Parse.Error.INVALID_JSON, `At most ${MAX_ALLOWED_SENDERS} other senders.`);
    }
    inbox.set('AllowedSenders', list);
  }
  await inbox.save(null, { useMasterKey: true });
  return view(inbox, ext);
}

// Deleting an account (customRoute/deleteAccount/deleteUser.js): the user's
// addresses and the log of mail they took in.
export async function deleteMailInboxes(userPointer) {
  const q = new Parse.Query('bs_MailInbox');
  q.equalTo('UserId', userPointer);
  const inboxes = await q.find({ useMasterKey: true });
  for (const inbox of inboxes) {
    for (;;) {
      const mq = new Parse.Query('bs_InboundMail');
      mq.equalTo('InboxId', ptr('bs_MailInbox', inbox.id));
      mq.limit(500);
      const rows = await mq.find({ useMasterKey: true });
      if (rows.length === 0) break;
      await Parse.Object.destroyAll(rows, { useMasterKey: true });
    }
  }
  if (inboxes.length) await Parse.Object.destroyAll(inboxes, { useMasterKey: true });
}
