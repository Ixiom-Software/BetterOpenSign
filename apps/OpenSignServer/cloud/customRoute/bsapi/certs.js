// Published certificates (docs/PublishedCertificates.md, repo root): the
// certificates BetterID identities signed completed documents with, and the
// CAs that issued them, so a reader can see and trust them. docsign reads them
// from the signed PDF itself, through bs-service-identity's
// POST /v1/pdf/signatures; nothing is uploaded by the apps.
//
//   signaturesForCertificate(doc)  when the completion certificate is made:
//     the final PDF's signatures for its "Digital signatures" section, and
//     their BetterID certificates stored. Best effort: null when the service
//     is unset or fails (logged), and the certificate is made without it.
//   GET /api/v1/certs/:sha256.cer          the DER (application/pkix-cert)
//   GET /api/v1/certs/:sha256              a JSON summary
//   GET /api/v1/identities/:vlad/certs     an identity's roots and leaves
//     No auth (routes before requireToken in index.js); 404 for anything not
//     stored. The web page /certs/:vladOrSha256 shows them.
//
// bs_PublishedCert (master key only), one row per certificate, the first
// sighting kept: Sha256 (unique), Der (base64), SubjectCN, IssuerCN, Serial,
// IsCA, Vlad, IssuerSha256, NotBefore, NotAfter, FirstSeenDoc, FirstSeenAt.
// Only certificates with a VLAD (from the BetterID identity extension) and
// the CAs above them in the same signature are stored, from intact signatures
// of completed documents. Vlad on a CA without one of its own is the identity
// whose certificate it was first seen issuing.
//
// The service reports what the CMS carries; nothing here decides trust. The
// chain is walked by issuer name, as the service gives no more.
//
// Env: BS_SERVICE_IDENTITY_URL / _TOKEN (as utils/seal.js); BS_API_ORIGIN
// (auth.js config()) for links to the web page; SERVER_URL for download links.

import crypto from 'node:crypto';
import axios from 'axios';
import { readDocumentPdf } from '../../../utils/appendOnlyPdf.js';
import { apiError, config } from './auth.js';

const CLASS = 'bs_PublishedCert';
// A VLAD in hex (its wire encoding): 16 to 256 bytes.
// A VLAD's wire bytes in hex. Real ones are about 400 bytes (they carry a
// small WASM check); the apps accept up to 4096 (bs_docsign MAX_VLAD).
export const VLAD_RE = /^(?:[0-9a-f]{2}){16,4096}$/;
const SERIAL_RE = /^[0-9a-f]{1,128}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DER_BYTES = 16 * 1024;
const MAX_CN = 512;
const MAX_SIGNATURES = 100;
const MAX_CHAIN = 10;
const MAX_LIST = 200;
const SERVICE_TIMEOUT_MS = 120000;
// A certificate never changes; a list grows as documents complete.
const CACHE_CERT = 'public, max-age=86400';
const CACHE_LIST = 'public, max-age=300';
const CACHE_MISS = 'public, max-age=60';
const master = { useMasterKey: true };

function log(event, fields) {
  console.log(JSON.stringify({ event: `bscerts_${event}`, ...fields }));
}

// --- links ------------------------------------------------------------------------

// The API as callers outside see it: SERVER_URL's origin, with the /api
// prefix of a deployment behind Caddy (as index.js serves files).
export function apiBase() {
  try {
    const u = new URL(process.env.SERVER_URL);
    const prefix = u.pathname.replace(/\/$/, '') === '/api/app' ? '/api' : '';
    return `${u.origin}${prefix}/api/v1`;
  } catch {
    return null;
  }
}

export const downloadUrl = sha => (apiBase() ? `${apiBase()}/certs/${sha}.cer` : null);
// The web page: an identity's page by its VLAD, or one certificate's by hash.
export const pageUrl = id => `${config().origin}/certs/${id}`;

// AB:CD:… as Acrobat shows a fingerprint.
export const fingerprint = sha => sha.toUpperCase().match(/.{2}/g).join(':');

// --- the service's answer --------------------------------------------------------

const isInt = v => Number.isSafeInteger(v);
const cleanText = (s, max) =>
  typeof s === 'string' ? s.replace(/\p{Cc}/gu, '').slice(0, max) : null;

