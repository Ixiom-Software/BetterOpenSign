// Sign on phone v2: the signer's BetterID phone signs the whole PDF with its
// own P-256 key, as a PAdES signature. Remote signing: we prepare the bytes
// (through bs-service-identity), the phone checks them against the PDF it
// downloads and signs them, we embed the result. Only for a session from
// "Sign in with BetterID", like v1 (bsPhoneSign.js, unchanged).
//
//   1. bsphonesignpdfstart { docId, fieldName, base, caption? }
//      `base` is the signer's revision: the document's current file with their
//      widgets and a blank signature field `fieldName` appended. We keep it,
//      hold the document against other signers (PDF.js phoneSignLockOf) and
//      send the phone an approve request through the relay.
//      -> { reqId, expiresAt }
//   2. bsphonesignpdfpoll { reqId }   (repeat until the status is final)
//      Long-polls the relay for the current step's answer and moves on:
//
//        approve ─▶ [certify root] ─▶ [certify leaf] ─▶ sign ─▶ signed
//
//      certify only when there is no certificate for the phone's keys yet (or
//      the signing certificate ends within 30 days). Each step is its own
//      relay request, with its own reqId and one-time X25519 key; the
//      challenge stays the approval's.
//      -> { status: waiting | approved | signing | signed | denied | error
//                   | expired | cancelled, reason?, message? }
//   3. bsphonesignpdfcancel { reqId }   (the signer closed the dialog)
//      Ends the attempt and frees the document.  -> { status: 'cancelled' }
//      If a poll is mid-step, that poll ends it at its next check, before it
//      sends the phone anything or commits.
//
// On `signed` the browser carries on as after a normal Finish, including the
// next signer's email, so nothing here sends one (unlike the desktop path).
//
// bs-service-identity builds each request body, opens and checks each answer,
// and builds the certificates, the prepared PDF and the final CMS
// (/v1/phone/*). We check the VLAD's signature on every answer's statement
// through the verifier, as v1 does. The signed PDF goes through finishSigning,
// append-only, with the VLAD in the audit trail and VladSignatures, as a
// desktop signature does (customRoute/bsapi/signatures.js), so later signers
// and the seal append. The phone downloads the PDFs from
// GET /api/v1/phone-sign/:reqId/file (phoneSignFile).
//
// Protocol and limits: docs/BetterIDPhoneSignV2.md (repo root).
//
// Env: BS_SERVICE_IDENTITY_URL, BS_SERVICE_IDENTITY_TOKEN (as utils/seal.js),
// and v1's relay and verifier settings.

import crypto from 'node:crypto';
import axios from 'axios';
import {
  appendedSignatureCoveringFile,
  extendsPdf,
  isAppendOnly,
  readDocumentPdf,
  signatureByteRanges,
} from '../../utils/appendOnlyPdf.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import { getSecureUrl } from '../../Utils.js';
import { apiError } from '../customRoute/bsapi/auth.js';
import { findAccessibleDocument, signerState } from '../customRoute/bsapi/documents.js';
import { loadForSigning } from '../customRoute/bsapi/signatures.js';
import {
  buildRequestEnvelope,
  newX25519,
  PDF_REQUEST_CT,
  relayCall,
  relayKey,
  sha256,
} from '../customRoute/bsapi/relay.js';
import { buildSignedMessage, decodeCbor } from '../customRoute/bsapi/statement.js';
import { verifySignature } from '../customRoute/bsapi/verifier.js';
import { cannotSign, openEphSecret, sealEphSecret, signerVlad, siteConfig } from './bsPhoneSign.js';
import {
  commitAtRevision,
  deleteUploadedFile,
  finishSigning,
  PHONE_LOCKED_MESSAGE,
  phoneSignLockOf,
  STALE_DOCUMENT,
  STALE_MESSAGE,
} from './pdf/PDF.js';

const CLASS = 'bs_PhoneSignPdf';
const CERT_CLASS = 'bs_PhoneSignCert';
// Each relay request; the relay allows at most 300 s.
const REQUEST_TTL_S = 180;
// The phone keeps an approval this long for its certify and sign requests.
const APPROVAL_S = 600;
// A step with less time than this left isn't sent.
const MIN_STEP_S = 30;
const POLL_WAIT_S = 20;
// Clock difference allowed between the phone and us.
const CLOCK_SKEW_S = 60;
// The hold on the document outlasts the current request by this much.
const LOCK_GRACE_S = 60;
// Once the phone has signed: time to embed the signature and commit.
const COMPLETE_S = 300;
// One poll at a time moves an attempt on (claim). The poll renews its lease
// while it works, so a slow step (prepare or complete take up to two minutes,
// then the seal and the upload) keeps it; one that dies lets it lapse.
const LEASE_MS = 120 * 1000;
const LEASE_RENEW_MS = 30 * 1000;
// Unfinished attempts are expired this long after their hold ends.
const SWEEP_AFTER_MS = 10 * 60 * 1000;
// As the desktop app's: a ten-year root issues a one-year signing certificate.
const ROOT_S = 3650 * 86400;
const LEAF_S = 365 * 86400;
const RENEW_S = 30 * 86400;
const BACKDATE_S = 300;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CAPTION = 200;
const ID_RE = /^[A-Za-z0-9]{1,32}$/;
// The PDF field name: no '.', which separates field name parts.
const FIELD_RE = /^bs-phone-[A-Za-z0-9_:-]{1,91}$/;
const REQ_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const LIVE = ['waiting', 'approved', 'signing'];
const STEP_STATUS = { approve: 'waiting', certify: 'approved', sign: 'signing' };
// What the phone's refusals mean to the signer.
const REASON_MESSAGES = {
  user: 'You declined on your phone.',
  locked: 'Your phone was locked, so nothing was signed.',
  expired: 'The request expired on your phone. Try again.',
  'no-signature':
    'Your phone has no signature to sign with. Add one in the BetterID app, then try again.',
  mismatch:
    "Your phone found that the document didn't match what it was asked to sign, so nothing was signed.",
  'unknown-approval': 'Your phone no longer has this approval. Try again.',
};
const NOT_VERIFIED = "Your phone's answer couldn't be verified.";
const FAILED = "Couldn't sign the document on your phone. Try again.";
const BUSY =
  'Your earlier signing on your phone is still finishing. Try again in a moment.';
