// Team seat licenses: Sign in with BetterID (bsidlogin) with a license in the
// id_token creates the account (BS_LICENSE_PROVISIONING) or gates it
// (BS_LICENSE_REQUIRED), and the Team seats functions call the license
// service's product API as the admin's VLAD (a mock license service here).
import crypto from 'node:crypto';
import http from 'node:http';
import {
  API,
  MASTER,
  ORIGIN,
  PARSE,
  PUBLIC,
  bearer,
  cbor,
  identity,
  link,
  mkMember,
  mkTenant,
  req,
  signIn,
  tag,
} from './support/lib.js';
import { bsidLoginParams } from './support/bsid.js';
import { verifier } from './support/verifier.js';

const LICENSE_PORT = 8794;
const ENV_KEYS = [
  'BS_LICENSE_PROVISIONING',
  'BS_LICENSE_REQUIRED',
  'BS_LICENSE_TENANT_ID',
  'LICENSE_URL',
  'LICENSE_PRODUCT_TOKEN',
];

const seat = (team, over = {}) => ({
  license: {
    jti: `jti-${tag()}`,
    team,
    team_name: `Team ${team}`,
    product: 'docsign',
    plan: 'hosted-unlimited',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  },
  entitlements: ['docsign.send'],
  team,
});

const bsidlogin = (vlad, extra) =>
  req('POST', `${PARSE}/functions/bsidlogin`, {
    headers: PUBLIC,
    body: bsidLoginParams(vlad, extra),
  });
// The extension's one-tap sign-in (bsextlogin): the phone's approval of a
// challenge, as bsextlogin.spec.js builds it.
async function extLogin(id) {
  const run = (name, body = {}) =>
    req('POST', `${PARSE}/functions/${name}`, { headers: PUBLIC, body });
  const ch = (await run('bsextchallenge')).json.result;
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
  return run('bsextlogin', {
    challengeId: ch.challengeId,
    statement: statement.toString('base64url'),
    vladSig: crypto.sign(null, digest, id.privateKey).toString('base64url'),
  });
}

const find = async (className, where) =>
  (
    await req(
      'GET',
      `${PARSE}/classes/${className}?` + new URLSearchParams({ where: JSON.stringify(where) }),
      { headers: MASTER }
    )
  ).json.results;
const extOf = async userId =>
  (
    await find('contracts_Users', {
      UserId: { __type: 'Pointer', className: '_User', objectId: userId },
    })
  )[0];

const TEAM = { id: 'team_seats1', name: 'Seats Inc', product: 'docsign', seats_paid: 3 };

