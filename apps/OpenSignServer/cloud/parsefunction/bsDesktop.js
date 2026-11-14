// Cloud functions for the BetterSign desktop app (BetterSignApps
// client/BetterSignClient, lib/src/opensign/). The app signs PDFs on the
// device (PAdES, BetterSign identity key) and uses these to hand them to
// OpenSign and back. It signs in with "Sign in with BetterSign" (bsidlogin,
// loopback redirect) and calls these with that Parse session.
//
//   bsdesktopsend    upload a locally signed PDF and send it to other signers
//   bsdesktopinbox   documents waiting for my signature
//   bsdesktopfetch   a short-lived download link for one of them
//   bsdesktopreturn  hand back the PDF I signed locally; marks me as signed
//
// The PDF the desktop returns already carries a BetterSign PAdES signature,
// so bsdesktopreturn stores it byte for byte. Unlike signPdf it does not
// flatten or re-save it (pdf-lib rewrites the file, which would break that
// signature). When it completes a document the audit certificate is still
// generated and mailed as usual.
//
// Files are uploaded first with the standard Parse file endpoint
// (POST <SERVER_URL>/files/<name>.pdf); these functions only take that URL.

import fs from 'node:fs';
import crypto from 'node:crypto';
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
import { cloudServerUrl, mailTemplate, appName } from '../../Utils.js';
import { setDocumentCount } from '../../utils/CountUtils.js';
import { findPlaceholderIndex, findPendingPriorSigner } from '../../utils/workflowUtils.js';
import { presignedlocalUrl } from './getSignedUrl.js';
import sendMailv3 from './sendMailv3.js';
import { sendNotifyMail, sendMailsaveCertifcate } from './pdf/PDF.js';
import {
  validateSigners,
  ownFileUrl,
  defaultPlaceholders,
  signingLink,
  hasActed,
  isComplete,
  fieldsFor,
} from '../../utils/bsDesktopUtils.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_SIGNATURE_PNG = 300 * 1024;
const DEFAULT_DAYS = 15;

const bad = msg => new Parse.Error(Parse.Error.INVALID_QUERY, msg);
const notFound = msg => new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, msg);

function publicUrl() {
  return (process.env.PUBLIC_URL || 'https://docsign.bettersign.ing').replace(/\/$/, '');
}

function requireUser(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in first.');
  }
  return request.user;
}

const userPtr = id => ({ __type: 'Pointer', className: '_User', objectId: id });

async function extUserFor(user) {
  const q = new Parse.Query('contracts_Users');
  q.equalTo('UserId', userPtr(user.id));
  q.include('TenantId');
  const ext = await q.first({ useMasterKey: true });
  if (!ext)
    throw notFound('This account has no OpenSign profile yet. Sign in on the website once.');
  return ext;
}

// Read a file this server stored, through its own signed-URL check.
async function readOwnFile(fileUrl) {
  const signed = new URL(presignedlocalUrl(fileUrl));
  const local = new URL(cloudServerUrl).origin + signed.pathname + signed.search;
  const res = await axios.get(local, {
    responseType: 'arraybuffer',
    maxContentLength: MAX_PDF_BYTES,
    timeout: 30000,
  });
  return Buffer.from(res.data);
}

function checkedFileUrl(fileUrl) {
  const url = ownFileUrl(fileUrl, process.env.SERVER_URL || cloudServerUrl);
  if (!url) throw bad('Upload the PDF to this server first.');
  return url;
}