const PREPARE_FAILED = "Couldn't prepare the document for your phone. Try again.";

const b64 = b => Buffer.from(b).toString('base64');
const b64u = b => Buffer.from(b).toString('base64url');
const unb64 = s => Buffer.from(String(s || ''), 'base64');
const hex = b => Buffer.from(b).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const sec = d => Math.floor(d.getTime() / 1000);
const dateOf = s => ({ __type: 'Date', iso: new Date(s * 1000).toISOString() });
const err = (code, msg) => new Parse.Error(code, msg);
// A failure the signer is told about as is, ending the attempt.
const userError = message => Object.assign(new Error(message), { userMessage: message });
// A failure worth trying again on the next poll.
const transient = message => Object.assign(new Error(message), { transient: true });

// --- the caption ---------------------------------------------------------------

// The caption the appearance draws next to the signature. The phone binds it
// at approval (captionSha256) and refuses an appearance with any other text,
// so it must be text the standard Helvetica draws with WinAnsiEncoding
// (bs_core pdf_field::win_ansi): printable ASCII, Latin-1 and WinAnsi's
// typographic extras, no control characters.
const WIN_ANSI_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const drawable = ch =>
  (ch >= ' ' && ch <= '~') || (ch >= '\u00a0' && ch <= '\u00ff') || WIN_ANSI_EXTRAS.includes(ch);
const isDrawable = s => [...s].every(drawable);
// Latin letters NFKD doesn't take apart.
const LATIN_BASE = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't' };

// The signer's name as WinAnsi text: accented Latin letters outside Latin-1
// lose their accents (Ő -> O, Ł -> L); a name with anything else (another
// script) gives '' rather than a mangled name.
function drawableName(name) {
  const chars = [...String(name || '').replace(/\s+/g, ' ').trim()].map(ch => {
    if (drawable(ch)) return ch;
    if (LATIN_BASE[ch]) return LATIN_BASE[ch];
    const bare = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return bare && isDrawable(bare) ? bare : null;
  });
  return chars.includes(null) ? '' : chars.join('');
}

// "Digitally signed by <name> · YYYY-MM-DD", or without the name if it can't
// be drawn; at most MAX_CAPTION characters (the name is cut).
function defaultCaption(name, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const drawn = drawableName(name);
  if (!drawn) return `Digitally signed · ${day}`;
  const room = MAX_CAPTION - `Digitally signed by  · ${day}`.length;
  return `Digitally signed by ${drawn.slice(0, room).trim()} · ${day}`;
}

function log(event, fields) {
  console.log(JSON.stringify({ event: `bsphonesignpdf_${event}`, ...fields }));
}

// --- bs-service-identity -------------------------------------------------------

function serviceConfig() {
  const url = (process.env.BS_SERVICE_IDENTITY_URL || '').replace(/\/$/, '');
  const token = process.env.BS_SERVICE_IDENTITY_TOKEN || '';
  return url && token ? { url, token } : null;
}

