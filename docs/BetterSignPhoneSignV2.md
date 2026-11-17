# Sign on phone v2: the phone's key signs the PDF

In v1 ([BetterSignPhoneSign.md](./BetterSignPhoneSign.md)) the phone approves a
field and returns a PNG; the PDF carries no signature from the phone. In v2 the
signer's BetterSign phone signs the **whole PDF** with its own P-256 key, as a
PAdES signature that readers validate. It is remote signing: docsign prepares
the bytes, the phone checks them against the PDF it downloads and signs them
with a hardware key, docsign embeds the result.

Design and wire format: BetterSignApps
`docs/Technical/phone-pades-signing-design.md` and `core/bs_docsign/README.md`.
Server: `apps/OpenSignServer/cloud/parsefunction/bsPhoneSignPdf.js`. v1 is
unchanged and still served.

- [The flow](#1-the-flow)
- [Cloud functions](#2-cloud-functions)
- [The phone's download](#3-the-phones-download)
- [What docsign checks](#4-what-docsign-checks)
- [Certificates](#5-certificates)
- [The hold on the document](#6-the-hold-on-the-document)
- [Classes](#7-classes)
- [Settings](#8-settings)
- [Limits](#9-limits)

## 1. The flow

Same rules as v1 §1: only for a Sign in with BetterSign session, and the
request reaches the phone over the relay (v1 §2).

```
browser                docsign                      bs-service-identity     relay / phone
  │ Finish: base ───────▶ │ extends current file? hold the doc                    │
  │ bsphonesignpdfstart   │── /v1/phone/request ───────▶│                        │
  │ ◀── {reqId}           │── approve ──────────────────┼──────────────────────▶ │ GET base, show, App Lock
  │ bsphonesignpdfpoll ─▶ │◀── PNG, docKey, rootKey, statement ──────────────────│
  │   waiting/approved    │── /v1/phone/answer, then the verifier                 │
  │                       │ [certify root] [certify leaf]: /v1/phone/{root,leaf}/tbs ─▶ phone signs TBS
  │                       │      ─▶ /v1/phone/{root,leaf}/assemble                │
  │   signing             │── /v1/phone/pades/prepare ─▶│                        │
  │                       │── sign (certificate, root, preparedSha256) ─────────▶ │ GET prepared, check, sign
  │                       │◀── signature over the signed attributes ──────────────│
  │                       │── /v1/phone/pades/complete ─▶│ (embeds, verifies)     │
  │ ◀── signed            │ finishSigning(appendOnly, Vlad, VladSignatures)       │
```

1. **Base.** At Finish the browser builds the signer's revision: the current
   file (`SignedUrl || URL`) followed by incremental updates that draw their
   other widgets and add one blank, visible signature field named
   `fieldName`. docsign checks it extends the current file byte for byte
   (`extendsPdf`), then has bs-service-identity make it Acrobat-ready
   (`/v1/phone/pades/base`): an unsigned PDF with compressed cross-references
   (pdf-lib's default) is re-saved with a classic table, content unchanged,
   because the signing revision always appends a classic table and Acrobat
   calls a signature over the mix invalid. A document already signed is left
   as is (the service's `warning`); docsign refuses a result that changed it
   anyway, or that isn't the current file with bytes appended when the
   document has signatures (`VladSignatures`, or any `/ByteRange` in the
   file): re-saving it would break them. That result is the base the phone
   approves; docsign stores it and holds the document (§6).
2. **approve.** The request carries the caption (§2). The phone downloads the
   base (§3), checks it and the blank field, shows it with the caption, and on
   approval answers with the signature PNG and its two public keys (document
   key, root key); its statement binds the caption (`captionSha256`).
3. **certify**, only when needed (§5): the root key signs a TBS for its root,
   then for the signing certificate the root issues.
4. **sign.** bs-service-identity prepares the PDF (the PNG and the approved
   caption as the field's appearance, a `/Contents` placeholder). The phone downloads it, checks it
   is the base plus only the signature, builds the CMS signed attributes
   itself and signs them with the document key.
5. **Complete.** bs-service-identity rebuilds the prepared PDF from the same
   inputs, embeds the CMS and verifies it. docsign checks the result extends
   the base and has a signature covering the whole file, then commits it with
   `finishSigning` like a desktop signature: `appendOnly: true`, an audit
   entry with `Vlad`, `SignedWith: 'BetterSign phone'` and `SignedSha256`, and
   a `VladSignatures` entry. From then on the document is append-only: later
   signers and OpenSign's seal append. A document you sign yourself completes
   in that same call, so the seal is appended there too. If storing the file
   fails, nothing is committed and the next poll tries again with the same
   inputs (until the hold's five minutes are up).

Every step is its own relay request: its own `reqId` and one-time X25519 key
(kept sealed as in v1 §5), `exp − iat` at most 180 s, and never past the
phone's approval window (600 s from the approve request). The `challenge`,
`docId`, `fieldId` (= `fieldName`) and base hash stay the same, and certify
and sign carry `approveReqId`. Only approve carries `caption`; the phone
remembers it. The phone refuses a certify or sign that doesn't continue an
approval it gave (`unknown-approval`).

Request bodies are built by bs-service-identity (`POST /v1/phone/request`,
the deterministic CBOR of `bs_docsign::pdf::PdfRequest`). docsign wraps them in
v1's request envelope with `ct = application/vnd.bettersign.docsign-pdf-request+cbor`.
Answers are relay envelopes with
`ct = application/vnd.bettersign.docsign-pdf-response+cbor`.

## 2. Cloud functions

| Function | Params | Returns |
|---|---|---|
| `bsphonesignpdfstart` | `{ docId, fieldName, base, caption? }` | `{ reqId, expiresAt }` |
| `bsphonesignpdfpoll` | `{ reqId }` | `{ status, reason?, message? }` |
| `bsphonesignpdfcancel` | `{ reqId }` | `{ status: "cancelled" }`, the final status if it had already ended, or the live status if a poll is moving it on (it then ends it) |

- `base`: base64 of the signer's revision (§1). At most 50 MB decoded; Parse
  accepts request bodies up to 100 MB (`maxUploadSize`).
- `fieldName`: `bs-phone-` and then 1 to 91 of `A–Z a–z 0–9 _ : -` (so no
  `.`, at most 100 characters).
- `caption`: the text the signature's appearance draws next to the PNG. At
  most 200 characters, and only what the standard Helvetica draws with
  WinAnsiEncoding (bs_core `pdf_field::win_ansi`): printable ASCII, Latin-1
  (U+00A0–U+00FF) and WinAnsi's extras (`€ ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • –
  — ˜ ™ š › œ ž Ÿ`); anything else, control characters included, is a `102`.
  Default `Digitally signed by <name> · <YYYY-MM-DD>` (UTC date), with the
  signer's name made drawable: Latin letters outside Latin-1 lose their
  accents (`Ő` → `O`, `Ł` → `L`); a name with any other character (another
  script) is left out: `Digitally signed · <YYYY-MM-DD>`. A long name is cut
  to fit 200. docsign sends it in the approve request and passes the same
  text to `/v1/phone/pades/prepare` and `/complete`.
- `reqId`: base64url of the approve request's id. It names the attempt
  whichever step is running.
- `expiresAt`: when the approve request expires, epoch milliseconds.
- `status`: `waiting` (approve sent), `approved` (certifying or preparing),
  `signing` (sign sent, or embedding), `signed` (committed through
  `finishSigning`: carry on as after a normal Finish, including the next
  signer's email, which docsign doesn't send here), `denied` (`reason` from
  the phone: `user`, `locked`, …), `error` (`reason` `mismatch`,
  `unknown-approval`, `no-signature`, `unverified`, `replaced`, …),
  `expired`, `cancelled`. `message`, when present, is for the signer as is.
- A poll waits up to 20 s for the phone. A step expires only when the relay
  has no answer for it: an answer the phone sent in time counts even if the
  poll comes late (its statement's `iat` must still fall within the request).
- Cancel while a poll is moving the attempt on is recorded
  (`CancelRequested`): that poll ends it as `cancelled` before it sends the
  phone the next request or commits the signed PDF. Once committed, it's
  `signed`.
- The browser polls again at once after a long poll, but no sooner than a
  second after a poll that came back at once (the relay or a service down);
  closing the dialog while start is still running cancels the attempt start
  returns.

`bsphonesignpdfstart` errors (`Parse.Error`, message shown as is):

| Code | When |
|---|---|
| `102` | Malformed `docId`, `fieldName`, `base` or `caption`; base too large |
| `101` | No such document; or the app has never connected to the relay |
| `119` | Not a BetterSign session; not the signer's turn (as v1); or another signer is signing it on their phone (§6) |
| `141` | `base` isn't the current file with bytes appended, or the document changed meanwhile |
| `155` | The relay's rate limit |
| `100` | The relay or the document's file can't be reached; the request couldn't be built; bs-service-identity couldn't make the base Acrobat-ready, or rewrote a signed document |
| `1` | bs-service-identity isn't configured |

## 3. The phone's download

`GET /api/v1/phone-sign/:reqId/file` (desktop API bearer token,
[BetterSignAPI.md](./BetterSignAPI.md)): the base for the approve request's
`reqId`, the prepared PDF for the sign request's. Only to the identity the
request was sent to (the token's VLAD), and only while the attempt runs;
`404` otherwise. `X-Content-SHA256` is the hash the request names.

## 4. What docsign checks

On each answer:

1. bs-service-identity `POST /v1/phone/answer` opens it with the step's
   one-time key and checks it names the request, and the step's own fields
   (approve: `imageHash`; certify: the TBS signature under the root key;
   sign: the prepared hash and the signature over the signed attributes
   under the document key). Anything that doesn't check out is a 422.
2. docsign decodes the `bs-docsign-pdf` statement and checks it names this
   VLAD, site, document, field, challenge, request and base, and was signed
   while the request was open (a minute of clock difference).
3. The verifier checks `vladSig` over the bs-message TBS with content type
   `application/vnd.bettersign.docsign-pdf+cbor` (v1 §4.3, other content
   type).
4. approve: the PNG is at most 512 KiB, the keys are SEC1 uncompressed P-256.

If bs-service-identity or the verifier is down, the poll reports the current
status and tries again next time; the relay keeps the answer until the request
expires. Two polls at once (a retry, a second tab) don't both act on an
answer: the one that claims the attempt does. The claim is a lease
(`LeaseUntil`, two minutes) with its own id (`LeaseId`); its poll renews it
every 30 s while it works (prepare and complete can take minutes) and
releases it only if it still holds it. A poll that dies lets it lapse.

The approve statement must also carry `captionSha256`, the SHA-256 of the
caption's UTF-8; docsign checks it as well as bs-service-identity.

## 5. Certificates

As on the desktop, the phone has a ten-year root (its root key) that issues
its one-year signing certificate (its document key). docsign keeps them in
`bs_PhoneSignCert` per VLAD and key, and certifies:

- the root when there is none for the root key that lasts more than 30 days;
- the signing certificate when there is none for the document key, from that
  root, that lasts more than 30 days.

Serials are 16 random bytes. The root starts five minutes back; the signing
certificate lies within the root's validity. After the first signing on a
phone, later ones go straight from approve to sign.

## 6. The hold on the document

From start until the attempt ends, the document is held for this signer:
`contracts_Document.PhoneSignLockId` (the approve reqId) and
`PhoneSignLockUntil` (the current request's `exp` plus a minute; five minutes
once the phone has signed). Taking it bumps `SignRevision`, so a signing
checked before it can't commit. While it is live:

- `signPdf` (online signing) and `finishSigning` refuse other signers with
  `119` "Someone is signing this document on their phone right now…";
- the desktop upload answers `409 locked`;
- another signer's `bsphonesignpdfstart` refuses with the same `119`. The same
  signer starting again ends their earlier attempt (`error`, reason
  `replaced`), claiming it first; if a poll is moving it on right now (it may
  be committing), start refuses with `119` "Your earlier signing on your
  phone is still finishing…".

It is released on every final status, and simply lapses if no one polls.
Attempts nobody polled to the end are marked `expired` ten minutes after their
hold lapses (swept on the next start). Clients can't write these fields
(`DocumentBeforesave`).

## 7. Classes

Migration `20261116120000-create_bs_phonesignpdf_classes.cjs`, both master
key only:

- `bs_PhoneSignPdf`, one attempt: `ApproveReqId`, `UserId`, `vlad`, `DocId`,
  `FieldName`, the signer (`SignerId`, `SignerClass`, `SignerName`),
  `Caption`, `Challenge`, the base (`BaseUrl`, `BaseSha256`, `BaseLen`,
  `BaseRevision`), the current step (`Step`, `Status`, `Answered`,
  `StepReqId`, `StepRequest`, `EphSecret`, `StepIssuedAt`, `StepExpiresAt`),
  `ApprovalUntil`, `LockUntil`, `LeaseUntil`, `LeaseId`, `CancelRequested`,
  the approval (`Image`,
  `DocKey`, `RootKey`), certify state (`Purpose`, `CertifyInputs`,
  `CertifyIssuer`, `CertifySignature`), signing state (`Certificate`, `Root`,
  `SigningTime`, `PreparedUrl`, `PreparedSha256`, `PreparedLen`,
  `SignedAttributes`, `Signature`), every step's `Statements` (step,
  certify's `purpose`, statement and VLAD signature), and the outcome (`Reason`, `Message`, `SignedSha256`,
  `SignedAt`, `FinishedAt`). The base and prepared files are deleted when the
  attempt ends; the row and its statements stay.
- `bs_PhoneSignCert`: `vlad`, `Kind` (`root` | `leaf`), `PublicKey`,
  `RootKey`, `IssuerSerial` (leaf), `Certificate` (DER, base64), `Serial`,
  `NotBefore`, `NotAfter`.

It also adds `PhoneSignLockId` and `PhoneSignLockUntil` to
`contracts_Document`.

## 8. Settings

v1's (§7), plus:

| Setting | Meaning |
|---|---|
| `BS_SERVICE_IDENTITY_URL` | bs-service-identity, as for the seal (`utils/seal.js`) |
| `BS_SERVICE_IDENTITY_TOKEN` | its `BS_SERVICE_TOKEN` |

Without them `bsphonesignpdfstart` refuses: "Signing on your phone is not set
up on this server."

## 9. Limits

- **The certificate isn't trusted** by readers out of the box: Acrobat shows
  "validity unknown" until the phone's root is trusted (the app shares it).
- **The phone's keys aren't in the identity's log yet.** The approve statement,
  signed by `/keys/primary`, names both keys and is kept in `Statements`.
- **Later signers draw into page content**, as after a desktop signature
  ([BetterSignAPI.md](./BetterSignAPI.md)): the phone's signature still
  verifies for its revision, but strict validators may flag later changes.
- **The request isn't sealed** and **a relay address can be claimed first**,
  as in v1 §8.
- **The base has no `/SigFlags`**; neither the browser nor prepare sets it.
  Readers verify the signature without it.
- One attempt at a time per document.
