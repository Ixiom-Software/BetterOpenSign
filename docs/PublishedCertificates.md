# Published certificates

A PDF reader shows a signature as valid only if it trusts the certificate the
signature chains to. A BetterSign phone or desktop signs with a certificate
issued by the identity's own root, which no reader trusts out of the box. So
docsign shows the certificates behind each signature in the completion
certificate, and publishes the BetterSign ones so a reader can download the
root and trust it.

Code: `apps/OpenSignServer/cloud/customRoute/bsapi/certs.js` (server),
`apps/OpenSign/src/pages/PublishedCerts.jsx` (the page).

- [Where the certificates come from](#1-where-the-certificates-come-from)
- [The completion certificate](#2-the-completion-certificate)
- [What is published](#3-what-is-published)
- [Public routes](#4-public-routes)
- [The page](#5-the-page)
- [Privacy](#6-privacy)
- [Settings](#7-settings)

## 1. Where the certificates come from

From the signed PDF itself. Nothing is uploaded by the apps. When a document
completes and its completion certificate is made (`PDF.js`
`sendMailsaveCertifcate`, or later through the `generatecertificate` cloud
function), docsign sends the final, sealed PDF to bs-service-identity's
`POST /v1/pdf/signatures`, which lists every signature in it, oldest first:
its signer certificate (or `null` when the CMS doesn't carry it), the
certificates the CMS carries (signer first, then each issuer, then any
others), its signing time (`/M`, or `null`), whether its CMS digest still
matches the bytes it covers (`intact`) and whether it covers the whole file.
`intact` doesn't check the signature value, and is false for SHA-1
signatures, so docsign says "unchanged since signing", never "verified".
Document timestamps aren't listed. The service reports; it doesn't decide
trust.

Best effort: if `BS_SERVICE_IDENTITY_URL` / `_TOKEN` aren't set, or the call
fails, the completion certificate is made as before, without the section, and
the log has `{"event":"bscerts_skipped",…}` or `{"event":"bscerts_list_failed",…}`.
Nothing is published then. A certificate made again later (it isn't, once one
exists) would try again.

## 2. The completion certificate

After the signers, a **Digital signatures** section lists each signature in
the order it was made:

| Line | |
|---|---|
| name | the signer certificate's common name; "Signer unknown" with "Certificate: not included in the signature" when the CMS doesn't carry it (then only Signed at and Status follow) |
| Issued by | the root the chain reaches: the CA whose subject CN is the signer's issuer CN, and so on up; or the signer's issuer if the chain stops short |
| Signer / Root certificate SHA-256 | fingerprints as Acrobat shows them (`AB:CD:…`) |
| Valid | the signer certificate's validity |
| Signed at | the signature's `/M`, if it has one |
| Status | "Unchanged since signing" (the CMS digest matches) or "Not confirmed unchanged since signing"; and whether it covers the whole document or later revisions (other signatures, the seal) came after it |
| BetterSign identity (VLAD) | shortened, when the certificate carries one |
| Root certificate | link to download the root (published roots only) |
| Trust it in Acrobat | link to the page (section 5) |

The links are clickable in the PDF (URI link annotations) and printed in full.

## 3. What is published

Class `bs_PublishedCert` (master key only; migration
`20261117120000-create_bs_publishedcert.cjs`), one row per certificate, the
first sighting kept:

| Field | |
|---|---|
| `Sha256` | of the DER, hex; unique (index made when the server first stores one) |
| `Der` | base64 |
| `SubjectCN`, `IssuerCN`, `Serial`, `IsCA`, `NotBefore`, `NotAfter` | from the certificate |
| `Vlad` | the VLAD from the certificate's BetterSign identity extension; for a CA without one, the identity whose certificate it was first seen issuing |
| `IssuerSha256` | the CA above it in the same signature, if any |
| `FirstSeenDoc`, `FirstSeenAt` | the completed document it came from (never served) |

Rules:

- **Completed documents only.** Certificates are read when the completion
  certificate is made.
- **BetterSign certificates only:** a certificate with a VLAD, and the CAs
  above it in the same signature's chain (matched by issuer name). Nothing
  else: a third party's certificate (a tenant's own PFX, the demo PFX, another
  signing tool's) appears in the completion certificate but isn't stored or
  served.
- **Unchanged signatures only.** A signature whose digest no longer matches
  (`intact: false`, also every SHA-1 signature), or with no signer
  certificate, publishes nothing. A CA the CMS carries that issued none of
  the VLAD certificates isn't published.
- **docsign's own seal.** When docsign seals with bs-service-identity, its seal
  certificate carries docsign's VLAD, so it is published like any identity's,
  with the CAs above it, under docsign's VLAD. A p12 seal (`SEAL_BACKEND=p12`)
  has no VLAD and is not published.

To withdraw a certificate, delete its row with the master key:

```bash
curl -X DELETE "$SERVER_URL/classes/bs_PublishedCert/<objectId>" \
  -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-Master-Key: $MASTER_KEY"
```

## 4. Public routes

On the API (`https://docsign-bettersign-api.fly.dev/api/v1`), no auth, open
CORS as the rest of the API. Errors are `{ "error", "message" }`.

| Route | Returns |
|---|---|
| `GET /certs/:sha256.cer` | the DER, `Content-Type: application/pkix-cert`, `Content-Disposition: attachment; filename="<CN>-<first 8 hex>.cer"`. `Cache-Control: public, max-age=86400` |
| `GET /certs/:sha256` | its summary (below). Same caching |
| `GET /identities/:vlad/certs` | `{ vlad, roots: [summary], leaves: [summary] }`: the certificates with this VLAD and every CA above them (also one stored under another identity), newest `not_before` first. `Cache-Control: public, max-age=300` |

`:sha256` is exactly 64 hex digits (either case); `:vlad` is 32 to 512 hex
digits, an even number. Anything else is `400 invalid_request`; anything not
published is `404 not_found` (cached 60 s).

```jsonc
// summary
{
  "sha256": "…", "fingerprint": "AB:CD:…",
  "subject_cn": "Alice", "issuer_cn": "Alice root", "serial": "…",
  "is_ca": false, "vlad": "8724…", "issuer_sha256": "…",
  "not_before": "…", "not_after": "…",
  "download_url": "https://…/api/v1/certs/<sha256>.cer",
  "page_url": "https://docsign.bettersign.ing/certs/<vlad or sha256>"
}
```

## 5. The page

`https://docsign.bettersign.ing/certs/<vlad>` (an identity) or
`/certs/<sha256>` (one certificate and the root that issued it). No sign-in.
It shows each root's name, fingerprint and validity with a download button,
the signing certificates, and the steps to trust a root in Adobe Acrobat:

1. Download the root certificate.
2. Settings › Signatures › Identities & Trusted Certificates › More…
3. Trusted Certificates › Import, and choose the `.cer`.
4. Select it, Edit Trust, tick "Use this certificate as a trusted root".
   Check its SHA-256 fingerprint matches the page's.
5. Reopen the document.

A 64-digit link is tried as a certificate hash first, then as a VLAD.

## 6. Privacy

These pages and routes are public. Anyone with a link, or a VLAD, sees:

- the **name** in each certificate (its common name: usually the signer's
  name), and the root's name;
- the **VLAD**, which identifies the BetterSign identity across every site
  that sees it;
- **validity dates and how many signing certificates** the identity has used
  on documents here (a hint at how often it renewed or changed devices).

They don't show which documents, their names, emails, the document owner, or
when a document completed (`FirstSeenDoc` / `FirstSeenAt` stay private).

What limits it:

- Only certificates that appeared in **completed** documents on this server
  are listed, never every certificate an identity has.
- There is **no index or search**: you need the VLAD or a hash. A VLAD is long
  and random enough not to be guessed. It isn't secret, though: it is in the
  signed PDF and its completion certificate, so everyone who received the
  document can open the page. The page only repeats what the PDF already
  carries, in a form anyone can link to.
- No rate limit on these routes (they're single indexed lookups); the API is
  reached directly on Fly, not through Cloudflare.

Signers should know that signing with BetterSign on docsign publishes their
certificate's name and VLAD here. Withdraw a row as in section 3.

## 7. Settings

| Env | |
|---|---|
| `BS_SERVICE_IDENTITY_URL`, `BS_SERVICE_IDENTITY_TOKEN` | the service (as for the seal). Unset: no section, nothing published |
| `SERVER_URL` | the download links' base: its origin + `/api/v1` (+ `/api` before it when `SERVER_URL` ends in `/api/app`, behind the Caddy proxy) |
| `BS_API_ORIGIN` | the page links' base, default `https://docsign.bettersign.ing` |

Frontend: the page calls the API beside `REACT_APP_SERVERURL`'s `/app`.
