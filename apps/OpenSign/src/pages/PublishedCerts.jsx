// PublishedCerts: the public page (no sign-in) for certificates docsign
// published from completed documents (docs/PublishedCertificates.md).
//
//   /certs/<vlad>     a BetterSign identity: its root and signing certificates
//   /certs/<sha256>   one certificate, and the root that issued it
//
// Each root can be downloaded, with the steps to trust it in Adobe Acrobat.
// The completion certificate links here. Data from the server's public
// routes (apps/OpenSignServer/cloud/customRoute/bsapi/certs.js):
//   GET /api/v1/certs/:sha256               a certificate's summary
//   GET /api/v1/identities/:vlad/certs      { vlad, roots, leaves }

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import axios from "axios";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { serverUrl_fn } from "../constant/appinfo";

const SHA256_RE = /^[0-9a-f]{64}$/;
// As the server: a VLAD in hex, 16 to 256 bytes.
// A VLAD's wire bytes in hex: real ones are about 400 bytes, up to 4096.
const VLAD_RE = /^(?:[0-9a-f]{2}){16,4096}$/;

// The API is beside Parse's /app mount.
export const certsApi = () =>
  `${serverUrl_fn()
    .replace(/\/+$/, "")
    .replace(/\/app$/, "")}/api/v1`;

// What the link names, or null if neither a hash nor a VLAD.
export function linkKind(id) {
  const s = String(id || "").toLowerCase();
  if (SHA256_RE.test(s)) return { kind: "sha256", id: s };
  if (VLAD_RE.test(s)) return { kind: "vlad", id: s };
  return null;
}

const shortVlad = (v) =>
  v.length > 32 ? `${v.slice(0, 16)}…${v.slice(-8)}` : v;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : "");

// What to show: { title, vlad?, roots, leaves }. Throws (status 404 when
// nothing is published under this link).
export async function loadCerts(link) {
  const api = certsApi();
  const get = async (path) => (await axios.get(`${api}${path}`)).data;
  const identity = async (vlad) => {
    const d = await get(`/identities/${vlad}/certs`);
    return { vlad: d.vlad, roots: d.roots || [], leaves: d.leaves || [] };
  };
  if (link.kind === "vlad") return identity(link.id);
  let cert;
  try {
    cert = await get(`/certs/${link.id}`);
  } catch (e) {
    // 64 hex digits could also be a (short) VLAD.
    if (e?.response?.status === 404 && VLAD_RE.test(link.id)) {
      return identity(link.id);
    }
    throw e;
  }
  if (cert.is_ca) return { single: true, roots: [cert], leaves: [] };
  let issuer = null;
  if (cert.issuer_sha256) {
    issuer = await get(`/certs/${cert.issuer_sha256}`).catch(() => null);
  }
  return { single: true, roots: issuer ? [issuer] : [], leaves: [cert] };
}

function Field({ label, children, mono }) {
  return (
    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 0.5 }}>
      <Typography sx={{ fontWeight: 600, minWidth: 170 }}>{label}</Typography>
      <Typography
        sx={{
          wordBreak: "break-all",
          ...(mono ? { fontFamily: "monospace", fontSize: 13 } : {})
        }}
      >
        {children}
      </Typography>
    </Box>
  );
}

function CertCard({ cert }) {
  const { t } = useTranslation();
  return (
    <Box
      data-testid={`cert-${cert.sha256}`}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        p: 2,
        mb: 2,
        bgcolor: "surface.main"
      }}
    >
      <Field label={t("published-certs.name")}>{cert.subject_cn}</Field>
      {cert.issuer_cn !== cert.subject_cn && (
        <Field label={t("published-certs.issued-by")}>{cert.issuer_cn}</Field>
      )}
      <Field label={t("published-certs.fingerprint")} mono>
        {cert.fingerprint}
      </Field>
      <Field label={t("published-certs.valid")}>
        {t("published-certs.valid-range", {
          from: day(cert.not_before),
          to: day(cert.not_after)
        })}
      </Field>
      <Button
        variant="contained"
        component="a"
        href={cert.download_url}
        download
        sx={{ mt: 1 }}
      >
        {t("published-certs.download")}
      </Button>
    </Box>
  );
}

function AcrobatSteps() {
  const { t } = useTranslation();
  return (
    <Box sx={{ mb: 3 }}>
      <Typography component="h2" sx={{ fontSize: 20, fontWeight: 600, mb: 1 }}>
        {t("published-certs.acrobat-title")}
      </Typography>
      <Box component="ol" sx={{ pl: 3, m: 0 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <li key={n}>
            <Typography>{t(`published-certs.acrobat-${n}`)}</Typography>
          </li>
        ))}
      </Box>
    </Box>
  );
}

export default function PublishedCerts() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    const link = linkKind(id);
    if (!link) {
      setState({ status: "invalid" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    loadCerts(link)
      .then((data) => live && setState({ status: "ok", data }))
      .catch((e) => {
        if (!live) return;
        const notFound = e?.response?.status === 404;
        setState({ status: notFound ? "not-found" : "failed" });
      });
    return () => {
      live = false;
    };
  }, [id]);

  const { status, data } = state;
  const section = (title, certs) =>
    certs.length > 0 && (
      <Box sx={{ mb: 3 }}>
        <Typography
          component="h2"
          sx={{ fontSize: 20, fontWeight: 600, mb: 1 }}
        >
          {title}
        </Typography>
        {certs.map((c) => (
          <CertCard key={c.sha256} cert={c} />
        ))}
      </Box>
    );

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: "background.default",
        color: "text.primary",
        display: "flex",
        justifyContent: "center",
        p: { xs: 2, md: 4 }
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 860 }}>
        <Typography component="h1" sx={{ fontSize: { xs: 24, md: 30 }, mb: 1 }}>
          {data?.single
            ? t("published-certs.title-one")
            : t("published-certs.title")}
        </Typography>
        {status === "loading" && (
          <Typography>{t("published-certs.loading")}</Typography>
        )}
        {status === "invalid" && (
          <Typography role="alert">{t("published-certs.invalid")}</Typography>
        )}
        {status === "not-found" && (
          <Typography role="alert">{t("published-certs.not-found")}</Typography>
        )}
        {status === "failed" && (
          <Typography role="alert">{t("published-certs.failed")}</Typography>
        )}
        {status === "ok" && (
          <>
            <Typography sx={{ mb: 2 }}>{t("published-certs.intro")}</Typography>
            {data.vlad && (
              <Field label={t("published-certs.identity")} mono>
                <span title={data.vlad}>{shortVlad(data.vlad)}</span>
              </Field>
            )}
            {data.single && data.leaves.length > 0 ? (
              // One signing certificate, then the root to trust.
              <Box sx={{ mt: 2 }}>
                {section(t("published-certs.leaves"), data.leaves)}
                {section(t("published-certs.issuer"), data.roots)}
                {data.roots.length > 0 && <AcrobatSteps />}
              </Box>
            ) : (
              <Box sx={{ mt: 2 }}>
                {section(t("published-certs.roots"), data.roots)}
                {data.roots.length > 0 && <AcrobatSteps />}
                {section(t("published-certs.leaves"), data.leaves)}
              </Box>
            )}
            <Typography sx={{ fontSize: 13, opacity: 0.8 }}>
              {t("published-certs.privacy")}
            </Typography>
          </>
        )}
      </Box>
    </Box>
  );
}
