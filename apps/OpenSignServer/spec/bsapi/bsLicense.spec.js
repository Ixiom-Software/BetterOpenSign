// Team seat licenses (utils/bsLicense.js): which id_token licenses give a
// seat, what a sign-in does with one, and the license service's product API.
import {
  accountDetails,
  licenseConfig,
  licenseFromClaims,
  placeholderEmail,
  productApi,
  signInDecision,
} from '../../utils/bsLicense.js';

const NOW = 1_800_000_000;
const VLAD = '8724' + 'ab'.repeat(38);

const claims = (license = {}, extra = {}) => ({
  vlad: VLAD,
  license: {
    jti: 'jti-1',
    team: 'team_abc123',
    team_name: 'Acme Legal',
    product: 'docsign',
    plan: 'hosted-unlimited',
    exp: NOW + 3600,
    ...license,
  },
  entitlements: ['docsign.send'],
  team: license.team ?? 'team_abc123',
  ...extra,
});

describe('licenseFromClaims', () => {
  it('accepts a docsign seat with docsign.send that has not expired', () => {
    const r = licenseFromClaims(claims(), NOW);
    expect(r.ok).toBe(true);
    expect(r.license).toEqual({
      jti: 'jti-1',
      team: 'team_abc123',
      teamName: 'Acme Legal',
      product: 'docsign',
      plan: 'hosted-unlimited',
      exp: NOW + 3600,
      entitlements: ['docsign.send'],
    });
  });

  it('says why it refuses one', () => {
    const reason = c => licenseFromClaims(c, NOW).reason;
    expect(reason({ vlad: VLAD })).toBe('no_license');
    expect(reason(undefined)).toBe('no_license');
    expect(reason({ license: 'x' })).toBe('malformed');
    expect(reason({ license: [] })).toBe('malformed');
    expect(reason(claims({ jti: '' }))).toBe('malformed');
    expect(reason(claims({ exp: '1900000000' }))).toBe('malformed');
    expect(reason(claims({ team: '../ops' }))).toBe('malformed');
    expect(reason(claims({ product: 'credentials' }))).toBe('wrong_product');
    expect(reason(claims({}, { entitlements: ['docsign.limit.20'] }))).toBe('no_entitlement');
    expect(reason(claims({}, { entitlements: undefined }))).toBe('no_entitlement');
    expect(reason(claims({ exp: NOW }))).toBe('expired');
    expect(reason(claims({ exp: NOW - 1 }))).toBe('expired');
    expect(reason(claims({}, { team: 'team_other' }))).toBe('team_mismatch');
  });

  it("doesn't need the top-level team, and names a team that has no name", () => {
    const c = claims({ team_name: '  ' });
    delete c.team;
    const r = licenseFromClaims(c, NOW);
    expect(r.ok).toBe(true);
    expect(r.license.teamName).toBe('');
  });
});

describe('signInDecision', () => {
  const ok = licenseFromClaims(claims(), NOW);
  const none = licenseFromClaims({ vlad: VLAD }, NOW);
  const linked = { user: { id: 'u1' }, email: 'a@example.com' };
  const cfg = (over = {}) => ({ provisioning: false, required: false, ...over });
  const decide = (account, license, over = {}, accountTeam = null) =>
    signInDecision({ account, license, accountTeam, config: cfg(over) });

  it('signs in a linked VLAD as before, whatever its license, while nothing is turned on', () => {
    expect(decide(linked, none).action).toBe('sign_in');
    expect(decide(linked, ok).action).toBe('sign_in');
    expect(decide(linked, none, {}, 'team_abc123').action).toBe('sign_in');
    expect(decide(linked, null, { required: true }, 'team_abc123').action).toBe('sign_in');
  });

  it('with BS_LICENSE_REQUIRED, needs a seat for the team of an account in a team organization', () => {
    const on = { required: true };
    expect(decide(linked, ok, on, 'team_abc123')).toEqual({ action: 'sign_in' });
    expect(decide(linked, none, on, 'team_abc123')).toEqual({
      action: 'refuse',
      reason: 'no_seat',
      detail: 'no_license',
    });
    expect(decide(linked, ok, on, 'team_other')).toEqual({
      action: 'refuse',
      reason: 'other_team',
    });
    // Accounts outside team organizations aren't gated.
    expect(decide(linked, none, on, null)).toEqual({ action: 'sign_in' });
  });

  it('with BS_LICENSE_PROVISIONING, creates an account for an unlinked VLAD with a seat', () => {
    const on = { provisioning: true };
    expect(decide({ reason: 'not_linked' }, ok, on)).toEqual({ action: 'provision' });
    expect(decide({ reason: 'inactive', unassigned: true }, ok, on)).toEqual({
      action: 'provision',
    });
  });

  it('refuses as before otherwise', () => {
    const on = { provisioning: true };
    // No seat, or provisioning off.
    expect(decide({ reason: 'not_linked' }, none, on)).toEqual({
      action: 'refuse',
      reason: 'not_linked',
    });
    expect(decide({ reason: 'not_linked' }, ok)).toEqual({
      action: 'refuse',
      reason: 'not_linked',
    });
    // The extension sign-in carries no claims.
    expect(decide({ reason: 'not_linked' }, null, on).action).toBe('refuse');
    // A link an admin turned off, a broken link, an account that's gone.
    expect(decide({ reason: 'inactive', unassigned: false }, ok, on)).toEqual({
      action: 'refuse',
      reason: 'inactive',
    });
    expect(decide({ reason: 'ambiguous' }, ok, on).action).toBe('refuse');
    expect(decide({ reason: 'no_account' }, ok, on).action).toBe('refuse');
  });
});

