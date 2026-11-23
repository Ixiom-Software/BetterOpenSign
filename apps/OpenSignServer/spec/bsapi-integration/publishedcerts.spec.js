// Published certificates (cloud/customRoute/bsapi/certs.js): a completed
// document's signatures, read through a stand-in for bs-service-identity's
// POST /v1/pdf/signatures, go into its completion certificate and, for
// BetterID identities, into bs_PublishedCert and the public routes.
import * as pdfLib from 'pdf-lib';
import {
  API,
  MASTER,
  PARSE,
  PUBLIC,
  browserPdf,
  certificateOf,
  docRow,
  mkContact,
  mkDoc,
  mkOwner,
  req,
  sha,
  signPdf,
  tag,
} from './support/lib.js';
import {
  certJson,
  signatureJson,
  signaturesService,
  startSignaturesService,
} from './support/signaturesService.js';
import { readDocumentPdf } from '../../utils/appendOnlyPdf.js';

// Real VLADs are about 400 bytes.
const VLAD = () =>
  '8724' + Buffer.from(tag() + tag() + tag() + tag() + tag()).toString('hex').padEnd(796, 'e9');

// Every link annotation's URI in a PDF.
async function links(bytes) {
  const pdf = await pdfLib.PDFDocument.load(bytes);
  const out = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() || 0); i++) {
      const a = annots.lookup(i, pdfLib.PDFDict);
      const uri = a
        .lookupMaybe(pdfLib.PDFName.of('A'), pdfLib.PDFDict)
        ?.get(pdfLib.PDFName.of('URI'));
      if (uri) out.push(uri.decodeText());
    }
  }
  return out;
}

const rows = async where =>
  (
    await req(
      'GET',
      `${PARSE}/classes/bs_PublishedCert?where=${encodeURIComponent(JSON.stringify(where))}`,
      { headers: MASTER }
    )
  ).json.results;

