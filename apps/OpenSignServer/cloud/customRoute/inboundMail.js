// Email PDFs to Better DocSign. Cloudflare Email Routing hands mail for
// in.betterid.net to the docsign-inbound Email Worker
// (deploy/cloudflare-inbound-mail/worker.js), which posts it here as it came:
//
//   POST /inbound/mail                 body: the raw message (message/rfc822)
//     x-bs-mail-from: <envelope sender>
//     x-bs-rcpt-to:   <envelope recipient>
//     x-bs-timestamp: <unix seconds>
//     x-bs-signature: hex HMAC-SHA256(BS_INBOUND_MAIL_SECRET,
//                       `${timestamp}\n${mailFrom}\n${rcptTo}\n${hex sha256(body)}`)
//
// The recipient names a bs_MailInbox (cloud/parsefunction/mailInbox.js):
// <token>@ makes each PDF a draft document, <token>+template@ a template.
// The mail must come from the account's email or one of the inbox's
// AllowedSenders, and carry a DKIM signature, checked here, of a domain
// aligned with From:'s (nothing Cloudflare or the sender says about it is
// trusted). Each PDF is stored as the web form stores an upload (form fields
// cleared, an empty-password encryption removed) and the owner gets an email
// with links.
//
// A message is taken once per address kind: its bs_InboundMail row is
// claimed ("processing") before anything is made and lists what is made as
// it goes. A failure undoes what was made, so the Worker's retry starts
// clean; a retry while it's still running gets 503 and tries later; a claim
// left by a crash is taken over after hooks.claimStaleMs (10 minutes),
// undoing its records.
//
// Answers:
//   200 { status: 'created', created: [{ kind, id, name }], skipped: [{ file, reason }] }
//   200 { status: 'duplicate' }                    the same Message-ID again
//   4xx { status: 'rejected', reason }             the Worker bounces it with `reason`
//   401 / 5xx                                      the Worker retries, then bounces
//
// Before the body is read, a request needs a fresh timestamp and a
// well-formed signature, its IP must not have sent too many bad signatures,
// and at most MAX_IN_FLIGHT bodies are read at once, so posting large bodies
// without the secret can't fill the machine's memory.
//
//   BS_INBOUND_MAIL_SECRET       shared with the Worker; unset, the route answers 503
//   BS_INBOUND_MAIL_DOMAIN       default in.betterid.net
//   BS_INBOUND_MAIL_MAX_MB       largest message, in MB; default 25 (Cloudflare's
//                                limit); the Worker's MAX_MESSAGE_MB should match
//   BS_INBOUND_MAIL_PER_HOUR     PDFs per address per hour; default 20
//   BS_INBOUND_MAIL_BAD_PER_MIN  bad signatures per IP per minute before it's
//                                refused unread; default 10
//   BS_INBOUND_MAIL_VERIFY       "off" skips the DKIM check (local testing only)

import crypto from 'node:crypto';
import express from 'express';
import { simpleParser } from 'mailparser';
import { authenticate } from 'mailauth';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import Coherentpdf from 'coherentpdf';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { getSecureUrl, MAX_NAME_LENGTH, saveFileUsage, sanitizeFileName } from '../../Utils.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import sendSystemMail from '../parsefunction/sendSystemMail.js';
import { mailDomain, normalEmail } from '../parsefunction/mailInbox.js';
import { clientIp } from './bsapi/rateLimit.js';

const MAX_PDFS = 10;
const MAX_IN_FLIGHT = 4;
const MAX_SKEW_SECONDS = 300;
const TOKEN_RE = /^[a-z2-7]{20}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

const ptr = (className, objectId) => ({ __type: 'Pointer', className, objectId });
const siteOrigin = () =>
  (process.env.BS_API_ORIGIN || 'https://docsign.betterid.net').replace(/\/$/, '');
const perHour = () => Number(process.env.BS_INBOUND_MAIL_PER_HOUR) || 20;
export const maxMb = () => Number(process.env.BS_INBOUND_MAIL_MAX_MB) || 25;
const badPerMin = () => Number(process.env.BS_INBOUND_MAIL_BAD_PER_MIN) || 10;

// What the route uses to store files, send mail and look up DKIM keys;
// tests swap these.
export const hooks = {
  upload: (name, bytes, type) => parseUploadFile(name, bytes, type),
  // A system mail: no extUserId, so it isn't counted against the user's mail.
  sendMail: params => sendSystemMail({ params }),
  resolver: undefined, // mailauth's default, dns.promises.resolve
  claimStaleMs: 10 * 60 * 1000,
};