// One call. Throws, with `.transient` when trying again may help (unreachable,
// 5xx); a 4xx means the service refused what we sent.
async function service(path, body, timeout = 30000) {
  const s = serviceConfig();
  if (!s) throw new Error('BS_SERVICE_IDENTITY_URL and _TOKEN are not set');
  let res;
  try {
    res = await axios.post(s.url + path, body, {
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      timeout,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
  } catch (e) {
    throw transient(`${path}: ${e.message}`);
  }
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  if (res.status >= 200 && res.status < 300) return d;
  const e = new Error(`${path}: ${res.status} ${d.code || ''} ${d.error || ''}`.trim());
  throw Object.assign(e, { status: res.status, code: d.code, transient: res.status >= 500 });
}

// --- files -----------------------------------------------------------------------

async function storePdf(name, bytes) {
  const f = await parseUploadFile(name, bytes, 'application/pdf');
  const url = getSecureUrl(f?.url)?.url;
  if (!url) throw new Error('could not store the PDF');
  return url;
}

// A PDF we stored, checked against the hash we sent the phone.
async function readStored(url, sha) {
  const bytes = await readDocumentPdf(url);
  if (sha256(bytes).toString('hex') !== sha) throw new Error('a stored PDF changed');
  return bytes;
}

// --- the hold on the document (PDF.js phoneSignLockOf) ------------------------------

// Take it at the revision `doc` was read at; that commit bumps SignRevision,
// so no signing checked before it can commit. Returns the new revision, or
// null if the document changed.
async function takeLock(doc, lockId, untilSec) {
  const revision = doc.get('SignRevision') || 0;
  const ok = await commitAtRevision(doc.id, revision, {
    PhoneSignLockId: lockId,
    PhoneSignLockUntil: dateOf(untilSec),
  });
  return ok ? revision + 1 : null;
}

// Extend it, if it is still ours and nothing has committed since. False if not.
async function holdLock(row, untilSec) {
  try {
    await Parse.Server.database.update(
      'contracts_Document',
      {
        objectId: row.get('DocId'),
        PhoneSignLockId: row.get('ApproveReqId'),
        SignRevision: row.get('BaseRevision'),
      },
      { PhoneSignLockUntil: dateOf(untilSec) },
      {}
    );
    return true;
  } catch (e) {
    if (e?.code === Parse.Error.OBJECT_NOT_FOUND) return false;
    throw e;
  }
}

async function releaseLock(docId, lockId) {
  try {
    await Parse.Server.database.update(
      'contracts_Document',
      { objectId: docId, PhoneSignLockId: lockId },
      { PhoneSignLockId: { __op: 'Delete' }, PhoneSignLockUntil: { __op: 'Delete' } },
      {}
    );
  } catch (e) {
    if (e?.code !== Parse.Error.OBJECT_NOT_FOUND) {
      console.log('bsphonesignpdf: could not release', docId, e?.message);
    }
  }
}

// --- one poll at a time -------------------------------------------------------------

// Polls overlap (a retry, a second tab), and the relay hands every one of them
// the same answer. Only the poll that claims the attempt, at the step it saw,
// acts on it; the others report the status. The claim is a lease with its own
// id (LeaseId): only its holder renews or releases it. Returns the id, or
// null if another poll holds the attempt.
async function claim(row) {
  const now = Date.now();
  const leaseId = crypto.randomBytes(8).toString('hex');
  try {
    await Parse.Server.database.update(
      CLASS,
      {
        objectId: row.id,
        StepReqId: row.get('StepReqId'),
        $or: [{ LeaseUntil: { $exists: false } }, { LeaseUntil: { $lt: now } }],
      },
      { LeaseUntil: now + LEASE_MS, LeaseId: leaseId },
      {}
    );
  } catch (e) {
    if (e?.code === Parse.Error.OBJECT_NOT_FOUND) return null;
    throw e;
  }
  await row.fetch({ useMasterKey: true });
  return leaseId;
}

// Change the lease only if it is still `leaseId`.
const updateLease = (row, leaseId, update) =>
  Parse.Server.database
    .update(CLASS, { objectId: row.id, LeaseId: leaseId }, update, {})
    .catch(() => {});

// Whether the signer has asked to cancel since `row` was read.
async function cancelRequested(row) {
  const fresh = await new Parse.Query(CLASS)
    .select('CancelRequested')
    .get(row.id, { useMasterKey: true });
  return !!fresh.get('CancelRequested');
}

const cancelled = row => finishRow(row, 'cancelled', { reason: 'user' });

async function withClaim(row, fn) {
  const leaseId = await claim(row);
  if (!leaseId) return result(row);
  const renew = setInterval(
    () => updateLease(row, leaseId, { LeaseUntil: Date.now() + LEASE_MS }),
    LEASE_RENEW_MS
  );
  renew.unref?.();
  try {
    if (!LIVE.includes(row.get('Status'))) return result(row);
    if (row.get('CancelRequested')) return await cancelled(row);
    const out = await fn();
    // A cancel that came in while this poll worked.
    if (LIVE.includes(row.get('Status')) && (await cancelRequested(row))) {
      return await cancelled(row);
    }
    return out;
  } finally {
    clearInterval(renew);
    await updateLease(row, leaseId, {
      LeaseUntil: { __op: 'Delete' },
      LeaseId: { __op: 'Delete' },
    });
  }
}

function result(row) {
  const out = { status: row.get('Status') };
  if (row.get('Reason')) out.reason = row.get('Reason');
  if (row.get('Message')) out.message = row.get('Message');
  return out;
}

// --- requests ---------------------------------------------------------------------------

// Build the next request (`step`, with its own fields `extra`) and set the
// attempt to wait for it. Doesn't save; nothing on the row changes if
// building fails.
async function buildStep(row, step, extra = {}) {
  const c = await siteConfig();
  const key = await relayKey();
  const reqId = crypto.randomBytes(16);
  const eph = newX25519();
  const iat = nowSec();
  const until = row.get('ApprovalUntil') ? sec(row.get('ApprovalUntil')) : iat + APPROVAL_S;
  const exp = Math.min(iat + REQUEST_TTL_S, until);
  if (exp - iat < MIN_STEP_S) throw userError('The approval on your phone ran out. Try again.');
  const request = {
    step,
    req_id: b64(reqId),
    origin: c.origin,
    rp: c.rp,
    receiver_vlad: b64(Buffer.from(c.receiverVlad, 'hex')),
    doc_id: row.get('DocId'),
    field_id: row.get('FieldName'),
    challenge: b64(Buffer.from(row.get('Challenge'), 'hex')),
    eph_pub: b64(eph.pub),
    iat,
    exp,
    base_sha256: row.get('BaseSha256'),
    base_len: row.get('BaseLen'),
    // The phone binds the caption at approval and remembers it.
    ...(step === 'approve' && { caption: row.get('Caption') }),
    ...(step !== 'approve' && { approve_req_id: b64(Buffer.from(row.get('ApproveReqId'), 'hex')) }),
    ...extra,
  };
  const built = await service('/v1/phone/request', request);
  if (built.ct !== PDF_REQUEST_CT || typeof built.body !== 'string') {
    throw new Error(`/v1/phone/request: unexpected answer ${built.ct}`);
  }
  const to = sha256(Buffer.from(row.get('vlad'), 'hex'));
  const env = buildRequestEnvelope({
    key,
    to,
    reqId,
    iat,
    exp,
    ct: PDF_REQUEST_CT,
    body: unb64(built.body),
  });

  const reqIdHex = hex(reqId);
  if (step === 'approve') {
    row.set('ApproveReqId', reqIdHex);
    row.set('ApprovalUntil', new Date(until * 1000));
  }
  row.set('Step', step);
  row.set('Status', STEP_STATUS[step]);
  row.set('Answered', false);
  row.set('StepReqId', reqIdHex);
  row.set('StepRequest', request);
  row.set('EphSecret', sealEphSecret(eph.secret, reqIdHex));
  row.set('StepIssuedAt', new Date(iat * 1000));
  row.set('StepExpiresAt', new Date(exp * 1000));
  row.set('LockUntil', new Date((exp + LOCK_GRACE_S) * 1000));
  return { key, env, to, reqId, exp };
}

// Hand a built request to the relay. Throws a Parse.Error for the signer.
//
// Only approve needs the person: certify and sign are answered by the app
// without a screen, so they go as `quiet` requests (the relay's own budget,
// 240/h per sender, and a data-only push) instead of using up the 20/h a
// known sender gets per phone. The relay also takes at most one request a
// second per sender, and certify and sign follow an answer at once, so a
// `rate-limited` refusal is retried after a short wait.
const RATE_RETRIES = 3;
const RATE_WAIT_MS = 1100;

async function postRequest(row, { key, env, to, reqId, exp }) {
  const refused = (code, message, fields) => {
    log(fields.event, { vlad: row.get('vlad').slice(0, 16), ...fields });
    return err(code, message);
  };
  const quiet = row.get('Step') !== 'approve';
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await relayCall(key, 'POST', '/v1/req', {
        body: { env: b64u(env), to: b64u(to), reqId: b64u(reqId), exp, ...(quiet ? { quiet } : {}) },
      });
    } catch (e) {
      throw refused(
        Parse.Error.CONNECTION_FAILED,
        "Couldn't reach the BetterID relay. Try again.",
        {
          event: 'relay_unreachable',
          error: e.message,
        }
      );
    }
    if (res.status !== 429 || res.body.error !== 'rate-limited' || attempt >= RATE_RETRIES) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, RATE_WAIT_MS));
  }
  if (res.status === 202) return;
  const fields = { event: 'relay_refused', status: res.status, error: res.body.error };
  if (res.body.error === 'unknown-recipient') {
    throw refused(
      Parse.Error.OBJECT_NOT_FOUND,
      "Your BetterID app hasn't connected yet. Open the app on your phone, then try again.",
      fields
    );
  }
  if (res.status === 429) {
    throw refused(
      Parse.Error.REQUEST_LIMIT_EXCEEDED,
      'Too many requests to your phone. Wait a little and try again.',
      fields
    );
  }
  throw refused(
    Parse.Error.CONNECTION_FAILED,
    "Couldn't send the request to your phone. Try again.",
    fields
  );
}

