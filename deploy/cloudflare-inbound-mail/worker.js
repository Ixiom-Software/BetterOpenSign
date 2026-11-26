// The docsign-inbound Email Worker: Cloudflare Email Routing sends it every
// message for in.betterid.net (a catch-all rule), and it posts each one, as
// it came, to the backend's POST /inbound/mail
// (apps/OpenSignServer/cloud/customRoute/inboundMail.js), signed with the
// shared BS_INBOUND_MAIL_SECRET. The backend decides everything else; when it
// refuses a message, the Worker bounces it with the backend's reason.
//
//   API_URL                  the backend origin (wrangler.jsonc vars)
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
