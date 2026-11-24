// Prepare a PDF for in-person signing on a BetterID phone.
//
// The phone app's "Sign a PDF in person" (BetterSignApps #566, bs_core
// pdf_local.rs) lists a PDF's blank signature fields by name. For each one the
// phone's owner picks Me, In person (someone else draws on the phone, and the
// drawing is stamped into the field's box) or Leave blank, then signs the
// whole PDF with their own key. This adds those blank fields: one per box the
// user placed, named for whoever signs there, all in the browser.
//
// Boxes are kept in the page's display space at scale 1 (what pdf.js shows:
// the crop box, turned by /Rotate, origin top left), so the page component
// only has to scale them.
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFSignature,
  StandardFonts,
  beginText,
  endText,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setDashPattern,
  setFillingGrayscaleColor,
  setFontAndSize,
  setLineWidth,
  setStrokingGrayscaleColor,
  showText,
  stroke
} from "@cantoo/pdf-lib";
import { addBlankSignatureField } from "./appendOnlyPdf";

// A new box, in display units (points at scale 1).
export const DEFAULT_BOX = { width: 180, height: 60 };
export const MIN_BOX = { width: 40, height: 20 };
// The /T limit the phone and docsign keep to.
const MAX_NAME = 100;

// As pdf.js reads /Rotate: a multiple of 90, else 0.
const normRotation = (degrees) =>
  (degrees || 0) % 90 ? 0 : (((degrees || 0) % 360) + 360) % 360;

// The field name for `label`: no '.', which separates field name parts, and
// at most 100 characters; unique among `taken` (" 2", " 3", ... appended).
// Like phoneSignFieldName (phoneSignBase.js), which the server limits further.
export const fieldNameFor = (label, taken) => {
  const base =
    String(label || "")
      .replace(/\./g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME) || "Signature";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = base.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!used.has(name)) return name;
  }
};

// The part of the page pdf.js shows: the crop box clipped to the media box,
// or the media box if they don't overlap.
const visibleBox = (page) => {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const width = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const height = Math.min(crop.y + crop.height, media.y + media.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : media;
};

// The page as pdf.js displays it: its visible box, rotation and display size.
const pageGeometry = (page) => {
  const { x, y, width, height } = visibleBox(page);
  const rotation = normRotation(page.getRotation().angle);
  const turned = rotation === 90 || rotation === 270;
  return {
    box: { x, y, width, height },
    rotation,
    displayWidth: turned ? height : width,
    displayHeight: turned ? width : height
  };
};

// A display point (origin top left, y down) in the page's user space.
const toUserSpace = ({ box, rotation }, dx, dy) => {
  switch (rotation) {
    case 90:
      return [box.x + dy, box.y + dx];
    case 180:
      return [box.x + box.width - dx, box.y + dy];
    case 270:
      return [box.x + box.width - dy, box.y + box.height - dx];
    default:
      return [box.x + dx, box.y + box.height - dy];
  }
};

// [x1, y1, x2, y2] in user space for a display box { x, y, width, height }.
export const displayBoxToRect = (geometry, { x, y, width, height }) => {
  const [ax, ay] = toUserSpace(geometry, x, y);
  const [bx, by] = toUserSpace(geometry, x + width, y + height);
  const round = (n) => Math.round(n * 100) / 100;
  return [
    round(Math.min(ax, bx)),
    round(Math.min(ay, by)),
    round(Math.max(ax, bx)),
    round(Math.max(ay, by))
  ];
};

// True if the PDF is certified (/Perms /DocMDP): the phone refuses in-person
// signatures on a certified PDF.
const isCertified = (pdfDoc) => {
  const perms = pdfDoc.catalog.lookup(PDFName.of("Perms"));
  return Boolean(perms?.get?.(PDFName.of("DocMDP")));
};

// True if the PDF carries a digital signature, which a full re-save would
// break: a signature field with a value (wherever its dictionary is stored,
// object streams included), or usage rights (/Perms /UR3, Reader
// extensions). Then the fields are added as an incremental update.
const hasSignature = (pdfDoc) => {
  const perms = pdfDoc.catalog.lookup(PDFName.of("Perms"));
  if (perms?.get?.(PDFName.of("UR3")) || perms?.get?.(PDFName.of("UR"))) {
    return true;
  }
  return pdfDoc
    .getForm()
    .getFields()
    .some(
      (field) =>
        field instanceof PDFSignature &&
        field.acroField.dict.get(PDFName.of("V")) !== undefined
    );
};

// The names a new top-level field must not take: every field's full name,
// and the top-level names of field groups ("Homeowner" of "Homeowner.sig"),
// which getFields() doesn't list.
const takenNames = (pdfDoc) => {
  const form = pdfDoc.getForm();
  const names = form.getFields().map((field) => field.getName());
  for (const [field] of form.acroForm.getFields()) {
    const name = field.getPartialName();
    if (name) names.push(name);
  }
  return names;
};

// Reads `bytes` for the page: each page's display size, the form's field
// names and its signature fields. Throws a { code } error for a PDF it can't
// prepare: "encrypted" or "certified".
export const readPdf = async (bytes) => {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(String(err?.message))) {
      throw Object.assign(new Error("encrypted"), { code: "encrypted" });
    }
    throw err;
  }
  if (isCertified(pdfDoc)) {
    throw Object.assign(new Error("certified"), { code: "certified" });
  }
  const pages = pdfDoc.getPages().map((page) => {
    const { displayWidth, displayHeight } = pageGeometry(page);
    return { width: displayWidth, height: displayHeight };
  });
  const fields = pdfDoc.getForm().getFields();
  return {
    pages,
    fieldNames: fields.map((field) => field.getName()),
    signatureFields: fields
      .filter((field) => field instanceof PDFSignature)
      .map((field) => field.getName())
  };
};