// The next request of a running attempt: saved, the hold extended, sent,
// unless the signer cancelled meanwhile.
async function continueWith(row, step, extra) {
  const sent = await buildStep(row, step, extra);
  await row.save(null, { useMasterKey: true });
  if (!(await holdLock(row, sec(row.get('LockUntil'))))) {
    throw userError('The document changed while you were signing. Reload it and sign again.');
  }
  if (await cancelRequested(row)) return cancelled(row);
  try {
    await postRequest(row, sent);
  } catch (e) {
    throw userError(e.message);
  }
  log('sent', { vlad: row.get('vlad').slice(0, 16), docId: row.get('DocId'), step });
  return result(row);
}

// --- start ------------------------------------------------------------------------------

// Who signs: the signer contact whose turn it is, or for a document you sign
// yourself, its owner (as signPdf without a userId).
function signerOf(doc, user) {
  const fallback = user.get('name') || user.get('email') || user.get('username') || 'Signer';
  if (doc.get('IsSignyourself')) {
    const ext = doc.get('ExtUserPtr');
    if (!ext) return null;
    return { id: ext.id, className: 'contracts_Users', name: ext.get('Name') || fallback };
  }
  const state = signerState(doc, user.id);
  if (!state.canSign) return null;
  const contact = state.contact;
  return {
    id: contact.id,
    className: 'contracts_Contactbook',
    name: contact.get('Name') || fallback,
  };
}

export async function bsphonesignpdfstart(request) {
  const { docId, fieldName, base, caption } = request.params || {};
  if (!ID_RE.test(String(docId || '')) || !FIELD_RE.test(String(fieldName || ''))) {
    throw err(Parse.Error.INVALID_QUERY, 'Missing or malformed document or field.');
  }
  if (typeof base !== 'string' || !B64_RE.test(base)) {
    throw err(Parse.Error.INVALID_QUERY, 'The document to sign is missing.');
  }
  if (
    caption != null &&
    (typeof caption !== 'string' || caption.length > MAX_CAPTION || !isDrawable(caption))
  ) {
    throw err(
      Parse.Error.INVALID_QUERY,
      `The caption can be at most ${MAX_CAPTION} characters of Latin text.`
    );
  }
  let baseBytes = Buffer.from(base, 'base64');
  if (baseBytes.length > MAX_PDF_BYTES) {
    throw err(Parse.Error.INVALID_QUERY, 'This document is too large to sign on your phone.');
  }
  const vlad = await signerVlad(request);
  const user = request.user;
  const c = await siteConfig();
  if (!serviceConfig()) {
    throw err(
      Parse.Error.INTERNAL_SERVER_ERROR,
      'Signing on your phone is not set up on this server.'
    );
  }
  const found = await findAccessibleDocument(docId, user.id);
  if (!found) throw err(Parse.Error.OBJECT_NOT_FOUND, 'No such document, or no access to it.');
  const doc = await loadForSigning(found.id);
  const why = cannotSign(doc, user.id);
  if (why) throw err(Parse.Error.OPERATION_FORBIDDEN, why);
  const signer = signerOf(doc, user);
  if (!signer) throw err(Parse.Error.OPERATION_FORBIDDEN, "You can't sign this document.");
  sweep();

  // Someone else's attempt holds the document. Your own earlier one (another
  // tab, a retry) gives way to this one, unless a poll is moving it on right
  // now (it may be committing): then try again in a moment.
  const held = phoneSignLockOf(doc);
  if (held) {
    const holder = await new Parse.Query(CLASS)
      .equalTo('ApproveReqId', held)
      .first({ useMasterKey: true });
    if (holder && holder.get('UserId')?.id !== user.id) {
      throw err(Parse.Error.OPERATION_FORBIDDEN, PHONE_LOCKED_MESSAGE);
    }
    if (holder && LIVE.includes(holder.get('Status'))) {
      await withClaim(holder, () =>
        finishRow(holder, 'error', {
          reason: 'replaced',
          message: 'You started signing this document again.',
        })
      );
      if (LIVE.includes(holder.get('Status'))) throw err(Parse.Error.OPERATION_FORBIDDEN, BUSY);
    }
  }

  // The revision must be the current file with only bytes appended.
  let current;
  try {
    current = await readDocumentPdf(doc.get('SignedUrl') || doc.get('URL'));
  } catch (e) {
    console.log('bsphonesignpdf: file download failed', doc.id, e?.message);
    throw err(Parse.Error.CONNECTION_FAILED, "Couldn't read the document's file. Try again.");
  }
  if (!extendsPdf(current, baseBytes)) throw err(STALE_DOCUMENT, STALE_MESSAGE);

  // What the phone approves is the base made Acrobat-ready: an unsigned PDF
  // with compressed cross-references (pdf-lib's default) is re-saved with a
  // classic table, or Acrobat calls the phone's signature invalid ("errors in
  // the formatting"; the signing revision always appends a classic table).
  // The content is unchanged. One already signed is left as is (a warning):
  // re-saving it would break its signatures, so for a signed document we
  // insist on the current file with bytes appended, as above.
  let n;
  try {
    n = await service('/v1/phone/pades/base', { pdf: baseBytes.toString('base64') }, 120000);
  } catch (e) {
    log('base_failed', { docId, error: e.message });
    throw err(Parse.Error.CONNECTION_FAILED, PREPARE_FAILED);
  }
  const normalized = Buffer.from(typeof n.pdf === 'string' ? n.pdf : '', 'base64');
  const signedBefore = isAppendOnly(doc) || signatureByteRanges(current).length > 0;
  const refused = !normalized.length
    ? 'empty'
    : n.warning && !normalized.equals(baseBytes)
      ? 'changed_despite_warning'
      : signedBefore && !extendsPdf(current, normalized)
        ? 'rewrote_signed'
        : null;
  if (n.warning) log('base_warning', { docId, warning: n.warning });
  if (refused) {
    log('base_refused', { docId, why: refused });
    throw err(Parse.Error.CONNECTION_FAILED, PREPARE_FAILED);
  }
  baseBytes = normalized;

  const baseSha256 = sha256(baseBytes).toString('hex');
  const row = new Parse.Object(CLASS);
  row.set('UserId', { __type: 'Pointer', className: '_User', objectId: user.id });
  row.set('vlad', vlad);
  row.set('DocId', doc.id);
  row.set('FieldName', fieldName);
  row.set('SignerId', signer.id);
  row.set('SignerClass', signer.className);
  row.set('SignerName', signer.name);
  row.set('Caption', caption || defaultCaption(signer.name));
  row.set('Challenge', crypto.randomBytes(32).toString('hex'));
  row.set('BaseSha256', baseSha256);
  row.set('BaseLen', baseBytes.length);
  row.set('IpAddress', request.headers?.['x-real-ip'] || '');
  row.set('PublicUrl', request.headers?.public_url || c.origin);
  row.set('Statements', []);
  row.setACL(new Parse.ACL());

  let sent;
  try {
    sent = await buildStep(row, 'approve');
  } catch (e) {
    log('start_failed', { vlad: vlad.slice(0, 16), docId, error: e.message });
    throw err(
      Parse.Error.CONNECTION_FAILED,
      "Couldn't prepare the request to your phone. Try again."
    );
  }
  const lockId = row.get('ApproveReqId');
  const revision = await takeLock(doc, lockId, sec(row.get('LockUntil')));
  if (revision === null) throw err(STALE_DOCUMENT, STALE_MESSAGE);

  // The base and the row before the request, so the phone never gets a
  // request we can't serve.
  const undo = async () => {
    await releaseLock(doc.id, lockId);
    if (row.id) await row.destroy({ useMasterKey: true }).catch(() => {});
    if (row.get('BaseUrl')) await deleteUploadedFile(row.get('BaseUrl'));
  };
  try {
    row.set('BaseUrl', await storePdf(`phone_base_${doc.id}.pdf`, baseBytes));
    row.set('BaseRevision', revision);
    await row.save(null, { useMasterKey: true });
    await postRequest(row, sent);
  } catch (e) {
    await undo();
    if (e instanceof Parse.Error) throw e;
    console.log('bsphonesignpdf: start failed', doc.id, e?.message);
    throw err(Parse.Error.INTERNAL_SERVER_ERROR, FAILED);
  }
  log('started', { vlad: vlad.slice(0, 16), userId: user.id, docId: doc.id });
  // expiresAt: when the phone can no longer approve, in epoch milliseconds.
  return { reqId: b64u(sent.reqId), expiresAt: row.get('StepExpiresAt').getTime() };
}