describe('published certificates', () => {
  let owner;
  let service;
  const saved = {};
  const KEYS = ['BS_SERVICE_IDENTITY_URL', 'BS_SERVICE_IDENTITY_TOKEN'];

  beforeAll(async () => {
    owner = await mkOwner(`owner-${tag()}@example.com`);
    service = await startSignaturesService();
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.BS_SERVICE_IDENTITY_URL = service.url;
    process.env.BS_SERVICE_IDENTITY_TOKEN = signaturesService.token;
  });

  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await service.stop();
  });

  beforeEach(() => {
    signaturesService.mode = 'ok';
    signaturesService.calls = [];
  });

  // A one-signer document, signed online; resolves once its completion
  // certificate is stored.
  async function complete() {
    const contact = await mkContact(owner.userId, 'Dave', `dave-${tag()}@example.com`);
    const docId = await mkDoc(owner, [contact]);
    const current = await readDocumentPdf((await docRow(docId)).SignedUrl);
    const r = await signPdf(docId, contact, await browserPdf(current, false));
    expect(r.json?.result?.status).toBe('success');
    const certificateUrl = await certificateOf(docId);
    expect(certificateUrl).toBeTruthy();
    return { docId, certificateUrl };
  }

  // Shaped like the service's answer for the owner's document (phone, desktop,
  // seal, each with a VLAD), plus a third party's and one whose CMS doesn't
  // carry the signer's certificate.
  describe('with phone, desktop, third-party, uncertified and seal signatures', () => {
    const vlad = VLAD();
    const janeVlad = VLAD();
    const sealVlad = VLAD();
    const PHONE_ROOT = 'Brendon Paul (BetterID phone root c81763)';
    const root = certJson(PHONE_ROOT, { ca: true, notBefore: 1700000000 });
    const leaf = certJson('Brendon Paul', { issuer: PHONE_ROOT, vlad, notBefore: 1700000000 });
    const newerLeaf = certJson('Brendon Paul', { issuer: PHONE_ROOT, vlad, notBefore: 1750000000 });
    const janeRoot = certJson('BetterID signer (BetterID root 689d07)', { ca: true });
    const jane = certJson('Jane Englefield', {
      issuer: janeRoot.subject_cn,
      vlad: janeVlad,
    });
    const sealRoot = certJson('BetterID docsign (BetterID root c17c6e)', { ca: true });
    const seal = certJson('BetterID docsign', { issuer: sealRoot.subject_cn, vlad: sealVlad });
    const third = certJson('Test Signer');
    // A CA the CMS carries that issued none of these.
    const stray = certJson('Some other CA', { ca: true });
    let first;
    let firstCalls;

    beforeAll(async () => {
      signaturesService.answer = () => ({
        signatures: [
          // Signer first, then its issuer, then anything else.
          signatureJson(leaf, [leaf, root, stray], { revision: 2 }),
          signatureJson(jane, [jane, janeRoot], { revision: 3 }),
          signatureJson(third, [third], { revision: 4, signing_time: null }),
          signatureJson(null, [], { revision: 5, intact: false, field: '' }),
          signatureJson(seal, [seal, sealRoot], { revision: 6, covers_whole_file: true }),
        ],
      });
      first = await complete();
      firstCalls = signaturesService.calls;
    });

    it('reads the final signed PDF', async () => {
      const row = await docRow(first.docId);
      const final = await readDocumentPdf(row.SignedUrl);
      const call = firstCalls.find(c => sha(c.pdf).equals(sha(final)));
      expect(call).toBeTruthy();
      expect(row.DocumentHash).toBe(sha(final).toString('hex'));
    });

    it('stores BetterID certificates and their roots, not the third party’s', async () => {
      const stored = await rows({ FirstSeenDoc: first.docId });
      expect(stored.map(r => r.Sha256).sort()).toEqual(
        [
          root.sha256,
          leaf.sha256,
          janeRoot.sha256,
          jane.sha256,
          sealRoot.sha256,
          seal.sha256,
        ].sort()
      );
      const leafRow = stored.find(r => r.Sha256 === leaf.sha256);
      expect(leafRow.Vlad).toBe(vlad);
      expect(leafRow.IssuerSha256).toBe(root.sha256);
      expect(leafRow.Der).toBe(leaf.der);
      expect(stored.find(r => r.Sha256 === root.sha256).Vlad).toBe(vlad);
      expect(stored.find(r => r.Sha256 === sealRoot.sha256).Vlad).toBe(sealVlad);
      expect((await rows({ Sha256: third.sha256 })).length).toBe(0);
      expect((await rows({ Sha256: stray.sha256 })).length).toBe(0);
    });

    it('keeps the class to the master key', async () => {
      const r = await req('GET', `${PARSE}/classes/bs_PublishedCert`, { headers: PUBLIC });
      expect(r.json.results).toBeUndefined();
      expect(r.json.code).toBe(119);
    });

    it('links each root and its page in the completion certificate', async () => {
      const uris = await links(await readDocumentPdf(first.certificateUrl));
      // Pages by the root's fingerprint: short, unlike a VLAD.
      for (const r of [root, janeRoot, sealRoot]) {
        expect(uris).toContain(`${API}/api/v1/certs/${r.sha256}.cer`);
        expect(uris).toContain(`https://docsign.betterid.net/certs/${r.sha256}`);
      }
      expect(uris.some(u => u.includes(vlad))).toBe(false);
      expect(uris.some(u => u.includes(third.sha256))).toBe(false);
    });

    it('serves the DER', async () => {
      const r = await req('GET', `${API}/api/v1/certs/${root.sha256}.cer`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pkix-cert');
      expect(r.headers.get('content-disposition')).toBe(
        `attachment; filename="Brendon_Paul_BetterID_phone_root_c81763_-${root.sha256.slice(0, 8)}.cer"`
      );
      expect(r.headers.get('cache-control')).toMatch(/public/);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.buf.toString('base64')).toBe(root.der);
      const upper = await req('GET', `${API}/api/v1/certs/${root.sha256.toUpperCase()}.cer`);
      expect(upper.status).toBe(200);
    });

    it('serves a summary', async () => {
      const r = await req('GET', `${API}/api/v1/certs/${leaf.sha256}`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        sha256: leaf.sha256,
        fingerprint: leaf.sha256.toUpperCase().match(/.{2}/g).join(':'),
        subject_cn: 'Brendon Paul',
        issuer_cn: PHONE_ROOT,
        serial: leaf.serial,
        is_ca: false,
        vlad,
        issuer_sha256: root.sha256,
        not_before: new Date(leaf.not_before * 1000).toISOString(),
        not_after: new Date(leaf.not_after * 1000).toISOString(),
        download_url: `${API}/api/v1/certs/${leaf.sha256}.cer`,
        page_url: `https://docsign.betterid.net/certs/${vlad}`,
      });
      expect(r.json.FirstSeenDoc).toBeUndefined();
    });

    it('404s for a certificate it didn’t publish, 400s for anything not a SHA-256', async () => {
      expect((await req('GET', `${API}/api/v1/certs/${third.sha256}.cer`)).status).toBe(404);
      expect((await req('GET', `${API}/api/v1/certs/${third.sha256}`)).status).toBe(404);
      for (const bad of [
        third.sha256.slice(1),
        `${third.sha256}0`,
        `${third.sha256}.pem`,
        'g'.repeat(64),
        'x',
      ]) {
        const r = await req('GET', `${API}/api/v1/certs/${bad}`);
        expect(r.status).withContext(bad).toBe(400);
      }
    });

    it('lists an identity’s roots and leaves, newest first', async () => {
      signaturesService.answer = () => ({
        signatures: [signatureJson(newerLeaf, [newerLeaf, root])],
      });
      await complete();
      const r = await req('GET', `${API}/api/v1/identities/${vlad}/certs`);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toMatch(/public/);
      expect(r.json.vlad).toBe(vlad);
      expect(r.json.roots.map(c => c.sha256)).toEqual([root.sha256]);
      expect(r.json.leaves.map(c => c.sha256)).toEqual([newerLeaf.sha256, leaf.sha256]);
      const upper = await req('GET', `${API}/api/v1/identities/${vlad.toUpperCase()}/certs`);
      expect(upper.json.leaves.length).toBe(2);
    });

    it('404s for an unknown identity, 400s for a malformed VLAD', async () => {
      expect((await req('GET', `${API}/api/v1/identities/${VLAD()}/certs`)).status).toBe(404);
      for (const bad of ['abc', 'zz'.repeat(40), 'ab'.repeat(4097)]) {
        const r = await req('GET', `${API}/api/v1/identities/${bad}/certs`);
        expect(r.status).withContext(bad).toBe(400);
      }
    });
  });

  it('a CA shared by two identities is listed for both', async () => {
    const a = VLAD();
    const b = VLAD();
    const ca = certJson(`Org CA ${tag()}`, { ca: true });
    const la = certJson('A', { issuer: ca.subject_cn, vlad: a });
    const lb = certJson('B', { issuer: ca.subject_cn, vlad: b });
    signaturesService.answer = () => ({
      signatures: [
        signatureJson(la, [la, ca], { revision: 1 }),
        signatureJson(lb, [lb, ca], { revision: 2 }),
      ],
    });
    await complete();
    for (const [v, leaf] of [
      [a, la],
      [b, lb],
    ]) {
      const r = await req('GET', `${API}/api/v1/identities/${v}/certs`);
      expect(r.json.roots.map(c => c.sha256)).toEqual([ca.sha256]);
      expect(r.json.leaves.map(c => c.sha256)).toEqual([leaf.sha256]);
    }
  });

  it('makes the certificate without the section when the service is down', async () => {
    const leaf = certJson('Carol', { vlad: VLAD() });
    signaturesService.answer = () => ({ signatures: [signatureJson(leaf, [leaf])] });
    signaturesService.mode = '503';
    const { certificateUrl } = await complete();
    expect(await links(await readDocumentPdf(certificateUrl))).toEqual([]);
    expect((await rows({ Sha256: leaf.sha256 })).length).toBe(0);
  });

  it('makes the certificate without the section when the service is not set up', async () => {
    delete process.env.BS_SERVICE_IDENTITY_URL;
    try {
      const { certificateUrl } = await complete();
      expect(await links(await readDocumentPdf(certificateUrl))).toEqual([]);
      expect(signaturesService.calls.length).toBe(0);
    } finally {
      process.env.BS_SERVICE_IDENTITY_URL = service.url;
    }
  });
});
