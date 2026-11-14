// node --test utils/bsDesktopUtils.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSigners,
  ownFileUrl,
  defaultPlaceholders,
  signingLink,
  hasActed,
  isComplete,
  fieldsFor,
  SIGN_BOX,
} from './bsDesktopUtils.js';

test('validateSigners cleans and rejects', () => {
  assert.deepEqual(validateSigners([{ email: ' Ann@Example.com ' }], 'me@x.com'), [
    { name: 'ann', email: 'ann@example.com' },
  ]);
  assert.throws(() => validateSigners([], 'me@x.com'), /at least one/);
  assert.throws(() => validateSigners([{ email: 'nope' }], 'me@x.com'), /not an email/);
  assert.throws(() => validateSigners([{ email: 'ME@x.com' }], 'me@x.com'), /already signed/);
  assert.throws(
    () => validateSigners([{ email: 'a@b.co' }, { email: 'A@b.co' }], 'me@x.com'),
    /twice/
  );
});

test('ownFileUrl accepts only this server', () => {
  const srv = 'https://api.example/app';
  assert.equal(
    ownFileUrl('https://api.example/app/files/abc_doc.pdf?token=x', srv),
    'https://api.example/app/files/abc_doc.pdf'
  );
  assert.equal(ownFileUrl('https://evil.example/app/files/a.pdf', srv), null);
  assert.equal(ownFileUrl('https://api.example/app/classes/a.pdf', srv), null);
  assert.equal(ownFileUrl('https://api.example/app/files/a.png', srv), null);
  assert.equal(ownFileUrl('not a url', srv), null);
});

test('defaultPlaceholders stacks boxes on the last page', () => {
  const ph = defaultPlaceholders(
    [
      { objectId: 'c1', email: 'a@b.co' },
      { objectId: 'c2', email: 'c@d.co' },
    ],
    { width: 612, height: 792 },
    3,
    i => `id${i}`
  );
  assert.equal(ph.length, 2);
  assert.equal(ph[0].signerObjId, 'c1');
  assert.equal(ph[0].placeHolder[0].pageNumber, 3);
  const [a, b] = ph.map(p => p.placeHolder[0].pos[0]);
  assert.equal(a.type, 'signature');
  assert.equal(a.xPosition, 612 - 36 - SIGN_BOX.width);
  assert.equal(a.yPosition, 792 - 36 - SIGN_BOX.height);
  assert.ok(b.yPosition < a.yPosition);
  assert.equal(a.options.status, 'required');
});

test('signingLink matches the web app format', () => {
  const link = signingLink('https://docsign.example/', 'D1', 'a@b.co', 'C1');
  const b64 = link.split('/login/')[1];
  assert.equal(Buffer.from(b64, 'base64').toString(), 'D1/a@b.co/C1');
  assert.ok(link.startsWith('https://docsign.example/login/'));
});

test('completion and acted checks', () => {
  const ph = [{ signerObjId: 'c1' }, { signerObjId: 'c2' }, { Role: 'prefill' }];
  const one = [{ UserPtr: { objectId: 'c1' }, Activity: 'Signed' }];
  const two = [...one, { UserPtr: { objectId: 'c2' }, Activity: 'Signed' }];
  assert.equal(hasActed(one, 'c1'), true);
  assert.equal(hasActed(one, 'c2'), false);
  assert.equal(hasActed([{ UserPtr: { objectId: 'c2' }, Activity: 'Viewed' }], 'c2'), false);
  assert.equal(isComplete(ph, one), false);
  assert.equal(isComplete(ph, two), true);
  assert.equal(isComplete([], two), false);
});

test('fieldsFor returns one signer’s boxes', () => {
  const ph = defaultPlaceholders(
    [{ objectId: 'c1', email: 'a@b.co' }],
    { width: 100 + 36 + SIGN_BOX.width, height: 500 },
    2
  );
  assert.deepEqual(fieldsFor(ph, 'c1'), [
    { page: 2, type: 'signature', x: 100, y: 500 - 36 - 60, width: 150, height: 60 },
  ]);
  assert.deepEqual(fieldsFor(ph, 'zz'), []);
});
