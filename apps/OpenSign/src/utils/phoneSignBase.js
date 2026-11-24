// Sign with your BetterID phone (v2): the base revision the phone signs.
//
// The signer's phone signs the whole PDF with its own key (PAdES). The
// browser builds the revision it signs: the document's current file, followed
// by an incremental update that draws the signer's other widgets as Finish
// does today and adds one blank, visible signature field where the signature
// widget is. The server checks the base extends the current file
// (OpenSignServer utils/appendOnlyPdf.js extendsPdf) and puts the phone's
// signature in that field. So the base is built in incremental mode
// (@cantoo/pdf-lib forIncrementalUpdate), even on a document no BetterID
// identity has signed yet, and signature fields are never flattened
// (flattenExceptSignatures).
//
// Server side: bsphonesignpdfstart { docId, fieldName, base, caption? }.
import { toDegrees } from "@cantoo/pdf-lib";
import { embedWidgetsToDoc, imageWidgetDrawOptions } from "../constant/Utils";
import { addBlankSignatureField, loadPdfForSigning } from "./appendOnlyPdf";

// The /T of the blank signature field: no '.' (it separates field name
// parts) and at most 100 characters.
// The server takes `bs-phone-` and at most 91 of [A-Za-z0-9_:-].
export const phoneSignFieldName = (key) =>
  `bs-phone-${String(key)
    .replace(/[^A-Za-z0-9_:-]/g, "-")
    .slice(0, 91)}`;

// The signer's signature widget, if they have exactly one:
// { pageNumber, position }, else null.
export const phoneSignatureWidget = (widgets) => {
  const found = [];
  for (const page of widgets || []) {
    for (const position of page?.pos || []) {
      if (position?.type === "signature") {
        found.push({ pageNumber: page.pageNumber, position });
      }
    }
  }
  return found.length === 1 ? found[0] : null;
};

// The widgets without the one whose key is `key`.
export const withoutWidget = (widgets, key) =>
  (widgets || []).map((page) => ({
    ...page,
    pos: (page?.pos || []).filter((position) => position?.key !== key)
  }));

// The [x1, y1, x2, y2] rectangle, in the page's default user space, of the
// image embedWidgetsToDoc would draw for `position`: the bounding box of the
// (possibly rotated) image, as page.drawImage rotates it about (x, y).
export const imageWidgetRect = (page, position, scale) => {
  const { x, y, width, height, rotate } = imageWidgetDrawOptions(
    page,
    position,
    scale
  );
  const rad = ((rotate ? toDegrees(rotate) : 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height]
  ].map(([u, v]) => [x + u * cos - v * sin, y + u * sin + v * cos]);
  // Rounded to hundredths, so 90° rotations don't leave float noise.
  const round = (n) => Math.round(n * 100) / 100;
  const xs = corners.map((c) => round(c[0]));
  const ys = corners.map((c) => round(c[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

// Builds the base: `bytes` (the document's current file) followed by an
// incremental update that draws `widgets` other than the signature widget and
// adds the blank signature field for it. `beforeDraw(pdfDoc)` runs first (to
// embed the document id, as Finish does). Answers { base (base64), fieldName }
// or { error } as embedWidgetsToDoc does.
export const buildPhoneSignBase = async ({
  bytes,
  widgets,
  scale,
  signyourself,
  beforeDraw
}) => {
  const signature = phoneSignatureWidget(widgets);
  if (!signature) {
    return { error: "Exactly one signature field is needed" };
  }
  const pdfDoc = await loadPdfForSigning(bytes, true);
  if (beforeDraw) await beforeDraw(pdfDoc);
  const page = pdfDoc.getPages()[signature.pageNumber - 1];
  if (!page) {
    return { error: "The signature field's page is missing" };
  }
  const fieldName = phoneSignFieldName(signature.position.key);
  addBlankSignatureField(
    pdfDoc,
    page,
    imageWidgetRect(page, signature.position, scale),
    fieldName
  );
  const base = await embedWidgetsToDoc(
    withoutWidget(widgets, signature.position.key),
    pdfDoc,
    signyourself,
    scale
  );
  if (base?.error) return base;
  return { base, fieldName };
};