// Find the owner's contact for this email, or make one (and its _User, which
// the recipient flow links to). Mirrors savecontact, but the guest _User gets
// a random password: recipients only get in through the emailed link.
async function contactFor(user, ext, { name, email }) {
  const q = new Parse.Query('contracts_Contactbook');
  q.equalTo('CreatedBy', userPtr(user.id));
  q.equalTo('Email', email);
  q.notEqualTo('IsDeleted', true);
  const existing = await q.first({ useMasterKey: true });
  if (existing) return existing;

  const uq = new Parse.Query(Parse.User);
  uq.equalTo('username', email);
  let guest = await uq.first({ useMasterKey: true });
  if (!guest) {
    guest = new Parse.User();
    guest.set('name', name);
    guest.set('username', email);
    guest.set('email', email);
    guest.set('password', crypto.randomBytes(24).toString('base64url'));
    guest = await guest.save(null, { useMasterKey: true });
  }

  const contact = new Parse.Object('contracts_Contactbook');
  contact.set('Name', name);
  contact.set('Email', email);
  contact.set('UserRole', 'contracts_Guest');
  contact.set('IsDeleted', false);
  contact.set('CreatedBy', userPtr(user.id));
  contact.set('UserId', userPtr(guest.id));
  const tenant = ext.get('TenantId');
  if (tenant?.id) {
    contact.set('TenantId', {
      __type: 'Pointer',
      className: 'partners_Tenant',
      objectId: tenant.id,
    });
  }
  const acl = new Parse.ACL();
  for (const id of [guest.id, user.id]) {
    acl.setReadAccess(id, true);
    acl.setWriteAccess(id, true);
  }
  contact.setACL(acl);
  return contact.save(null, { useMasterKey: true });
}

// --- bsdesktopsend -------------------------------------------------------------
// Params: { fileUrl, name, note?, signers: [{ name, email }] }
// Returns: { docId, signers: [{ email, contactId }] }
export async function bsDesktopSend(request) {
  const user = requireUser(request);
  const { fileUrl, name, note } = request.params || {};
  const ext = await extUserFor(user);
  const owner = ext.toJSON();

  let signers;
  try {
    signers = validateSigners(request.params?.signers, owner.Email);
  } catch (e) {
    throw bad(e.message);
  }
  const url = checkedFileUrl(fileUrl);
  const title =
    String(name || '')
      .trim()
      .slice(0, 250) || 'Untitled document';

  let pageCount;
  let lastPage;
  try {
    const pdf = await PDFDocument.load(await readOwnFile(url), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    pageCount = pdf.getPageCount();
    lastPage = pdf.getPage(pageCount - 1).getSize();
  } catch (e) {
    console.log('bsdesktopsend: unreadable pdf', e?.message);
    throw bad('That file is not a readable PDF.');
  }

  const contacts = [];
  for (const s of signers) {
    const c = await contactFor(user, ext, s);
    contacts.push({ objectId: c.id, email: s.email, name: s.name });
  }

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + DEFAULT_DAYS);
  const storedUrl = presignedlocalUrl(url);

  const doc = new Parse.Object('contracts_Document');
  doc.set('Name', title);
  if (note) doc.set('Note', String(note).slice(0, 200));
  doc.set('URL', storedUrl);
  doc.set('SignedUrl', storedUrl);
  doc.set('ExtUserPtr', { __type: 'Pointer', className: 'contracts_Users', objectId: ext.id });
  doc.set('CreatedBy', userPtr(user.id));
  doc.set('OriginIp', request?.headers?.['x-real-ip'] || '');
  doc.set(
    'Signers',
    contacts.map(c => ({
      __type: 'Pointer',
      className: 'contracts_Contactbook',
      objectId: c.objectId,
    }))
  );
  doc.set('Placeholders', defaultPlaceholders(contacts, lastPage, pageCount));
  doc.set('SentToOthers', true);
  doc.set('SendinOrder', false);
  doc.set('TimeToCompleteDays', DEFAULT_DAYS);
  doc.set('ExpiryDate', expiry);
  doc.set('SignedWith', 'BetterSign desktop');
  const saved = await doc.save(null, { useMasterKey: true });
  setDocumentCount(ext.id);

  const expires = expiry.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  let mailed = 0;
  for (const c of contacts) {
    const tpl = mailTemplate({
      senderName: owner.Name || owner.Email,
      senderMail: owner.Email,
      title,
      organization: owner.Company || '',
      localExpireDate: expires,
      note: note || '',
      signingUrl: signingLink(publicUrl(), saved.id, c.email, c.objectId),
    });
    try {
      const res = await sendMailv3({
        params: {
          extUserId: ext.id,
          recipient: c.email,
          subject: tpl.subject,
          replyto: owner.Email,
          from: owner.Name || appName,
          html: tpl.body,
        },
      });
      if (res?.status === 'success') mailed++;
    } catch (e) {
      console.log('bsdesktopsend: mail failed', c.email, e?.message);
    }
  }
  if (mailed > 0) {
    saved.set('SendMail', true);
    await saved.save(null, { useMasterKey: true });
  }
  console.log(
    JSON.stringify({ event: 'bsdesktopsend', docId: saved.id, signers: contacts.length, mailed })
  );
  return {
    docId: saved.id,
    mailed,
    signers: contacts.map(c => ({ email: c.email, contactId: c.objectId })),
  };
}

