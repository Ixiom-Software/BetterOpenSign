// Prepare a PDF for in-person signing: place named signature boxes on its
// pages and download it with a blank signature field in each. The BetterID
// phone app's "Sign a PDF in person" fills them: someone draws a signature on
// the phone for a box, and the phone's owner seals the PDF with their own
// signature (src/utils/inPersonFields.js). The PDF never leaves the browser.
//
// It can start from a template instead of a local PDF (/in-person?templateId=
// opens one): the template's PDF, with a box for each of its signature and
// initials widgets, named for the widget's role. The template is only read
// (getReport, getTemplate), never changed.
//
// Instead of downloading it, the PDF can be assigned to a colleague in one of
// your teams who has BetterID (inpersonassignees, inpersonassign in
// apps/OpenSignServer parsefunction/inPersonAssign.js): it's in their list to
// sign, on the website and in their BetterID app, which signs it in person.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Document, Page } from "react-pdf";
import { Rnd } from "react-rnd";
import axios from "axios";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MuiAlert from "@mui/material/Alert";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import {
  DEFAULT_BOX,
  MIN_BOX,
  addInPersonFields,
  readPdf,
  templateBoxes
} from "../utils/inPersonFields";

const MAX_PAGE_WIDTH = 900;
// The Templates report (json/ReportJson.js).
const TEMPLATES_REPORT = "6TeaPr321t";

// Calls a cloud function as the signed-in user; answers its result.
const runCloudFn = async (name, params) => {
  const res = await axios.post(
    `${localStorage.getItem("baseUrl")}functions/${name}`,
    params,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Parse-Application-Id": localStorage.getItem("parseAppId"),
        sessiontoken: localStorage.getItem("accesstoken")
      }
    }
  );
  return res.data?.result;
};

// Base64 of `bytes`, for a cloud function parameter.
const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

// The message of a failed cloud function call.
const cloudError = (err) => err?.response?.data?.error || err?.message || "";

// The template's name and placeholders, and its PDF's bytes. Throws a
// { code: "template" } error if it's gone, not shared with the user, or its
// PDF can't be fetched.
const fetchTemplate = async (templateId) => {
  const failed = () =>
    Object.assign(new Error("template"), { code: "template" });
  const template = await runCloudFn("getTemplate", { templateId }).catch(
    () => null
  );
  if (!template || template.error || !template.URL) throw failed();
  // getTemplate presigns URL for a short while: fetch it now.
  const res = await fetch(template.URL).catch(() => null);
  if (!res?.ok) throw failed();
  return {
    name: template.Name,
    placeholders: template.Placeholders,
    bytes: new Uint8Array(await res.arrayBuffer())
  };
};

