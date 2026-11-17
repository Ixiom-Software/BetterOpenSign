/* eslint-env node */
import { readFileSync } from "fs";
import { resolve } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFSignature,
  PDFDocument as IncrementalPDFDocument
} from "@cantoo/pdf-lib";
import {
  buildPhoneSignBase,
  phoneSignFieldName,
  phoneSignatureWidget,
  withoutWidget
} from "./phoneSignBase";

// embedWidgetsToDoc fetches times.ttf from the CDN; serve the server's copy.
const font = readFileSync(
  resolve(__dirname, "../../../OpenSignServer/font/times.ttf")
);
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(font, { status: 200 }))
  );
});
afterAll(() => vi.unstubAllGlobals());

const startsWith = (bytes, prefix) =>
  bytes.length > prefix.length && prefix.every((byte, i) => bytes[i] === byte);

// Two 600x800 pages; the first has a text field, as uploaded documents may.
async function fixturePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  doc.addPage([600, 800]);
  const text = doc.getForm().createTextField("company");
  text.setText("ACME");
  text.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  return doc.save();
}

const SIG_KEY = 1731772800123;

// The signer's widgets: a filled text widget on page 1, the signature on
// page 2 (not signed: the phone signs it).
const signerWidgets = (sigOptions = {}) => [
  {
    pageNumber: 1,
    pos: [
      {
        key: 11,
        type: "text input",
        xPosition: 50,
        yPosition: 300,
        Width: 150,
        Height: 20,
        options: { response: "Alice Example", fontSize: 12 }
      }
    ]
  },
  {
    pageNumber: 2,
    pos: [
      {
        key: SIG_KEY,
        type: "signature",
        xPosition: 100,
        yPosition: 200,
        Width: 150,
        Height: 60,
        options: { ...sigOptions }
      }
    ]
  }
];

// The names in a page's /Resources /<kind> dictionary.
const resourceNames = (page, kind) => {
  const dict = page.node.Resources()?.lookup(PDFName.of(kind));
  return dict instanceof PDFDict ? dict.keys().map(String) : [];
};

async function build(widgets = signerWidgets()) {
  const bytes = await fixturePdf();
  const res = await buildPhoneSignBase({
    bytes,
    widgets,
    scale: 1,
    signyourself: false
  });
  expect(res.error).toBeUndefined();
  const out = Buffer.from(res.base, "base64");
  return { bytes, out, fieldName: res.fieldName };
}

const sigFields = (doc) =>
  doc
    .getForm()
    .getFields()
    .filter((f) => f instanceof PDFSignature);

describe("phoneSignFieldName", () => {
  it("is bs-phone-<key> as the server takes it", () => {
    // The server's check (bsPhoneSignPdf.js FIELD_RE).
    const ok = (n) => /^bs-phone-[A-Za-z0-9_:-]{1,91}$/.test(n);
    expect(phoneSignFieldName(SIG_KEY)).toBe(`bs-phone-${SIG_KEY}`);
    expect(phoneSignFieldName("a.b c/é")).toBe("bs-phone-a-b-c--");
    expect(phoneSignFieldName("x".repeat(200))).toHaveLength(100);
    for (const key of [SIG_KEY, "a.b c/é", "x".repeat(200), 12345678]) {
      expect(ok(phoneSignFieldName(key))).toBe(true);
    }
  });
});

describe("phoneSignatureWidget", () => {
  it("finds exactly one signature widget", () => {
    expect(phoneSignatureWidget(signerWidgets())).toMatchObject({
      pageNumber: 2,
      position: { key: SIG_KEY }
    });
  });

  it("is null for none or several", () => {
    const widgets = signerWidgets();
    expect(phoneSignatureWidget(withoutWidget(widgets, SIG_KEY))).toBe(null);
    widgets[0].pos.push({ ...widgets[1].pos[0], key: 12 });
    expect(phoneSignatureWidget(widgets)).toBe(null);
    expect(phoneSignatureWidget(undefined)).toBe(null);
  });
});

describe("buildPhoneSignBase", () => {
  it("starts with the current file, byte for byte", async () => {
    const { bytes, out } = await build();
    expect(startsWith(out, bytes)).toBe(true);
  });

  it("adds one blank signature field with the right name, page and rect", async () => {
    const { out, fieldName } = await build();
    expect(fieldName).toBe(`bs-phone-${SIG_KEY}`);
    const doc = await IncrementalPDFDocument.load(out);
    const sigs = sigFields(doc);
    expect(sigs.map((f) => f.getName())).toEqual([fieldName]);

    const dict = sigs[0].acroField.dict;
    expect(dict.get(PDFName.of("FT"))).toBe(PDFName.of("Sig"));
    expect(dict.has(PDFName.of("V"))).toBe(false);
    // 600x800 page: x 100, 200 from the top, 150x60.
    expect(dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle()).toEqual({
      x: 100,
      y: 540,
      width: 150,
      height: 60
    });

    // In the AcroForm's /Fields and on page 2's /Annots, not page 1's.
    const ref = doc.context.getObjectRef(dict);
    expect(ref).toBeInstanceOf(PDFRef);
    const fields = doc.catalog
      .lookup(PDFName.of("AcroForm"), PDFDict)
      .lookup(PDFName.of("Fields"), PDFArray)
      .asArray();
    expect(fields).toContain(ref);
    const [page1, page2] = doc.getPages();
    expect(page2.node.Annots()?.asArray() || []).toContain(ref);
    expect(page1.node.Annots()?.asArray() || []).not.toContain(ref);
    expect(dict.get(PDFName.of("P"))).toBe(page2.ref);
  });

  it("uses the rect of the rotated image for a rotated widget", async () => {
    const { out } = await build(signerWidgets({ rotation: 90 }));
    const doc = await IncrementalPDFDocument.load(out);
    const dict = sigFields(doc)[0].acroField.dict;
    // Drawn 60 wide and 150 high, its top-left corner where the widget's is.
    expect(dict.lookup(PDFName.of("Rect"), PDFArray).asRectangle()).toEqual({
      x: 100,
      y: 450,
      width: 60,
      height: 150
    });
  });

  it("still draws the other widgets and flattens other fields", async () => {
    const { out } = await build();
    const doc = await IncrementalPDFDocument.load(out);
    const [page1, page2] = doc.getPages();
    // The text widget is drawn on page 1 with the Times font.
    expect(resourceNames(page1, "Font").join()).toMatch(/TimesNewRoman/);
    // Nothing is drawn for the signature widget itself.
    expect(resourceNames(page2, "Font")).toEqual([]);
    expect(resourceNames(page2, "XObject")).toEqual([]);
    // The document's own text field is flattened; the signature field stays.
    expect(
      doc
        .getForm()
        .getFields()
        .map((f) => f.getName())
    ).toEqual([`bs-phone-${SIG_KEY}`]);
  });

  it("refuses without exactly one signature widget", async () => {
    const res = await buildPhoneSignBase({
      bytes: await fixturePdf(),
      widgets: withoutWidget(signerWidgets(), SIG_KEY),
      scale: 1
    });
    expect(res.error).toBeTruthy();
  });
});
