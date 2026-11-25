// Assign a PDF prepared for signing in person (the website's Sign in person
// page, apps/OpenSign src/pages/InPersonFields.jsx) to a colleague, instead of
// downloading it.
//
// The PDF carries blank, named signature fields. The colleague (the assignee)
// finds it in their "Need your sign" list and in the BetterID app, which lists
// their documents through /api/v1. On the phone they pick Me, In person or
// Leave blank for each field, hand the phone over for the In person ones, and
// seal the PDF with their own BetterID signature; the app uploads it with
// POST /api/v1/documents/:id/signatures, which completes the document.
//
// The document is marked InPerson (server-only, DocumentBeforesave.js): it
// can't be signed in the browser (signPdf) or with Sign on phone, which would
// flatten or fill the blank fields. Its one signer is the assignee, with one
// placeholder and no widgets, so their upload completes it.
//
// Who can be assigned: active members of the caller's organization in one of
// the caller's teams or a team under one (TeamIds[].Ancestors), with an
// active BetterID link (bs_Identity), since only their phone can finish it.
//
//   inpersonassignees {}                       -> [{ id, name, email, teams, linked }]
//   inpersonassign { name, pdf, assigneeId }   -> { id, name, assignee: { name, email } }
//
// `pdf` is base64; `assigneeId` a contracts_Users id from inpersonassignees.

import crypto from 'node:crypto';
import { PDFDocument, PDFName, PDFSignature } from '@cantoo/pdf-lib';
import { getSecureUrl, MAX_NAME_LENGTH, sanitizeFileName } from '../../Utils.js';
import { setDocumentCount } from '../../utils/CountUtils.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import { sendQuietly, signRequestMail } from '../customRoute/bsapi/notify.js';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PLACEHOLDER_COLOR = '#93a3db';

const ptr = (className, objectId) => ({ __type: 'Pointer', className, objectId });
const fail = (code, message) => new Parse.Error(code, message);
const siteOrigin = () =>
  (process.env.BS_API_ORIGIN || 'https://docsign.betterid.net').replace(/\/$/, '');

