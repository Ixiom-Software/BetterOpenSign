// Prepare a PDF for in-person signing: place named signature boxes on its
// pages and download it with a blank signature field in each. The BetterID
// phone app's "Sign a PDF in person" fills them: someone draws a signature on
// the phone for a box, and the phone's owner seals the PDF with their own
// signature (src/utils/inPersonFields.js). The PDF never leaves the browser.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Document, Page } from "react-pdf";
import { Rnd } from "react-rnd";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MuiAlert from "@mui/material/Alert";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import {
  DEFAULT_BOX,
  MIN_BOX,
  addInPersonFields,
  readPdf
} from "../utils/inPersonFields";

const MAX_PAGE_WIDTH = 900;

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

  const handleFile = async (event) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    setError("");
    setDone(null);
    setBoxes([]);
    setInfo(null);
    setBytes(null);
    if (picked.type !== "application/pdf" && !/\.pdf$/i.test(picked.name)) {
      setError(t("please-select-pdf"));
      return;
    }
    setBusy(true);
    try {
      const data = new Uint8Array(await picked.arrayBuffer());
      const read = await readPdf(data);
      setFileName(picked.name);
      setBytes(data);
      setInfo(read);
    } catch (err) {
      console.log("in-person: cannot read the PDF", err);
      setError(
        err?.code === "encrypted"
          ? t("in-person.encrypted")
          : err?.code === "certified"
            ? t("in-person.certified")
            : t("in-person.load-error")
      );
    } finally {
      setBusy(false);
    }
  };

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
          </Box>

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
    </Box>
  );
}

export default InPersonFields;
