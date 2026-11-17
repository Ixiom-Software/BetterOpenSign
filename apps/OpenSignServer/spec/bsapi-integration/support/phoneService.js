// A stand-in for bs-service-identity's Sign on phone v2 routes (/v1/phone/*),
// for cloud/parsefunction/bsPhoneSignPdf.js. Checks the bearer token and
// answers like the service, with stand-in bytes:
//   - a request body is the canonical CBOR of the request in camelCase (the
//     real service encodes bs_docsign's PdfRequest);
//   - an answer is opened with docsign's own envelope code, and its
//     statement and P-256 signatures checked as the contract says;
//   - a "certificate" is its TBS ‖ the root key's signature;
//   - the prepared PDF is the base signed by a test PKCS#12 (so the final
//     file carries a signature covering it), and complete returns it once the
//     phone's signature over signedAttrsFor(prepared) verifies.
// Specs switch it to 503 and read the calls.
import crypto from 'node:crypto';
import http from 'node:http';
import {
  encodeCbor,
  openEnvelope,
  PDF_REQUEST_CT,
  PDF_RESPONSE_CT,
} from '../../../cloud/customRoute/bsapi/relay.js';
import { decodeCbor } from '../../../cloud/customRoute/bsapi/statement.js';
import { desktopSign } from './lib.js';

export const phoneService = {
  token: 'bsapi-test-phone-token-0123456789abcdef',
  mode: 'ok', // 'ok' | '503'
  calls: [],
  p12: null,
  prepared: new Map(), // prepared sha256 hex -> PDF
  completed: null, // the last PDF complete returned
};

const sha = b => crypto.createHash('sha256').update(b).digest();
const unb64 = s => Buffer.from(String(s || ''), 'base64');
const b64 = b => Buffer.from(b).toString('base64');

// What the phone signs for a prepared PDF (it builds them itself).
export const signedAttrsFor = preparedSha256Hex =>
  Buffer.concat([Buffer.from('signed-attrs:'), Buffer.from(preparedSha256Hex, 'hex')]);

// SEC1 uncompressed P-256 <-> KeyObject.
export const rawP256 = key => {
  const j = key.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(j.x, 'base64url'),
    Buffer.from(j.y, 'base64url'),
  ]);
};
const p256 = raw =>
  crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
const verifies = (keyB64, data, sigB64) => {
  try {
    return crypto.verify('sha256', data, p256(unb64(keyB64)), unb64(sigB64));
  } catch {
    return false;
  }
};

const tbsOf = (kind, inputs) => {
  const { signature, ...rest } = inputs; // eslint-disable-line no-unused-vars
  return Buffer.concat([Buffer.from(`TBS-${kind}:`), sha(JSON.stringify(rest))]);
};

function requestBody(r) {
  const opt = (k, v) => (r[k] === undefined ? undefined : v(r[k]));
  return encodeCbor({
    v: 1,
    step: r.step,
    reqId: unb64(r.req_id),
    origin: r.origin,
    rp: r.rp,
    receiverVlad: unb64(r.receiver_vlad),
    docId: r.doc_id,
    fieldId: r.field_id,
    challenge: unb64(r.challenge),
    ephPub: unb64(r.eph_pub),
    iat: r.iat,
    exp: r.exp,
    baseSha256: Buffer.from(r.base_sha256, 'hex'),
    baseLen: r.base_len,
    approveReqId: opt('approve_req_id', unb64),
    tbs: opt('tbs', unb64),
    purpose: r.purpose,
    preparedSha256: opt('prepared_sha256', h => Buffer.from(h, 'hex')),
    preparedLen: r.prepared_len,
    certificate: opt('certificate', unb64),
    root: opt('root', unb64),
  });
}

