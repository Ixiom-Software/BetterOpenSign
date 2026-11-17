// Published certificates (cloud/customRoute/bsapi/certs.js) without a
// database: reading /v1/pdf/signatures' answer, what gets published, and the
// completion certificate's "Digital signatures" section.
// `npx jasmine --config=spec/support/bsapi.json`.
import crypto from 'node:crypto';
import http from 'node:http';
import * as pdfLib from 'pdf-lib';
import {
  apiBase,
  describeSignature,
  fingerprint,
  issuersOf,
  listSignatures,
  parseCert,
  parseSignatures,
  rootOf,
  signaturesForCertificate,
  toPublish,
} from '../../cloud/customRoute/bsapi/certs.js';
import GenerateCertificate from '../../cloud/parsefunction/pdf/GenerateCertificate.js';

const TOKEN = 'certs-spec-token-0123456789abcdef0123456789';
// Real VLADs are about 400 bytes.
const VLAD = '8724' + 'ab'.repeat(398);
const SEAL_VLAD = '8724' + 'cd'.repeat(398);
const NOW = Math.floor(Date.now() / 1000);

// A CertJson as the service sends it; any bytes stand in for the DER.
function certJson(cn, { issuer = cn, ca = false, vlad, notBefore = NOW - 60 } = {}) {
  const der = crypto.randomBytes(300);
  return {
    der: der.toString('base64'),
    sha256: crypto.createHash('sha256').update(der).digest('hex'),
    subject_cn: cn,
    issuer_cn: issuer,
    serial: crypto.randomBytes(8).toString('hex'),
    not_before: notBefore,
    not_after: notBefore + 365 * 86400,
    is_ca: ca,
    // The service sends null, not nothing, when there is no VLAD.
    vlad: vlad || null,
  };
}

function signatureJson(signer, chain, over = {}) {
  return {
    field: 'Signature1',
    revision: 1,
    sub_filter: 'ETSI.CAdES.detached',
    signing_time: NOW - 30,
    covers_whole_file: false,
    intact: true,
    signer,
    chain,
    ...over,
  };
}

const ENV = ['BS_SERVICE_IDENTITY_URL', 'BS_SERVICE_IDENTITY_TOKEN', 'SERVER_URL', 'BS_API_ORIGIN'];

