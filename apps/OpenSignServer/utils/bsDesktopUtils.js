// Pure helpers for the BetterSign desktop app functions
// (cloud/parsefunction/bsDesktop.js). No Parse or network access here, so
// `node --test utils/bsDesktopUtils.test.js` runs them without a server.

import { COMPLETION_ACTIVITIES, isCompletionRelevant } from './workflowUtils.js';

export const MAX_SIGNERS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same size as the web editor's default signature widget
// (apps/OpenSign/src/constant/Utils.js defaultWidthHeight).
export const SIGN_BOX = { width: 150, height: 60 };
const MARGIN = 36; // half an inch from the page edge
const GAP = 12; // between stacked boxes

// The palette the web editor gives signers, in order.
const BLOCK_COLORS = ['#93a3db', '#e6c3db', '#c0e3bc', '#bce3db', '#b8ccdb', '#ceb8db'];

export function normalizeEmail(email) {
  return String(email || '')
    .toLowerCase()
    .replace(/\s/g, '');
}

// [{name, email}] -> cleaned list, or throws Error with a user-facing message.
export function validateSigners(signers, ownerEmail) {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error('Add at least one signer.');
  }
  if (signers.length > MAX_SIGNERS) {
    throw new Error(`At most ${MAX_SIGNERS} signers.`);
  }
  const seen = new Set();
  const owner = normalizeEmail(ownerEmail);
  return signers.map(s => {
    const email = normalizeEmail(s?.email);
    if (!EMAIL_RE.test(email)) throw new Error(`"${s?.email || ''}" is not an email address.`);
    if (email === owner) throw new Error('You have already signed; add someone else.');
    if (seen.has(email)) throw new Error(`${email} is listed twice.`);
    seen.add(email);
    const name = String(s?.name || '').trim() || email.split('@')[0];
    return { name: name.slice(0, 250), email };
  });
}

// A file URL this server stored (POST /app/files/<name>), with any ?token
// stripped. `serverUrl` is SERVER_URL (e.g. https://host/app).
export function ownFileUrl(fileUrl, serverUrl) {
  let u;
  let s;
  try {
    u = new URL(String(fileUrl));
    s = new URL(String(serverUrl));
  } catch {
    return null;
  }
  if (u.origin !== s.origin || !u.pathname.includes('/files/')) return null;
  if (!/\.pdf$/i.test(u.pathname)) return null;
  return u.origin + u.pathname;
}

// One signature box per signer, stacked upward from the bottom-right corner
// of the last page. Positions are PDF points from the page's top-left, which
// is what the web editor stores (xPosition/yPosition/Width/Height, scale 1).
export function defaultPlaceholders(contacts, lastPage, pageCount, idFor = defaultId) {
  const { width: pw, height: ph } = lastPage;
  return contacts.map((c, i) => {
    const x = Math.max(0, pw - MARGIN - SIGN_BOX.width);
    const y = Math.max(0, ph - MARGIN - SIGN_BOX.height - i * (SIGN_BOX.height + GAP));
    return {
      Id: idFor(i),
      Role: '',
      blockColor: BLOCK_COLORS[i % BLOCK_COLORS.length],
      signerPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: c.objectId },
      signerObjId: c.objectId,
      email: c.email,
      placeHolder: [
        {
          pageNumber: pageCount,
          pos: [
            {
              xPosition: x,
              yPosition: y,
              isStamp: false,
              key: Date.now() + i,
              scale: 1,
              zIndex: i + 1,
              type: 'signature',
              options: { name: `signature-${idFor(i)}-1`, status: 'required' },
              Width: SIGN_BOX.width,
              Height: SIGN_BOX.height,
            },
          ],
        },
      ],
    };
  });
}

function defaultId(i) {
  return `${Date.now().toString(36)}${i}`;
}

// The link the web app's own send flow emails (GuestLogin route /login/:b64).
export function signingLink(publicUrl, docId, email, contactId) {
  const b64 = Buffer.from(`${docId}/${email}/${contactId}`).toString('base64');
  return `${String(publicUrl).replace(/\/$/, '')}/login/${b64}`;
}

// Has this contact already signed? (Audit trail entry with a completion activity.)
export function hasActed(auditTrail, contactId) {
  return (Array.isArray(auditTrail) ? auditTrail : []).some(
    a => a?.UserPtr?.objectId === contactId && COMPLETION_ACTIVITIES.includes(a?.Activity)
  );
}

// Same rule as signPdf: complete once every completion-relevant placeholder
// has a Signed entry.
export function isComplete(placeholders, auditTrail) {
  const relevant = Array.isArray(placeholders) ? placeholders.filter(isCompletionRelevant) : [];
  const acted = (Array.isArray(auditTrail) ? auditTrail : []).filter(a =>
    COMPLETION_ACTIVITIES.includes(a?.Activity)
  );
  return relevant.length > 0 && acted.length >= relevant.length;
}

// The fields a signer is asked to fill, for the desktop to show or place on.
export function fieldsFor(placeholders, contactId) {
  const mine = (placeholders || []).find(
    p => (p?.signerObjId || p?.signerPtr?.objectId) === contactId
  );
  const out = [];
  for (const page of mine?.placeHolder || []) {
    for (const pos of page?.pos || []) {
      out.push({
        page: page.pageNumber,
        type: pos.type,
        x: pos.xPosition,
        y: pos.yPosition,
        width: pos.Width,
        height: pos.Height,
      });
    }
  }
  return out;
}