// The attempt of this session's user for a reqId (the approve request's), or
// a 101.
async function ownRow(request) {
  const reqId = String(request.params?.reqId || '');
  if (!REQ_ID_RE.test(reqId)) throw err(Parse.Error.INVALID_QUERY, 'Missing request.');
  const vlad = await signerVlad(request);
  const row = await new Parse.Query(CLASS)
    .equalTo('ApproveReqId', Buffer.from(reqId, 'base64url').toString('hex'))
    .first({ useMasterKey: true });
  if (!row || row.get('UserId')?.id !== request.user.id || row.get('vlad') !== vlad) {
    throw err(Parse.Error.OBJECT_NOT_FOUND, 'No such request.');
  }
  return row;
}

// bsphonesignpdfcancel { reqId }: the signer closed the dialog. Ends the
// attempt and frees the document at once. -> { status: 'cancelled' }, or the
// final status if it had already ended. If a poll is moving the attempt on,
// the request is recorded (CancelRequested) and that poll ends it before it
// sends the phone anything more or commits; the answer is the status then.
export async function bsphonesignpdfcancel(request) {
  const row = await ownRow(request);
  if (!LIVE.includes(row.get('Status'))) return result(row);
  try {
    await Parse.Server.database.update(
      CLASS,
      { objectId: row.id, Status: { $in: LIVE } },
      { CancelRequested: true },
      {}
    );
  } catch (e) {
    if (e?.code !== Parse.Error.OBJECT_NOT_FOUND) throw e;
    await row.fetch({ useMasterKey: true });
    return result(row);
  }
  return withClaim(row, () => cancelled(row));
}

// --- poll -------------------------------------------------------------------------------

export async function bsphonesignpdfpoll(request) {
  const row = await ownRow(request);
  if (!LIVE.includes(row.get('Status'))) return result(row);
  if (row.get('CancelRequested')) return withClaim(row, () => cancelled(row));
  if (row.get('Answered')) return withClaim(row, () => advance(row));
  // Only once the relay has no answer: one the phone sent in time counts even
  // if this poll comes late (checkStatement bounds its iat).
  const unanswered = () =>
    sec(row.get('StepExpiresAt')) + CLOCK_SKEW_S < nowSec()
      ? withClaim(row, () => finishRow(row, 'expired'))
      : result(row);

  const key = await relayKey();
  let res;
  try {
    res = await relayCall(
      key,
      'GET',
      `/v1/resp/${b64u(Buffer.from(row.get('StepReqId'), 'hex'))}`,
      {
        query: { wait: POLL_WAIT_S },
        timeout: (POLL_WAIT_S + 10) * 1000,
      }
    );
  } catch {
    return unanswered();
  }
  if (res.status === 202 || res.status === 204) return unanswered();
  if (res.status === 410) return withClaim(row, () => finishRow(row, 'expired'));
  if (res.status !== 200 || typeof res.body.env !== 'string') {
    log('relay_poll_failed', { status: res.status, error: res.body.error });
    return unanswered();
  }
  const env = res.body.env;
  // Another poll may have taken this answer already; then carry on from there.
  return withClaim(row, () => (row.get('Answered') ? advance(row) : answer(row, env)));
}