describe('published certificates', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    process.env.SERVER_URL = 'https://api.example.com/app';
    delete process.env.BS_API_ORIGIN;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('parseCert', () => {
    it('reads a CertJson', () => {
      const j = certJson('Alice', { issuer: 'Alice root', vlad: VLAD.toUpperCase() });
      const c = parseCert(j);
      expect(c.sha256).toBe(j.sha256);
      expect(c.der.toString('base64')).toBe(j.der);
      expect(c.subjectCn).toBe('Alice');
      expect(c.issuerCn).toBe('Alice root');
      expect(c.vlad).toBe(VLAD);
      expect(c.notBefore.getTime()).toBe(j.not_before * 1000);
      expect(c.isCa).toBe(false);
    });

    it('refuses a hash that is not the DER’s, a bad VLAD, bad types', () => {
      const j = certJson('Alice');
      expect(parseCert({ ...j, sha256: 'ab'.repeat(32) })).toBeNull();
      expect(parseCert({ ...j, vlad: 'xyz' })).toBeNull();
      expect(parseCert({ ...j, vlad: 'abc' })).toBeNull();
      expect(parseCert({ ...j, is_ca: 'yes' })).toBeNull();
      expect(parseCert({ ...j, not_after: 1.5 })).toBeNull();
      expect(parseCert({ ...j, der: '!!' })).toBeNull();
      expect(parseCert({ ...j, serial: 'zz' })).toBeNull();
      expect(parseCert(null)).toBeNull();
    });

    it('strips control characters from names', () => {
      expect(parseCert(certJson('Al\nice\u0000')).subjectCn).toBe('Alice');
    });
  });

  describe('parseSignatures', () => {
    it('sorts by revision; a missing or malformed signer certificate is null', () => {
      const a = certJson('A');
      const b = certJson('B');
      const out = parseSignatures([
        signatureJson(b, [b], { revision: 4 }),
        signatureJson({ ...a, sha256: '00'.repeat(32) }, [], { revision: 3 }),
        signatureJson(null, [], { revision: 2, intact: false, field: '' }),
        signatureJson(a, [a, { bad: true }], { revision: 1, signing_time: null }),
        { field: 'x', revision: 'one', intact: true },
      ]);
      expect(out.map(s => s.signer?.subjectCn ?? null)).toEqual(['A', null, null, 'B']);
      expect(out[0].chain.length).toBe(1);
      expect(out[0].signingTime).toBeNull();
      expect(out[0].signer.vlad).toBeNull();
      expect(out[1].field).toBe('');
      expect(() => parseSignatures(undefined)).toThrow();
    });
  });

  describe('chains', () => {
    const root = certJson('Alice root', { ca: true });
    const leaf = certJson('Alice', { issuer: 'Alice root', vlad: VLAD });
    const [sig] = parseSignatures([signatureJson(leaf, [leaf, root])]);

    it('finds the root by issuer name', () => {
      expect(issuersOf(sig.signer, sig.chain).map(c => c.subjectCn)).toEqual(['Alice root']);
      expect(rootOf(sig).sha256).toBe(root.sha256);
    });

    it("follows the service's issuer link over common names", () => {
      // Two CAs share a common name; the link says which one issued it.
      const real = certJson('Shared CA', { ca: true });
      const decoy = certJson('Shared CA', { ca: true });
      const link = (c, to) => ({ ...c, issuer_sha256: to.sha256 });
      const leaf = link(certJson('Carol', { issuer: 'Shared CA', vlad: VLAD }), real);
      const [s1] = parseSignatures([
        signatureJson(leaf, [leaf, link(decoy, decoy), link(real, real)]),
      ]);
      expect(rootOf(s1).sha256).toBe(real.sha256);
      expect(parseSignatures([signatureJson({ ...leaf, issuer_sha256: 'zz' }, [])])[0].signer)
        .toBeNull();
    });

    it('a self-signed signer is its own root; a missing issuer is no root', () => {
      const self = certJson('Test Signer');
      const orphan = certJson('Bob', { issuer: 'Somewhere CA' });
      const [s1, s2] = parseSignatures([
        signatureJson(self, [self], { revision: 1 }),
        signatureJson(orphan, [orphan], { revision: 2 }),
      ]);
      expect(rootOf(s1).sha256).toBe(self.sha256);
      expect(rootOf(s2)).toBeNull();
    });
  });

  describe('toPublish', () => {
    it('publishes VLAD certificates and the CAs above them, nothing else', () => {
      const root = certJson('Alice root', { ca: true });
      const leaf = certJson('Alice', { issuer: 'Alice root', vlad: VLAD });
      const sealRoot = certJson('docsign root', { ca: true, vlad: SEAL_VLAD });
      const seal = certJson('docsign', { issuer: 'docsign root', vlad: SEAL_VLAD });
      const third = certJson('Test Signer');
      const otherCa = certJson('Some CA', { ca: true });
      const p = toPublish(
        parseSignatures([
          signatureJson(leaf, [leaf, root, otherCa], { revision: 1 }),
          signatureJson(third, [third], { revision: 2 }),
          signatureJson(seal, [seal, sealRoot], { revision: 3, covers_whole_file: true }),
        ])
      );
      expect([...p.keys()].sort()).toEqual(
        [root.sha256, leaf.sha256, sealRoot.sha256, seal.sha256].sort()
      );
      expect(p.get(root.sha256).vlad).toBe(VLAD); // the identity it issued for
      expect(p.get(leaf.sha256).issuerSha256).toBe(root.sha256);
      expect(p.get(root.sha256).issuerSha256).toBeNull();
      expect(p.get(sealRoot.sha256).vlad).toBe(SEAL_VLAD);
    });

    it('publishes nothing from a signature that is not intact', () => {
      const leaf = certJson('Alice', { vlad: VLAD });
      expect(
        toPublish(parseSignatures([signatureJson(leaf, [leaf], { intact: false })])).size
      ).toBe(0);
    });
  });

  describe('describeSignature', () => {
    const root = certJson('Alice root', { ca: true });
    const leaf = certJson('Alice', { issuer: 'Alice root', vlad: VLAD });
    const [sig] = parseSignatures([signatureJson(leaf, [leaf, root])]);

    it('links the published root and its page', () => {
      const d = describeSignature(sig, new Set([root.sha256, leaf.sha256]));
      expect(d.signerName).toBe('Alice');
      expect(d.rootName).toBe('Alice root');
      expect(d.rootSha256).toBe(root.sha256);
      expect(d.rootDownloadUrl).toBe(`https://api.example.com/api/v1/certs/${root.sha256}.cer`);
      // The root's page, by fingerprint: short, unlike a VLAD (about 800 hex digits).
      expect(d.pageUrl).toBe(`https://docsign.bettersign.ing/certs/${root.sha256}`);
    });

    it('a signature without its certificate says so', () => {
      const [s] = parseSignatures([signatureJson(null, [], { intact: false })]);
      expect(rootOf(s)).toBeNull();
      expect(toPublish([s]).size).toBe(0);
      expect(describeSignature(s, new Set())).toEqual({
        certificateIncluded: false,
        signingTime: s.signingTime,
        intact: false,
        coversWholeFile: false,
      });
    });

    it('no links for what is not published', () => {
      const d = describeSignature(sig, new Set());
      expect(d.rootDownloadUrl).toBeNull();
      expect(d.pageUrl).toBeNull();
    });
  });

  it('formats fingerprints as Acrobat does', () => {
    expect(fingerprint('ab01' + '00'.repeat(30))).toMatch(/^AB:01:00:/);
    expect(fingerprint('ab'.repeat(32)).length).toBe(95);
  });

  it('derives the public API from SERVER_URL', () => {
    process.env.SERVER_URL = 'https://docsign-bettersign-api.fly.dev/app';
    expect(apiBase()).toBe('https://docsign-bettersign-api.fly.dev/api/v1');
    process.env.SERVER_URL = 'https://sign.example.com/api/app';
    expect(apiBase()).toBe('https://sign.example.com/api/api/v1');
    process.env.SERVER_URL = 'not a url';
    expect(apiBase()).toBeNull();
  });

  describe('POST /v1/pdf/signatures', () => {
    const service = { calls: [], status: 200, answer: null };
    let server;
    let url;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          service.calls.push({
            path: req.url,
            auth: req.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
          res.writeHead(service.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(service.answer));
        });
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise(r => server.close(r)));
    beforeEach(() => {
      service.calls = [];
      service.status = 200;
      process.env.BS_SERVICE_IDENTITY_URL = url;
      process.env.BS_SERVICE_IDENTITY_TOKEN = TOKEN;
    });

    it('sends the PDF with the bearer token and reads the answer', async () => {
      const leaf = certJson('Alice', { vlad: VLAD });
      service.answer = { signatures: [signatureJson(leaf, [leaf])] };
      const out = await listSignatures(Buffer.from('%PDF-1.7 test'));
      expect(service.calls[0].path).toBe('/v1/pdf/signatures');
      expect(service.calls[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(Buffer.from(service.calls[0].body.pdf, 'base64').toString()).toBe('%PDF-1.7 test');
      expect(out[0].signer.vlad).toBe(VLAD);
    });

    it('throws when the service fails or is not set up', async () => {
      service.status = 503;
      service.answer = { code: 'unavailable', error: 'down' };
      await expectAsync(listSignatures(Buffer.from('x'))).toBeRejectedWithError(/503 unavailable/);
      delete process.env.BS_SERVICE_IDENTITY_URL;
      await expectAsync(listSignatures(Buffer.from('x'))).toBeRejectedWithError(/not set/);
    });

    it('signaturesForCertificate is null, not an error, when it can’t say', async () => {
      delete process.env.BS_SERVICE_IDENTITY_URL;
      expect(await signaturesForCertificate({ objectId: 'd1', SignedUrl: 'x' })).toBeNull();
      process.env.BS_SERVICE_IDENTITY_URL = url;
      expect(await signaturesForCertificate({ objectId: 'd1' })).toBeNull();
      expect(service.calls.length).toBe(0);
    });
  });

  describe('the completion certificate', () => {
    const doc = {
      objectId: 'doc123',
      Name: 'Contract',
      Signers: [{ objectId: 'c1', Name: 'Dave', Email: 'dave@example.com' }],
      AuditTrail: [{ UserPtr: { objectId: 'c1' }, SignedOn: new Date().toISOString() }],
      ExtUserPtr: { Name: 'Owner', Email: 'owner@example.com' },
    };

    // Every link annotation's URI.
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
      return { out, pages: pdf.getPageCount() };
    }

    const described = (n, published = true) => {
      const root = certJson('Alice root', { ca: true });
      const leaf = certJson('Alice', { issuer: 'Alice root', vlad: VLAD });
      const sigs = parseSignatures(
        Array.from({ length: n }, (_, i) => signatureJson(leaf, [leaf, root], { revision: i }))
      );
      const set = new Set(published ? [root.sha256, leaf.sha256] : []);
      return { root, list: sigs.map(s => describeSignature(s, set)) };
    };

    it('is unchanged without signatures', async () => {
      const { out, pages } = await links(await GenerateCertificate(doc));
      expect(out).toEqual([]);
      expect(pages).toBe(1);
    });

    it('lists the signatures with links to the root and its page', async () => {
      const { root, list } = described(1);
      const { out } = await links(await GenerateCertificate(doc, { signatures: list }));
      expect(out).toContain(`https://api.example.com/api/v1/certs/${root.sha256}.cer`);
      expect(out).toContain(`https://docsign.bettersign.ing/certs/${root.sha256}`);
    });

    it('lists a signature without its certificate, without links', async () => {
      const [s] = parseSignatures([signatureJson(null, [], { intact: false })]);
      const { out, pages } = await links(
        await GenerateCertificate(doc, { signatures: [describeSignature(s, new Set())] })
      );
      expect(out).toEqual([]);
      expect(pages).toBe(1);
    });

    it('no links for unpublished certificates', async () => {
      const { list } = described(1, false);
      const { out } = await links(await GenerateCertificate(doc, { signatures: list }));
      expect(out).toEqual([]);
    });

    it('flows onto new pages', async () => {
      const { list } = described(8);
      const { pages, out } = await links(await GenerateCertificate(doc, { signatures: list }));
      expect(pages).toBeGreaterThan(1);
      expect(out.length).toBeGreaterThanOrEqual(16);
    });
  });
});
