// Team seat licenses: Sign in with BetterID (bsidlogin) with a license in the
// id_token creates the account (BS_LICENSE_PROVISIONING) or gates it
// (BS_LICENSE_REQUIRED), and the Team seats functions call the license
// service's product API as the admin's VLAD (a mock license service here).
import http from 'node:http';
import {
  MASTER,
  PARSE,
  PUBLIC,
  identity,
  link,
  mkMember,
  mkTenant,
  req,
  tag,
} from './support/lib.js';
import { bsidLoginParams } from './support/bsid.js';

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

describe('Team seat licenses', () => {
  let saved;
  let tenantId;

  beforeAll(async () => {
    tenantId = await mkTenant();
    await mkMember(tenantId, 'contracts_Admin');
  });

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

  describe('Team seats functions', () => {
    let server;
    let calls;
    let admin;
    let adminId;
    const TEAM = { id: 'team_seats1', name: 'Seats Inc', product: 'docsign', seats_paid: 3 };

    beforeAll(async () => {
      calls = [];
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
          if (rq.headers['x-acting-vlad'] !== adminId.vlad) {
            return send(403, { error: 'not_admin', error_description: 'Not a team admin.' });
          }
          if (rq.url === '/v1/product/teams') return send(200, { teams: [TEAM] });
          if (rq.url === `/v1/product/teams/${TEAM.id}`) {
            return send(200, {
              team: TEAM,
              seats: [
                { vlad: adminId.vlad, state: 'active', claimed_at: 1 },
                { vlad: 'aa'.repeat(40), state: 'pending', claimed_at: 2 },
              ],
            });
          }
          if (rq.url.endsWith('/rotate-code'))
            return send(200, { join_code: 'DOCS-AAAA-BBBB-CCCC' });
          if (rq.url.endsWith('/remove') || rq.url.endsWith('/approve'))
            return send(200, { ok: true });
          return send(404, { error: 'not_found' });
        });
      });
      await new Promise(resolve => server.listen(LICENSE_PORT, resolve));
      admin = await mkMember(tenantId, 'contracts_OrgAdmin');
      adminId = identity();
      await link(adminId, admin.userId);
    });

    afterAll(() => new Promise(resolve => server.close(resolve)));

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