// For mail to bounce with `reason`.
class Rejected extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}

// For the Worker to try again later.
class Retry extends Error {}

const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');

export function signatureFor(secret, timestamp, mailFrom, rcptTo, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${mailFrom}\n${rcptTo}\n${sha256hex(body)}`)
    .digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === 32 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

let badSignatures = null;
function badLimiter() {
  const points = badPerMin();
  if (badSignatures?.points !== points) {
    badSignatures = new RateLimiterMemory({ points, duration: 60 });
  }
  return badSignatures;
}

let inFlight = 0;

// Before the body is read: set up, signed and recent, not from an IP that
// keeps signing badly, and not too many bodies being read already.
async function checkHeaders(req, res, next) {
  if (!process.env.BS_INBOUND_MAIL_SECRET) {
    return res.status(503).json({ status: 'error', reason: 'Inbound mail isn’t set up.' });
  }
  const ts = Number(req.get('x-bs-timestamp'));
  const sig = req.get('x-bs-signature') || '';
  if (!ts || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS || !SIGNATURE_RE.test(sig)) {
    return res.status(401).json({ status: 'error', reason: 'Unsigned or stale request.' });
  }
  const seen = await badLimiter().get(clientIp(req));
  if (seen && seen.consumedPoints >= badPerMin()) {
    res.set('Retry-After', String(Math.ceil(seen.msBeforeNext / 1000)));
    return res.status(503).json({ status: 'error', reason: 'Too many bad signatures.' });
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    res.set('Retry-After', '5');
    return res.status(503).json({ status: 'error', reason: 'Busy.' });
  }
  inFlight++;
  res.on('close', () => inFlight--);
  return next();
}

// express.raw, with the limit read per request (BS_INBOUND_MAIL_MAX_MB). A
// Content-Length over it is refused before anything is read.
const rawBody = (req, res, next) =>
  express.raw({ type: () => true, limit: maxMb() * 1024 * 1024 })(req, res, next);

function checkSignature(req) {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const expected = signatureFor(
    process.env.BS_INBOUND_MAIL_SECRET,
    req.get('x-bs-timestamp'),
    req.get('x-bs-mail-from') || '',
    req.get('x-bs-rcpt-to') || '',
    body
  );
  return safeEqualHex(req.get('x-bs-signature'), expected);
}

// The inbox and kind the recipient names, e.g. abc...@in.betterid.net or
// abc...+template@in.betterid.net.
function addressed(rcptTo) {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(normalEmail(rcptTo));
  if (!m || m[2] !== mailDomain()) return null;
  const plus = m[1].indexOf('+');
  const token = plus === -1 ? m[1] : m[1].slice(0, plus);
  const tag = plus === -1 ? '' : m[1].slice(plus + 1);
  if (!TOKEN_RE.test(token)) return null;
  if (tag === '') return { token, kind: 'document' };
  if (tag === 'template') return { token, kind: 'template' };
  return null;
}

// Whether `raw` carries a valid DKIM signature by a domain aligned (relaxed,
// as DMARC aligns) with its From: domain, covering the whole body (no l=
// shorter than it, which would let content be added). rsa-sha1 doesn't count.
export async function senderVerified(raw, mailFrom) {
  if (String(process.env.BS_INBOUND_MAIL_VERIFY).toLowerCase() === 'off') return { ok: true };
  let result;
  try {
    result = await authenticate(raw, {
      sender: mailFrom,
      mta: 'docsign',
      disableArc: true,
      disableBimi: true,
      disableDmarc: true,
      rejectRsaSha1: true,
      ...(hooks.resolver ? { resolver: hooks.resolver } : {}),
    });
  } catch (err) {
    return { ok: false, detail: `dkim error: ${err?.message || err}` };
  }
  const results = result?.dkim?.results || [];
  const ok = results.some(
    r => r.status?.result === 'pass' && r.status?.aligned && !r.status?.underSized
  );
  const detail =
    results
      .map(
        r =>
          `dkim=${r.status?.result} d=${r.signingDomain || '?'}` +
          (r.status?.aligned ? '' : ' (not aligned)') +
          (r.status?.underSized ? ' (partial body)' : '')
      )
      .join('; ') || 'no DKIM signature';
  return { ok, detail };
}

const isPdf = a => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename || '');

// Title from a file name, as the web form makes it (generateTitleFromFilename).
export function titleFromFilename(filename) {
  let title = String(filename || '').trim();
  const dot = title.lastIndexOf('.');
  if (dot > 0) title = title.substring(0, dot);
  title = title
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\p{L}\S*/gu, txt => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase())
    .trim();
  return title.slice(0, 100).trim() || 'Document';
}

const subjectTitle = subject =>
  String(subject || '')
    .replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);

// The PDF as the web form uploads it: an encryption with an empty password
// removed, form fields and widgets cleared (clearAcroFields). Throws
// Rejected for a PDF it can't take.
async function cleanedPdf(bytes) {
  if (bytes.subarray(0, 1024).indexOf('%PDF-') === -1) throw new Rejected(422, 'not a PDF');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (!/encrypt/i.test(String(err?.message))) throw new Rejected(422, 'can’t be read');
    try {
      const pdf = await Coherentpdf.fromMemory(bytes, '');
      await Coherentpdf.decryptPdf(pdf, '');
      const plain = Buffer.from(await Coherentpdf.toMemory(pdf, false, false));
      doc = await PDFDocument.load(plain, { updateMetadata: false });
    } catch {
      throw new Rejected(422, 'password-protected');
    }
  }
  try {
    const acroForm = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
    if (acroForm?.set) {
      acroForm.set(PDFName.of('Fields'), doc.context.obj([]));
      acroForm.delete(PDFName.of('XFA'));
      acroForm.delete(PDFName.of('SigFlags'));
    }
  } catch {
    // a malformed AcroForm; the widgets go below anyway
  }
  for (const page of doc.getPages()) {
    try {
      const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')));
      if (!annots?.asArray) continue;
      const kept = annots.asArray().filter(ref => {
        try {
          return doc.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString() !== '/Widget';
        } catch {
          return true;
        }
      });
      page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
    } catch {
      // leave this page's annotations
    }
  }
  if (doc.getPageCount() === 0) throw new Rejected(422, 'no pages');
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const classOf = kind => (kind === 'template' ? 'contracts_Template' : 'contracts_Document');

// The fields the web form (pages/Form.jsx) sets on a new document or template.
function newRecord(kind, { name, url, ext, user }) {
  const obj = new Parse.Object(classOf(kind));
  obj.set('Name', name);
  obj.set('URL', url);
  obj.set('Note', 'Please review and sign this document');
  obj.set('Description', '');
  obj.set('CreatedBy', ptr('_User', user.id));
  obj.set('ExtUserPtr', ptr('contracts_Users', ext.id));
  obj.set('SendinOrder', ext.get('SendinOrder') !== false);
  obj.set('SendInOrderStrict', false);
  obj.set('AutomaticReminders', false);
  obj.set('RemindOnceInEvery', 5);
  obj.set('IsTourEnabled', ext.get('IsTourEnabled') !== false);
  obj.set('TimeToCompleteDays', 15);
  obj.set('PenColors', ['blue', 'red', 'black']);
  obj.set('AllowModifications', false);
  obj.set('IsEnableOTP', false);
  obj.set('NotifyOnSignatures', ext.get('NotifyOnSignatures') !== false);
  const tenant = ext.get('TenantId');
  if (kind === 'document' && tenant?.get?.('RequestBody') && tenant?.get?.('RequestSubject')) {
    obj.set('RequestBody', tenant.get('RequestBody'));
    obj.set('RequestSubject', tenant.get('RequestSubject'));
    obj.set('EmailEditorType', tenant.get('EmailEditorType'));
  }
  if (ext.get('UseNameAsSender')) {
    if (ext.get('Name')) obj.set('SenderName', ext.get('Name'));
    if (ext.get('Email')) obj.set('SenderMail', ext.get('Email'));
  }
  // Saved with the master key there's no request.user, so the afterSave
  // hooks don't set the owner-only ACL; set it here.
  const acl = new Parse.ACL();
  acl.setReadAccess(user.id, true);
  acl.setWriteAccess(user.id, true);
  obj.setACL(acl);
  return obj;
}

// Destroy the records a claim made (a failure, or a stale claim taken over).
async function undo(created) {
  for (const c of created || []) {
    try {
      const obj = await new Parse.Query(classOf(c.kind)).get(c.id, { useMasterKey: true });
      await obj.destroy({ useMasterKey: true });
    } catch (err) {
      if (err?.code !== Parse.Error.OBJECT_NOT_FOUND) throw err;
    }
  }
}

const linkFor = (kind, id) =>
  `${siteOrigin()}/${kind === 'template' ? 'template' : 'placeHolderSign'}/${id}`;

const esc = s =>
  String(s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function confirmationMail(ext, subject, created, skipped) {
  const kindLabel = kind => (kind === 'template' ? 'template' : 'draft document');
  const items = created
    .map(
      c =>
        `<li><a href="${esc(linkFor(c.kind, c.id))}">${esc(c.name)}</a> (${kindLabel(c.kind)})</li>`
    )
    .join('');
  const skippedItems = skipped.map(s => `<li>${esc(s.file)}: ${esc(s.reason)}</li>`).join('');
  return {
    recipient: ext.get('Email'),
    subject: `Received: ${created.map(c => c.name).join(', ')}`.slice(0, 200),
    from: 'Better DocSign',
    html:
      `<p>We received your email${subject ? ` “${esc(subject)}”` : ''} and made:</p><ul>${items}</ul>` +
      (skippedItems ? `<p>These attachments were skipped:</p><ul>${skippedItems}</ul>` : '') +
      `<p>Open a draft to add signers and fields, then send it.</p>`,
  };
}

// The row already taken for this message and kind: created, or being made.
async function existingClaim(inboxId, messageId, kind) {
  const q = new Parse.Query('bs_InboundMail');
  q.equalTo('InboxId', ptr('bs_MailInbox', inboxId));
  q.equalTo('MessageId', messageId);
  q.equalTo('Kind', kind);
  q.containedIn('Status', ['created', 'processing']);
  return q.first({ useMasterKey: true });
}

// PDFs taken in by this address in the last hour, those being made included.
async function usedThisHour(inboxId) {
  const q = new Parse.Query('bs_InboundMail');
  q.equalTo('InboxId', ptr('bs_MailInbox', inboxId));
  q.containedIn('Status', ['created', 'processing']);
  q.greaterThan('createdAt', new Date(Date.now() - 60 * 60 * 1000));
  q.limit(1000);
  const rows = await q.find({ useMasterKey: true });
  return rows.reduce((n, m) => n + (m.get('PdfCount') || 0), 0);
}

// Takes in one message. Throws Rejected for mail to bounce, Retry for later.
export async function receive({ raw, mailFrom, rcptTo }) {
  const where = addressed(rcptTo);
  if (!where) throw new Rejected(404, 'There’s no such address.');

  const q = new Parse.Query('bs_MailInbox');
  q.equalTo('Token', where.token);
  q.include('ExtUserPtr');
  q.include('ExtUserPtr.TenantId');
  q.include('UserId');
  const inbox = await q.first({ useMasterKey: true });
  if (!inbox) throw new Rejected(404, 'There’s no such address.');

  const mail = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  const from = normalEmail(mail.from?.value?.[0]?.address);
  const messageId = String(mail.messageId || `sha256:${sha256hex(raw)}`).slice(0, 500);
  const subject = String(mail.subject || '').slice(0, 500);

  const earlier = await existingClaim(inbox.id, messageId, where.kind);
  if (earlier?.get('Status') === 'created') return { status: 'duplicate' };
  if (earlier && Date.now() - earlier.updatedAt.getTime() < hooks.claimStaleMs) {
    throw new Retry('This email is still being taken in.');
  }

  const log = earlier || new Parse.Object('bs_InboundMail');
  log.set('InboxId', ptr('bs_MailInbox', inbox.id));
  log.set('MessageId', messageId);
  log.set('Kind', where.kind);
  log.set('From', from || normalEmail(mailFrom));
  log.set('To', normalEmail(rcptTo));
  log.set('Subject', subject);
  const reject = async (status, reason, detail) => {
    log.set('Status', 'rejected');
    log.set('Reason', detail ? `${reason} (${detail})` : reason);
    await log.save(null, { useMasterKey: true });
    throw new Rejected(status, reason);
  };
  if (earlier) {
    // A claim left by a crash: undo what it made, then take it over.
    await undo(earlier.get('Created'));
    log.set('Created', []);
  }

  const ext = inbox.get('ExtUserPtr');
  const user = inbox.get('UserId');
  // A deleted user or contracts_Users row leaves an unfetched pointer.
  if (inbox.get('IsActive') === false || !ext?.createdAt || !user?.createdAt) {
    await reject(404, 'This address is turned off.');
  }
  if (ext.get('IsDisabled')) await reject(404, 'This address is turned off.');
  const allowed = new Set(
    [ext.get('Email'), user.get('email'), ...(inbox.get('AllowedSenders') || [])]
      .map(normalEmail)
      .filter(Boolean)
  );
  if (!from || !allowed.has(from)) {
    await reject(403, `${from || 'This sender'} can’t send to this address.`);
  }
  const verified = await senderVerified(raw, mailFrom);
  if (!verified.ok) {
    await reject(403, `We couldn’t verify that this email came from ${from}.`, verified.detail);
  }

  const pdfs = (mail.attachments || []).filter(isPdf);
  if (pdfs.length === 0) await reject(422, 'There’s no PDF attached.');
  if (pdfs.length > MAX_PDFS) await reject(422, `Attach at most ${MAX_PDFS} PDFs to one email.`);
  if ((await usedThisHour(inbox.id)) + pdfs.length > perHour()) {
    await reject(429, 'Too many PDFs sent to this address in the last hour. Try again later.');
  }

  // Claim it, counting its PDFs against the hour while they're made.
  log.set('Status', 'processing');
  log.set('PdfCount', pdfs.length);
  log.set('Created', []);
  log.unset('Reason');
  await log.save(null, { useMasterKey: true });

  const created = [];
  const skipped = [];
  try {
    for (const att of pdfs) {
      const file = att.filename || 'attachment.pdf';
      let bytes;
      try {
        bytes = await cleanedPdf(att.content);
      } catch (err) {
        if (!(err instanceof Rejected)) throw err;
        skipped.push({ file, reason: err.message });
        continue;
      }
      const name =
        pdfs.length === 1 && subjectTitle(subject)
          ? subjectTitle(subject)
          : titleFromFilename(file);
      const stored = await hooks.upload(
        `${sanitizeFileName(name) || 'document'}.pdf`,
        bytes,
        'application/pdf'
      );
      const url = getSecureUrl(stored?.url)?.url;
      if (!url) throw new Error('Couldn’t store the PDF.');
      // Never throws (it logs); awaited so the usage is counted before we answer.
      await saveFileUsage(bytes.length, url, user.id, ext.get('TenantId')?.id);
      const saved = await newRecord(where.kind, { name, url, ext, user }).save(null, {
        useMasterKey: true,
      });
      created.push({ kind: where.kind, id: saved.id, name });
      log.set('Created', created);
      await log.save(null, { useMasterKey: true });
    }
  } catch (err) {
    await undo(created);
    log.set('Status', 'failed');
    log.set('Created', []);
    log.set('Reason', String(err?.message || err).slice(0, 500));
    await log.save(null, { useMasterKey: true });
    throw err;
  }
  if (created.length === 0) {
    await reject(
      422,
      `None of the PDFs could be used: ${skipped.map(s => `${s.file} (${s.reason})`).join(', ')}.`
    );
  }

  log.set('Status', 'created');
  log.set('PdfCount', created.length);
  log.set('Skipped', skipped);
  await log.save(null, { useMasterKey: true });
  try {
    await hooks.sendMail(confirmationMail(ext, subject, created, skipped));
  } catch (err) {
    console.log('inbound mail: confirmation mail failed', err?.message);
  }
  return { status: 'created', created, skipped };
}

export const router = express.Router();

router.post('/inbound/mail', checkHeaders, rawBody, async (req, res) => {
  if (!checkSignature(req)) {
    await badLimiter()
      .penalty(clientIp(req), 1)
      .catch(() => {});
    return res.status(401).json({ status: 'error', reason: 'Bad signature.' });
  }
  try {
    const result = await receive({
      raw: req.body,
      mailFrom: req.get('x-bs-mail-from') || '',
      rcptTo: req.get('x-bs-rcpt-to') || '',
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof Rejected) {
      return res.status(err.status).json({ status: 'rejected', reason: err.message });
    }
    if (err instanceof Retry) {
      res.set('Retry-After', '30');
      return res.status(503).json({ status: 'error', reason: err.message });
    }
    console.log('inbound mail failed', err?.message || err);
    return res.status(500).json({ status: 'error', reason: 'Something went wrong.' });
  }
});

// A body over BS_INBOUND_MAIL_MAX_MB: bounced, saying the limit.
// eslint-disable-next-line no-unused-vars
router.use('/inbound/mail', (err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ status: 'rejected', reason: `This email is too large (at most ${maxMb()} MB).` });
  }
  return next(err);
});
