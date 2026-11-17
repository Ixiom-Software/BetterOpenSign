// Sign on phone v2 (cloud/parsefunction/bsPhoneSignPdf.js): the phone's own
// key signs the PDF. bs-service-identity (support/phoneService.js) and the
// relay (support/relay.js) are stand-ins, and the spec plays the phone.
import crypto from 'node:crypto';
import {
  API,
  MASTER,
  PARSE,
  PUBLIC,
  browserPdf,
  certificateOf,
  docRow,
  docsignStatement,
  identity,
  link,
  mkContact,
  mkDoc,
  mkOwner,
  mkUser,
  req,
  sha,
  signPdf,
  tag,
  tbs,
  tokenFor,
  upload,
  verifyAll,
} from './support/lib.js';
import { verifier } from './support/verifier.js';
import { relay } from './support/relay.js';
import { shared } from './support/setup.js';
import {
  phoneService,
  rawP256,
  signedAttrsFor,
  startPhoneService,
} from './support/phoneService.js';
import { recordBsIdSession } from '../../utils/bsWebSession.js';
import { readDocumentPdf } from '../../utils/appendOnlyPdf.js';
import {
  encodeCbor,
  hpkeSealer,
  HPKE_INFO_PREFIX,
  PDF_REQUEST_CT,
  PDF_RESPONSE_CT,
  RESPONSE_ENV_DOMAIN,
  ed25519FromSeed,
} from '../../cloud/customRoute/bsapi/relay.js';
import { decodeCbor } from '../../cloud/customRoute/bsapi/statement.js';
import { PHONE_LOCKED_MESSAGE } from '../../cloud/parsefunction/pdf/PDF.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const PDF_CT = 'application/vnd.bettersign.docsign-pdf+cbor';
const nowSec = () => Math.floor(Date.now() / 1000);

async function bsSession(id, userId) {
  const r = await req('POST', `${PARSE}/loginAs`, { headers: MASTER, body: { userId } });
  await recordBsIdSession(r.json.sessionToken, id.vlad, userId);
  return r.json.sessionToken;
}

const call = (fn, token, params) =>
  req('POST', `${PARSE}/functions/${fn}`, {
    headers: { ...PUBLIC, 'X-Parse-Session-Token': token },
    body: params,
  });

const envOf = rec => decodeCbor(Buffer.from(rec.env, 'base64url'));
const requestBody = rec => decodeCbor(envOf(rec).get('body'));

// A phone: the identity's document key and root key (P-256).
function phone() {
  const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { doc: ec(), root: ec() };
}

// The phone's answer to the relay's last request (or `rec`). `over` changes
// the statement; `signer` signs it in place of the identity.
function answer(id, ph, { rec = relay.last, result = 'ok', reason, over = {}, signer = id } = {}) {
  const r = requestBody(rec);
  const step = r.get('step');
  const reqId = Buffer.from(r.get('reqId'));
  let fields = {};
  let st = {};
  if (result === 'ok' && step === 'approve') {
    fields = { image: PNG, docKey: rawP256(ph.doc.publicKey), rootKey: rawP256(ph.root.publicKey) };
    st = { imageHash: sha(PNG), docKey: fields.docKey, rootKey: fields.rootKey };
  } else if (result === 'ok' && step === 'certify') {
    const t = Buffer.from(r.get('tbs'));
    fields = { signature: crypto.sign('sha256', t, ph.root.privateKey) };
    st = { tbsSha256: sha(t) };
  } else if (result === 'ok') {
    const attrs = signedAttrsFor(Buffer.from(r.get('preparedSha256')).toString('hex'));
    fields = { signature: crypto.sign('sha256', attrs, ph.doc.privateKey) };
    st = { preparedSha256: Buffer.from(r.get('preparedSha256')), signedAttrsSha256: sha(attrs) };
  }
  const statement = encodeCbor({
    v: 1,
    type: 'bs-docsign-pdf',
    step,
    vlad: Buffer.from(id.vlad, 'hex'),
    origin: r.get('origin'),
    rp: r.get('rp'),
    docId: r.get('docId'),
    fieldId: r.get('fieldId'),
    challenge: r.get('challenge'),
    reqId,
    approveReqId: r.get('approveReqId'),
    baseSha256: r.get('baseSha256'),
    iat: nowSec(),
    ...st,
    ...over,
  });
  const message = tbs('bs-docsign-pdf', id.vlad, statement, {
    contentType: PDF_CT,
    receiverVlad: Buffer.from(r.get('receiverVlad')).toString('hex'),
  });
  const body =
    result === 'ok'
      ? {
          v: 1,
          reqId,
          result,
          statement,
          vladSig: crypto.sign(null, message, signer.privateKey),
          ...fields,
        }
      : { v: 1, reqId, result, reason };

  const idSign = ed25519FromSeed(crypto.randomBytes(32));
  const now = nowSec();
  const sealer = hpkeSealer(
    Buffer.from(r.get('ephPub')),
    Buffer.from(HPKE_INFO_PREFIX + PDF_RESPONSE_CT)
  );
  const header = {
    v: 1,
    ct: PDF_RESPONSE_CT,
    to: sha(reqId),
    from: idSign.pub,
    reqId,
    iat: now,
    exp: now + 60,
    enc: sealer.enc,
  };
  const headerCbor = encodeCbor(header);
  const ciphertext = sealer.seal(headerCbor, encodeCbor(body));
  const sig = crypto.sign(
    null,
    Buffer.concat([Buffer.from(RESPONSE_ENV_DOMAIN), headerCbor, sha(ciphertext)]),
    idSign.privateKey
  );
  relay.respond(rec.reqId, encodeCbor({ header, ciphertext, sig }).toString('base64url'));
}

