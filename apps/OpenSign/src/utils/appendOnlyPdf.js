// Append-only signing for documents a BetterID identity (VLAD) has signed.
//
// That signature (PAdES, made on the desktop) covers the exact bytes of the
// file. pdf-lib's save() rewrites the whole file, which would break it, so for
// these documents the signing page loads the PDF with @cantoo/pdf-lib (an
// API-compatible pdf-lib fork) in incremental mode: save() then returns the
// original bytes with this signer's changes appended. The server refuses
// anything else (OpenSignServer utils/appendOnlyPdf.js).
import { PDFDocument } from "pdf-lib";
import {
  PDFDocument as IncrementalPDFDocument,
  PDFNumber,
  PDFSignature,
  PDFString
} from "@cantoo/pdf-lib";

// True once any BetterID identity has signed the document.
export const isAppendOnlyDoc = (doc) =>
  Array.isArray(doc?.VladSignatures) && doc.VladSignatures.length > 0;

// The PDF to draw this signer's widgets on.
export const loadPdfForSigning = (bytes, appendOnly) =>
  appendOnly
    ? IncrementalPDFDocument.load(bytes, {
        forIncrementalUpdate: true,
        updateMetadata: false
      })
    : PDFDocument.load(bytes);

export const isAppendOnlyPdf = (pdfDoc) =>
  pdfDoc instanceof IncrementalPDFDocument;

// form.flatten() removes every field, signature fields included, which would
// delete the BetterID signature from later revisions. Flatten the rest,
// skipping (and logging) a widget that can't be flattened, as flatten() does.
//
// flatten() also flattens "orphan" widgets: any widget annotation carrying its
// own /FT. Signature widgets usually do (field and widget in one dictionary),
// so that pass would flatten the signatures away; it isn't run here. That
// matches pdf-lib's flatten(), which the normal signing path uses and which
// has no such pass either.
export const flattenExceptSignatures = (form) => {
  if (!form) return;
  try {
    form.updateFieldAppearances();
  } catch (err) {
    console.log("could not update field appearances", err);
  }
  for (const field of form.getFields()) {
    if (field instanceof PDFSignature) continue;
    for (const widget of field.acroField.getWidgets()) {
      try {
        form.flattenWidgetOntoPage(
          form.findWidgetPage(widget),
          widget,
          form.findWidgetAppearanceRef(field, widget)
        );
      } catch (err) {
        console.log("could not flatten a form widget", err);
      }
    }
    form.removeField(field);
  }
};

// Adds a blank, visible signature field named `name` at `rect` on `page`:
// field and widget in one dictionary (/FT /Sig, no /V, no appearance), in the
// page's /Annots and the AcroForm's /Fields. Used by Sign on phone
// (phoneSignBase.js) and in-person signing (inPersonFields.js).
export const addBlankSignatureField = (pdfDoc, page, rect, name) => {
  const field = pdfDoc.context.register(
    pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      Rect: rect.map((n) => PDFNumber.of(n)),
      T: PDFString.of(name),
      F: 4, // Print
      P: page.ref
    })
  );
  page.node.addAnnot(field);
  pdfDoc.getForm().acroForm.addField(field);
  return field;
};
