// "Document completed": when a document is finished, tell the BetterSign apps
// of the people on it, so the phone can offer "Send to…" for the completed
// copy without the person opening Signed documents first
// (BetterSignApps #368; docs/BetterSignPhoneSign.md §4.4).
//
// One notice per VLAD with an active BetterSign link (bs_Identity) among the
// document's owner and signers, through the relay like a Sign on phone
// request, addressed to = sha256(VLAD) and signed by docsign's relay key. It
// is sent quiet: the relay's visible alert always reads "Sign-in request", so
// the app shows its own notification. The body names the document by id only
// (the relay sees it); the app looks it up as that identity, and the API only
// answers people on the document.
//
// Best effort: nothing waits for it and it never throws. A phone that isn't
// registered with the relay (404 unknown-recipient) just doesn't get one.
//
// Env:
//   BS_COMPLETED_NOTICE   "off" turns it off (default on)
import crypto from 'node:crypto';
import { config } from './auth.js';
import { buildRequestEnvelope, relayCall, relayKey, sha256 } from './relay.js';

export const COMPLETED_CT = 'application/vnd.bettersign.docsign-completed+cbor';
// The relay keeps a request at most 300 s.
export const NOTICE_TTL_S = 300;
const VLAD_HEX_RE = /^[0-9a-f]+$/;
// The relay takes one request a second from a key.
const SPACING_MS = 1100;
const b64u = b => Buffer.from(b).toString('base64url');
const delay = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function log(event, fields) {
  console.log(JSON.stringify({ event: `bscompleted_${event}`, ...fields }));
}

export const noticeEnabled = () =>
  String(process.env.BS_COMPLETED_NOTICE || '')
    .trim()
    .toLowerCase() !== 'off';

// { header: { v, ct: COMPLETED_CT, to, from, reqId, iat, exp },
//   body: CBOR({ v: 1, reqId, origin, docId, iat, exp }), sig }
export function buildCompletedNotice({ key, to, reqId, origin, docId, iat, exp }) {
  return buildRequestEnvelope({
    key,
    to,
    reqId,
    iat,
    exp,
    ct: COMPLETED_CT,
    request: { v: 1, reqId, origin, docId, iat, exp },
  });
}

const idOf = p => (typeof p === 'string' ? p : p?.objectId || p?.id || null);

// The _User ids of the document's owner and signers (a signer contact's
// UserId; contacts without an account are skipped).
export function documentUserIds(doc) {
  const ids = new Set();
  const owner = idOf(doc?.CreatedBy);
  if (owner) ids.add(owner);
  for (const s of doc?.Signers || []) {
    const u = idOf(typeof s?.get === 'function' ? s.get('UserId') : s?.UserId);
    if (u) ids.add(u);
  }
  return [...ids];
}

// The active BetterSign VLADs (lower hex) linked to these accounts.
export async function activeVladsFor(userIds) {
  if (!userIds.length) return [];
  const q = new Parse.Query('bs_Identity');
  q.containedIn(
    'UserId',
    userIds.map(objectId => ({ __type: 'Pointer', className: '_User', objectId }))
  );
  q.equalTo('Active', true);
  q.limit(100);
  const rows = await q.find({ useMasterKey: true });
  const vlads = rows.map(r => String(r.get('vlad') || '').toLowerCase());
  return [...new Set(vlads.filter(v => VLAD_HEX_RE.test(v) && v.length % 2 === 0))];
}

// Send one notice per VLAD. Returns how many the relay took. Never throws.
export async function notifyCompleted(
  doc,
  { vladsFor = activeVladsFor, post = relayCall, key: keyIn, now = nowSec, sleep = delay } = {}
) {
  const docId = idOf(doc);
  if (!noticeEnabled() || !docId) return 0;
  let sent = 0;
  try {
    const vlads = await vladsFor(documentUserIds(doc));
    if (!vlads.length) return 0;
    const key = keyIn || (await relayKey());
    const { origin } = config();
    for (const [i, vlad] of vlads.entries()) {
      if (i > 0) await sleep(SPACING_MS);
      const to = sha256(Buffer.from(vlad, 'hex'));
      const reqId = crypto.randomBytes(16);
      const iat = now();
      const exp = iat + NOTICE_TTL_S;
      const env = buildCompletedNotice({ key, to, reqId, origin, docId, iat, exp });
      try {
        const body = { env: b64u(env), to: b64u(to), reqId: b64u(reqId), exp, quiet: true };
        let res = await post(key, 'POST', '/v1/req', { body });
        if (res.status === 429) {
          await sleep(SPACING_MS);
          res = await post(key, 'POST', '/v1/req', { body });
        }
        if (res.status === 202) sent++;
        else if (res.status !== 404) {
          log('refused', { docId, status: res.status, error: res.body?.error });
        }
      } catch (e) {
        log('unreachable', { docId, error: e.message });
      }
    }
  } catch (e) {
    log('failed', { docId, error: e.message });
  }
  return sent;
}