// --- shared: a document I still have to sign ------------------------------------

async function myContacts(user) {
  const q = new Parse.Query('contracts_Contactbook');
  q.equalTo('UserId', userPtr(user.id));
  q.notEqualTo('IsDeleted', true);
  q.limit(1000);
  return q.find({ useMasterKey: true });
}

async function pendingDoc(user, docId) {
  if (typeof docId !== 'string' || !/^[A-Za-z0-9]{6,32}$/.test(docId))
    throw bad('Bad document id.');
  const q = new Parse.Query('contracts_Document');
  q.equalTo('objectId', docId);
  q.notEqualTo('IsDeclined', true);
  q.notEqualTo('IsArchive', true);
  q.notEqualTo('IsCompleted', true);
  q.include('ExtUserPtr,Signers,ExtUserPtr.TenantId,Bcc,Cc,CreatedBy');
  const doc = await q.first({ useMasterKey: true });
  if (!doc) throw notFound('That document is not waiting for a signature.');
  const json = doc.toJSON();
  const mine = new Set((await myContacts(user)).map(c => c.id));
  const me = (json.Signers || []).find(s => mine.has(s.objectId));
  if (!me) throw notFound('That document is not waiting for a signature.');
  if (hasActed(json.AuditTrail, me.objectId)) throw bad('You have already signed this document.');
  if (json.ExpiryDate?.iso && new Date(json.ExpiryDate.iso) < new Date()) {
    throw bad('This document has expired.');
  }
  if (json.SendinOrder === true && json.SendInOrderStrict === true) {
    const placeholders = (json.Placeholders || []).filter(p => p?.Role !== 'prefill');
    const idx = findPlaceholderIndex(placeholders, me.objectId);
    if (idx > 0 && findPendingPriorSigner(placeholders, idx, json.AuditTrail)) {
      throw bad('Earlier signers have to sign first.');
    }
  }
  return { doc, json, me };
}

// --- bsdesktopinbox --------------------------------------------------------------
// Returns: [{ docId, name, note, sender: {name, email}, sentAt, expiresAt }]
export async function bsDesktopInbox(request) {
  const user = requireUser(request);
  const contacts = await myContacts(user);
  if (contacts.length === 0) return [];
  const ids = new Set(contacts.map(c => c.id));

  const q = new Parse.Query('contracts_Document');
  q.containedIn(
    'Signers',
    contacts.map(c => c.toPointer())
  );
  q.notEqualTo('IsCompleted', true);
  q.notEqualTo('IsDeclined', true);
  q.notEqualTo('IsArchive', true);
  q.notEqualTo('Type', 'Folder');
  q.exists('Placeholders');
  q.exists('SignedUrl');
  q.greaterThan('ExpiryDate', new Date());
  q.include('ExtUserPtr');
  q.descending('createdAt');
  q.limit(100);
  const docs = await q.find({ useMasterKey: true });

  return docs
    .map(d => d.toJSON())
    .filter(d => {
      const me = (d.Signers || []).find(s => ids.has(s.objectId));
      return me && !hasActed(d.AuditTrail, me.objectId);
    })
    .map(d => ({
      docId: d.objectId,
      name: d.Name,
      note: d.Note || '',
      sender: { name: d.ExtUserPtr?.Name || '', email: d.SenderMail || d.ExtUserPtr?.Email || '' },
      sentAt: d.createdAt,
      expiresAt: d.ExpiryDate?.iso || null,
    }));
}

