// Vendored from BetterSignApps server/signInWithBetterIDButton/src/button.js (commit cac8260a).
// Don't edit here: change it there and run
//   node server/signInWithBetterIDButton/scripts/vendor.mjs <this folder> button
// LOCAL CHANGE (BetterOpenSign self sign-up): the `scope` attribute / option,
// passed to startPasskeySignIn(). Not upstream yet: add it to BetterSignApps
// before re-vendoring, or this copy loses it (and bs-id stops sending the
// verified email that self sign-up needs).
// --- end of vendoring note ---
// <betterid-sign-in>: the Sign in with BetterID button, as a standard
// custom element, so it works in plain HTML and in any framework.
//
//   <script type="module">
//     import { defineSignInButton } from "@betterid/sign-in-button/button";
//     defineSignInButton();
//   </script>
//   <betterid-sign-in client-id="my-site"></betterid-sign-in>
//
// Clicking it tries the BetterID extension (a tap on the phone) and falls
// back to the passkey at bs-id. When bs-id sends the browser back, the same
// element on that page finishes the sign-in by itself. Either way it fires
// `betterid-signed-in` with what the site's server returned.
//
// By default it talks to the routes from routes.js under /betterid; set
// the getChallenge / completeExtension / completePasskey properties to use
// your own endpoints instead.

import {
  extensionSignIn, hasPendingPasskeySignIn, startPasskeySignIn, takePasskeyCallback,
} from "./browser.js";

const DEFAULT_LABEL = "Sign in with BetterID";
const CALLBACK_PARAMS = ["code", "state", "error", "error_description", "iss"];

const STYLE = `
:host { display: inline-block; font-family: var(--betterid-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); }
:host([full-width]) { display: block; }
:host([hidden]) { display: none; }
button {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; min-height: 44px; padding: 0 20px; cursor: pointer;
  font: 600 15px/1 inherit; font-family: inherit;
  color: var(--betterid-fg, #fff); background: var(--betterid-bg, #0b5c8a);
  border: 1px solid var(--betterid-border, transparent); border-radius: var(--betterid-radius, 10px);
}
:host([theme="light"]) button { color: var(--betterid-fg, #0b5c8a); background: var(--betterid-bg, #fff); border-color: var(--betterid-border, #d5dee5); }
:host([theme="outline"]) button { color: var(--betterid-fg, #0b5c8a); background: var(--betterid-bg, transparent); border-color: var(--betterid-border, currentColor); }
button:hover:not(:disabled) { filter: brightness(1.08); }
button:focus-visible { outline: 3px solid var(--betterid-focus, #4bbf9a); outline-offset: 2px; }
button:disabled { cursor: progress; opacity: .7; }
svg { width: 18px; height: 18px; flex: none; }
.status { margin: 8px 0 0; font-size: 13px; line-height: 1.4; color: var(--betterid-status, #5b6b76); text-align: center; }
.status.error { color: var(--betterid-error, #b3261e); }
.status:empty { display: none; }
.fallback { display: block; margin: 4px auto 0; padding: 0; border: 0; background: none; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--betterid-link, #0b5c8a); text-decoration: underline; min-height: 0; width: auto; }
.fallback[hidden] { display: none; }
`;

