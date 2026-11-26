// Self sign-up (BS_SELF_SIGNUP=true): Sign in with BetterID makes an account
// for a VLAD with no link and a verified email (cloud/parsefunction/bsidlogin.js,
// utils/bsSelfSignup.js, utils/bsSignInDecision.js), against the mock bs-id.
import crypto from 'node:crypto';
import {
  MASTER,
  ORIGIN,
  PARSE,
  PUBLIC,
  cbor,
  identity,
  link,
  mkOwner,
  mkUser,
  req,
  tag,
} from './support/lib.js';
import { bsidLoginParams } from './support/bsid.js';
import { verifier } from './support/verifier.js';
import { recordSignInAttempt } from '../../utils/bsIdentity.js';

const emailClaims = email => ({
  email,
  email_verified: true,
  bs_email_verified_at: Math.floor(Date.now() / 1000) - 60,
});
const bsidlogin = (vlad, claims) =>
  req('POST', `${PARSE}/functions/bsidlogin`, {
    headers: PUBLIC,
    body: bsidLoginParams(vlad, claims),
  });
const find = async (className, where) =>
  (
    await req(
      'GET',
      `${PARSE}/classes/${className}?` + new URLSearchParams({ where: JSON.stringify(where) }),
      { headers: MASTER }
    )
  ).json.results;
const ptr = (className, objectId) => ({ __type: 'Pointer', className, objectId });