// --- bsdesktopfetch -------------------------------------------------------------
// Params: { docId }
// Returns: { docId, name, url (valid ~3 min), fields: [{page, type, x, y, width, height}] }
export async function bsDesktopFetch(request) {
  const user = requireUser(request);
  const { json, me } = await pendingDoc(user, request.params?.docId);
  return {
    docId: json.objectId,
    name: json.Name,
    url: presignedlocalUrl(json.SignedUrl || json.URL),
    fields: fieldsFor(json.Placeholders, me.objectId),
  };
}

// --- bsdesktopreturn ------------------------------------------------------------
// Params: { docId, fileUrl, signaturePng? (data:image/png;base64,...) }
// Returns: { status: 'success', completed }
export async function bsDesktopReturn(request) {
  const user = requireUser(request);
  const { docId, fileUrl, signaturePng } = request.params || {};
  const { json, me } = await pendingDoc(user, docId);
  const url = checkedFileUrl(fileUrl);

  let sign = '';
  if (signaturePng !== undefined && signaturePng !== null && signaturePng !== '') {
    if (
      typeof signaturePng !== 'string' ||
      !signaturePng.startsWith('data:image/png;base64,') ||
      signaturePng.length > MAX_SIGNATURE_PNG
    ) {
      throw bad('The signature image must be a PNG data URL.');
    }
    sign = signaturePng;
  }

  const bytes = await readOwnFile(url);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('That file is not a PDF.');
  const storedUrl = presignedlocalUrl(url);

  const entry = {
    UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: me.objectId },
    SignedUrl: storedUrl,
    Activity: 'Signed',
    ipAddress: request?.headers?.['x-real-ip'] || '',
    SignedOn: new Date().toISOString(), // a string, as signPdf stores it
    Signature: sign,
    SignedWith: 'BetterSign desktop',
  };
  const auditTrail = [...(json.AuditTrail || []), entry];
  const completed = isComplete(json.Placeholders, auditTrail);
  const documentHash = crypto.createHash('sha256').update(bytes).digest('hex');

  // Conditional on nobody else signing in between (same SignedUrl).
  const doc = new Parse.Object('contracts_Document');
  doc.id = json.objectId;
  doc.set('SignedUrl', storedUrl);
  doc.set('AuditTrail', auditTrail);
  doc.set('IsCompleted', completed);
  if (completed) doc.set('DocumentHash', documentHash);
  const fresh = await new Parse.Query('contracts_Document').get(json.objectId, {
    useMasterKey: true,
  });
  if (fresh.get('SignedUrl') !== json.SignedUrl) {
    throw bad('Someone signed this document while you were signing. Open it again.');
  }
  await doc.save(null, { useMasterKey: true });

  const signer = (json.Signers || []).find(s => s.objectId === me.objectId) || me;
  const mailProvider = request.params?.mailProvider || '';
  sendNotifyMail({ ...json, AuditTrail: auditTrail }, signer, mailProvider, publicUrl());
  if (completed) {
    // Same certificate + completion mail as signPdf. It reads the signing key
    // from a temp .pfx file and deletes it when done.
    let pfxFile = process.env.PFX_BASE64;
    let passphrase = process.env.PASS_PHRASE;
    if (json.ExtUserPtr?.TenantId?.PfxFile?.base64) {
      pfxFile = json.ExtUserPtr.TenantId.PfxFile.base64;
      passphrase = json.ExtUserPtr.TenantId.PfxFile.password;
    }
    const pfx = { name: `keystore_${crypto.randomBytes(6).toString('hex')}.pfx`, passphrase };
    fs.writeFileSync(pfx.name, Buffer.from(pfxFile, 'base64'));
    const safeName = (json.Name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
    sendMailsaveCertifcate(
      { ...json, AuditTrail: auditTrail, SignedUrl: storedUrl, DocumentHash: documentHash },
      pfx,
      false,
      mailProvider,
      `signed_${safeName.slice(0, 100)}.pdf`
    ).catch(e => console.log('bsdesktopreturn: certificate failed', e?.message));
  }
  console.log(JSON.stringify({ event: 'bsdesktopreturn', docId: json.objectId, completed }));
  return { status: 'success', completed };
}