// One CertJson (contract section D), checked; null if malformed. The hash is
// recomputed: a row's Sha256 is always its Der's.
export function parseCert(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.der !== 'string' || !B64_RE.test(c.der)) return null;
  const der = Buffer.from(c.der, 'base64');
  if (!der.length || der.length > MAX_DER_BYTES) return null;
  const sha256 = crypto.createHash('sha256').update(der).digest('hex');
  if (String(c.sha256 || '').toLowerCase() !== sha256) return null;
  const subjectCn = cleanText(c.subject_cn, MAX_CN);
  const issuerCn = cleanText(c.issuer_cn, MAX_CN);
  const serial = String(c.serial || '').toLowerCase();
  if (subjectCn === null || issuerCn === null || !SERIAL_RE.test(serial)) return null;
  if (!isInt(c.not_before) || !isInt(c.not_after) || typeof c.is_ca !== 'boolean') return null;
  // The issuing certificate in the same CMS, matched by the service on the
  // whole name (itself for a root); null when it isn't carried.
  let issuerSha256 = null;
  if (c.issuer_sha256 !== undefined && c.issuer_sha256 !== null) {
    issuerSha256 = String(c.issuer_sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(issuerSha256)) return null;
  }
  let vlad = null;
  if (c.vlad !== undefined && c.vlad !== null) {
    vlad = String(c.vlad).toLowerCase();
    if (!VLAD_RE.test(vlad)) return null;
  }
  return {
    der,
    sha256,
    subjectCn,
    issuerCn,
    serial,
    notBefore: new Date(c.not_before * 1000),
    notAfter: new Date(c.not_after * 1000),
    isCa: c.is_ca,
    vlad,
    issuerSha256,
  };
}

// The `signatures` of /v1/pdf/signatures, checked, oldest first. `signer`
// is null when the CMS doesn't carry the signer's certificate (the service
// sends null, and intact false) or it is malformed here; a malformed chain
// certificate is left out.
export function parseSignatures(list) {
  if (!Array.isArray(list)) throw new Error('no signatures list');
  const out = [];
  for (const s of list.slice(0, MAX_SIGNATURES)) {
    if (!s || !isInt(s.revision) || typeof s.intact !== 'boolean') {
      log('bad_signature', { field: cleanText(s?.field, 100) });
      continue;
    }
    const signer = parseCert(s.signer);
    if (!signer && s.signer !== null) log('bad_certificate', { field: cleanText(s.field, 100) });
    const chain = (Array.isArray(s.chain) ? s.chain.slice(0, MAX_CHAIN) : [])
      .map(parseCert)
      .filter(Boolean);
    out.push({
      field: cleanText(s.field, 200) || '',
      revision: s.revision,
      subFilter: cleanText(s.sub_filter, 100) || '',
      signingTime: isInt(s.signing_time) ? new Date(s.signing_time * 1000) : null,
      coversWholeFile: s.covers_whole_file === true,
      // The CMS digest matches the bytes it covers ("unchanged since
      // signing"); the signature value itself isn't checked.
      intact: s.intact,
      signer,
      chain,
    });
  }
  return out.sort((a, b) => a.revision - b.revision);
}

// By the service's issuer link when it sent one; by common name otherwise
// (two CAs can share a CN, so that's only a fallback).
const selfIssued = c =>
  c.issuerSha256 ? c.issuerSha256 === c.sha256 : c.subjectCn === c.issuerCn;
const issues = (up, cur) =>
  cur.issuerSha256 ? up.sha256 === cur.issuerSha256 : up.subjectCn === cur.issuerCn;

// The CAs above `cert` in its signature's chain, nearest first. Not a trust
// decision: a reader still checks the signatures.
export function issuersOf(cert, chain) {
  const out = [];
  const seen = new Set([cert.sha256]);
  let cur = cert;
  while (!selfIssued(cur) && out.length < MAX_CHAIN) {
    const up = chain.find(c => c.isCa && !seen.has(c.sha256) && issues(c, cur));
    if (!up) break;
    out.push(up);
    seen.add(up.sha256);
    cur = up;
  }
  return out;
}

// The root a signature chains to: the top CA in its chain, the signer itself
// if self-signed, or null if the chain doesn't reach one (or there is no
// signer certificate).
export function rootOf(sig) {
  if (!sig.signer) return null;
  const up = issuersOf(sig.signer, sig.chain);
  if (up.length) return up[up.length - 1];
  return selfIssued(sig.signer) ? sig.signer : null;
}

// What to publish from these signatures: every certificate with a VLAD in an
// intact signature, and the CAs above it. Map sha256 -> { cert, vlad,
// issuerSha256 }, the first signature's view of each.
export function toPublish(signatures) {
  const out = new Map();
  const add = (cert, vlad, chain) => {
    if (out.has(cert.sha256)) return;
    const issuer = issuersOf(cert, chain)[0];
    out.set(cert.sha256, { cert, vlad, issuerSha256: issuer?.sha256 || null });
  };
  for (const s of signatures) {
    if (!s.intact || !s.signer) continue;
    const all = [s.signer, ...s.chain.filter(c => c.sha256 !== s.signer.sha256)];
    for (const cert of all) {
      if (!cert.vlad) continue;
      add(cert, cert.vlad, all);
      for (const ca of issuersOf(cert, all)) add(ca, ca.vlad || cert.vlad, all);
    }
  }
  return out;
}