// The phone's answer to the current step: the service opens and checks it, we
// check the VLAD's signature, keep what it carries, and move on.
async function answer(row, env) {
  const c = await siteConfig();
  const step = row.get('Step');
  const reqIdHex = row.get('StepReqId');
  const reject = (reason, extra = {}) => {
    log('rejected', { vlad: row.get('vlad').slice(0, 16), step, reason, ...extra });
    return finishRow(row, 'error', { reason: 'unverified', message: NOT_VERIFIED });
  };

  const body = {
    env,
    request: row.get('StepRequest'),
    eph_secret: b64(openEphSecret(row.get('EphSecret'), reqIdHex)),
    now: nowSec(),
  };
  if (step !== 'approve') {
    body.doc_key = row.get('DocKey');
    body.root_key = row.get('RootKey');
  }
  if (step === 'sign') body.signed_attributes = row.get('SignedAttributes');
  let a;
  try {
    a = await service('/v1/phone/answer', body);
  } catch (e) {
    // The relay keeps the answer until the request expires: try again.
    if (e.transient) {
      log('service_unavailable', { step, error: e.message });
      return result(row);
    }
    return reject('answer', { error: e.message });
  }
  if (a.result === 'denied' || a.result === 'error') {
    const reason = typeof a.reason === 'string' ? a.reason.slice(0, 64) : undefined;
    log(a.result, { vlad: row.get('vlad').slice(0, 16), step, reason });
    return finishRow(row, a.result === 'denied' ? 'denied' : 'error', {
      reason,
      message: REASON_MESSAGES[reason] || (a.result === 'error' ? FAILED : undefined),
    });
  }
  if (a.result !== 'ok') return reject('result', { result: a.result });

  const bad = checkStatement(row, a, c);
  if (bad) return reject(bad);
  const message = buildSignedMessage({
    senderVlad: Buffer.from(row.get('vlad'), 'hex'),
    receiverVlad: Buffer.from(c.receiverVlad, 'hex'),
    type: 'bs-docsign-pdf',
    body: unb64(a.statement),
  });
  const v = await verifySignature({
    vladHex: row.get('vlad'),
    messageHex: message.toString('hex'),
    signatureHex: unb64(a.vlad_sig).toString('hex'),
    rp: c.rp,
  });
  if (!v.ok) {
    // A verifier outage just means another poll.
    if (v.unavailable) return result(row);
    return reject('signature', { code: v.code });
  }

  if (step === 'approve') {
    const image = unb64(a.image);
    const isKey = k => typeof k === 'string' && unb64(k).length === 65 && unb64(k)[0] === 4;
    if (image.length > MAX_IMAGE_BYTES || !image.subarray(0, 8).equals(PNG_MAGIC)) {
      return reject('image');
    }
    if (!isKey(a.doc_key) || !isKey(a.root_key)) return reject('keys');
    row.set('Image', b64(image));
    row.set('DocKey', a.doc_key);
    row.set('RootKey', a.root_key);
  } else if (typeof a.signature !== 'string' || !a.signature) {
    return reject('signature_value');
  } else if (step === 'certify') {
    row.set('CertifySignature', a.signature);
  } else {
    row.set('Signature', a.signature);
    row.set('LockUntil', new Date((nowSec() + COMPLETE_S) * 1000));
  }
  row.add('Statements', {
    step,
    ...(step === 'certify' && { purpose: row.get('Purpose') }),
    reqId: reqIdHex,
    statement: a.statement,
    vladSig: a.vlad_sig,
  });
  row.set('Answered', true);
  row.unset('EphSecret');
  await row.save(null, { useMasterKey: true });
  if (step === 'sign') await holdLock(row, sec(row.get('LockUntil')));
  log('answered', { vlad: row.get('vlad').slice(0, 16), docId: row.get('DocId'), step });
  return advance(row);
}

// The statement names this attempt and step, signed while the request was open.
// Null if so, else what's wrong. The service has checked it too; this is what
// docsign relies on.
function checkStatement(row, a, c) {
  let s;
  try {
    s = decodeCbor(unb64(a.statement));
  } catch {
    return 'statement';
  }
  if (!(s instanceof Map)) return 'statement';
  const bytesHex = k => (s.get(k) instanceof Uint8Array ? hex(s.get(k)) : null);
  const iat = s.get('iat');
  const checks = {
    type: s.get('v') === 1 && s.get('type') === 'bs-docsign-pdf',
    step: s.get('step') === row.get('Step'),
    vlad: bytesHex('vlad') === row.get('vlad'),
    answerVlad: a.vlad === undefined || hex(unb64(a.vlad)) === row.get('vlad'),
    origin: s.get('origin') === c.origin,
    rp: s.get('rp') === c.rp,
    docId: s.get('docId') === row.get('DocId'),
    fieldId: s.get('fieldId') === row.get('FieldName'),
    challenge: bytesHex('challenge') === row.get('Challenge'),
    reqId: bytesHex('reqId') === row.get('StepReqId'),
    baseSha256: bytesHex('baseSha256') === row.get('BaseSha256'),
    // The caption the appearance may draw, bound at approval.
    caption:
      row.get('Step') !== 'approve' ||
      bytesHex('captionSha256') === sha256(Buffer.from(row.get('Caption'), 'utf8')).toString('hex'),
    iat:
      typeof iat === 'number' &&
      iat >= sec(row.get('StepIssuedAt')) - CLOCK_SKEW_S &&
      iat <= sec(row.get('StepExpiresAt')) + CLOCK_SKEW_S,
  };
  return Object.keys(checks).find(k => !checks[k]) || null;
}

// An answered step: what comes next. A failure worth retrying leaves the
// attempt as it is for the next poll; any other ends it.
async function advance(row) {
  const step = row.get('Step');
  try {
    if (step === 'sign') {
      if (sec(row.get('LockUntil')) < nowSec()) throw userError(FAILED);
      return await complete(row);
    }
    if (step === 'certify') await storeCertificate(row);
    if (sec(row.get('ApprovalUntil')) - MIN_STEP_S < nowSec()) return finishRow(row, 'expired');
    return await nextStep(row);
  } catch (e) {
    if (e.transient) {
      log('retry', { docId: row.get('DocId'), step, error: e.message });
      return result(row);
    }
    log('failed', { docId: row.get('DocId'), step, error: e.message });
    return finishRow(row, 'error', { message: e.userMessage || FAILED });
  }
}

// --- certificates (bs_PhoneSignCert) -------------------------------------------------------

