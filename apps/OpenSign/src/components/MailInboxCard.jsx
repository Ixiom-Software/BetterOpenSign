// Profile page: the user's address for emailing PDFs to Better DocSign. Off
// until turned on; then each PDF sent to the address becomes a draft
// document, and sent to the +template address, a template. Mail is taken
// only from the account's email and the senders added here. Server side:
// apps/OpenSignServer/cloud/parsefunction/mailInbox.js (mailinboxget,
// mailinboxrotate, mailinboxupdate) and cloud/customRoute/inboundMail.js.
import { useEffect, useState } from "react";
import Parse from "parse";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ModalUi from "../primitives/ModalUi";
import Tooltip from "../primitives/Tooltip";
import Loader from "../primitives/Loader";
import { copytoData } from "../constant/Utils";
import { withSessionValidation } from "../utils";

const rowSx = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 1,
  borderBottom: 1,
  borderColor: "divider",
  py: 1,
  wordBreak: "break-all"
};

const statusColor = (status) =>
  status === "created"
    ? "success.main"
    : status === "processing"
      ? "text.secondary"
      : "error.main";

const MailInboxCard = () => {
  const { t } = useTranslation();
  const [inbox, setInbox] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sender, setSender] = useState("");
  const [message, setMessage] = useState({ type: "", text: "" });
  const [isRotateOpen, setIsRotateOpen] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      setInbox(await Parse.Cloud.run("mailinboxget"));
    } catch (err) {
      console.log("Err in mailinboxget", err);
      setMessage({ type: "error", text: t("something-went-wrong-mssg") });
    } finally {
      setIsLoading(false);
    }
  }

  const run = withSessionValidation(async (fn, params, done) => {
    setBusy(true);
    setMessage({ type: "", text: "" });
    try {
      setInbox(await Parse.Cloud.run(fn, params));
      if (done) setMessage({ type: "success", text: done });
      return true;
    } catch (err) {
      console.log(`Err in ${fn}`, err);
      setMessage({
        type: "error",
        text: err?.message || t("something-went-wrong-mssg")
      });
      return false;
    } finally {
      setBusy(false);
    }
  });

  const copy = (address) => {
    copytoData(address);
    setMessage({ type: "success", text: t("mail-inbox.copied") });
  };

  const addSender = async (e) => {
    e.preventDefault();
    const email = sender.trim();
    if (!email) return;
    const ok = await run("mailinboxupdate", {
      allowedSenders: [...inbox.allowedSenders, email]
    });
    if (ok) setSender("");
  };

  const removeSender = (email) =>
    run("mailinboxupdate", {
      allowedSenders: inbox.allowedSenders.filter((s) => s !== email)
    });

  const rotate = () => {
    setIsRotateOpen(false);
    run("mailinboxrotate", {}, t("mail-inbox.rotated"));
  };

  const address = (label, value) => (
    <Box component="li" sx={rowSx}>
      <Box component="span" sx={{ fontWeight: 600, flexShrink: 0 }}>
        {label}:
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <Box component="span" sx={{ fontFamily: "monospace", fontSize: 13 }}>
          {value}
        </Box>
        <IconButton
          size="small"
          aria-label={t("mail-inbox.copy")}
          title={t("mail-inbox.copy")}
          onClick={() => copy(value)}
        >
          <i className="fa-light fa-copy"></i>
        </IconButton>
      </Box>
    </Box>
  );

  const details = () => (
    <>
      <Box
        component="ul"
        sx={{
          listStyle: "none",
          p: 0,
          m: 0,
          fontSize: { xs: "0.875rem", md: "1rem" },
          opacity: inbox.enabled ? 1 : 0.5
        }}
      >
        {address(t("mail-inbox.document"), inbox.addresses.document)}
        {address(t("mail-inbox.template"), inbox.addresses.template)}
        <Box component="li" sx={{ ...rowSx, display: "block" }}>
          <Box component="span" sx={{ fontWeight: 600 }}>
            {t("mail-inbox.senders")}:
          </Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
            <Chip size="small" label={inbox.accountEmail} />
            {inbox.allowedSenders.map((s) => (
              <Chip
                key={s}
                size="small"
                label={s}
                disabled={busy}
                onDelete={() => removeSender(s)}
              />
            ))}
          </Box>
          <Box
            component="form"
            onSubmit={addSender}
            sx={{ display: "flex", gap: 1, mt: 1 }}
          >
            <TextField
              size="small"
              type="email"
              fullWidth
              placeholder={t("mail-inbox.add-sender")}
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
            <Button type="submit" variant="outlined" disabled={busy}>
              {t("mail-inbox.add")}
            </Button>
          </Box>
        </Box>
      </Box>
      {inbox.recent.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 14 }}>
            {t("mail-inbox.recent")}
          </Typography>
          {inbox.recent.map((m, i) => (
            <Box
              key={i}
              sx={{ fontSize: 13, py: 0.5, wordBreak: "break-word" }}
            >
              <Box component="span" sx={{ color: "text.secondary" }}>
                {new Date(m.at?.iso || m.at).toLocaleString()}
              </Box>{" "}
              {m.subject || m.from}
              {" — "}
              <Box component="span" sx={{ color: statusColor(m.status) }}>
                {m.status === "created"
                  ? t("mail-inbox.made", { count: m.created.length })
                  : m.status === "processing"
                    ? t("mail-inbox.processing")
                    : m.reason}
              </Box>
            </Box>
          ))}
        </Box>
      )}
      <Box sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}>
        <Button
          variant="text"
          color="secondary"
          disabled={busy}
          onClick={() => setIsRotateOpen(true)}
        >
          {t("mail-inbox.rotate")}
        </Button>
      </Box>
    </>
  );

  return (
    <Paper
      elevation={2}
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        borderRadius: 4,
        width: 450,
        mt: 2,
        px: 2,
        pb: 2
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pt: 1.5
        }}
      >
        <Box sx={{ fontWeight: 300, fontSize: { xs: "18px", md: "20px" } }}>
          {t("mail-inbox.title")}{" "}
          <Box component="span" sx={{ fontSize: "13px", fontWeight: 400 }}>
            <Tooltip message={t("mail-inbox.help")} maxWidth="max-w-[300px]" />
          </Box>
        </Box>
        {inbox && (
          <Switch
            checked={inbox.enabled}
            disabled={busy}
            onChange={(e) =>
              run("mailinboxupdate", { enabled: e.target.checked })
            }
            slotProps={{ input: { "aria-label": t("mail-inbox.enabled") } }}
          />
        )}
      </Box>
      {isLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <Loader />
        </Box>
      ) : inbox?.addresses ? (
        details()
      ) : (
        inbox && (
          <Typography sx={{ fontSize: 14, color: "text.secondary", py: 1 }}>
            {t("mail-inbox.off")}
          </Typography>
        )
      )}
      {message.text && (
        <Typography
          role="status"
          sx={{
            mt: 1,
            fontSize: 13,
            color: message.type === "error" ? "error.main" : "success.main"
          }}
        >
          {message.text}
        </Typography>
      )}
      <ModalUi
        isOpen={isRotateOpen}
        title={t("mail-inbox.rotate")}
        handleClose={() => setIsRotateOpen(false)}
      >
        <Box sx={{ m: 2.5 }}>
          <Typography sx={{ fontSize: "1rem", color: "text.primary" }}>
            {t("mail-inbox.rotate-confirm")}
          </Typography>
          <Divider sx={{ mt: 2 }} />
          <Box sx={{ display: "flex", alignItems: "center", mt: 1.5, gap: 1 }}>
            <Button variant="contained" color="error" onClick={rotate}>
              {t("yes")}
            </Button>
            <Button
              variant="contained"
              color="secondary"
              onClick={() => setIsRotateOpen(false)}
            >
              {t("no")}
            </Button>
          </Box>
        </Box>
      </ModalUi>
    </Paper>
  );
};

export default MailInboxCard;
