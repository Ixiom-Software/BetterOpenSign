// PhoneSignPdf: "Sign with your BetterSign phone" at Finish (v2).
//
// The signer's BetterSign phone signs the whole PDF with its own key (PAdES)
// instead of returning a PNG for one field (PhoneSign, v1). Offered to someone
// signed in with BetterSign (isBetterSignSession) whose widgets hold exactly
// one signature widget. The page builds the base (utils/phoneSignBase.js) and
// starts the request; this modal shows its progress until the server has
// committed the signed PDF (as finishSigning does for a normal Finish), the
// phone declines, or it fails or expires. The document stays unsigned then, so
// the signer can try again or finish normally.
//
// Server side: apps/OpenSignServer/cloud/parsefunction (Sign on phone v2)
//   bsphonesignpdfstart { docId, fieldName, base, caption? } -> { reqId, expiresAt }
//   bsphonesignpdfpoll  { reqId } -> { status, reason?, message? }
//   bsphonesignpdfcancel { reqId } -> { status }: closing the modal while it
//     runs, so the document isn't held locked until the request expires.

import { useEffect, useRef, useState } from "react";
import Parse from "parse";
import { useTranslation } from "react-i18next";
import ModalUi from "../../primitives/ModalUi";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import { isBetterSignSession } from "./PhoneSign";
import { phoneSignatureWidget } from "../../utils/phoneSignBase";

// Whether to offer "Sign with your BetterSign phone" at Finish: a BetterSign
// session, a saved document, and exactly one signature widget of the signer's.
export function canSignPdfOnPhone(docId, widgets) {
  return !!docId && isBetterSignSession() && !!phoneSignatureWidget(widgets);
}

const RETRY_MS = 1500;
// A poll normally waits on the server for the phone; one that comes back at
// once (the relay or a service is down) isn't repeated sooner than this.
const MIN_POLL_MS = 1000;
const FAILED = ["denied", "error", "expired", "cancelled"];

// expiresAt as epoch milliseconds: accepts milliseconds, seconds or a date
// string.
export function expiryMs(expiresAt) {
  if (typeof expiresAt === "number") {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? null : ms;
}

const pause = (ms) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// `start()` builds the base and runs bsphonesignpdfstart, answering
// { reqId, expiresAt }; it throws with a message to show. `onSigned()` runs
// once the server has committed the phone's signature.
export default function PhoneSignPdf({ isOpen, onClose, start, onSigned }) {
  const { t } = useTranslation();
  const [step, setStep] = useState("");
  const [message, setMessage] = useState("");
  const [expiresAt, setExpiresAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const runRef = useRef(0);
  // The running attempt's reqId, to cancel it on close.
  const reqRef = useRef(null);

  const isError = FAILED.includes(step);
  const busy = !!step && !isError && step !== "signed";

  const fail = (status, msg) => {
    setStep(status);
    setMessage(msg || t(`phone-sign-pdf.${status}`));
  };

  async function send() {
    const run = ++runRef.current;
    const live = () => run === runRef.current;
    setStep("preparing");
    setMessage("");
    setExpiresAt(null);
    let reqId;
    let expires;
    try {
      const res = await start();
      reqId = res.reqId;
      expires = res.expiresAt;
    } catch (e) {
      if (live()) fail("error", e?.message || t("phone-sign-pdf.send-failed"));
      return;
    }
    if (!live()) {
      // Closed while it started: end the attempt it started, so the document
      // isn't held until the request expires.
      if (reqId) {
        Parse.Cloud.run("bsphonesignpdfcancel", { reqId }).catch(() => {});
      }
      return;
    }
    reqRef.current = reqId;
    setExpiresAt(expiryMs(expires));
    setStep("waiting");
    while (live()) {
      const began = Date.now();
      let res;
      try {
        res = await Parse.Cloud.run("bsphonesignpdfpoll", { reqId });
      } catch {
        if (!live()) return;
        setStep("retrying");
        await pause(RETRY_MS);
        continue;
      }
      if (!live()) return;
      const status = res?.status;
      if (status === "signed") {
        reqRef.current = null;
        setStep("signed");
        onSigned && onSigned();
        return;
      }
      if (FAILED.includes(status)) {
        reqRef.current = null;
        return fail(status, res.message);
      }
      if (["waiting", "approved", "signing"].includes(status)) {
        setStep(status);
        await pause(MIN_POLL_MS - (Date.now() - began));
      } else {
        // Unknown status: don't spin on it.
        await pause(RETRY_MS);
      }
    }
  }

  // Start as soon as the modal opens; stop waiting when it closes.
  useEffect(() => {
    if (isOpen) send();
    return () => {
      runRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Tick the countdown while waiting for the approval.
  useEffect(() => {
    if (step !== "waiting" || !expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step, expiresAt]);

  function close() {
    runRef.current++;
    const reqId = reqRef.current;
    reqRef.current = null;
    if (reqId) {
      // Best effort: the lock lapses on its own at the request's expiry.
      Parse.Cloud.run("bsphonesignpdfcancel", { reqId }).catch(() => {});
    }
    setStep("");
    setMessage("");
    onClose && onClose();
  }

  if (!isOpen) return null;

  const status = isError
    ? message
    : step === "waiting"
      ? t("phone-sign-pdf.waiting")
      : ["approved", "signing"].includes(step)
        ? t("phone-sign-pdf.signing")
        : step
          ? t(`phone-sign-pdf.${step}`)
          : "";

  return (
    <ModalUi
      isOpen={isOpen}
      title={t("phone-sign-pdf.title")}
      handleClose={close}
      reduceWidth="max-w-[420px]"
    >
      <Box sx={{ px: 2, py: 1.5, color: "text.primary" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
          {busy && <CircularProgress size={20} />}
          <Typography
            role="status"
            sx={{
              fontSize: "0.875rem",
              color: isError ? "error.main" : "text.primary"
            }}
          >
            {status}
          </Typography>
        </Box>
        {step === "waiting" && expiresAt && (
          <Typography
            sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 1.5 }}
          >
            {t("phone-sign-pdf.expires-in", {
              time: countdown(expiresAt - now)
            })}
          </Typography>
        )}
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
          {step !== "signed" && (
            <Button type="button" variant="text" size="small" onClick={close}>
              {busy ? t("phone-sign-pdf.cancel") : t("phone-sign-pdf.close")}
            </Button>
          )}
          {isError && (
            <Button
              type="button"
              variant="contained"
              size="small"
              onClick={send}
            >
              {t("phone-sign-pdf.try-again")}
            </Button>
          )}
        </Box>
      </Box>
    </ModalUi>
  );
}