// POST /v1/phone/answer, as the contract describes the service's checks.
function openAnswer(body) {
  const r = body.request;
  const opened = openEnvelope(Buffer.from(body.env, 'base64url'), {
    ct: PDF_RESPONSE_CT,
    recipientSecret: unb64(body.eph_secret),
    reqId: unb64(r.req_id),
    now: body.now,
  });
  const a = decodeCbor(opened.plaintext);
  if (!Buffer.from(a.get('reqId')).equals(unb64(r.req_id))) throw new Error('reqId');
  const result = a.get('result');
  const out = { from: b64(opened.from), result };
  if (a.get('reason')) out.reason = a.get('reason');
  if (result !== 'ok') return out;
  const statement = Buffer.from(a.get('statement'));
  const s = decodeCbor(statement);
  const same = (k, v) => Buffer.from(s.get(k)).equals(v);
  if (
    s.get('step') !== r.step ||
    s.get('docId') !== r.doc_id ||
    s.get('fieldId') !== r.field_id ||
    !same('reqId', unb64(r.req_id)) ||
    !same('challenge', unb64(r.challenge))
  ) {
    throw new Error('statement does not name the request');
  }
  out.statement = b64(statement);
  out.vlad_sig = b64(a.get('vladSig'));
  out.vlad = b64(s.get('vlad'));
  if (r.step === 'approve') {
    const image = Buffer.from(a.get('image'));
    if (!same('imageHash', sha(image))) throw new Error('imageHash');
    out.image = b64(image);
    out.doc_key = b64(a.get('docKey'));
    out.root_key = b64(a.get('rootKey'));
    return out;
  }
  out.signature = b64(a.get('signature'));
  const signed = r.step === 'certify' ? unb64(r.tbs) : unb64(body.signed_attributes);
  const key = r.step === 'certify' ? body.root_key : body.doc_key;
  if (!verifies(key, signed, out.signature)) throw new Error('signature');
  return out;
}

const routes = {
  '/v1/phone/request': async b => ({ ct: PDF_REQUEST_CT, body: b64(requestBody(b)) }),
  '/v1/phone/answer': async b => openAnswer(b),
  '/v1/phone/root/tbs': async b => ({ tbs: b64(tbsOf('root', b)) }),
  '/v1/phone/leaf/tbs': async b => ({ tbs: b64(tbsOf('leaf', b)) }),
  '/v1/phone/root/assemble': async b => {
    const tbs = tbsOf('root', b);
    if (!verifies(b.root_key, tbs, b.signature)) throw new Error('root signature');
    return { certificate: b64(Buffer.concat([tbs, unb64(b.signature)])) };
  },
  '/v1/phone/leaf/assemble': async b => {
    const tbs = tbsOf('leaf', b);
    if (!verifies(b.root_key, tbs, b.signature)) throw new Error('leaf signature');
    return { certificate: b64(Buffer.concat([tbs, unb64(b.signature)])) };
  },
  // The real route re-saves PDFs with compressed cross-references; the
  // fixtures here already use a classic table, so it hands them back.
  '/v1/phone/pades/base': async b => ({
    pdf: b.pdf,
    base_sha256: crypto.createHash('sha256').update(Buffer.from(b.pdf, 'base64')).digest('hex'),
  }),
  '/v1/phone/pades/prepare': async b => {
    const pdf = await desktopSign(unb64(b.base), 'phone', phoneService.p12);
    const h = sha(pdf).toString('hex');
    phoneService.prepared.set(h, pdf);
    return { pdf: b64(pdf), signed_attributes: b64(signedAttrsFor(h)), prepared_sha256: h };
  },
  '/v1/phone/pades/complete': async b => {
    const pdf = phoneService.prepared.get(b.prepared_sha256);
    if (!pdf) throw new Error('no longer matches');
    if (!verifies(b.doc_key, signedAttrsFor(b.prepared_sha256), b.signature)) {
      throw new Error('signature');
    }
    phoneService.completed = pdf;
    return { pdf: b64(pdf) };
  },
};

export function startPhoneService() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const route = routes[new URL(req.url, 'http://x').pathname];
      if (req.method !== 'POST' || !route) return send(404, { code: 'not_found' });
      if (req.headers.authorization !== `Bearer ${phoneService.token}`) {
        return send(401, { code: 'unauthorized', error: 'missing or wrong bearer token' });
      }
      if (phoneService.mode === '503') return send(503, { code: 'unavailable', error: 'down' });
      const body = JSON.parse(Buffer.concat(chunks).toString());
      phoneService.calls.push({ path: req.url, body });
      try {
        return send(200, await route(body));
      } catch (e) {
        return send(422, { code: 'bad_request', error: e.message });
      }
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        stop: () => new Promise(r => server.close(r)),
      })
    )
  );
}