// What the completion certificate shows for one signature. `published`: the
// hashes stored as published (links only for those).
// A signature without a signer certificate: only what the CMS says.
export function describeSignature(sig, published) {
  if (!sig.signer) {
    return {
      certificateIncluded: false,
      signingTime: sig.signingTime,
      intact: sig.intact,
      coversWholeFile: sig.coversWholeFile,
    };
  }
  const root = rootOf(sig);
  const rootPublished = root && published.has(root.sha256);
  return {
    certificateIncluded: true,
    signerName: sig.signer.subjectCn,
    signerSha256: sig.signer.sha256,
    notBefore: sig.signer.notBefore,
    notAfter: sig.signer.notAfter,
    rootName: root ? root.subjectCn : sig.signer.issuerCn,
    rootSha256: root?.sha256 || null,
    signingTime: sig.signingTime,
    intact: sig.intact,
    coversWholeFile: sig.coversWholeFile,
    vlad: sig.signer.vlad,
    rootDownloadUrl: rootPublished ? downloadUrl(root.sha256) : null,
    // The root's own page: what the reader is asked to trust, and a short
    // link (a VLAD is about 800 hex digits).
    pageUrl: rootPublished ? pageUrl(root.sha256) : null,
  };
}

// --- bs-service-identity -----------------------------------------------------------

function serviceConfig() {
  const url = (process.env.BS_SERVICE_IDENTITY_URL || '').replace(/\/$/, '');
  const token = process.env.BS_SERVICE_IDENTITY_TOKEN || '';
  return url && token ? { url, token } : null;
}

// POST /v1/pdf/signatures. Throws on any failure.
export async function listSignatures(pdfBytes) {
  const s = serviceConfig();
  if (!s) throw new Error('BS_SERVICE_IDENTITY_URL and _TOKEN are not set');
  const res = await axios.post(
    `${s.url}/v1/pdf/signatures`,
    { pdf: Buffer.from(pdfBytes).toString('base64') },
    {
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      timeout: SERVICE_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    }
  );
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`/v1/pdf/signatures: ${res.status} ${d.code || ''} ${d.error || ''}`.trim());
  }
  return parseSignatures(d.signatures);
}

// --- bs_PublishedCert ------------------------------------------------------------------

let uniquePending = null;

// Once per process, as apiConfig.js. If the index can't be built, the lookup
// before each insert still keeps rows unique in practice.
function ensureUniqueSha() {
  uniquePending ??= Parse.Server.database.adapter
    .ensureUniqueness(CLASS, { fields: { Sha256: { type: 'String' } } }, ['Sha256'])
    .catch(e => log('not_unique', { error: e.message }));
  return uniquePending;
}

const findBySha = sha =>
  new Parse.Query(CLASS).equalTo('Sha256', sha).ascending('createdAt').first(master);

// Store one certificate unless it is already. True if this call stored it.
async function storeCert({ cert, vlad, issuerSha256 }, docId) {
  if (await findBySha(cert.sha256)) return false;
  const row = new Parse.Object(CLASS);
  row.set('Sha256', cert.sha256);
  row.set('Der', cert.der.toString('base64'));
  row.set('SubjectCN', cert.subjectCn);
  row.set('IssuerCN', cert.issuerCn);
  row.set('Serial', cert.serial);
  row.set('IsCA', cert.isCa);
  if (vlad) row.set('Vlad', vlad);
  if (issuerSha256) row.set('IssuerSha256', issuerSha256);
  row.set('NotBefore', cert.notBefore);
  row.set('NotAfter', cert.notAfter);
  row.set('FirstSeenDoc', docId);
  row.set('FirstSeenAt', new Date());
  row.setACL(new Parse.ACL());
  try {
    await row.save(null, master);
    return true;
  } catch (e) {
    if (e.code === Parse.Error.DUPLICATE_VALUE) return false;
    throw e;
  }
}

// Store what these signatures publish. Returns the hashes that are published
// (stored now or before).
export async function publishCertificates(signatures, docId) {
  await ensureUniqueSha();
  const published = new Set();
  let stored = 0;
  for (const entry of toPublish(signatures).values()) {
    // eslint-disable-next-line no-await-in-loop
    if (await storeCert(entry, docId)) stored++;
    published.add(entry.cert.sha256);
  }
  if (stored) log('stored', { docId, stored });
  return published;
}