// A plain fingerprint mark (no brand asset needed).
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
<path d="M12 11v3a8 8 0 0 1-1.5 4.7"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0v2a12 12 0 0 1-.8 4.3"/>
<path d="M5.5 15.5V12a6.5 6.5 0 0 1 11-4.7"/><path d="M18.5 12v1.5"/><path d="M3 9.5A9.5 9.5 0 0 1 17.6 4.5"/></svg>`;

// So importing this file on a server (SSR) doesn't throw.
const Base = globalThis.HTMLElement ?? class {};

export class BetterIDSignInButton extends Base {
  static observedAttributes = ["label", "disabled"];

  #root;
  #button;
  #status;
  #fallback;
  #busy = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    // Hooks; null means the default (fetch to api-base).
    this.getChallenge = null;
    this.completeExtension = null;
    this.completePasskey = null;
    // How long to wait for the extension (ms); null for the defaults
    // (1.5 s to answer at all, 130 s for the phone).
    this.helloTimeoutMs = null;
    this.requestTimeoutMs = null;
  }

  // --- configuration -------------------------------------------------------------

  get clientId() { return this.getAttribute("client-id") || ""; }
  get bsIdUrl() { return (this.getAttribute("bs-id-url") || "https://id.betterid.net").replace(/\/$/, ""); }
  get apiBase() { return (this.getAttribute("api-base") || "/betterid").replace(/\/$/, ""); }
  get redirectUri() { return this.getAttribute("redirect-uri") || location.origin + location.pathname; }
  get label() { return this.getAttribute("label") || DEFAULT_LABEL; }
  get scope() { return this.getAttribute("scope") || "openid"; }

  // --- lifecycle -------------------------------------------------------------------

  connectedCallback() {
    if (!this.#button) this.#render();
    if (hasPendingPasskeySignIn() && /[?&](code|error)=/.test(location.search)) this.#finishPasskey();
  }

  attributeChangedCallback() {
    if (!this.#button) return;
    this.#button.querySelector(".label").textContent = this.label;
    this.#button.disabled = this.#busy || this.hasAttribute("disabled");
  }

  #render() {
    const nonce = this.getAttribute("style-nonce");
    if (!nonce && "adoptedStyleSheets" in this.#root && typeof CSSStyleSheet === "function") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      this.#root.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement("style");
      if (nonce) style.setAttribute("nonce", nonce);
      style.textContent = STYLE;
      this.#root.append(style);
    }
    this.#button = document.createElement("button");
    this.#button.type = "button";
    this.#button.setAttribute("part", "button");
    this.#button.innerHTML = ICON + '<span class="label"></span>';
    this.#button.querySelector(".label").textContent = this.label;
    this.#button.disabled = this.hasAttribute("disabled");
    this.#button.addEventListener("click", () => this.signIn());
    this.#status = document.createElement("p");
    this.#status.className = "status";
    this.#status.setAttribute("part", "status");
    this.#status.setAttribute("role", "status");
    this.#fallback = document.createElement("button");
    this.#fallback.type = "button";
    this.#fallback.className = "fallback";
    this.#fallback.setAttribute("part", "fallback");
    this.#fallback.textContent = "Use passkey instead";
    this.#fallback.hidden = true;
    this.#fallback.addEventListener("click", () => this.#passkey());
    this.#root.append(this.#button, this.#status, this.#fallback);
  }

  // --- state -----------------------------------------------------------------------

  #setBusy(busy) {
    this.#busy = busy;
    this.#button.disabled = busy || this.hasAttribute("disabled");
    this.#button.setAttribute("aria-busy", String(busy));
    if (!busy) this.#fallback.hidden = true;
  }

  #show(message, isError = false) {
    if (this.hasAttribute("no-status")) return;
    this.#status.textContent = message;
    this.#status.classList.toggle("error", isError);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #failed(method, error) {
    this.#setBusy(false);
    this.#show((error && error.message) || "Sign-in failed. Please try again.", true);
    this.#emit("betterid-error", { method, error });
  }

  async #post(path, body) {
    const res = await fetch(this.apiBase + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error_description || out.error || `HTTP ${res.status}`), { status: res.status, body: out });
    return out;
  }

  // --- the two paths -------------------------------------------------------------

  /** Start a sign-in, as a click does. */
  async signIn() {
    if (this.#busy) return;
    if (!this.clientId) return this.#failed("extension", new Error("betterid-sign-in: client-id is not set"));
    this.#setBusy(true);
    this.#show("");
    let challengeId;
    const r = await extensionSignIn({
      rp: this.clientId,
      helloTimeoutMs: this.helloTimeoutMs ?? undefined,
      requestTimeoutMs: this.requestTimeoutMs ?? undefined,
      onStatus: (m) => {
        this.#show(m);
        this.#fallback.hidden = false;
        this.#emit("betterid-status", { message: m });
      },
      getChallenge: async () => {
        if (this.getChallenge) return this.getChallenge();
        const c = await this.#post("/challenge", {});
        challengeId = c.challengeId;
        return c.challenge;
      },
      complete: async ({ statement, vladSig, challenge }) => this.completeExtension
        ? this.completeExtension({ statement, vladSig, challenge })
        : this.#post("/extension", { challengeId, statement, vladSig }),
    });
    if (r.result === "ok") {
      this.#setBusy(false);
      this.#show("");
      this.#emit("betterid-signed-in", { method: "extension", value: r.value });
    } else if (r.result === "denied") {
      this.#setBusy(false);
      this.#show("Sign-in was denied on your phone.", true);
      this.#emit("betterid-denied", {});
    } else if (r.result === "failed") {
      this.#failed("extension", r.error);
    } else {
      await this.#passkey();
    }
  }

  async #passkey() {
    this.#show("");
    this.#fallback.hidden = true;
    this.#setBusy(true);
    try {
      await startPasskeySignIn({ bsIdUrl: this.bsIdUrl, clientId: this.clientId, redirectUri: this.redirectUri, scope: this.scope });
    } catch (e) {
      this.#failed("passkey", e);
    }
  }

  async #finishPasskey() {
    const cb = takePasskeyCallback(location.search, { redirectUri: this.redirectUri });
    // Not the sign-in this tab started: leave the page (and that sign-in) alone.
    if (cb.foreign) return;
    // Drop bs-id's parameters from the address bar, keep the page's own.
    const url = new URL(location.href);
    for (const k of CALLBACK_PARAMS) url.searchParams.delete(k);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    if (cb.error) return this.#failed("passkey", new Error(cb.error));
    this.#setBusy(true);
    this.#show("Signing in…");
    try {
      const value = this.completePasskey
        ? await this.completePasskey(cb)
        : await this.#post("/passkey", cb);
      this.#setBusy(false);
      this.#show("");
      this.#emit("betterid-signed-in", { method: "passkey", value });
    } catch (e) {
      this.#failed("passkey", e);
    }
  }
}

/** Register the element (once). Returns the tag name. */
export function defineSignInButton(tagName = "betterid-sign-in") {
  if (!customElements.get(tagName)) customElements.define(tagName, class extends BetterIDSignInButton {});
  return tagName;
}

/**
 * Create a button inside `container` without writing HTML:
 *   mountSignInButton(el, { clientId: "my-site", onSignedIn: (value) => ... })
 * Options: clientId, bsIdUrl, apiBase, redirectUri, scope, label, theme, fullWidth,
 * styleNonce, getChallenge, completeExtension, completePasskey, and the
 * handlers onSignedIn(value, method), onError(error), onDenied().
 */
export function mountSignInButton(container, options = {}) {
  const tag = defineSignInButton();
  const el = document.createElement(tag);
  const attrs = {
    "client-id": options.clientId, "bs-id-url": options.bsIdUrl, "api-base": options.apiBase,
    "redirect-uri": options.redirectUri, scope: options.scope, label: options.label, theme: options.theme, "style-nonce": options.styleNonce,
  };
  for (const [k, v] of Object.entries(attrs)) if (v) el.setAttribute(k, v);
  if (options.fullWidth) el.setAttribute("full-width", "");
  for (const k of ["getChallenge", "completeExtension", "completePasskey"]) if (options[k]) el[k] = options[k];
  if (options.onSignedIn) el.addEventListener("betterid-signed-in", (e) => options.onSignedIn(e.detail.value, e.detail.method));
  if (options.onError) el.addEventListener("betterid-error", (e) => options.onError(e.detail.error));
  if (options.onDenied) el.addEventListener("betterid-denied", () => options.onDenied());
  container.append(el);
  return el;
}