describe('Self sign-up through Sign in with BetterID', () => {
  beforeEach(() => {
    process.env.BS_SELF_SIGNUP = 'true';
    verifier.mode = 'ok';
  });
  afterEach(() => delete process.env.BS_SELF_SIGNUP);

  it('makes an admin account with its own organization, links the VLAD, and signs in', async () => {
    const id = identity();
    const email = `new-${tag()}@example.com`;
    const r = await bsidlogin(id.vlad, { ...emailClaims(email.toUpperCase()), name: 'Jane Doe' });
    expect(r.status).toBe(200);
    const { objectId, sessionToken, created } = r.json.result;
    expect(r.json.result.email).toBe(email);
    expect(created).toBe(true);
    expect(sessionToken).toMatch(/^r:/);

    const [ext] = await find('contracts_Users', { UserId: ptr('_User', objectId) });
    expect(ext).toEqual(
      jasmine.objectContaining({ Email: email, Name: 'Jane Doe', UserRole: 'contracts_Admin' })
    );
    expect(ext.OrganizationId).toBeDefined();
    expect(ext.TeamIds.length).toBe(1);
    const [tenant] = await find('partners_Tenant', { objectId: ext.TenantId.objectId });
    expect(tenant).toEqual(
      jasmine.objectContaining({ TenantName: 'Jane Doe', EmailAddress: email, BsSelfSignup: true })
    );
    const [org] = await find('contracts_Organizations', { objectId: ext.OrganizationId.objectId });
    expect(org.TenantId.objectId).toBe(tenant.objectId);
    const rows = await find('bs_Identity', { vlad: id.vlad });
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(jasmine.objectContaining({ Active: true, Label: 'Self sign-up' }));
    expect(rows[0].UserId.objectId).toBe(objectId);

    // getUserDetails (what Login.jsx needs to finish) answers for the session.
    const details = await req('POST', `${PARSE}/functions/getUserDetails`, {
      headers: { ...PUBLIC, 'X-Parse-Session-Token': sessionToken },
    });
    expect(details.json.result.objectId).toBe(ext.objectId);

    // Next time it's an ordinary sign-in to the same account.
    const again = await bsidlogin(id.vlad, emailClaims(email));
    expect(again.json.result.objectId).toBe(objectId);
    expect(again.json.result.created).toBe(false);
  });

  it('uses the email for the name when the token has none', async () => {
    const id = identity();
    const email = `jane.doe-${tag()}@example.com`;
    const r = await bsidlogin(id.vlad, emailClaims(email));
    const [ext] = await find('contracts_Users', { Email: email });
    expect(ext.Name).toMatch(/^Jane Doe /);
    expect(r.json.result.created).toBe(true);
  });

  it('takes over its own unassigned sign-in attempt row', async () => {
    const id = identity();
    await recordSignInAttempt(id.vlad);
    const r = await bsidlogin(id.vlad, emailClaims(`attempt-${tag()}@example.com`));
    expect(r.status).toBe(200);
    const rows = await find('bs_Identity', { vlad: id.vlad });
    expect(rows.length).toBe(1);
    expect(rows[0].Active).toBe(true);
    expect(rows[0].UserId.objectId).toBe(r.json.result.objectId);
  });

  it("makes the account on a recipient's _User", async () => {
    const id = identity();
    const email = `recipient-${tag()}@example.com`;
    const recipientId = await mkUser(email); // as OpenSign does for a contact
    const r = await bsidlogin(id.vlad, emailClaims(email));
    expect(r.status).toBe(200);
    expect(r.json.result.objectId).toBe(recipientId);
    expect((await find('contracts_Users', { Email: email })).length).toBe(1);
  });

  it("refuses an email an account already has, doesn't link it, and records the VLAD", async () => {
    const id = identity();
    const email = `taken-${tag()}@example.com`;
    await mkOwner(email);
    const r = await bsidlogin(id.vlad, emailClaims(email));
    expect(r.json.code).toBe(101);
    expect(r.json.error).toContain(`already uses ${email}`);
    const rows = await find('bs_Identity', { vlad: id.vlad });
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(jasmine.objectContaining({ Active: false, Label: 'Sign-in attempt' }));
    expect(rows[0].UserId).toBeUndefined();
  });

  it('refuses without a verified email and says how to link one', async () => {
    for (const claims of [{}, { email: `unverified-${tag()}@example.com` }]) {
      const id = identity();
      const r = await bsidlogin(id.vlad, claims);
      expect(r.json.code).toBe(101);
      expect(r.json.error).toMatch(/Settings → Account → Link an email address/);
      expect((await find('bs_Identity', { vlad: id.vlad })).length).toBe(1); // recorded
    }
  });

  it("doesn't sign up a VLAD whose link an admin turned off", async () => {
    const id = identity();
    const { userId } = await mkOwner(`off-${tag()}@example.com`);
    await link(id, userId, { Active: false });
    const r = await bsidlogin(id.vlad, emailClaims(`off-new-${tag()}@example.com`));
    expect(r.json.code).toBe(101);
    expect(r.json.error).toMatch(/isn't linked/);
  });

  it('makes one account when the same VLAD signs in twice at once', async () => {
    const id = identity();
    const email = `race-${tag()}@example.com`;
    const results = await Promise.all([
      bsidlogin(id.vlad, emailClaims(email)),
      bsidlogin(id.vlad, emailClaims(email)),
      bsidlogin(id.vlad, emailClaims(email)),
    ]);
    const ok = results.filter(r => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map(r => r.json.result.objectId)).size).toBe(1);
    expect(ok.filter(r => r.json.result.created).length).toBe(1);
    expect((await find('_User', { username: email })).length).toBe(1);
    expect((await find('contracts_Users', { Email: email })).length).toBe(1);
    expect((await find('partners_Tenant', { EmailAddress: email })).length).toBe(1);
    expect((await find('bs_Identity', { vlad: id.vlad, Active: true })).length).toBe(1);
  });

  it("makes one account when a recipient's VLAD signs in twice at once", async () => {
    const id = identity();
    const email = `race-recipient-${tag()}@example.com`;
    await mkUser(email);
    const results = await Promise.all([
      bsidlogin(id.vlad, emailClaims(email)),
      bsidlogin(id.vlad, emailClaims(email)),
    ]);
    expect(results.filter(r => r.status === 200 && r.json.result.created).length).toBe(1);
    expect((await find('contracts_Users', { Email: email })).length).toBe(1);
    expect((await find('partners_Tenant', { EmailAddress: email })).length).toBe(1);
  });

  it('is off unless BS_SELF_SIGNUP is true', async () => {
    delete process.env.BS_SELF_SIGNUP;
    const id = identity();
    const email = `off-switch-${tag()}@example.com`;
    const r = await bsidlogin(id.vlad, emailClaims(email));
    expect(r.json.code).toBe(101);
    expect(r.json.error).toMatch(/isn't linked/);
    expect((await find('_User', { username: email })).length).toBe(0);
  });

  it("keeps the unassigned sign-in attempts off a self sign-up admin's Users page", async () => {
    const pending = identity();
    await recordSignInAttempt(pending.vlad);
    const [row] = await find('bs_Identity', { vlad: pending.vlad });
    const r = await bsidlogin(identity().vlad, emailClaims(`admin-${tag()}@example.com`));
    const session = { ...PUBLIC, 'X-Parse-Session-Token': r.json.result.sessionToken };
    const call = (fn, body = {}) =>
      req('POST', `${PARSE}/functions/${fn}`, { headers: session, body });
    const list = (await call('bsidentitylist')).json.result;
    expect(list.identities.some(i => i.vlad === pending.vlad)).toBe(false);
    expect(list.identities.length).toBe(1); // its own link
    expect(
      (await call('bsidentitysave', { id: row.objectId, userId: r.json.result.objectId })).json.code
    ).toBe(101);
    expect((await call('bsidentitydelete', { id: row.objectId })).json.code).toBe(101);
  });

  describe('through the extension (bsextlogin)', () => {
    const run = (name, body = {}) =>
      req('POST', `${PARSE}/functions/${name}`, { headers: PUBLIC, body });
    function approve(id, ch) {
      const statement = cbor({
        v: 1,
        type: 'bs-login',
        vlad: Buffer.from(id.vlad, 'hex'),
        origin: ORIGIN,
        rp: 'bs-opensign',
        challenge: Buffer.from(ch.challenge, 'base64url'),
        reqId: crypto.randomBytes(16),
        extSignPub: crypto.randomBytes(32),
        iat: Math.floor(Date.now() / 1000),
      });
      const digest = crypto
        .createHash('sha256')
        .update(Buffer.concat([Buffer.from('bs-login/v1/statement\n'), statement]))
        .digest();
      return {
        challengeId: ch.challengeId,
        statement: statement.toString('base64url'),
        vladSig: crypto.sign(null, digest, id.privateKey).toString('base64url'),
      };
    }

    it('sends an unlinked VLAD to the passkey (code 4201), without an account or a record', async () => {
      const id = identity();
      verifier.register(id);
      const r = await run('bsextlogin', approve(id, (await run('bsextchallenge')).json.result));
      expect(r.json.code).toBe(4201);
      expect((await find('bs_Identity', { vlad: id.vlad })).length).toBe(0);
    });

    it('refuses as before when self sign-up is off', async () => {
      delete process.env.BS_SELF_SIGNUP;
      const id = identity();
      verifier.register(id);
      const r = await run('bsextlogin', approve(id, (await run('bsextchallenge')).json.result));
      expect(r.json.code).toBe(101);
      expect(r.json.error).toMatch(/isn't linked/);
    });
  });
});