describe('Team seat licenses', () => {
  let saved;
  let tenantId;
  let server;
  let adminId = null; // the Team seats functions' admin
  const calls = [];
  const teamAdmins = new Map(); // vlad -> license team ids it administers

  beforeAll(async () => {
    tenantId = await mkTenant();
    await mkMember(tenantId, 'contracts_Admin');
    server = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', c => (body += c));
      rq.on('end', () => {
        calls.push({
          method: rq.method,
          url: rq.url,
          auth: rq.headers.authorization,
          acting: rq.headers['x-acting-vlad'],
          body: body ? JSON.parse(body) : null,
        });
        const send = (status, obj) => {
          rs.writeHead(status, { 'content-type': 'application/json' });
          rs.end(JSON.stringify(obj));
        };
        const acting = rq.headers['x-acting-vlad'];
        // VLADs a spec made admins of other teams (provisioned sign-ins).
        if (teamAdmins.has(acting) && rq.url === '/v1/product/teams') {
          return send(200, { teams: teamAdmins.get(acting).map(id => ({ id })) });
        }
        if (acting !== adminId?.vlad) {
          return send(403, { error: 'not_admin', error_description: 'Not a team admin.' });
        }
        if (rq.url === '/v1/product/teams') return send(200, { teams: [TEAM] });
        if (rq.url === `/v1/product/teams/${TEAM.id}`) {
          return send(200, {
            team: TEAM,
            seats: [
              {
                vlad: adminId.vlad,
                state: 'active',
                requested_at: 1,
                claimed_at: 1,
                license_exp: 2,
              },
              { vlad: 'aa'.repeat(40), state: 'pending', requested_at: 2, claimed_at: null },
            ],
            admins: [{ vlad: adminId.vlad, added_at: 1 }],
          });
        }
        if (rq.url.endsWith('/rotate-code'))
          return send(200, {
            join_code: 'DOCS-AAAA-BBBB-CCCC',
            join_link: 'https://license.betterid.net/join?code=DOCS-AAAA-BBBB-CCCC',
          });
        if (rq.url.endsWith('/remove') || rq.url.endsWith('/approve'))
          return send(200, { ok: true });
        return send(404, { error: 'not_found' });
      });
    });
    await new Promise(resolve => server.listen(LICENSE_PORT, resolve));
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.BS_LICENSE_TENANT_ID = tenantId;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('sign-in', () => {
    it('changes nothing while provisioning is off', async () => {
      const r = await bsidlogin(identity().vlad, seat(`t${tag()}`));
      expect(r.json.code).toBe(4404);
    });

    it("creates a seat holder's account in their team's organization, once per team", async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const team = `t${tag()}`;
      const ada = identity();
      const email = `ada-${tag()}@example.com`;
      // A sign-in attempt from before the seat, recorded for an admin.
      expect((await bsidlogin(ada.vlad)).json.code).toBe(4404);

      const r = await bsidlogin(ada.vlad, { ...seat(team), email, name: 'Ada' });
      expect(r.status).toBe(200);
      expect(r.json.result.email).toBe(email);
      expect(r.json.result.sessionToken).toMatch(/^r:/);
      const userId = r.json.result.objectId;

      const [mapping] = await find('bs_LicenseTeam', { LicenseTeam: team });
      expect(mapping.Name).toBe(`Team ${team}`);
      expect(mapping.TenantId.objectId).toBe(tenantId);
      expect(mapping.ACL).toEqual({});
      const ext = await extOf(userId);
      expect(ext).toEqual(
        jasmine.objectContaining({ Name: 'Ada', Email: email, UserRole: 'contracts_User' })
      );
      expect(ext.OrganizationId.objectId).toBe(mapping.OrganizationId.objectId);
      expect(ext.TenantId.objectId).toBe(tenantId);
      expect(ext.TeamIds.map(t => t.objectId)).toEqual([mapping.TeamId.objectId]);
      const [org] = await find('contracts_Organizations', {
        objectId: mapping.OrganizationId.objectId,
      });
      expect(org.Name).toBe(`Team ${team}`);

      // Its recorded attempt became the link.
      const links = await find('bs_Identity', { vlad: ada.vlad });
      expect(links.length).toBe(1);
      expect(links[0]).toEqual(
        jasmine.objectContaining({ Active: true, Label: 'BetterID team seat' })
      );
      expect(links[0].UserId.objectId).toBe(userId);

      // Next time it's an ordinary sign-in, even without the license.
      const again = await bsidlogin(ada.vlad);
      expect(again.json.result.objectId).toBe(userId);

      // A second member joins the same organization; no email means a placeholder.
      const bob = identity();
      const b = await bsidlogin(bob.vlad, seat(team));
      expect(b.status).toBe(200);
      expect(b.json.result.email).toMatch(/^[0-9a-f]{16}@users\.betterid\.invalid$/);
      expect((await extOf(b.json.result.objectId)).OrganizationId.objectId).toBe(
        mapping.OrganizationId.objectId
      );
      expect((await find('bs_LicenseTeam', { LicenseTeam: team })).length).toBe(1);
    });

    it('never signs in to another account by its email', async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const taken = await mkMember(tenantId);
      const r = await bsidlogin(identity().vlad, { ...seat(`t${tag()}`), email: taken.email });
      expect(r.status).toBe(200);
      expect(r.json.result.objectId).not.toBe(taken.userId);
      expect(r.json.result.email).toMatch(/@users\.betterid\.invalid$/);
    });

    it('refuses as before without a valid seat', async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const expired = seat(`t${tag()}`, { exp: Math.floor(Date.now() / 1000) - 10 });
      expect((await bsidlogin(identity().vlad, expired)).json.code).toBe(4404);
      const noSend = { ...seat(`t${tag()}`), entitlements: [] };
      expect((await bsidlogin(identity().vlad, noSend)).json.code).toBe(4404);
    });

    it('with BS_LICENSE_REQUIRED, needs a seat for the team of a team account', async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const team = `t${tag()}`;
      const id = identity();
      const first = await bsidlogin(id.vlad, seat(team));
      expect(first.status).toBe(200);

      process.env.BS_LICENSE_REQUIRED = 'true';
      const none = await bsidlogin(id.vlad);
      expect(none.json.code).toBe(119); // OPERATION_FORBIDDEN
      expect(none.json.error).toMatch(/doesn't have a Better DocSign seat/);
      expect((await bsidlogin(id.vlad, seat(`t${tag()}`))).json.code).toBe(119);
      expect((await bsidlogin(id.vlad, seat(team))).json.result.objectId).toBe(
        first.json.result.objectId
      );

      // Accounts outside team organizations aren't gated.
      const other = await mkMember(tenantId);
      const otherId = identity();
      await link(otherId, other.userId);
      expect((await bsidlogin(otherId.vlad)).json.result.objectId).toBe(other.userId);
    });
  });

  describe('the extension and the desktop API', () => {
    it('with BS_LICENSE_REQUIRED, refuse team accounts, which carry no seat there', async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const id = identity();
      verifier.register(id);
      const first = await bsidlogin(id.vlad, seat(`t${tag()}`));
      expect(first.status).toBe(200);

      // Off: both work, as before.
      expect((await extLogin(id)).json.result.objectId).toBe(first.json.result.objectId);
      const token = await signIn(id);
      expect(token.status).toBe(200);
      const auth = bearer(token.json.access_token);
      expect((await req('GET', `${API}/api/v1/me`, { headers: auth })).status).toBe(200);

      process.env.BS_LICENSE_REQUIRED = 'true';
      const ext = await extLogin(id);
      expect(ext.json.code).toBe(119);
      expect(ext.json.error).toMatch(/doesn't have a Better DocSign seat/);
      const desk = await signIn(id);
      expect(desk.status).toBe(403);
      expect(desk.json).toEqual(jasmine.objectContaining({ error: 'no_seat', code: 119 }));
      // A token from before the gate stops too.
      const me = await req('GET', `${API}/api/v1/me`, { headers: auth });
      expect(me.status).toBe(403);
      expect(me.json.error).toBe('no_seat');
    });

    it('leave accounts outside team organizations alone', async () => {
      process.env.BS_LICENSE_REQUIRED = 'true';
      const other = await mkMember(tenantId);
      const id = identity();
      verifier.register(id);
      await link(id, other.userId);
      expect((await extLogin(id)).json.result.objectId).toBe(other.userId);
      expect((await signIn(id)).status).toBe(200);
    });

    it("don't create accounts", async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const id = identity();
      verifier.register(id);
      expect((await extLogin(id)).json.code).toBe(4404);
      expect((await signIn(id)).status).toBe(403);
    });
  });

  describe("a team's admin", () => {
    it('gets contracts_OrgAdmin when the license service lists the team for their VLAD', async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      process.env.LICENSE_URL = `http://localhost:${LICENSE_PORT}`;
      process.env.LICENSE_PRODUCT_TOKEN = 'product-secret';
      const team = `t${tag()}`;
      const boss = identity();
      teamAdmins.set(boss.vlad, [team]);
      const member = identity();
      teamAdmins.set(member.vlad, [`t${tag()}`]); // an admin of another team only

      const b = await bsidlogin(boss.vlad, seat(team));
      expect((await extOf(b.json.result.objectId)).UserRole).toBe('contracts_OrgAdmin');
      const m = await bsidlogin(member.vlad, seat(team));
      expect((await extOf(m.json.result.objectId)).UserRole).toBe('contracts_User');
      expect(calls.filter(c => c.acting === boss.vlad)[0]).toEqual(
        jasmine.objectContaining({ url: '/v1/product/teams', auth: 'Bearer product-secret' })
      );
    });

    it("gets contracts_User without a product token, or if the service can't be asked", async () => {
      process.env.BS_LICENSE_PROVISIONING = 'true';
      const team = `t${tag()}`;
      const a = identity();
      teamAdmins.set(a.vlad, [team]);
      const before = calls.length;
      const r1 = await bsidlogin(a.vlad, seat(team));
      expect((await extOf(r1.json.result.objectId)).UserRole).toBe('contracts_User');
      expect(calls.length).toBe(before);

      process.env.LICENSE_URL = 'http://localhost:1';
      process.env.LICENSE_PRODUCT_TOKEN = 'product-secret';
      const b = identity();
      const r2 = await bsidlogin(b.vlad, seat(team));
      expect(r2.status).toBe(200);
      expect((await extOf(r2.json.result.objectId)).UserRole).toBe('contracts_User');
    });
  });

  describe('Team seats functions', () => {
    let admin;

    beforeAll(async () => {
      admin = await mkMember(tenantId, 'contracts_OrgAdmin');
      adminId = identity();
      await link(adminId, admin.userId);
    });

    beforeEach(() => {
      process.env.LICENSE_URL = `http://localhost:${LICENSE_PORT}`;
      process.env.LICENSE_PRODUCT_TOKEN = 'product-secret';
      calls.length = 0;
    });

    const run = (fn, params = {}, headers = admin.session) =>
      req('POST', `${PARSE}/functions/${fn}`, { headers, body: params });

    it("lists the admin's teams and a team's seats, acting as their VLAD", async () => {
      const list = await run('bslicenseteams');
      expect(list.json.result).toEqual({
        configured: true,
        teams: [{ ...TEAM, organization: null }],
      });
      expect(calls[0]).toEqual(
        jasmine.objectContaining({ auth: 'Bearer product-secret', acting: adminId.vlad })
      );
      const one = await run('bslicenseteam', { id: TEAM.id });
      const seats = one.json.result.seats;
      expect(seats[0].account.email).toBe(admin.email);
      expect(seats[1].account).toBeNull();
    });

    it('removes, approves and rotates', async () => {
      const holder = 'aa'.repeat(40);
      expect((await run('bslicenseremove', { id: TEAM.id, vlad: holder })).status).toBe(200);
      expect((await run('bslicenseapprove', { id: TEAM.id, vlad: holder })).status).toBe(200);
      expect((await run('bslicenserotate', { id: TEAM.id })).json.result).toEqual({
        join_code: 'DOCS-AAAA-BBBB-CCCC',
        join_link: 'https://license.betterid.net/join?code=DOCS-AAAA-BBBB-CCCC',
      });
      expect(calls.map(c => [c.method, c.url, c.body])).toEqual([
        ['POST', `/v1/product/teams/${TEAM.id}/remove`, { vlad: holder }],
        ['POST', `/v1/product/teams/${TEAM.id}/approve`, { vlad: holder }],
        ['POST', `/v1/product/teams/${TEAM.id}/rotate-code`, {}],
      ]);
    });

    it("is for admins only, and passes on the service's refusal", async () => {
      const user = await mkMember(tenantId);
      await link(identity(), user.userId);
      expect((await run('bslicenseteams', {}, user.session)).json.code).toBe(119);
      expect((await run('bslicenseteams', {}, PUBLIC)).json.code).toBe(209);
      expect(calls.length).toBe(0);

      const otherAdmin = await mkMember(tenantId, 'contracts_Admin');
      await link(identity(), otherAdmin.userId);
      const r = await run('bslicenseteams', {}, otherAdmin.session);
      expect(r.json.code).toBe(119);
      expect(r.json.error).toMatch(/isn't an admin of this team/);

      const unlinked = await mkMember(tenantId, 'contracts_Admin');
      expect((await run('bslicenseteams', {}, unlinked.session)).json.error).toMatch(
        /no BetterID identity/
      );
    });

    it('says when the license service is not set up or unreachable', async () => {
      delete process.env.LICENSE_PRODUCT_TOKEN;
      expect((await run('bslicenseteams')).json.result).toEqual({ configured: false, teams: [] });
      expect((await run('bslicenseteam', { id: TEAM.id })).json.error).toMatch(/aren't set up/);
      process.env.LICENSE_PRODUCT_TOKEN = 'product-secret';
      process.env.LICENSE_URL = 'http://localhost:1';
      expect((await run('bslicenseteams')).json.error).toMatch(/Couldn't reach/);
    });
  });
});
