// The "document completed" notice (cloud/customRoute/bsapi/completedNotice.js):
// its envelope, who gets one, and that sending never throws. No database or
// network: the VLAD lookup and the relay call are stubbed.
import {
  buildCompletedNotice,
  COMPLETED_CT,
  documentUserIds,
  NOTICE_TTL_S,
  notifyCompleted,
} from '../../cloud/customRoute/bsapi/completedNotice.js';
import {
  ed25519FromSeed,
  ed25519Verify,
  encodeCbor,
  REQUEST_ENV_DOMAIN,
  sha256,
} from '../../cloud/customRoute/bsapi/relay.js';
import { decodeCbor } from '../../cloud/customRoute/bsapi/statement.js';

// decodeCbor gives Maps; plain objects are easier to check.
const decode = b => {
  const plain = v =>
    v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : v;
  return plain(decodeCbor(b));
};

const key = ed25519FromSeed(Buffer.alloc(32, 0x11));
const VLAD_A = '0187010120' + 'ab'.repeat(32);
const VLAD_B = '0187010120' + 'cd'.repeat(32);

const doc = {
  objectId: 'AbC123xyz',
  CreatedBy: { __type: 'Pointer', className: '_User', objectId: 'owner1' },
  Signers: [
    { objectId: 'c1', UserId: { __type: 'Pointer', className: '_User', objectId: 'user1' } },
    { objectId: 'c2' }, // a contact with no account
    { objectId: 'c3', UserId: { objectId: 'owner1' } },
  ],
};

function relay(statuses = []) {
  const calls = [];
  return {
    calls,
    post: async (k, method, path, { body }) => {
      calls.push({ k, method, path, body });
      return { status: statuses.length ? statuses.shift() : 202, body: {} };
    },
  };
}

describe('completed notice', () => {
  let env;
  beforeEach(() => {
    env = process.env.BS_COMPLETED_NOTICE;
    delete process.env.BS_COMPLETED_NOTICE;
  });
  afterEach(() => {
    if (env === undefined) delete process.env.BS_COMPLETED_NOTICE;
    else process.env.BS_COMPLETED_NOTICE = env;
  });

  it('is a signed request envelope naming only the document', () => {
    const to = sha256(Buffer.from(VLAD_A, 'hex'));
    const reqId = Buffer.alloc(16, 0x44);
    const iat = 1763200000;
    const bytes = buildCompletedNotice({
      key,
      to,
      reqId,
      origin: 'https://docsign.bettersign.ing',
      docId: 'AbC123xyz',
      iat,
      exp: iat + NOTICE_TTL_S,
    });
    const { header, body, sig } = decode(bytes);
    expect(header.ct).toBe(COMPLETED_CT);
    expect(Buffer.from(header.to).equals(to)).toBe(true);
    expect(Buffer.from(header.from).equals(key.pub)).toBe(true);
    const signed = Buffer.concat([
      Buffer.from(REQUEST_ENV_DOMAIN),
      encodeCbor(header),
      sha256(body),
    ]);
    expect(ed25519Verify(key.pub, signed, sig)).toBe(true);
    const notice = decode(body);
    expect(Object.keys(notice).sort()).toEqual(['docId', 'exp', 'iat', 'origin', 'reqId', 'v']);
    expect(notice.docId).toBe('AbC123xyz');
    expect(notice.exp).toBe(header.exp);
    expect(Buffer.from(notice.reqId).equals(reqId)).toBe(true);
  });

  it('names the owner and the signers with accounts, once each', () => {
    expect(documentUserIds(doc)).toEqual(['owner1', 'user1']);
    expect(documentUserIds({})).toEqual([]);
  });

  it('sends one quiet notice per VLAD, spaced out', async () => {
    const r = relay();
    const sleeps = [];
    let asked;
    const sent = await notifyCompleted(doc, {
      key,
      post: r.post,
      vladsFor: async ids => {
        asked = ids;
        return [VLAD_A, VLAD_B];
      },
      sleep: async ms => sleeps.push(ms),
      now: () => 1763200000,
    });
    expect(asked).toEqual(['owner1', 'user1']);
    expect(sent).toBe(2);
    expect(r.calls.length).toBe(2);
    expect(sleeps.length).toBe(1);
    for (const [i, vlad] of [VLAD_A, VLAD_B].entries()) {
      const { body, path, method } = r.calls[i];
      expect(method).toBe('POST');
      expect(path).toBe('/v1/req');
      expect(body.quiet).toBe(true);
      expect(body.exp).toBe(1763200000 + NOTICE_TTL_S);
      expect(body.to).toBe(sha256(Buffer.from(vlad, 'hex')).toString('base64url'));
      const { header } = decode(Buffer.from(body.env, 'base64url'));
      expect(Buffer.from(header.reqId).toString('base64url')).toBe(body.reqId);
    }
  });

  it('retries once when rate-limited, and skips phones the relay does not know', async () => {
    const r = relay([429, 202, 404]);
    const sent = await notifyCompleted(doc, {
      key,
      post: r.post,
      vladsFor: async () => [VLAD_A, VLAD_B],
      sleep: async () => {},
    });
    expect(r.calls.length).toBe(3);
    expect(sent).toBe(1);
  });

  it('never throws', async () => {
    const failing = async () => {
      throw new Error('down');
    };
    expect(await notifyCompleted(doc, { key, post: failing, vladsFor: async () => [VLAD_A] })).toBe(
      0
    );
    expect(await notifyCompleted(doc, { key, vladsFor: failing })).toBe(0);
  });

  it('can be turned off, and sends nothing with no one linked', async () => {
    const r = relay();
    process.env.BS_COMPLETED_NOTICE = 'off';
    expect(await notifyCompleted(doc, { key, post: r.post, vladsFor: async () => [VLAD_A] })).toBe(
      0
    );
    delete process.env.BS_COMPLETED_NOTICE;
    expect(await notifyCompleted(doc, { key, post: r.post, vladsFor: async () => [] })).toBe(0);
    expect(r.calls.length).toBe(0);
  });
});
