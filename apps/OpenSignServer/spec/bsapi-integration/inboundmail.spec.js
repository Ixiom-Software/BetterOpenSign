// Emailing PDFs to Better DocSign (cloud/customRoute/inboundMail.js,
// cloud/parsefunction/mailInbox.js): the Email Worker posts each message to
// POST /inbound/mail, signed; a PDF sent to a user's address becomes a draft
// document, or a template with +template, if the sender is theirs and the
// message carries their domain's DKIM signature.
import crypto from 'node:crypto';
import * as cantoo from '@cantoo/pdf-lib';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { API, MASTER, PARSE, mkMember, mkTenant, ptr, req, tag } from './support/lib.js';
import { hooks, signatureFor } from '../../cloud/customRoute/inboundMail.js';
import { deleteUser } from '../../cloud/customRoute/deleteAccount/deleteUser.js';

const SECRET = 'inbound-test-secret';

// One DKIM key, published (by the fake resolver) for these domains only.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PUBLISHED = new Set(['example.com', 'mail.example.com', 'example.org', 'evil.test']);
const resolver = async (name, rr) => {
  const m = /^s1\._domainkey\.(.+)$/.exec(name);
  if (rr === 'TXT' && m && PUBLISHED.has(m[1])) return [[`v=DKIM1; k=rsa; p=${PUBLIC_B64}`]];
  const err = new Error(`queryTxt ENOTFOUND ${name}`);
  err.code = 'ENOTFOUND';
  throw err;
};

const call = (who, fn, params = {}) =>
  req('POST', `${PARSE}/functions/${fn}`, { headers: who.session, body: params });

async function pdf({ pages = 1, field = false, userPassword } = {}) {
  const doc = await cantoo.PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]);
  if (field) doc.getForm().createTextField('stale').addToPage(doc.getPage(0));
  if (userPassword === undefined) return Buffer.from(await doc.save({ useObjectStreams: false }));
  // coherentpdf can't decrypt pdf-lib's encryption with a plain xref table;
  // with object streams (how most encrypted PDFs come) it can.
  doc.encrypt({ userPassword, ownerPassword: 'owner' });
  return Buffer.from(await doc.save());
}

const compose = ({ from, to, subject = 'Lease', files = [], messageId }) =>
  new MailComposer({
    from,
    to,
    subject,
    text: 'see attached',
    messageId: messageId || `<${tag()}@example.com>`,
    attachments: files.map(([filename, content, contentType = 'application/pdf']) => ({
      filename,
      content,
      contentType,
    })),
  })
    .compile()
    .build();

async function dkimSigned(raw, domain, extra = {}) {
  const { algorithm, ...signature } = extra;
  const signed = await dkimSign(raw, {
    ...(algorithm ? { algorithm } : {}),
    signatureData: [
      { signingDomain: domain, selector: 's1', privateKey: PRIVATE_PEM, ...signature },
    ],
  });
  if (!signed.signatures) throw new Error(JSON.stringify(signed.errors));
  return Buffer.concat([Buffer.from(signed.signatures), raw]);
}

// A message as the Worker gets it, DKIM-signed by `dkim` (default: the From
// domain; null: unsigned) with `dkimOpts`; `append` is added after signing.
async function message({ dkim, dkimOpts = {}, append = '', ...opts }) {
  const raw = await compose(opts);
  const domain = dkim === undefined ? opts.from.split('@')[1].toLowerCase() : dkim;
  const signed = domain ? await dkimSigned(raw, domain, dkimOpts) : raw;
  return Buffer.concat([signed, Buffer.from(append)]);
}

async function post(raw, { from, to }, { secret = SECRET, ts, sig } = {}) {
  const timestamp = String(ts ?? Math.floor(Date.now() / 1000));
  return req('POST', `${API}/inbound/mail`, {
    raw: true,
    body: raw,
    headers: {
      'content-type': 'message/rfc822',
      'x-bs-mail-from': from,
      'x-bs-rcpt-to': to,
      'x-bs-timestamp': timestamp,
      'x-bs-signature': sig ?? signatureFor(secret, timestamp, from, to, raw),
    },
  });
}

const send = async (opts, postOpts) => post(await message(opts), opts, postOpts);

const row = async (className, id) =>
  (await req('GET', `${PARSE}/classes/${className}/${id}`, { headers: MASTER })).json;
