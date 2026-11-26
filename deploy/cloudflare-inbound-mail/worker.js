// The docsign-inbound Email Worker: betterid.net's Email Routing catch-all.
// Mail for in.betterid.net (users' addresses for emailing PDFs) it posts, as
// it came, to the backend's POST /inbound/mail
// (apps/OpenSignServer/cloud/customRoute/inboundMail.js), signed with the
// shared BS_INBOUND_MAIL_SECRET. The backend decides everything else; when it
// refuses a message, the Worker bounces it with the backend's reason.
//
// Any other address the zone's own rules don't take (the catch-all's job
// before this Worker) it forwards to FORWARD_TO, as the catch-all did.
//
//   API_URL                  the backend origin (wrangler.jsonc vars)
//   INBOUND_DOMAIN           the users' addresses' domain (wrangler.jsonc
//                            vars); default in.betterid.net
//   FORWARD_TO               where other mail goes: wrangler secret put
//                            FORWARD_TO (a verified Email Routing destination;
//                            a secret so the address isn't in this public
//                            repo). Unset, other mail bounces.
//   MAX_MESSAGE_MB           largest message, in MB (wrangler.jsonc vars;
//                            default 25, Cloudflare's own limit); keep it the
//                            same as the backend's BS_INBOUND_MAIL_MAX_MB
//   RETRY_DELAY_MS           wait before the first retry, doubling; default 2000
//   BS_INBOUND_MAIL_SECRET   wrangler secret put BS_INBOUND_MAIL_SECRET
const ATTEMPTS = 3;

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(secret, timestamp, mailFrom, rcptTo, body) {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", body));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const text = `${timestamp}\n${mailFrom}\n${rcptTo}\n${bodyHash}`;
  return hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))
  );
}

async function post(env, message, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${env.API_URL.replace(/\/$/, "")}/inbound/mail`, {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-bs-mail-from": message.from,
      "x-bs-rcpt-to": message.to,
      "x-bs-timestamp": timestamp,
      "x-bs-signature": await sign(
        env.BS_INBOUND_MAIL_SECRET,
        timestamp,
        message.from,
        message.to,
        body
      )
    },
    body
  });
}

export default {
  async email(message, env) {
    const domain = (env.INBOUND_DOMAIN || "in.betterid.net").toLowerCase();
    const to = String(message.to || "").toLowerCase();
    if (!to.endsWith(`@${domain}`)) {
      if (env.FORWARD_TO) return message.forward(env.FORWARD_TO);
      message.setReject("There’s no such address.");
      return;
    }
    const maxMb = Number(env.MAX_MESSAGE_MB) || 25;
    if (message.rawSize > maxMb * 1024 * 1024) {
      message.setReject(`This email is too large (at most ${maxMb} MB).`);
      return;
    }
    const delay = Number(env.RETRY_DELAY_MS ?? 2000);
    const body = await new Response(message.raw).arrayBuffer();
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let res;
      try {
        res = await post(env, message, body);
      } catch (err) {
        console.log("inbound: backend unreachable", attempt, err?.message);
      }
      if (res?.ok) return;
      // 4xx other than a signing problem: the sender's to fix; bounce it.
      if (res && res.status >= 400 && res.status < 500 && res.status !== 401) {
        const answer = await res.json().catch(() => ({}));
        message.setReject(answer.reason || "This email couldn’t be accepted.");
        return;
      }
      console.log("inbound: backend failed", attempt, res?.status);
      if (attempt < ATTEMPTS)
        await new Promise((r) => setTimeout(r, delay * attempt));
    }
    message.setReject(
      "Better DocSign couldn’t take this email just now. Please try again later."
    );
  }
};