/**
 * The completed document's signatures for its completion certificate, read
 * from its final PDF (`doc.SignedUrl`), with their BetterID certificates
 * published. Best effort: null (and logged) if the service is unset or fails.
 *
 * @param {object} doc - the completed contracts_Document (JSON)
 * @returns {Promise<object[]|null>} describeSignature() per signature
 */
export async function signaturesForCertificate(doc) {
  const docId = doc?.objectId;
  if (!serviceConfig()) {
    log('skipped', { docId, reason: 'not_configured' });
    return null;
  }
  let signatures;
  try {
    if (!doc?.SignedUrl) throw new Error('no signed file');
    signatures = await listSignatures(await readDocumentPdf(doc.SignedUrl));
  } catch (e) {
    log('list_failed', { docId, error: e.message });
    return null;
  }
  let published = new Set();
  try {
    published = await publishCertificates(signatures, docId);
  } catch (e) {
    // The section is still worth showing, without download links.
    log('store_failed', { docId, error: e.message });
  }
  return signatures.map(s => describeSignature(s, published));
}

// --- the public routes --------------------------------------------------------------

function summary(row) {
  const sha = row.get('Sha256');
  const vlad = row.get('Vlad') || null;
  return {
    sha256: sha,
    fingerprint: fingerprint(sha),
    subject_cn: row.get('SubjectCN'),
    issuer_cn: row.get('IssuerCN'),
    serial: row.get('Serial'),
    is_ca: !!row.get('IsCA'),
    vlad,
    issuer_sha256: row.get('IssuerSha256') || null,
    not_before: row.get('NotBefore')?.toISOString(),
    not_after: row.get('NotAfter')?.toISOString(),
    download_url: downloadUrl(sha),
    page_url: pageUrl(vlad || sha),
  };
}

const notFound = (res, what) => {
  res.set('Cache-Control', CACHE_MISS);
  return apiError(res, 404, 'not_found', `No such ${what}.`);
};

// GET /certs/:name, `name` = <sha256> or <sha256>.cer (lower or upper case hex).
export async function getCert(req, res) {
  const m = /^([0-9a-fA-F]{64})(\.cer)?$/.exec(req.params.name || '');
  if (!m) return apiError(res, 400, 'invalid_request', 'Expected a SHA-256 in hex.');
  const sha = m[1].toLowerCase();
  const row = await findBySha(sha);
  if (!row) return notFound(res, 'certificate');
  res.set('Cache-Control', CACHE_CERT);
  if (!m[2]) return res.json(summary(row));
  const name = (row.get('SubjectCN') || 'certificate').replace(/[^A-Za-z0-9._-]+/g, '_');
  res.set('Content-Type', 'application/pkix-cert');
  res.set(
    'Content-Disposition',
    `attachment; filename="${name.slice(0, 60)}-${sha.slice(0, 8)}.cer"`
  );
  res.set('X-Content-Type-Options', 'nosniff');
  return res.send(Buffer.from(row.get('Der'), 'base64'));
}

const newestFirst = (a, b) => b.get('NotBefore') - a.get('NotBefore');

// GET /identities/:vlad/certs: the certificates with this VLAD and the CAs
// that issued them, newest first.
export async function getIdentityCerts(req, res) {
  const vlad = String(req.params.vlad || '').toLowerCase();
  if (!VLAD_RE.test(vlad)) return apiError(res, 400, 'invalid_request', 'Expected a VLAD in hex.');
  const rows = await new Parse.Query(CLASS).equalTo('Vlad', vlad).limit(MAX_LIST).find(master);
  if (!rows.length) return notFound(res, 'identity');
  // CAs above them stored under another identity's VLAD (a shared root).
  const have = new Set(rows.map(r => r.get('Sha256')));
  let wanted = rows.map(r => r.get('IssuerSha256')).filter(s => s && !have.has(s));
  for (let depth = 0; wanted.length && depth < MAX_CHAIN; depth++) {
    // eslint-disable-next-line no-await-in-loop
    const up = await new Parse.Query(CLASS)
      .containedIn('Sha256', [...new Set(wanted)])
      .find(master);
    up.forEach(r => {
      if (!have.has(r.get('Sha256'))) rows.push(r);
      have.add(r.get('Sha256'));
    });
    wanted = up.map(r => r.get('IssuerSha256')).filter(s => s && !have.has(s));
  }
  rows.sort(newestFirst);
  res.set('Cache-Control', CACHE_LIST);
  return res.json({
    vlad,
    roots: rows.filter(r => r.get('IsCA')).map(summary),
    leaves: rows.filter(r => !r.get('IsCA')).map(summary),
  });
}