const rows = async (className, where) =>
  (
    await req(
      'GET',
      `${PARSE}/classes/${className}?where=${encodeURIComponent(JSON.stringify(where))}&limit=1000`,
      { headers: MASTER }
    )
  ).json.results;
const put = (className, id, body) =>
  req('PUT', `${PARSE}/classes/${className}/${id}`, { headers: MASTER, body });

const inboxRowOf = async member =>
  (await rows('bs_MailInbox', { UserId: ptr('_User', member.userId) }))[0];
const logsOf = async member =>
  rows('bs_InboundMail', { InboxId: ptr('bs_MailInbox', (await inboxRowOf(member)).objectId) });
const docsOf = async member =>
  rows('contracts_Document', { CreatedBy: ptr('_User', member.userId) });

describe('emailing PDFs in', () => {
  let tenantId;
  let owner;
  let inbox;
  let mail;
  const saved = { ...hooks };

  // A member with emailed PDFs turned on.
  async function withInbox(extra) {
    const member = await mkMember(tenantId, 'contracts_User', extra);
    const r = await call(member, 'mailinboxupdate', { enabled: true });
    if (r.status !== 200) throw new Error(JSON.stringify(r.json));
    return { member, box: r.json.result };
  }

  beforeAll(async () => {
    process.env.BS_INBOUND_MAIL_SECRET = SECRET;
    hooks.resolver = resolver;
    tenantId = await mkTenant();
    await put('partners_Tenant', tenantId, {
      RequestSubject: 'Please sign {{document_title}}',
      RequestBody: '<p>Sign it</p>',
    });
    ({ member: owner, box: inbox } = await withInbox({ UseNameAsSender: true }));
  });

  afterAll(() => {
    Object.assign(hooks, saved);
    for (const k of ['SECRET', 'PER_HOUR', 'MAX_MB', 'BAD_PER_MIN']) {
      delete process.env[`BS_INBOUND_MAIL_${k}`];
    }
  });

  beforeEach(() => {
    mail = [];
    hooks.sendMail = async params => mail.push(params);
    hooks.upload = saved.upload;
    hooks.claimStaleMs = saved.claimStaleMs;
  });

  it('has its classes, master key only, with their indexes (the migration)', async () => {
    const schema = async c => (await req('GET', `${PARSE}/schemas/${c}`, { headers: MASTER })).json;
    const box = await schema('bs_MailInbox');
    const log = await schema('bs_InboundMail');
    expect(Object.keys(box.indexes)).toEqual(jasmine.arrayContaining(['Token_1', 'UserId_1']));
    expect(Object.keys(log.indexes)).toContain('InboxId_MessageId_Kind_1');
    expect(log.fields.Kind).toEqual({ type: 'String' });
    expect(box.classLevelPermissions.find).toEqual({});
  });

  describe('the address', () => {
    it('is off, with no address, until the user turns it on', async () => {
      const fresh = await mkMember(tenantId);
      const r = (await call(fresh, 'mailinboxget')).json.result;
      expect(r).toEqual(
        jasmine.objectContaining({ enabled: false, addresses: null, accountEmail: fresh.email })
      );
      expect((await call(fresh, 'mailinboxrotate')).json.error).toMatch(/Turn on/);
      const senders = await call(fresh, 'mailinboxupdate', { allowedSenders: ['a@example.org'] });
      expect(senders.json.error).toMatch(/Turn on/);
      expect(await inboxRowOf(fresh)).toBeUndefined();
    });

    it('gives two addresses on in.betterid.net once on', () => {
      expect(inbox.enabled).toBe(true);
      expect(inbox.accountEmail).toBe(owner.email);
      expect(inbox.addresses.document).toMatch(/^[a-z2-7]{20}@in\.betterid\.net$/);
      expect(inbox.addresses.template).toBe(inbox.addresses.document.replace('@', '+template@'));
    });

    it('is made once when turned on twice at the same moment', async () => {
      const fresh = await mkMember(tenantId);
      const [a, b] = await Promise.all([
        call(fresh, 'mailinboxupdate', { enabled: true }),
        call(fresh, 'mailinboxupdate', { enabled: true }),
      ]);
      expect(a.json.result.addresses).toEqual(b.json.result.addresses);
      expect((await rows('bs_MailInbox', { UserId: ptr('_User', fresh.userId) })).length).toBe(1);
      const again = (await call(fresh, 'mailinboxget')).json.result;
      expect(again.addresses).toEqual(a.json.result.addresses);
    });
  });

  describe('a PDF sent in', () => {
    it('makes a draft document as the web form would, in Drafts', async () => {
      const r = await send({
        from: owner.email,
        to: inbox.addresses.document,
        subject: 'Fwd: Office lease',
        files: [['lease.pdf', await pdf({ pages: 2, field: true })]],
      });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe('created');
      const [made] = r.json.created;
      expect(made).toEqual(jasmine.objectContaining({ kind: 'document', name: 'Office lease' }));

      const doc = await row('contracts_Document', made.id);
      expect(doc).toEqual(
        jasmine.objectContaining({
          SendinOrder: true,
          NotifyOnSignatures: true,
          TimeToCompleteDays: 15,
          RequestSubject: 'Please sign {{document_title}}',
          RequestBody: '<p>Sign it</p>',
          SenderMail: owner.email,
          SenderName: owner.email.split('@')[0],
        })
      );
      expect(doc.SignedUrl).toBeUndefined();
      expect(doc.Signers).toBeUndefined();
      expect(doc.CreatedBy.objectId).toBe(owner.userId);
      expect(doc.ExtUserPtr.objectId).toBe(owner.extId);
      expect(Object.keys(doc.ACL)).toEqual([owner.userId]);

      // Stored as the web form stores an upload: form fields cleared.
      const stored = await req('GET', doc.URL);
      const loaded = await cantoo.PDFDocument.load(stored.buf);
      expect(loaded.getPageCount()).toBe(2);
      expect(loaded.getForm().getFields().length).toBe(0);

      // In both drafts lists the site shows.
      for (const reportId of ['ByHuevtCFY', 'kC5mfynCi4']) {
        const list = await call(owner, 'getReport', { reportId, limit: 50, skip: 0 });
        expect(list.json.result.map(d => d.objectId))
          .withContext(reportId)
          .toContain(made.id);
      }

      // Counted against the member's tenant, though they don't own it.
      const credits = await rows('partners_TenantCredits', {
        PartnersTenant: ptr('partners_Tenant', tenantId),
      });
      expect(credits[0]?.usedStorage).toBeGreaterThan(0);

      // The confirmation: a system mail, not counted against the user.
      expect(mail.length).toBe(1);
      expect(mail[0].recipient).toBe(owner.email);
      expect(mail[0].extUserId).toBeUndefined();
      expect(mail[0].html).toContain(`/placeHolderSign/${made.id}`);
    });

    it('makes a template with +template, one per PDF, in Templates', async () => {
      const r = await send({
        from: owner.email.toUpperCase(),
        to: inbox.addresses.template,
        files: [
          ['work_order-v2.pdf', await pdf()],
          ['notes.txt', Buffer.from('hi'), 'text/plain'],
          ['NDA.pdf', await pdf()],
        ],
      });
      expect(r.status).toBe(200);
      expect(r.json.created.map(c => [c.kind, c.name])).toEqual([
        ['template', 'Work Order-v2'],
        ['template', 'Nda'],
      ]);
      const t = await row('contracts_Template', r.json.created[0].id);
      expect(t.URL).toBeTruthy();
      expect(t.RequestBody).toBeUndefined();
      expect(Object.keys(t.ACL)).toEqual([owner.userId]);
      const list = await call(owner, 'getReport', { reportId: '6TeaPr321t', limit: 50, skip: 0 });
      expect(list.json.result.map(d => d.objectId)).toEqual(
        jasmine.arrayContaining(r.json.created.map(c => c.id))
      );
      expect(mail[0].html).toContain(`/template/${r.json.created[0].id}`);
    });

    it('is taken once, however often it is posted', async () => {
      const opts = {
        from: owner.email,
        to: inbox.addresses.document,
        messageId: `<dup-${tag()}@example.com>`,
        files: [['a.pdf', await pdf()]],
      };
      const raw = await message(opts);
      expect((await post(raw, opts)).json.status).toBe('created');
      expect((await post(raw, opts)).json).toEqual({ status: 'duplicate' });
      expect(mail.length).toBe(1);
    });

    it('sent to both addresses at once, makes a draft and a template', async () => {
      const opts = {
        from: owner.email,
        to: inbox.addresses.document,
        messageId: `<both-${tag()}@example.com>`,
        files: [['both.pdf', await pdf()]],
      };
      const raw = await message(opts);
      const asDoc = await post(raw, opts);
      const asTemplate = await post(raw, { ...opts, to: inbox.addresses.template });
      expect(asDoc.json.created.map(c => c.kind)).toEqual(['document']);
      expect(asTemplate.json.created.map(c => c.kind)).toEqual(['template']);
    });

    it('decrypts a PDF with an empty password, skips one with a password', async () => {
      const r = await send({
        from: owner.email,
        to: inbox.addresses.document,
        files: [
          ['open.pdf', await pdf({ userPassword: '' })],
          ['locked.pdf', await pdf({ userPassword: 'secret' })],
        ],
      });
      expect(r.status).toBe(200);
      expect(r.json.created.map(c => c.name)).toEqual(['Open']);
      expect(r.json.skipped).toEqual([{ file: 'locked.pdf', reason: 'password-protected' }]);
      expect(mail[0].html).toContain('locked.pdf');
    });

    it('bounces mail with no usable PDF', async () => {
      const none = await send({ from: owner.email, to: inbox.addresses.document });
      expect(none.status).toBe(422);
      expect(none.json.reason).toMatch(/no PDF/);
      const bad = await send({
        from: owner.email,
        to: inbox.addresses.document,
        files: [['fake.pdf', Buffer.from('not a pdf')]],
      });
      expect(bad.status).toBe(422);
      expect(bad.json.reason).toMatch(/fake\.pdf \(not a PDF\)/);
      expect(mail).toEqual([]);
    });
  });

  describe('failures and retries', () => {
    it('undoes what a failed attempt made, so the retry makes it once', async () => {
      const { member, box } = await withInbox();
      const opts = {
        from: member.email,
        to: box.addresses.document,
        files: [
          ['one.pdf', await pdf()],
          ['two.pdf', await pdf()],
        ],
      };
      const raw = await message(opts);
      let uploads = 0;
      hooks.upload = async (...args) => {
        if (++uploads === 2) throw new Error('disk full');
        return saved.upload(...args);
      };
      const failed = await post(raw, opts);
      expect(failed.status).toBe(500);
      expect(await docsOf(member)).toEqual([]);
      expect((await logsOf(member)).map(l => [l.Status, l.Reason])).toEqual([
        ['failed', 'disk full'],
      ]);

      hooks.upload = saved.upload;
      const retried = await post(raw, opts);
      expect(retried.status).toBe(200);
      expect(retried.json.created.length).toBe(2);
      expect((await docsOf(member)).length).toBe(2);
    });

    it('asks for a retry while the same message is being taken in', async () => {
      const { member, box } = await withInbox();
      const opts = {
        from: member.email,
        to: box.addresses.document,
        files: [['a.pdf', await pdf()]],
      };
      const raw = await message(opts);
      let release;
      const gate = new Promise(resolve => (release = resolve));
      hooks.upload = async (...args) => {
        await gate;
        return saved.upload(...args);
      };
      const first = post(raw, opts);
      for (let i = 0; i < 100; i++) {
        if ((await logsOf(member)).some(l => l.Status === 'processing')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const second = await post(raw, opts);
      expect(second.status).toBe(503);
      release();
      expect((await first).status).toBe(200);
      expect((await docsOf(member)).length).toBe(1);
    });

    it('takes over a stale claim, undoing what it made', async () => {
      const { member, box } = await withInbox();
      const messageId = `<stale-${tag()}@example.com>`;
      const leftover = await req('POST', `${PARSE}/classes/contracts_Document`, {
        headers: MASTER,
        body: { Name: 'Leftover', CreatedBy: ptr('_User', member.userId), URL: 'x' },
      });
      await req('POST', `${PARSE}/classes/bs_InboundMail`, {
        headers: MASTER,
        body: {
          InboxId: ptr('bs_MailInbox', (await inboxRowOf(member)).objectId),
          MessageId: messageId,
          Kind: 'document',
          Status: 'processing',
          PdfCount: 1,
          Created: [{ kind: 'document', id: leftover.json.objectId, name: 'Leftover' }],
        },
      });
      hooks.claimStaleMs = 0;
      const r = await send({
        from: member.email,
        to: box.addresses.document,
        messageId,
        files: [['a.pdf', await pdf()]],
      });
      expect(r.status).toBe(200);
      expect((await docsOf(member)).map(d => d.objectId)).toEqual([r.json.created[0].id]);
      expect((await logsOf(member)).map(l => l.Status)).toEqual(['created']);
    });
  });

  describe('who can send', () => {
    it('bounces mail from anyone but the owner and their allowed senders', async () => {
      const files = [['a.pdf', await pdf()]];
      const other = `someone-${tag()}@example.org`;
      const r = await send({ from: other, to: inbox.addresses.document, files });
      expect(r.status).toBe(403);
      expect(r.json.reason).toContain('can’t send to this address');

      const u = await call(owner, 'mailinboxupdate', { allowedSenders: [other.toUpperCase()] });
      expect(u.json.result.allowedSenders).toEqual([other]);
      expect((await send({ from: other, to: inbox.addresses.document, files })).status).toBe(200);

      const bad = await call(owner, 'mailinboxupdate', { allowedSenders: ['nope'] });
      expect(bad.json.error).toMatch(/isn’t an email address/);
    });

    describe('DKIM', () => {
      let files;
      let base;
      beforeAll(async () => {
        files = [['a.pdf', await pdf()]];
      });
      beforeEach(() => {
        base = { from: owner.email, to: inbox.addresses.document, files };
      });

      it('takes a signature by a subdomain or a parent of the From domain', async () => {
        expect((await send({ ...base, dkim: 'mail.example.com' })).status).toBe(200);
        const sub = `x-${tag()}@sub.example.com`;
        await call(owner, 'mailinboxupdate', { allowedSenders: [sub] });
        expect((await send({ ...base, from: sub, dkim: 'example.com' })).status).toBe(200);
      });

      it('bounces unsigned mail, and a signature by another domain', async () => {
        const unsigned = await send({ ...base, dkim: null });
        expect(unsigned.status).toBe(403);
        expect(unsigned.json.reason).toMatch(/couldn’t verify/);
        expect((await send({ ...base, dkim: 'evil.test' })).status).toBe(403);
        // A domain without a published key.
        expect((await send({ ...base, dkim: 'nokey.example.net' })).status).toBe(403);
      });

      it('bounces mail changed after signing', async () => {
        const r = await send({ ...base, append: '\r\nPS: one more thing\r\n' });
        expect(r.status).toBe(403);
      });

      it('bounces a signature over only part of the body (l=)', async () => {
        const subject = `Partial ${tag()}`;
        const r = await send({ ...base, subject, dkimOpts: { maxBodyLength: 10 } });
        expect(r.status).toBe(403);
        expect(r.json.reason).toMatch(/couldn’t verify/);
        const [log] = await rows('bs_InboundMail', { Subject: subject });
        expect(log.Reason).toContain('partial body');
      });

      it('bounces an rsa-sha1 signature', async () => {
        expect((await send({ ...base, dkimOpts: { algorithm: 'rsa-sha1' } })).status).toBe(403);
      });
    });
  });

  describe('the request', () => {
    let opts;
    let raw;
    beforeAll(async () => {
      opts = { from: owner.email, to: inbox.addresses.document, files: [['a.pdf', await pdf()]] };
      raw = await message(opts);
    });

    it('must be signed with the secret, recently, for this recipient', async () => {
      expect((await post(raw, opts, { secret: 'wrong' })).status).toBe(401);
      const stale = Math.floor(Date.now() / 1000) - 3600;
      expect((await post(raw, opts, { ts: stale })).status).toBe(401);
      expect((await post(raw, opts, { sig: 'not-hex' })).status).toBe(401);
      const ts = Math.floor(Date.now() / 1000);
      const sig = signatureFor(SECRET, String(ts), opts.from, inbox.addresses.template, raw);
      expect((await post(raw, opts, { ts, sig })).status).toBe(401);

      delete process.env.BS_INBOUND_MAIL_SECRET;
      try {
        expect((await post(raw, opts)).status).toBe(503);
      } finally {
        process.env.BS_INBOUND_MAIL_SECRET = SECRET;
      }
    });

    it('is refused unread from an IP that keeps signing badly', async () => {
      process.env.BS_INBOUND_MAIL_BAD_PER_MIN = '2';
      try {
        expect((await post(raw, opts, { secret: 'wrong' })).status).toBe(401);
        expect((await post(raw, opts, { secret: 'wrong' })).status).toBe(401);
        const refused = await post(raw, opts);
        expect(refused.status).toBe(503);
        expect(refused.json.reason).toMatch(/bad signatures/);
      } finally {
        delete process.env.BS_INBOUND_MAIL_BAD_PER_MIN;
      }
      // A changed limit starts a fresh count.
      expect((await post(raw, opts)).status).not.toBe(503);
    });

    it('bounces a message over BS_INBOUND_MAIL_MAX_MB, saying the limit', async () => {
      process.env.BS_INBOUND_MAIL_MAX_MB = '1';
      try {
        const big = await message({
          ...opts,
          files: [['big.pdf', crypto.randomBytes(1.2 * 1024 * 1024)]],
        });
        const r = await post(big, opts);
        expect(r.status).toBe(413);
        expect(r.json.reason).toBe('This email is too large (at most 1 MB).');
      } finally {
        delete process.env.BS_INBOUND_MAIL_MAX_MB;
      }
    });
  });

  describe('the address bounces mail', () => {
    let files;
    beforeAll(async () => {
      files = [['a.pdf', await pdf()]];
    });

    it('when unknown, misaddressed or turned off', async () => {
      const to = inbox.addresses.document;
      const tries = [
        'aaaaaaaaaaaaaaaaaaaa@in.betterid.net',
        to.replace('in.betterid.net', 'betterid.net'),
        to.replace('@', '+other@'),
        inbox.addresses.template.replace('@', '+x@'),
      ];
      for (const t of tries) {
        const r = await send({ from: owner.email, to: t, files });
        expect(r.status).withContext(t).toBe(404);
      }
      const off = await call(owner, 'mailinboxupdate', { enabled: false });
      expect(off.json.result.enabled).toBe(false);
      expect((await send({ from: owner.email, to, files })).status).toBe(404);
      await call(owner, 'mailinboxupdate', { enabled: true });
    });

    it('after a new address is made', async () => {
      const rotated = (await call(owner, 'mailinboxrotate')).json.result;
      expect(rotated.addresses.document).not.toBe(inbox.addresses.document);
      const old = await send({ from: owner.email, to: inbox.addresses.document, files });
      expect(old.status).toBe(404);
      const now = await send({ from: owner.email, to: rotated.addresses.document, files });
      expect(now.status).toBe(200);
      inbox = rotated;
    });

    it('for a disabled or deleted user', async () => {
      const { member, box } = await withInbox();
      const to = box.addresses.document;
      await put('contracts_Users', member.extId, { IsDisabled: true });
      expect((await send({ from: member.email, to, files })).status).toBe(404);
      await put('contracts_Users', member.extId, { IsDisabled: false });
      expect((await send({ from: member.email, to, files })).status).toBe(200);

      await req('DELETE', `${PARSE}/classes/_User/${member.userId}`, { headers: MASTER });
      expect((await send({ from: member.email, to, files })).status).toBe(404);
    });

    it('over PDFs per address per hour', async () => {
      process.env.BS_INBOUND_MAIL_PER_HOUR = '1';
      try {
        const r = await send({ from: owner.email, to: inbox.addresses.document, files });
        expect(r.status).toBe(429);
      } finally {
        delete process.env.BS_INBOUND_MAIL_PER_HOUR;
      }
    });
  });

  it('lists recent mail on the inbox, and keeps others out of it', async () => {
    const r = (await call(owner, 'mailinboxget')).json.result;
    expect(r.recent.length).toBe(5);
    expect(r.recent[0].status).toBe('rejected');
    expect(r.recent[0].reason).toMatch(/Too many/);

    const blocked = await req('GET', `${PARSE}/classes/bs_MailInbox`, { headers: owner.session });
    expect(blocked.json.results ?? []).toEqual([]);
    const anon = await req('POST', `${PARSE}/functions/mailinboxget`, {
      headers: { 'X-Parse-Application-Id': MASTER['X-Parse-Application-Id'] },
      body: {},
    });
    expect(anon.json.code).toBe(209);
  });

  it('deleting the account deletes the address and its mail log', async () => {
    const { member, box } = await withInbox();
    const sent = await send({
      from: member.email,
      to: box.addresses.document,
      files: [['a.pdf', await pdf()]],
    });
    expect(sent.status).toBe(200);
    const inboxId = (await inboxRowOf(member)).objectId;
    expect((await logsOf(member)).length).toBe(1);

    const result = await deleteUser(member.userId, undefined, ptr('partners_Tenant', tenantId));
    expect(result?.code).not.toBe(400);
    expect(await inboxRowOf(member)).toBeUndefined();
    expect(await rows('bs_InboundMail', { InboxId: ptr('bs_MailInbox', inboxId) })).toEqual([]);
  });
});