// The caller's contracts_Users row, with their active teams.
async function callerOf(request) {
  if (!request.user) {
    throw fail(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const q = new Parse.Query('contracts_Users');
  q.equalTo('UserId', ptr('_User', request.user.id));
  q.notEqualTo('IsDisabled', true);
  q.include('TeamIds');
  const ext = await q.first({ useMasterKey: true });
  if (!ext || !ext.get('OrganizationId')) {
    throw fail(Parse.Error.OBJECT_NOT_FOUND, 'You aren’t a member of an organization.');
  }
  const teams = (ext.get('TeamIds') || []).filter(t => t && t.get?.('IsActive') !== false);
  return { ext, teamIds: new Set(teams.map(t => t.id)) };
}

// The member's active teams that are, or are under, one of `teamIds`.
function sharedTeams(member, teamIds) {
  return (member.get('TeamIds') || []).filter(
    t =>
      t &&
      t.get?.('IsActive') !== false &&
      [t, ...(t.get?.('Ancestors') || [])].some(a => teamIds.has(a?.id || a?.objectId))
  );
}

// Members of the caller's organization the caller may assign to.
async function assignableMembers(caller) {
  if (caller.teamIds.size === 0) return [];
  const q = new Parse.Query('contracts_Users');
  q.equalTo('OrganizationId', caller.ext.get('OrganizationId'));
  q.notEqualTo('IsDisabled', true);
  q.include('TeamIds');
  q.include('UserId');
  q.limit(500);
  const members = await q.find({ useMasterKey: true });
  return members
    .map(member => ({ member, teams: sharedTeams(member, caller.teamIds) }))
    .filter(({ member, teams }) => teams.length > 0 && member.get('UserId'));
}

// The ids of those of `userIds` with an active BetterID link.
async function linkedUserIds(userIds) {
  if (userIds.length === 0) return new Set();
  const q = new Parse.Query('bs_Identity');
  q.containedIn(
    'UserId',
    userIds.map(id => ptr('_User', id))
  );
  q.equalTo('Active', true);
  q.limit(1000);
  const rows = await q.find({ useMasterKey: true });
  return new Set(rows.map(r => r.get('UserId')?.id).filter(Boolean));
}

export async function inpersonassignees(request) {
  const caller = await callerOf(request);
  const found = await assignableMembers(caller);
  const linked = await linkedUserIds(found.map(({ member }) => member.get('UserId').id));
  return found
    .map(({ member, teams }) => ({
      id: member.id,
      name: member.get('Name') || member.get('Email') || '',
      email: member.get('Email') || '',
      teams: teams.map(t => t.get('Name')).filter(Boolean),
      linked: linked.has(member.get('UserId').id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The PDF bytes if the phone can work on them: a PDF, not password-protected
// or certified, with at least one blank signature field.
async function checkedPdf(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (bytes.length === 0 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw fail(Parse.Error.INVALID_JSON, 'This isn’t a PDF.');
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw fail(Parse.Error.FILE_TOO_LARGE, 'This PDF is too large.');
  }
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const encrypted = /encrypt/i.test(String(err?.message));
    throw fail(
      Parse.Error.INVALID_JSON,
      encrypted ? 'This PDF is password-protected.' : 'This PDF can’t be read.'
    );
  }
  const perms = doc.catalog.lookup(PDFName.of('Perms'));
  if (perms?.get?.(PDFName.of('DocMDP'))) {
    throw fail(Parse.Error.INVALID_JSON, 'This PDF is certified.');
  }
  const blank = doc
    .getForm()
    .getFields()
    .some(f => f instanceof PDFSignature && f.acroField.dict.get(PDFName.of('V')) === undefined);
  if (!blank) {
    throw fail(Parse.Error.INVALID_JSON, 'This PDF has no blank signature fields.');
  }
  return bytes;
}

// The caller's contact for the assignee (contracts_Contactbook rows belong to
// whoever sends), made if there isn't one.
async function contactFor(caller, user, member) {
  const callerUser = caller.ext.get('UserId');
  const email = String(member.get('Email') || user.get('email') || '').toLowerCase();
  const q = new Parse.Query('contracts_Contactbook');
  q.equalTo('CreatedBy', ptr('_User', callerUser.id));
  q.equalTo('Email', email);
  q.notEqualTo('IsDeleted', true);
  const existing = await q.first({ useMasterKey: true });
  if (existing) {
    if (existing.get('UserId')?.id !== user.id) {
      existing.set('UserId', ptr('_User', user.id));
      await existing.save(null, { useMasterKey: true });
    }
    return existing;
  }
  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', member.get('Name') || email);
  contact.set('Email', email);
  contact.set('UserId', ptr('_User', user.id));
  contact.set('CreatedBy', ptr('_User', callerUser.id));
  contact.set('UserRole', 'contracts_Guest');
  contact.set('IsDeleted', false);
  if (caller.ext.get('TenantId')) contact.set('TenantId', caller.ext.get('TenantId'));
  const acl = new Parse.ACL();
  acl.setReadAccess(callerUser.id, true);
  acl.setWriteAccess(callerUser.id, true);
  acl.setReadAccess(user.id, true);
  acl.setWriteAccess(user.id, true);
  contact.setACL(acl);
  return contact.save(null, { useMasterKey: true });
}

export async function inpersonassign(request) {
  const caller = await callerOf(request);
  const name = String(request.params?.name || '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (!name) throw fail(Parse.Error.INVALID_JSON, 'Give the document a name.');

  // The assignee: one of the caller's teams, with an active BetterID link.
  const assigneeId = String(request.params?.assigneeId || '');
  const found = (await assignableMembers(caller)).find(({ member }) => member.id === assigneeId);
  if (!found) {
    throw fail(Parse.Error.OPERATION_FORBIDDEN, 'You can’t assign documents to this person.');
  }
  const member = found.member;
  const user = member.get('UserId');
  if (!(await linkedUserIds([user.id])).has(user.id)) {
    throw fail(
      Parse.Error.OPERATION_FORBIDDEN,
      'This person has no BetterID linked, so they can’t sign in person.'
    );
  }

  // As uploaded: savefile would flatten the PDF and drop the blank fields.
  const bytes = await checkedPdf(request.params?.pdf);
  const fileName = `${sanitizeFileName(name) || 'document'}.pdf`;
  const file = await parseUploadFile(fileName, bytes, 'application/pdf');
  const url = getSecureUrl(file?.url)?.url;
  if (!url) throw fail(Parse.Error.INTERNAL_SERVER_ERROR, 'Couldn’t store the PDF.');

  const contact = await contactFor(caller, user, member);
  const callerUser = caller.ext.get('UserId');
  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', name);
  doc.set('URL', url);
  doc.set('SignedUrl', url);
  doc.set('ExtUserPtr', ptr('contracts_Users', caller.ext.id));
  doc.set('CreatedBy', ptr('_User', callerUser.id));
  doc.set('Signers', [ptr('contracts_Contactbook', contact.id)]);
  doc.set('Placeholders', [
    {
      Id: crypto.randomUUID(),
      Role: 'In person',
      blockColor: PLACEHOLDER_COLOR,
      signerObjId: contact.id,
      signerPtr: ptr('contracts_Contactbook', contact.id),
      email: contact.get('Email'),
      placeHolder: [],
    },
  ]);
  doc.set('InPerson', true);
  doc.set('SentToOthers', true);
  doc.set('SendinOrder', false);
  doc.set('IsEnableOTP', false);
  doc.set('DocSentAt', new Date());
  doc.set('OriginIp', request.headers?.['x-real-ip'] || '');
  const saved = await doc.save(null, { useMasterKey: true });
  setDocumentCount(caller.ext.id);

  // The request email, as the browser sends when a document is sent.
  const q = new Parse.Query('contracts_Document');
  q.include('ExtUserPtr.TenantId');
  q.include('Signers');
  const full = (await q.get(saved.id, { useMasterKey: true })).toJSON();
  await sendQuietly(
    signRequestMail(full, full.Placeholders[0], siteOrigin()),
    'in-person assignment'
  );

  return {
    id: saved.id,
    name,
    assignee: { name: member.get('Name') || '', email: contact.get('Email') },
  };
}