// The phone's root for its root key, or its signing certificate for its
// document key from that root, if it lasts past `minEnd`.
function findCert(kind, row, minEnd, root) {
  const q = new Parse.Query(CERT_CLASS);
  q.equalTo('vlad', row.get('vlad'));
  q.equalTo('Kind', kind);
  q.equalTo('PublicKey', row.get(kind === 'root' ? 'RootKey' : 'DocKey'));
  q.greaterThan('NotAfter', new Date(minEnd * 1000));
  if (root) q.equalTo('IssuerSerial', root.get('Serial'));
  q.descending('NotAfter');
  return q.first({ useMasterKey: true });
}

async function nextStep(row) {
  const end = nowSec() + RENEW_S;
  const root = await findCert('root', row, end);
  if (!root) return certify(row, 'root');
  const leaf = await findCert('leaf', row, end, root);
  if (!leaf) return certify(row, 'leaf', root);
  return prepare(row, root, leaf);
}

// Ask the phone's root key to sign a certificate's TBS: its root (ten years)
// or the signing certificate the root issues (a year, within the root's).
async function certify(row, purpose, root) {
  const serial = crypto.randomBytes(16);
  // Positive, and no leading zero byte (DER INTEGER).
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const now = nowSec();
  const vlad = b64(Buffer.from(row.get('vlad'), 'hex'));
  let inputs;
  if (purpose === 'root') {
    inputs = {
      root_key: row.get('RootKey'),
      vlad,
      signer_name: row.get('SignerName'),
      serial: b64(serial),
      not_before: now - BACKDATE_S,
      not_after: now - BACKDATE_S + ROOT_S,
    };
  } else {
    const notBefore = Math.max(now - BACKDATE_S, sec(root.get('NotBefore')));
    inputs = {
      doc_key: row.get('DocKey'),
      vlad,
      common_name: row.get('SignerName'),
      serial: b64(serial),
      not_before: notBefore,
      not_after: Math.min(notBefore + LEAF_S, sec(root.get('NotAfter'))),
      root: root.get('Certificate'),
      root_key: row.get('RootKey'),
    };
  }
  const { tbs } = await service(`/v1/phone/${purpose}/tbs`, inputs);
  if (typeof tbs !== 'string' || !tbs) throw new Error(`/v1/phone/${purpose}/tbs: no tbs`);
  row.set('Purpose', purpose);
  row.set('CertifyInputs', inputs);
  row.set('CertifyIssuer', root ? root.get('Serial') : null);
  row.unset('CertifySignature');
  return continueWith(row, 'certify', { tbs, purpose });
}

// The certificate the phone just signed, kept for every later signing.
async function storeCertificate(row) {
  const purpose = row.get('Purpose');
  const inputs = row.get('CertifyInputs');
  const serial = hex(unb64(inputs.serial));
  const { certificate } = await service(`/v1/phone/${purpose}/assemble`, {
    ...inputs,
    signature: row.get('CertifySignature'),
  });
  if (typeof certificate !== 'string' || !certificate) {
    throw new Error(`/v1/phone/${purpose}/assemble: no certificate`);
  }
  // A retried step assembles the same certificate again.
  const exists = await new Parse.Query(CERT_CLASS)
    .equalTo('Kind', purpose)
    .equalTo('Serial', serial)
    .first({ useMasterKey: true });
  if (exists) return;
  const cert = new Parse.Object(CERT_CLASS);
  cert.set('vlad', row.get('vlad'));
  cert.set('Kind', purpose);
  cert.set('PublicKey', purpose === 'root' ? inputs.root_key : inputs.doc_key);
  cert.set('RootKey', row.get('RootKey'));
  if (purpose === 'leaf') cert.set('IssuerSerial', row.get('CertifyIssuer'));
  cert.set('Certificate', certificate);
  cert.set('Serial', serial);
  cert.set('NotBefore', new Date(inputs.not_before * 1000));
  cert.set('NotAfter', new Date(inputs.not_after * 1000));
  cert.setACL(new Parse.ACL());
  await cert.save(null, { useMasterKey: true });
  log('certified', { vlad: row.get('vlad').slice(0, 16), purpose, serial });
}

// --- prepare, sign, complete ------------------------------------------------------------

// What /v1/phone/pades/{prepare,complete} take: complete rebuilds the prepared
// PDF from the same inputs.
const pdfInputs = (row, base) => ({
  base: b64(base),
  field_name: row.get('FieldName'),
  png: row.get('Image'),
  caption: row.get('Caption'),
  certificate: row.get('Certificate'),
  root: row.get('Root'),
  doc_key: row.get('DocKey'),
  signing_time: row.get('SigningTime'),
});

async function prepare(row, root, leaf) {
  const base = await readStored(row.get('BaseUrl'), row.get('BaseSha256'));
  row.set('Certificate', leaf.get('Certificate'));
  row.set('Root', root.get('Certificate'));
  row.set('SigningTime', nowSec());
  const p = await service('/v1/phone/pades/prepare', pdfInputs(row, base), 120000);
  const prepared = unb64(p.pdf);
  const preparedSha256 = sha256(prepared).toString('hex');
  if (!extendsPdf(base, prepared) || p.prepared_sha256 !== preparedSha256) {
    throw new Error('prepare: not the base with the signature appended');
  }
  const url = await storePdf(`phone_prepared_${row.get('DocId')}.pdf`, prepared);
  row.set('PreparedUrl', url);
  row.set('PreparedSha256', preparedSha256);
  row.set('PreparedLen', prepared.length);
  row.set('SignedAttributes', p.signed_attributes);
  try {
    return await continueWith(row, 'sign', {
      prepared_sha256: preparedSha256,
      prepared_len: prepared.length,
      certificate: row.get('Certificate'),
      root: row.get('Root'),
    });
  } catch (e) {
    // Not saved: the next poll prepares again. (Once saved, finishRow
    // deletes it.)
    if (e.transient) await deleteUploadedFile(url);
    throw e;
  }
}