// Helvetica can only draw WinAnsi characters; anything else becomes "?".
const drawable = (font, text) => {
  const supported = new Set(font.getCharacterSet());
  return Array.from(text)
    .map((ch) => (supported.has(ch.codePointAt(0)) ? ch : "?"))
    .join("");
};

// The field's appearance before anyone signs: a dashed outline and the
// signer's name in its top left corner (documents usually print their own
// signature line), upright as the page is displayed (the form's /Matrix
// undoes the page's /Rotate).
const blankAppearance = (pdfDoc, font, rotation, width, height, label) => {
  const size = Math.max(5, Math.min(8, height / 4));
  const text = drawable(font, label);
  const maxWidth = width - 6;
  let shown = text;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > maxWidth) {
    shown = shown.slice(0, -1);
  }
  const operators = [
    pushGraphicsState(),
    setStrokingGrayscaleColor(0.45),
    setLineWidth(0.75),
    setDashPattern([3, 2], 0),
    moveTo(0.5, 0.5),
    lineTo(width - 0.5, 0.5),
    lineTo(width - 0.5, height - 0.5),
    lineTo(0.5, height - 0.5),
    lineTo(0.5, 0.5),
    stroke(),
    beginText(),
    setFillingGrayscaleColor(0.35),
    setFontAndSize("Helv", size),
    moveText(3, Math.max(1, height - size - 2)),
    showText(font.encodeText(shown)),
    endText(),
    popGraphicsState()
  ];
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return pdfDoc.context.register(
    pdfDoc.context.formXObject(operators, {
      BBox: [0, 0, width, height],
      Matrix: [cos, sin, -sin, cos, 0, 0],
      Resources: { Font: { Helv: font.ref } }
    })
  );
};

// The PDF with one blank, visible signature field per box. `boxes` is
// [{ page (0-based), x, y, width, height, name }] in display units. A signed
// PDF gets an incremental update (its signatures stay valid); any other is
// re-saved with a classic cross-reference table, as Acrobat and the phone
// prefer. Answers { bytes, names } (the field names used, in box order).
export const addInPersonFields = async (bytes, boxes) => {
  let pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (isCertified(pdfDoc)) {
    throw Object.assign(new Error("certified"), { code: "certified" });
  }
  const incremental = hasSignature(pdfDoc);
  if (incremental) {
    pdfDoc = await PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
      updateMetadata: false
    });
  }
  const pages = pdfDoc.getPages();
  const taken = takenNames(pdfDoc);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const names = [];
  for (const box of boxes) {
    const page = pages[box.page];
    if (!page) throw new Error(`There is no page ${box.page + 1}`);
    const geometry = pageGeometry(page);
    const label = String(box.name || "").trim() || "Signature";
    const name = fieldNameFor(label, taken);
    taken.push(name);
    names.push(name);
    const field = addBlankSignatureField(
      pdfDoc,
      page,
      displayBoxToRect(geometry, box),
      name
    );
    const dict = pdfDoc.context.lookup(field);
    // Names may be any language: text strings, not PDFDocEncoding.
    dict.set(PDFName.of("T"), PDFHexString.fromText(name));
    dict.set(PDFName.of("TU"), PDFHexString.fromText(`Signature: ${label}`));
    dict.set(
      PDFName.of("AP"),
      pdfDoc.context.obj({
        N: blankAppearance(
          pdfDoc,
          font,
          geometry.rotation,
          box.width,
          box.height,
          label
        )
      })
    );
  }
  const out = await pdfDoc.save(incremental ? {} : { useObjectStreams: false });
  return { bytes: out, names };
};