const outputName = (fileName) =>
  `${String(fileName || "document").replace(/\.pdf$/i, "")}-in-person.pdf`;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function InPersonFields() {
  const { t } = useTranslation();
  const [fileName, setFileName] = useState("");
  const [bytes, setBytes] = useState(null);
  const [info, setInfo] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [nextName, setNextName] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pageWidth, setPageWidth] = useState(MAX_PAGE_WIDTH);
  const [notice, setNotice] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignees, setAssignees] = useState(null);
  const [assignee, setAssignee] = useState(null);
  const [docName, setDocName] = useState("");
  const [assignError, setAssignError] = useState("");
  const [assigned, setAssigned] = useState(null);
  const nextId = useRef(1);
  const viewer = useRef(null);
  // Set while a drag or resize ends: letting go outside the box (against the
  // page's edge, or below the minimum size) clicks the page itself.
  const justMoved = useRef(false);

  // pdf.js takes over the buffer it's given: hand it a copy.
  const file = useMemo(() => (bytes ? { data: bytes.slice() } : null), [bytes]);

  useEffect(() => {
    const el = viewer.current;
    if (!el) return undefined;
    const fit = () =>
      setPageWidth(Math.min(MAX_PAGE_WIDTH, Math.max(240, el.clientWidth)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [info]);

  const clearPdf = () => {
    setAssigned(null);
    setError("");
    setNotice("");
    setDone(null);
    setBoxes([]);
    setInfo(null);
    setBytes(null);
  };

  // Shows the PDF `load()` answers ({ name, bytes, placeholders? }), with a
  // box for each of the template's signature widgets if it's a template's.
  const openPdf = async (load) => {
    clearPdf();
    setBusy(true);
    try {
      const { name, bytes: data, placeholders } = await load();
      const read = await readPdf(data);
      if (placeholders) {
        const found = templateBoxes(placeholders, read.pages);
        setBoxes(found.boxes.map((box) => ({ ...box, id: nextId.current++ })));
        if (found.boxes.length === 0) {
          setNotice(t("in-person.template-no-signatures"));
        } else if (found.skipped > 0) {
          setNotice(t("in-person.template-skipped", { count: found.skipped }));
        }
      }
      setFileName(name);
      setBytes(data);
      setInfo(read);
    } catch (err) {
      console.log("in-person: cannot read the PDF", err);
      setError(
        err?.code === "encrypted"
          ? t("in-person.encrypted")
          : err?.code === "certified"
            ? t("in-person.certified")
            : err?.code === "template"
              ? t("in-person.template-error")
              : t("in-person.load-error")
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (event) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    if (picked.type !== "application/pdf" && !/\.pdf$/i.test(picked.name)) {
      clearPdf();
      setError(t("please-select-pdf"));
      return;
    }
    await openPdf(async () => ({
      name: picked.name,
      bytes: new Uint8Array(await picked.arrayBuffer())
    }));
  };

  const openTemplate = (templateId) =>
    openPdf(async () => {
      const template = await fetchTemplate(templateId);
      return { ...template, name: `${template.name || "template"}.pdf` };
    });

  // /in-person?templateId=... (the Templates list's "Sign in person").
  const linkedTemplate = searchParams.get("templateId");
  useEffect(() => {
    if (linkedTemplate) openTemplate(linkedTemplate);
    // Only when the link changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedTemplate]);

  // The user's templates matching what's typed, while the list is open.
  const search = useRef(0);
  useEffect(() => {
    if (!templatesOpen) return undefined;
    const id = ++search.current;
    const timer = setTimeout(async () => {
      setTemplatesLoading(true);
      try {
        const params = { reportId: TEMPLATES_REPORT, skip: 0, limit: 20 };
        if (templateQuery.trim()) params.searchTerm = templateQuery.trim();
        const result = await runCloudFn("getReport", params);
        if (id === search.current) {
          setTemplates(Array.isArray(result) ? result : []);
        }
      } catch (err) {
        console.log("in-person: cannot list templates", err);
        if (id === search.current) setTemplates([]);
      } finally {
        if (id === search.current) setTemplatesLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [templatesOpen, templateQuery]);

  const scaleOf = (pageIndex) => pageWidth / info.pages[pageIndex].width;

  // A click on a page (not on a box) puts a box there, centred on the click.
  const handlePageClick = (pageIndex, event) => {
    if (event.target !== event.currentTarget || justMoved.current) return;
    const scale = scaleOf(pageIndex);
    const page = info.pages[pageIndex];
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(DEFAULT_BOX.width, page.width);
    const height = Math.min(DEFAULT_BOX.height, page.height);
    const x = clamp(
      (event.clientX - rect.left) / scale - width / 2,
      0,
      page.width - width
    );
    const y = clamp(
      (event.clientY - rect.top) / scale - height / 2,
      0,
      page.height - height
    );
    const id = nextId.current++;
    const name =
      nextName.trim() || t("in-person.default-name", { n: boxes.length + 1 });
    setBoxes((prev) => [
      ...prev,
      { id, page: pageIndex, x, y, width, height, name }
    ]);
    setNextName("");
    setDone(null);
  };

  // The click, if any, comes straight after the mouseup that ends the move.
  const endMove = () => {
    justMoved.current = true;
    setTimeout(() => {
      justMoved.current = false;
    }, 0);
  };

  const updateBox = (id, changes) => {
    setBoxes((prev) =>
      prev.map((b) => (b.id === id ? { ...b, ...changes } : b))
    );
    setDone(null);
  };

  const removeBox = (id) => {
    setBoxes((prev) => prev.filter((b) => b.id !== id));
    setDone(null);
  };

  // The people the PDF can be assigned to (loaded when the dialog opens).
  const openAssign = async () => {
    setAssignError("");
    setAssignee(null);
    setDocName(String(fileName || "").replace(/\.pdf$/i, ""));
    setAssignOpen(true);
    if (assignees) return;
    try {
      const result = await runCloudFn("inpersonassignees", {});
      setAssignees(Array.isArray(result) ? result : []);
    } catch (err) {
      console.log("in-person: cannot list colleagues", err);
      setAssignees([]);
      setAssignError(t("in-person.assign-list-error"));
    }
  };

  const handleAssign = async () => {
    setBusy(true);
    setAssignError("");
    try {
      const { bytes: out } = await addInPersonFields(bytes, boxes);
      const result = await runCloudFn("inpersonassign", {
        name: docName.trim(),
        assigneeId: assignee.id,
        pdf: toBase64(out)
      });
      setAssignOpen(false);
      setDone(null);
      setAssigned({
        name: result?.name || docName.trim(),
        to: assignee.name || assignee.email
      });
    } catch (err) {
      console.log("in-person: cannot assign", err);
      setAssignError(
        err?.code === "certified"
          ? t("in-person.certified")
          : cloudError(err) || t("in-person.save-error")
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    setBusy(true);
    setError("");
    try {
      const { bytes: out, names } = await addInPersonFields(bytes, boxes);
      const url = URL.createObjectURL(
        new Blob([out], { type: "application/pdf" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = outputName(fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(names);
    } catch (err) {
      console.log("in-person: cannot add the fields", err);
      setError(
        err?.code === "certified"
          ? t("in-person.certified")
          : t("in-person.save-error")
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        maxWidth: 1152,
        mx: "auto",
        p: { xs: 2, md: 3 },
        bgcolor: "background.paper",
        color: "text.primary",
        boxShadow: 3,
        borderRadius: 3
      }}
    >
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
        {t("in-person.title")}
      </Typography>
      <Typography sx={{ color: "text.secondary", mb: 2 }}>
        {t("in-person.intro")}
      </Typography>

      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 2,
          mb: 2
        }}
      >
        <Button variant="outlined" component="label" disabled={busy}>
          {info ? t("in-person.change-file") : t("select-pdf-document")}
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFile}
            hidden
          />
        </Button>
        <Autocomplete
          size="small"
          sx={{ minWidth: 260, flex: "0 1 320px" }}
          options={templates}
          getOptionLabel={(option) => option?.Name || ""}
          isOptionEqualToValue={(a, b) => a.objectId === b.objectId}
          // The server filters by what's typed.
          filterOptions={(options) => options}
          loading={templatesLoading}
          disabled={busy}
          value={null}
          blurOnSelect
          open={templatesOpen}
          onOpen={() => setTemplatesOpen(true)}
          onClose={() => setTemplatesOpen(false)}
          onInputChange={(e, value, reason) => {
            if (reason === "input") setTemplateQuery(value);
          }}
          onChange={(e, option) => {
            if (option?.objectId) openTemplate(option.objectId);
          }}
          noOptionsText={t("in-person.template-none")}
          renderInput={(params) => (
            <TextField
              {...params}
              label={t("in-person.from-template")}
              placeholder={t("in-person.template-search")}
            />
          )}
        />
        {fileName && info && (
          <Typography
            sx={{
              fontSize: "0.875rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "100%"
            }}
          >
            {t("selected-file")}: {fileName}
          </Typography>
        )}
        {busy && <CircularProgress size={20} />}
      </Box>

      {error && (
        <MuiAlert severity="error" sx={{ mb: 2 }}>
          {error}
        </MuiAlert>
      )}

      {info && (
        <>
          {notice && (
            <MuiAlert severity="info" sx={{ mb: 2 }}>
              {notice}
            </MuiAlert>
          )}
          {info.signatureFields.length > 0 && (
            <MuiAlert severity="info" sx={{ mb: 2 }}>
              {t("in-person.existing", {
                names: info.signatureFields.join(", ")
              })}
            </MuiAlert>
          )}

          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-start",
              gap: 2,
              mb: 2
            }}
          >
            <TextField
              size="small"
              label={t("in-person.next-name")}
              placeholder={t("in-person.default-name", { n: boxes.length + 1 })}
              helperText={t("in-person.click-hint")}
              value={nextName}
              onChange={(e) => setNextName(e.target.value)}
              sx={{ minWidth: 260, flex: "1 1 260px" }}
            />
            <Button
              variant="contained"
              onClick={handleDownload}
              disabled={busy || boxes.length === 0}
              startIcon={
                <i className="fa-light fa-download" aria-hidden="true" />
              }
            >
              {t("in-person.download")}
            </Button>
            <Button
              variant="outlined"
              onClick={openAssign}
              disabled={busy || boxes.length === 0}
              startIcon={
                <i className="fa-light fa-user-check" aria-hidden="true" />
              }
            >
              {t("in-person.assign")}
            </Button>
          </Box>

          {assigned && (
            <MuiAlert severity="success" sx={{ mb: 2 }}>
              {t("in-person.assigned", assigned)}
            </MuiAlert>
          )}

          {done && (
            <MuiAlert severity="success" sx={{ mb: 2 }}>
              {t("in-person.downloaded", { names: done.join(", ") })}
            </MuiAlert>
          )}

          {boxes.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography sx={{ fontWeight: 600, mb: 1 }}>
                {t("in-person.boxes-title")}
              </Typography>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {boxes.map((b) => (
                  <Box
                    key={b.id}
                    sx={{ display: "flex", alignItems: "center", gap: 1 }}
                  >
                    <TextField
                      size="small"
                      value={b.name}
                      onChange={(e) =>
                        updateBox(b.id, { name: e.target.value })
                      }
                      inputProps={{ "aria-label": t("in-person.signer-name") }}
                      sx={{ flex: "1 1 auto", maxWidth: 420 }}
                    />
                    <Typography
                      sx={{ fontSize: "0.875rem", color: "text.secondary" }}
                    >
                      {t("in-person.page-n", { n: b.page + 1 })}
                    </Typography>
                    <IconButton
                      aria-label={t("in-person.remove")}
                      onClick={() => removeBox(b.id)}
                      size="small"
                    >
                      <i className="fa-light fa-trash" aria-hidden="true" />
                    </IconButton>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          <Box ref={viewer} sx={{ width: "100%" }}>
            <Document
              file={file}
              loading={t("loading-doc")}
              error={t("in-person.load-error")}
            >
              {info.pages.map((page, index) => {
                const scale = scaleOf(index);
                return (
                  <Box key={index} sx={{ mb: 2 }}>
                    <Typography
                      sx={{
                        fontSize: "0.75rem",
                        color: "text.secondary",
                        mb: 0.5
                      }}
                    >
                      {t("in-person.page-n", { n: index + 1 })}
                    </Typography>
                    <Box
                      sx={{
                        position: "relative",
                        width: pageWidth,
                        height: page.height * scale,
                        border: 1,
                        borderColor: "divider",
                        bgcolor: "#fff"
                      }}
                    >
                      <Page
                        pageIndex={index}
                        width={pageWidth}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                      />
                      <Box
                        data-testid={`in-person-page-${index}`}
                        onClick={(e) => handlePageClick(index, e)}
                        sx={{
                          position: "absolute",
                          inset: 0,
                          cursor: "crosshair"
                        }}
                      >
                        {boxes
                          .filter((b) => b.page === index)
                          .map((b) => (
                            <Rnd
                              key={b.id}
                              bounds="parent"
                              cancel=".in-person-remove"
                              size={{
                                width: b.width * scale,
                                height: b.height * scale
                              }}
                              position={{ x: b.x * scale, y: b.y * scale }}
                              minWidth={MIN_BOX.width * scale}
                              minHeight={MIN_BOX.height * scale}
                              onDragStop={(e, d) => {
                                endMove();
                                updateBox(b.id, {
                                  x: d.x / scale,
                                  y: d.y / scale
                                });
                              }}
                              onResizeStop={(e, dir, ref, delta, pos) => {
                                endMove();
                                updateBox(b.id, {
                                  width: ref.offsetWidth / scale,
                                  height: ref.offsetHeight / scale,
                                  x: pos.x / scale,
                                  y: pos.y / scale
                                });
                              }}
                              style={{
                                border: "2px dashed #1f7a4d",
                                background: "rgba(31, 122, 77, 0.12)",
                                cursor: "move"
                              }}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "flex-start",
                                  justifyContent: "space-between",
                                  height: "100%",
                                  px: 0.5,
                                  color: "#123",
                                  fontSize: "0.75rem",
                                  overflow: "hidden",
                                  userSelect: "none"
                                }}
                              >
                                <Box
                                  component="span"
                                  sx={{
                                    bgcolor: "rgba(255, 255, 255, 0.9)",
                                    borderRadius: 0.5,
                                    px: 0.5,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis"
                                  }}
                                >
                                  {b.name}
                                </Box>
                                <IconButton
                                  className="in-person-remove"
                                  aria-label={t("in-person.remove")}
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeBox(b.id);
                                  }}
                                  sx={{ p: 0.25, color: "#123" }}
                                >
                                  <i
                                    className="fa-light fa-xmark"
                                    aria-hidden="true"
                                  />
                                </IconButton>
                              </Box>
                            </Rnd>
                          ))}
                      </Box>
                    </Box>
                  </Box>
                );
              })}
            </Document>
          </Box>

          <MuiAlert severity="info" sx={{ mt: 1 }}>
            {t("in-person.phone-steps")}
          </MuiAlert>
        </>
      )}

      <Dialog
        open={assignOpen}
        onClose={() => !busy && setAssignOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t("in-person.assign-title")}</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: "text.secondary", mb: 2 }}>
            {t("in-person.assign-intro")}
          </Typography>
          <TextField
            label={t("in-person.assign-doc-name")}
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            fullWidth
            size="small"
            sx={{ mb: 2 }}
          />
          <Autocomplete
            options={assignees || []}
            loading={!assignees}
            value={assignee}
            onChange={(e, option) => setAssignee(option)}
            getOptionLabel={(option) => option?.name || option?.email || ""}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            getOptionDisabled={(option) => !option.linked}
            noOptionsText={t("in-person.assign-none")}
            renderOption={(props, option) => {
              const { key, ...rest } = props;
              return (
                <Box component="li" key={key} {...rest}>
                  <Box>
                    <Typography>{option.name || option.email}</Typography>
                    <Typography
                      sx={{ fontSize: "0.8rem", color: "text.secondary" }}
                    >
                      {[option.email, option.teams.join(", ")]
                        .filter(Boolean)
                        .join(" · ")}
                      {!option.linked &&
                        ` · ${t("in-person.assign-no-betterid")}`}
                    </Typography>
                  </Box>
                </Box>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("in-person.assign-to")}
                size="small"
              />
            )}
          />
          {assignError && (
            <MuiAlert severity="error" sx={{ mt: 2 }}>
              {assignError}
            </MuiAlert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignOpen(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={handleAssign}
            disabled={busy || !assignee || !docName.trim()}
          >
            {busy ? <CircularProgress size={18} /> : t("in-person.assign-send")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default InPersonFields;