const fileOf = (auth, reqId) =>
  req('GET', `${API}/api/v1/phone-sign/${reqId}/file`, { headers: auth });

describe('sign on phone v2 (PAdES)', () => {
  let stopService;
  let owner;
  let bob;
  let bobId;
  let bobC;
  let daveC;
  let token;
  let B;
  let bobPhone;

  beforeAll(async () => {
    phoneService.p12 = shared.p12;
    const s = await startPhoneService();
    stopService = s.stop;
    process.env.BS_SERVICE_IDENTITY_URL = s.url;
    process.env.BS_SERVICE_IDENTITY_TOKEN = phoneService.token;
    owner = await mkOwner(`owner-${tag()}@example.com`);
    bob = identity();
    verifier.register(bob);
    bobId = await mkUser(`bob-${tag()}@example.com`);
    await link(bob, bobId);
    bobC = await mkContact(owner.userId, 'Bob', `bob-${tag()}@example.com`, bobId);
    daveC = await mkContact(owner.userId, 'Dave', `dave-${tag()}@example.com`);
    token = await bsSession(bob, bobId);
    B = await tokenFor(bob);
    bobPhone = phone();
  });

  afterAll(async () => {
    delete process.env.BS_SERVICE_IDENTITY_URL;
    delete process.env.BS_SERVICE_IDENTITY_TOKEN;
    await stopService();
  });

  beforeEach(() => {
    verifier.mode = 'ok';
    relay.mode = 'ok';
    relay.onRequest = null;
    relay.rateLimitNext = 0;
    phoneService.mode = 'ok';
  });

  const currentFile = async docId => {
    const d = await docRow(docId);
    return readDocumentPdf(d.SignedUrl || d.URL);
  };
  // The signer's revision as the browser builds it (appended).
  const baseFor = async docId => browserPdf(await currentFile(docId), true);
  const start = async (docId, base, params = {}, t = token) =>
    call('bsphonesignpdfstart', t, {
      docId,
      fieldName: 'bs-phone-1234',
      base: base.toString('base64'),
      ...params,
    });
  const poll = (reqId, t = token) => call('bsphonesignpdfpoll', t, { reqId });
  const status = async (reqId, t) => (await poll(reqId, t)).json.result;

  // Approve, certify as asked, and sign; returns the poll results in order.
  async function signOnPhone(id, ph, reqId, t = token) {
    const seen = [];
    for (let i = 0; i < 5; i++) {
      answer(id, ph);
      const s = await status(reqId, t);
      seen.push(s.status);
      if (s.status !== 'approved' && s.status !== 'signing') break;
    }
    return seen;
  }

  it('signs the PDF with the phone key, certifying the keys the first time', async () => {
    const docId = await mkDoc(owner, [bobC, daveC]);
    const base = await baseFor(docId);
    const s = await start(docId, base);
    expect(s.status).toBe(200);
    const { reqId, expiresAt } = s.json.result;
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 300 * 1000);

    // The approve request: addressed to the identity, our content type, naming the base.
    const rec = relay.last;
    expect(rec.reqId).toBe(reqId);
    // Approve needs the person: an ordinary request, so the phone rings.
    expect(rec.quiet).toBeUndefined();
    expect(Buffer.from(rec.to, 'base64url').equals(sha(Buffer.from(bob.vlad, 'hex')))).toBeTrue();
    expect(envOf(rec).get('header').get('ct')).toBe(PDF_REQUEST_CT);
    const r = requestBody(rec);
    expect(r.get('step')).toBe('approve');
    expect(r.get('fieldId')).toBe('bs-phone-1234');
    expect(Buffer.from(r.get('baseSha256')).equals(sha(base))).toBeTrue();

    // The phone downloads the base; no one else can.
    const f = await fileOf(B, reqId);
    expect(f.status).toBe(200);
    expect(f.buf.equals(base)).toBeTrue();
    expect(f.headers.get('x-content-sha256')).toBe(sha(base).toString('hex'));
    const eve = identity();
    verifier.register(eve);
    await link(eve, await mkUser(`eve-${tag()}@example.com`));
    expect((await fileOf(await tokenFor(eve), reqId)).status).toBe(404);

    expect(await status(reqId)).toEqual({ status: 'waiting' });

    // approve -> certify root -> certify leaf -> sign
    answer(bob, bobPhone);
    expect((await status(reqId)).status).toBe('approved');
    const root = requestBody(relay.last);
    expect(root.get('step')).toBe('certify');
    expect(root.get('purpose')).toBe('root');
    expect(Buffer.from(root.get('approveReqId')).toString('base64url')).toBe(reqId);
    expect(Buffer.from(root.get('challenge')).equals(Buffer.from(r.get('challenge')))).toBeTrue();
    expect(relay.last.reqId).not.toBe(reqId);
    // The app answers certify and sign without a screen: quiet requests.
    expect(relay.last.quiet).toBeTrue();

    answer(bob, bobPhone);
    expect((await status(reqId)).status).toBe('approved');
    expect(requestBody(relay.last).get('purpose')).toBe('leaf');

    answer(bob, bobPhone);
    expect((await status(reqId)).status).toBe('signing');
    const signReq = relay.last;
    expect(signReq.quiet).toBeTrue();
    const sr = requestBody(signReq);
    expect(sr.get('step')).toBe('sign');
    expect(sr.get('certificate')).toBeTruthy();
    expect(sr.get('root')).toBeTruthy();

    // The prepared PDF for the sign request's id.
    const p = await fileOf(B, signReq.reqId);
    expect(p.status).toBe(200);
    expect(p.headers.get('x-content-sha256')).toBe(
      Buffer.from(sr.get('preparedSha256')).toString('hex')
    );
    expect(p.buf.subarray(0, base.length).equals(base)).toBeTrue();

    answer(bob, bobPhone);
    expect(await status(reqId)).toEqual({ status: 'signed' });
    expect(await status(reqId)).toEqual({ status: 'signed' });
    expect((await fileOf(B, reqId)).status).toBe(404);

    // Committed like a desktop signature, and the document is free again.
    const d = await docRow(docId);
    expect(d.VladSignatures.length).toBe(1);
    expect(d.VladSignatures[0].vlad).toBe(bob.vlad);
    expect(d.VladSignatures[0].signerId).toBe(bobC);
    expect(d.VladSignatures[0].signedWith).toBe('BetterSign phone');
    const audit = d.AuditTrail.find(a => a.UserPtr.objectId === bobC);
    expect(audit.Vlad).toBe(bob.vlad);
    expect(audit.SignedWith).toBe('BetterSign phone');
    expect(d.PhoneSignLockId).toBeUndefined();
    expect(d.IsCompleted).toBeFalse();
    const signed = await currentFile(docId);
    expect(signed.equals(phoneService.completed)).toBeTrue();

    // Dave signs online: appended, and every signature still verifies.
    const daves = await browserPdf(signed, true);
    expect((await signPdf(docId, daveC, daves)).status).toBe(200);
    expect(await certificateOf(docId)).toBeTruthy();
    const final = await currentFile(docId);
    expect(final.subarray(0, signed.length).equals(signed)).toBeTrue();
    const sigs = verifyAll(final);
    expect(sigs.length).toBe(2);
    expect(sigs.every(x => x.ok)).toBeTrue();
  });

  it('waits out the relay\'s one request a second instead of failing', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    const { reqId } = s.json.result;
    // The next request after the approval is refused twice, then accepted.
    relay.rateLimitNext = 2;
    answer(bob, bobPhone);
    expect((await status(reqId)).status).toBe('signing');
    expect(relay.rateLimitNext).toBe(0);
    answer(bob, bobPhone);
    expect((await status(reqId)).status).toBe('signed');
  });

  it('goes straight to signing once the keys have certificates', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signing');
    expect(requestBody(relay.last).get('step')).toBe('sign');
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signed');
    // The only signer: completed and sealed, appended after the phone's signature.
    const d = await docRow(docId);
    expect(d.IsCompleted).toBeTrue();
    expect(await certificateOf(docId)).toBeTruthy();
    const final = await currentFile(docId);
    expect(final.subarray(0, phoneService.completed.length).equals(phoneService.completed)).toBe(
      true
    );
    expect(verifyAll(final).every(x => x.ok)).toBeTrue();
  });

  it('renews a signing certificate that ends within 30 days', async () => {
    const where = encodeURIComponent(JSON.stringify({ vlad: bob.vlad, Kind: 'leaf' }));
    const leaves = await req('GET', `${PARSE}/classes/bs_PhoneSignCert?where=${where}`, {
      headers: MASTER,
    });
    expect(leaves.json.results.length).toBe(1);
    await req('PUT', `${PARSE}/classes/bs_PhoneSignCert/${leaves.json.results[0].objectId}`, {
      headers: MASTER,
      body: { NotAfter: { __type: 'Date', iso: new Date(Date.now() + 10 * 864e5).toISOString() } },
    });
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('approved');
    expect(requestBody(relay.last).get('purpose')).toBe('leaf');
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signing');
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signed');
  });

  it('lets the owner sign a document they sign themselves, sealed in the same step', async () => {
    const carol = identity();
    verifier.register(carol);
    const carolOwner = await mkOwner(`carol-${tag()}@example.com`);
    await link(carol, carolOwner.userId);
    const carolToken = await bsSession(carol, carolOwner.userId);
    const docId = await mkDoc(carolOwner, [], { extra: { IsSignyourself: true } });
    const s = await start(docId, await baseFor(docId), {}, carolToken);
    expect(s.status).toBe(200);
    const seen = await signOnPhone(carol, phone(), s.json.result.reqId, carolToken);
    expect(seen).toEqual(['approved', 'approved', 'signing', 'signed']);

    const d = await docRow(docId);
    expect(d.IsCompleted).toBeTrue();
    expect(d.Seal).toBeTruthy();
    expect(d.VladSignatures[0].vlad).toBe(carol.vlad);
    expect(d.AuditTrail[0].SignedWith).toBe('BetterSign phone');
    expect(await certificateOf(docId)).toBeTruthy();
    const final = await currentFile(docId);
    // The seal is appended: the phone's signature still covers its bytes.
    expect(final.subarray(0, phoneService.completed.length).equals(phoneService.completed)).toBe(
      true
    );
    const sigs = verifyAll(final);
    expect(sigs.length).toBe(2);
    expect(sigs.every(x => x.ok)).toBeTrue();
  });

  it('holds the document against other signers until the attempt ends', async () => {
    const erin = identity();
    verifier.register(erin);
    const erinId = await mkUser(`erin-${tag()}@example.com`);
    await link(erin, erinId);
    const erinC = await mkContact(owner.userId, 'Erin', `erin-${tag()}@example.com`, erinId);
    const docId = await mkDoc(owner, [bobC, daveC, erinC]);
    const s = await start(docId, await baseFor(docId));
    expect(s.status).toBe(200);
    expect((await docRow(docId)).PhoneSignLockId).toBeTruthy();

    // Online, on the desktop, and on another phone.
    const online = await signPdf(docId, daveC, await browserPdf(await currentFile(docId), false));
    expect(online.json.error).toBe(PHONE_LOCKED_MESSAGE);
    const current = await currentFile(docId);
    const up = await upload(
      await tokenFor(erin),
      docId,
      current,
      docsignStatement(erin, docId, current, current)
    );
    expect(up.status).toBe(409);
    expect(up.json.error).toBe('locked');
    const other = await start(docId, await baseFor(docId), {}, await bsSession(erin, erinId));
    expect(other.json.code).toBe(119);
    expect(other.json.error).toBe(PHONE_LOCKED_MESSAGE);

    // Declined on the phone: free again.
    answer(bob, bobPhone, { result: 'denied', reason: 'user' });
    const p = await status(s.json.result.reqId);
    expect(p.status).toBe('denied');
    expect(p.reason).toBe('user');
    expect(p.message).toBeTruthy();
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
    const again = await signPdf(docId, daveC, await browserPdf(await currentFile(docId), false));
    expect(again.status).toBe(200);
  });

  it('frees the document when the signer cancels', async () => {
    const docId = await mkDoc(owner, [bobC, daveC]);
    const s = await start(docId, await baseFor(docId));
    const c = await call('bsphonesignpdfcancel', token, { reqId: s.json.result.reqId });
    expect(c.json.result.status).toBe('cancelled');
    expect((await status(s.json.result.reqId)).status).toBe('cancelled');
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
    expect((await fileOf(B, s.json.result.reqId)).status).toBe(404);
  });

  it('lets the same signer start again, ending the earlier attempt', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const first = await start(docId, await baseFor(docId));
    const second = await start(docId, await baseFor(docId));
    expect(second.status).toBe(200);
    const p = await status(first.json.result.reqId);
    expect(p.status).toBe('error');
    expect(p.reason).toBe('replaced');
  });

  it("refuses a revision that isn't the current file with bytes appended", async () => {
    const docId = await mkDoc(owner, [bobC]);
    const rewritten = await browserPdf(await currentFile(docId), false);
    const s = await start(docId, rewritten);
    expect(s.json.code).toBe(141);
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
  });

  it('refuses a malformed field name', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId), { fieldName: 'bs-phone-1.2' });
    expect(s.json.code).toBe(102);
  });

  it("ends an attempt whose answer doesn't verify", async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone, { signer: identity() });
    const p = await status(s.json.result.reqId);
    expect(p.status).toBe('error');
    expect(p.message).toMatch(/couldn't be verified/);
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
  });

  it('ends an attempt whose statement names another field', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone, { over: { fieldId: 'bs-phone-other' } });
    expect((await status(s.json.result.reqId)).status).toBe('error');
  });

  it("reports the phone's refusal of what it was asked to sign", async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signing');
    answer(bob, bobPhone, { result: 'error', reason: 'mismatch' });
    const p = await status(s.json.result.reqId);
    expect(p.status).toBe('error');
    expect(p.reason).toBe('mismatch');
    expect(p.message).toMatch(/didn't match/);
  });

  it('keeps waiting while the service or the verifier is down', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    answer(bob, bobPhone);
    phoneService.mode = '503';
    expect((await status(s.json.result.reqId)).status).toBe('waiting');
    phoneService.mode = 'ok';
    verifier.mode = '503';
    expect((await status(s.json.result.reqId)).status).toBe('waiting');
    verifier.mode = 'ok';
    expect((await status(s.json.result.reqId)).status).toBe('signing');
    answer(bob, bobPhone);
    expect((await status(s.json.result.reqId)).status).toBe('signed');
  });

  it('reports a request the relay expired, and frees the document', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const s = await start(docId, await baseFor(docId));
    relay.expire(relay.last.reqId);
    expect((await status(s.json.result.reqId)).status).toBe('expired');
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
  });

  it("says so when the app hasn't connected, and leaves the document free", async () => {
    const docId = await mkDoc(owner, [bobC]);
    relay.mode = 'unknown';
    const s = await start(docId, await baseFor(docId));
    expect(s.json.code).toBe(101);
    expect(s.json.error).toMatch(/Open the app/);
    expect((await docRow(docId)).PhoneSignLockId).toBeUndefined();
  });

  it('is only for a Sign in with BetterSign session, and only its own requests', async () => {
    const docId = await mkDoc(owner, [bobC]);
    const plain = (
      await req('POST', `${PARSE}/loginAs`, { headers: MASTER, body: { userId: bobId } })
    ).json.sessionToken;
    expect((await start(docId, await baseFor(docId), {}, plain)).json.code).toBe(119);

    const s = await start(docId, await baseFor(docId));
    const eve = identity();
    const eveId = await mkUser(`eve-${tag()}@example.com`);
    await link(eve, eveId);
    const p = await poll(s.json.result.reqId, await bsSession(eve, eveId));
    expect(p.json.code).toBe(101);
    await call('bsphonesignpdfcancel', token, { reqId: s.json.result.reqId });
  });
});