describe('account details for a new seat holder', () => {
  it('uses the id_token email and name', () => {
    expect(accountDetails({ email: ' Ada@Example.COM ', name: 'Ada L' }, VLAD)).toEqual({
      email: 'ada@example.com',
      placeholder: placeholderEmail(VLAD),
      name: 'Ada L',
    });
    expect(accountDetails({ email: 'ada@example.com' }, VLAD).name).toBe('ada');
  });

  it('falls back to a placeholder that is unique per VLAD and never delivered', () => {
    const d = accountDetails({ email: 'not an email' }, VLAD);
    expect(d.email).toBe('');
    expect(d.name).toBe('BetterID user');
    expect(d.placeholder).toMatch(/^[0-9a-f]{16}@users\.betterid\.invalid$/);
    expect(placeholderEmail(VLAD.toUpperCase())).toBe(d.placeholder);
    // VLADs share their leading bytes; the placeholders still differ.
    expect(placeholderEmail(VLAD.slice(0, -2) + 'cd')).not.toBe(d.placeholder);
  });
});

describe('licenseConfig', () => {
  it('is off by default', () => {
    expect(licenseConfig({})).toEqual({
      provisioning: false,
      required: false,
      tenantId: '',
      url: 'https://license.betterid.net',
      productToken: '',
    });
    const c = licenseConfig({
      BS_LICENSE_PROVISIONING: 'true',
      BS_LICENSE_REQUIRED: 'true',
      LICENSE_URL: 'http://localhost:9/',
      LICENSE_PRODUCT_TOKEN: 'tok',
    });
    expect(c.provisioning && c.required).toBe(true);
    expect(c.url).toBe('http://localhost:9');
  });
});

describe('productApi', () => {
  const ADMIN = '8724' + 'ee'.repeat(38);
  let realFetch;
  let calls;
  let replies;
  const reply = (status, body) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const api = () => productApi({ url: 'https://license.example', productToken: 'prod-token' });

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    replies = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next || reply(200, {});
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('lists teams as the acting admin, with the product token', async () => {
    const teams = [{ id: 't1', name: 'Acme', seats_paid: 5, seats_used: 2 }];
    replies.push(reply(200, { teams }));
    expect(await api().teams(ADMIN)).toEqual({ teams });
    const { url, init } = calls[0];
    expect(url).toBe('https://license.example/v1/product/teams');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer prod-token');
    expect(init.headers['x-acting-vlad']).toBe(ADMIN);
    expect(init.body).toBeUndefined();
  });

  it('calls each team route with its body', async () => {
    const a = api();
    await a.team(ADMIN, 't1');
    await a.remove(ADMIN, 't1', 'aa11');
    await a.approve(ADMIN, 't1', 'bb22');
    replies.push(reply(200, { join_code: 'DOCS-1111-2222-3333' }));
    expect(await a.rotateCode(ADMIN, 't1')).toEqual({ join_code: 'DOCS-1111-2222-3333' });
    expect(calls.map(c => [c.init.method, c.url.replace('https://license.example', '')])).toEqual([
      ['GET', '/v1/product/teams/t1'],
      ['POST', '/v1/product/teams/t1/remove'],
      ['POST', '/v1/product/teams/t1/approve'],
      ['POST', '/v1/product/teams/t1/rotate-code'],
    ]);
    expect(JSON.parse(calls[1].init.body)).toEqual({ vlad: 'aa11' });
    expect(JSON.parse(calls[2].init.body)).toEqual({ vlad: 'bb22' });
    expect(calls[1].init.headers['content-type']).toBe('application/json');
  });

  it('refuses a team id that could leave the route, without calling', async () => {
    await expectAsync(api().team(ADMIN, '../ops/teams')).toBeRejectedWith(
      jasmine.objectContaining({ status: 400, code: 'bad_team' })
    );
    await expectAsync(api().remove(ADMIN, 't1/x', 'aa')).toBeRejected();
    expect(calls.length).toBe(0);
  });

  it("passes on the service's error", async () => {
    replies.push(
      reply(403, { error: 'not_admin', error_description: 'Not an admin of this team.' })
    );
    await expectAsync(api().team(ADMIN, 't1')).toBeRejectedWith(
      jasmine.objectContaining({
        status: 403,
        code: 'not_admin',
        message: 'Not an admin of this team.',
      })
    );
  });

  it('says when the service is unreachable or answers nonsense', async () => {
    replies.push(new TypeError('fetch failed'));
    await expectAsync(api().teams(ADMIN)).toBeRejectedWith(
      jasmine.objectContaining({ status: 0, code: 'unreachable' })
    );
    replies.push(reply(200, '<html>'));
    await expectAsync(api().teams(ADMIN)).toBeRejectedWith(
      jasmine.objectContaining({ status: 0, code: 'bad_answer' })
    );
    replies.push(reply(502, '<html>'));
    await expectAsync(api().teams(ADMIN)).toBeRejectedWith(
      jasmine.objectContaining({ status: 502 })
    );
  });

  it("doesn't call without a product token", async () => {
    await expectAsync(
      productApi({ url: 'https://license.example', productToken: '' }).teams(ADMIN)
    ).toBeRejectedWith(jasmine.objectContaining({ code: 'not_configured' }));
    expect(calls.length).toBe(0);
  });
});