// The phone signed: embed its signature and commit the PDF like a desktop
// signature, append-only.
async function complete(row) {
  const approveReqId = row.get('ApproveReqId');
  const committed = d => (d?.get('VladSignatures') || []).some(s => s?.reqId === approveReqId);
  const base = await readStored(row.get('BaseUrl'), row.get('BaseSha256'));
  const out = await service(
    '/v1/phone/pades/complete',
    {
      ...pdfInputs(row, base),
      prepared_sha256: row.get('PreparedSha256'),
      signature: row.get('Signature'),
    },
    120000
  );
  const signed = unb64(out.pdf);
  if (!extendsPdf(base, signed)) throw new Error('complete: rewrote the base');
  const appended = appendedSignatureCoveringFile(base, signed);
  if (!appended) throw new Error('complete: no signature covering the file');

  const doc = await loadForSigning(row.get('DocId')).catch(() => null);
  if (!doc) throw userError('This document was deleted.');
  const fileSha256 = sha256(signed).toString('hex');
  const done = async () => {
    row.set('SignedSha256', fileSha256);
    row.set('SignedAt', new Date());
    log('signed', { vlad: row.get('vlad').slice(0, 16), docId: doc.id, fileSha256 });
    return finishRow(row, 'signed');
  };
  // A retry after a commit that went through.
  if (committed(doc)) return done();
  const why = cannotSign(doc, row.get('UserId').id);
  if (why) throw userError(why);
  // The last point a cancel can take effect.
  if (await cancelRequested(row)) return cancelled(row);

  const vlad = row.get('vlad');
  const _resDoc = doc.toJSON();
  const self = row.get('SignerClass') === 'contracts_Users';
  const signUser = self
    ? _resDoc.ExtUserPtr
    : (_resDoc.Signers || []).find(x => x.objectId === row.get('SignerId'));
  if (!signUser) throw userError("You can't sign this document.");
  const tenant = _resDoc?.ExtUserPtr?.TenantId;
  const entry = {
    vlad,
    signerId: row.get('SignerId'),
    fileSha256,
    baseSha256: row.get('BaseSha256'),
    byteRange: appended.byteRange,
    reqId: approveReqId,
    signedAt: new Date().toISOString(),
    signedWith: 'BetterID phone',
  };
  let res;
  try {
    res = await finishSigning({
      docId: doc.id,
      _resDoc,
      signUser,
      className: row.get('SignerClass'),
      pdfBuffer: signed,
      userIP: row.get('IpAddress') || '',
      isCustomMail: !!(tenant?.CompletionBody && tenant?.CompletionSubject),
      publicUrl: row.get('PublicUrl'),
      // A document you sign yourself completes here, so the seal is appended
      // in this same call.
      appendOnly: true,
      baseRevision: row.get('BaseRevision'),
      auditExtra: { Vlad: vlad, SignedWith: 'BetterID phone', SignedSha256: fileSha256 },
      docExtra: {
        VladSignatures: { __op: 'Add', objects: [entry] },
        PhoneSignLockId: { __op: 'Delete' },
        PhoneSignLockUntil: { __op: 'Delete' },
      },
      phoneSignLock: approveReqId,
    });
  } catch (e) {
    const now = await loadForSigning(doc.id).catch(() => null);
    if (committed(now)) return done();
    if (e?.stale || e?.message === PHONE_LOCKED_MESSAGE) {
      throw userError('The document changed while you were signing. Reload it and sign again.');
    }
    throw transient(`finishSigning: ${e?.message}`);
  }
  // finishSigning answers nothing when the upload failed: then nothing was
  // committed, and the next poll tries again with the same inputs.
  if (res?.status !== 'success') {
    const now = await loadForSigning(doc.id).catch(() => null);
    if (committed(now)) return done();
    throw transient('finishSigning: nothing was stored');
  }
  return done();
}

// --- the end of an attempt ---------------------------------------------------------------

// Settle the attempt: the one-time key and the PDFs it served are no longer
// needed, and the document is free again. The statements stay.
async function finishRow(row, status, { reason, message } = {}) {
  row.set('Status', status);
  if (reason) row.set('Reason', reason);
  if (message) row.set('Message', message);
  row.set('FinishedAt', new Date());
  row.unset('EphSecret');
  row.unset('LeaseUntil');
  row.unset('LeaseId');
  await row.save(null, { useMasterKey: true });
  await releaseLock(row.get('DocId'), row.get('ApproveReqId'));
  await Promise.all(
    [row.get('BaseUrl'), row.get('PreparedUrl')].filter(Boolean).map(deleteUploadedFile)
  );
  if (status !== 'signed') {
    log(status, { vlad: row.get('vlad')?.slice(0, 16), docId: row.get('DocId'), reason });
  }
  return result(row);
}

// Best-effort: expire attempts nobody polled to the end, shortly after their
// hold ran out. Never blocks or fails the caller.
function sweep() {
  new Parse.Query(CLASS)
    .containedIn('Status', LIVE)
    .lessThan('LockUntil', new Date(Date.now() - SWEEP_AFTER_MS))
    .limit(20)
    .find({ useMasterKey: true })
    .then(rows => Promise.all(rows.map(r => withClaim(r, () => finishRow(r, 'expired')))))
    .catch(() => {});
}

// --- GET /api/v1/phone-sign/:reqId/file ----------------------------------------------------

// The phone's download: the base for an approve request's reqId, the prepared
// PDF for a sign request's, while the attempt runs, and only to the identity
// it was sent to. X-Content-SHA256 is the hash the request names.
export async function phoneSignFile(req, res) {
  const notFound = () => apiError(res, 404, 'not_found', 'No such request.');
  const id = String(req.params.reqId || '');
  if (!REQ_ID_RE.test(id)) return notFound();
  const reqIdHex = Buffer.from(id, 'base64url').toString('hex');
  const row = await Parse.Query.or(
    new Parse.Query(CLASS).equalTo('ApproveReqId', reqIdHex),
    new Parse.Query(CLASS).equalTo('StepReqId', reqIdHex)
  ).first({ useMasterKey: true });
  if (!row || row.get('vlad') !== req.bs.vlad || !LIVE.includes(row.get('Status'))) {
    return notFound();
  }
  let url;
  let sha;
  if (row.get('ApproveReqId') === reqIdHex) {
    url = row.get('BaseUrl');
    sha = row.get('BaseSha256');
  } else if (row.get('Step') === 'sign' && row.get('PreparedUrl')) {
    url = row.get('PreparedUrl');
    sha = row.get('PreparedSha256');
  } else {
    return notFound();
  }
  let bytes;
  try {
    bytes = await readStored(url, sha);
  } catch (e) {
    console.log('bsphonesignpdf: file read failed', row.get('DocId'), e?.message);
    return apiError(res, 502, 'file_unavailable', "Couldn't read the document's file.");
  }
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="document.pdf"',
    'Cache-Control': 'no-store',
    'X-Content-SHA256': sha,
  });
  return res.send(bytes);
}
