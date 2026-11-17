// A stand-in for bs-service-identity's POST /v1/pdf/signatures (contract
// section D), for cloud/customRoute/bsapi/certs.js. Checks the bearer token,
// records the PDF it was sent and answers `signaturesService.answer(pdf)`:
// specs say which signatures "are" in the file. Specs switch it to 503.
import crypto from 'node:crypto';
import http from 'node:http';

export const signaturesService = {
  token: 'bsapi-test-signatures-token-0123456789abcdef',
  mode: 'ok', // 'ok' | '503'
  calls: [],
  answer: () => ({ signatures: [] }),
};

const NOW = () => Math.floor(Date.now() / 1000);

// A CertJson; random bytes stand in for the DER.
export function certJson(cn, { issuer = cn, ca = false, vlad, notBefore = NOW() - 60 } = {}) {
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

export function signatureJson(signer, chain, over = {}) {
  return {
    field: 'Signature1',
    revision: 1,
    sub_filter: 'ETSI.CAdES.detached',
    signing_time: NOW() - 30,
    covers_whole_file: false,
    intact: true,
    signer,
    chain,
    ...over,
  };
}

export function startSignaturesService() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/v1/pdf/signatures') {
        return send(404, { code: 'not_found' });
      }
      if (req.headers.authorization !== `Bearer ${signaturesService.token}`) {
        return send(401, { code: 'unauthorized', error: 'missing or wrong bearer token' });
      }
      if (signaturesService.mode === '503')
        return send(503, { code: 'unavailable', error: 'down' });
      const pdf = Buffer.from(JSON.parse(Buffer.concat(chunks).toString()).pdf, 'base64');
      signaturesService.calls.push({ pdf });
      return send(200, signaturesService.answer(pdf));
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
