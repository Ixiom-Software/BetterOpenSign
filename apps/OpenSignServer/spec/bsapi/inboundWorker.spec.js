// The docsign-inbound Email Worker (deploy/cloudflare-inbound-mail/worker.js):
// what it posts to the backend, and how it answers Cloudflare for each reply.
import worker from '../../../../deploy/cloudflare-inbound-mail/worker.js';
import { signatureFor } from '../../cloud/customRoute/inboundMail.js';

const ENV = {
  API_URL: 'https://api.example/',
  BS_INBOUND_MAIL_SECRET: 'worker-secret',
  MAX_MESSAGE_MB: '1',
  RETRY_DELAY_MS: '0',
};
const RAW = 'From: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n';

function emailMessage(
  raw = RAW,
  rawSize = Buffer.byteLength(raw),
  to = 'abcdefghijklmnopqrst@in.betterid.net'
) {
  return {
    from: 'bounce@example.com',
    to,
    rawSize,
    raw: new Blob([raw]).stream(),
    setReject: jasmine.createSpy('setReject'),
    forward: jasmine.createSpy('forward').and.resolveTo(),
  };
}

const reply = (status, body = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('docsign-inbound Email Worker', () => {
  let realFetch;
  let calls;
  let replies;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = [];
    replies = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next || reply(200, { status: 'created' });
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts the message as it came, signed as the backend checks it', async () => {
    const message = emailMessage();
    await worker.email(message, ENV);
    expect(message.setReject).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.example/inbound/mail');
    expect(init.method).toBe('POST');
    const body = Buffer.from(init.body);
    expect(body.toString()).toBe(RAW);
    const h = init.headers;
    expect(h['content-type']).toBe('message/rfc822');
    expect(h['x-bs-mail-from']).toBe(message.from);
    expect(h['x-bs-rcpt-to']).toBe(message.to);
    expect(Math.abs(Number(h['x-bs-timestamp']) - Date.now() / 1000)).toBeLessThan(5);
    expect(h['x-bs-signature']).toBe(
      signatureFor(ENV.BS_INBOUND_MAIL_SECRET, h['x-bs-timestamp'], message.from, message.to, body)
    );
  });

  it('bounces with the backend’s reason when it refuses', async () => {
    for (const status of [403, 404, 413, 422, 429]) {
      replies = [reply(status, { status: 'rejected', reason: `no (${status})` })];
      calls = [];
      const message = emailMessage();
      await worker.email(message, ENV);
      expect(calls.length).withContext(String(status)).toBe(1);
      expect(message.setReject).toHaveBeenCalledWith(`no (${status})`);
    }
  });

  it('retries a failure, a bad signature or no answer, then accepts', async () => {
    replies = [reply(500), reply(401), new Error('connection reset'), reply(200)];
    const message = emailMessage();
    await worker.email(message, ENV);
    // Three attempts: the third fails too, so it bounces asking for later.
    expect(calls.length).toBe(3);
    expect(message.setReject).toHaveBeenCalledWith(
      'Better DocSign couldn’t take this email just now. Please try again later.'
    );

    replies = [reply(503), reply(200)];
    calls = [];
    const second = emailMessage();
    await worker.email(second, ENV);
    expect(calls.length).toBe(2);
    expect(second.setReject).not.toHaveBeenCalled();
  });

  it('bounces a message over MAX_MESSAGE_MB without posting it', async () => {
    const message = emailMessage(RAW, 2 * 1024 * 1024);
    await worker.email(message, ENV);
    expect(calls).toEqual([]);
    expect(message.setReject).toHaveBeenCalledWith('This email is too large (at most 1 MB).');
  });

  it('forwards mail for other addresses, as the catch-all did', async () => {
    const env = { ...ENV, FORWARD_TO: 'owner@example.net' };
    for (const to of ['contact@betterid.net', 'x@sub.in.betterid.net', 'x@notin.betterid.net']) {
      const message = emailMessage(RAW, 30 * 1024 * 1024, to);
      await worker.email(message, env);
      expect(message.forward).withContext(to).toHaveBeenCalledWith('owner@example.net');
      expect(message.setReject).not.toHaveBeenCalled();
    }
    expect(calls).toEqual([]);
  });

  it('bounces other addresses when FORWARD_TO isn’t set', async () => {
    const message = emailMessage(RAW, undefined, 'contact@betterid.net');
    await worker.email(message, ENV);
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledWith('There’s no such address.');
    expect(calls).toEqual([]);
  });

  it('takes its domain in any case, and from INBOUND_DOMAIN', async () => {
    const upper = emailMessage(RAW, undefined, 'ABCDEFGHIJKLMNOPQRST@IN.BetterID.net');
    await worker.email(upper, { ...ENV, FORWARD_TO: 'owner@example.net' });
    expect(upper.forward).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);

    const other = emailMessage(RAW, undefined, 'tok@mail.example.org');
    await worker.email(other, { ...ENV, INBOUND_DOMAIN: 'mail.example.org' });
    expect(calls.length).toBe(2);
  });

  it('defaults to 25 MB', async () => {
    const message = emailMessage(RAW, 24 * 1024 * 1024);
    await worker.email(message, { ...ENV, MAX_MESSAGE_MB: undefined });
    expect(calls.length).toBe(1);
    const tooBig = emailMessage(RAW, 26 * 1024 * 1024);
    await worker.email(tooBig, { ...ENV, MAX_MESSAGE_MB: undefined });
    expect(tooBig.setReject).toHaveBeenCalledWith('This email is too large (at most 25 MB).');
  });
});
