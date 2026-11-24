import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFSignature,
  degrees
} from "@cantoo/pdf-lib";
import {
  addInPersonFields,
  displayBoxToRect,
  fieldNameFor,
  readPdf
} from "./inPersonFields";

const startsWith = (bytes, prefix) =>
  bytes.length > prefix.length && prefix.every((byte, i) => bytes[i] === byte);

// Two 600x800 pages; the first has a text field named "Customer".
async function fixturePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  doc.addPage([600, 800]);
  const text = doc.getForm().createTextField("Customer");
  text.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  return doc.save();
}

const fieldDict = (doc, name) =>
  doc
    .getForm()
    .getFields()
    .find((field) => field.getName() === name)?.acroField.dict;

const rectOf = (dict) =>
  dict
    .lookup(PDFName.of("Rect"))
    .asArray()
    .map((n) => n.asNumber());

describe("fieldNameFor", () => {
  it("drops '.' and extra spaces", () => {
    expect(fieldNameFor("  J.  Smith ", [])).toBe("J Smith");
  });

  it("names an empty label Signature", () => {
    expect(fieldNameFor("  ", [])).toBe("Signature");
  });

  it("numbers a name already taken", () => {
    expect(fieldNameFor("Customer", ["Customer", "Customer 2"])).toBe(
      "Customer 3"
    );
  });

  it("keeps to 100 characters, suffix included", () => {
    const long = "x".repeat(150);
    expect(fieldNameFor(long, [])).toHaveLength(100);
    const second = fieldNameFor(long, ["x".repeat(100)]);
    expect(second).toHaveLength(100);
    expect(second.endsWith(" 2")).toBe(true);
  });
});

describe("displayBoxToRect", () => {
  // A 600x800 crop box at (10, 20).
  const box = { x: 10, y: 20, width: 600, height: 800 };
  const display = { x: 100, y: 50, width: 180, height: 60 };

  it("flips y on an upright page", () => {
    expect(displayBoxToRect({ box, rotation: 0 }, display)).toEqual([
      110,
      20 + 800 - 110,
      290,
      20 + 800 - 50
    ]);
  });

  it("follows the page's /Rotate", () => {
    // Shown 800 wide and 600 high; the box's top left corner (100, 50)...
    // 90: user (10 + 50, 20 + 100), the box spans 60 in x and 180 in y.
    expect(displayBoxToRect({ box, rotation: 90 }, display)).toEqual([
      60, 120, 120, 300
    ]);
    // 180: mirrored in both directions.
    expect(displayBoxToRect({ box, rotation: 180 }, display)).toEqual([
      10 + 600 - 280,
      20 + 50,
      10 + 600 - 100,
      20 + 110
    ]);
    // 270: user (10 + 600 - 50, 20 + 800 - 100) is the top right corner.
    expect(displayBoxToRect({ box, rotation: 270 }, display)).toEqual([
      10 + 600 - 110,
      20 + 800 - 280,
      10 + 600 - 50,
      20 + 800 - 100
    ]);
  });
});

describe("readPdf", () => {
  it("answers display sizes and the form's fields", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.addPage([600, 800]).setRotation(degrees(90));
    const info = await readPdf(await doc.save());
    expect(info.pages).toEqual([
      { width: 600, height: 800 },
      { width: 800, height: 600 }
    ]);
    expect(info.signatureFields).toEqual([]);
  });

  it("refuses a certified PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(
      PDFName.of("Perms"),
      doc.context.obj({ DocMDP: doc.context.obj({}) })
    );
    await expect(readPdf(await doc.save())).rejects.toMatchObject({
      code: "certified"
    });
  });
});

describe("addInPersonFields", () => {
  it("adds named, blank, visible signature fields", async () => {
    const input = await fixturePdf();
    const { bytes, names } = await addInPersonFields(input, [
      { page: 0, x: 100, y: 600, width: 180, height: 60, name: "Customer" },
      { page: 1, x: 300, y: 650, width: 180, height: 60, name: "Technician" }
    ]);
    // "Customer" is the text field's name already.
    expect(names).toEqual(["Customer 2", "Technician"]);

    const doc = await PDFDocument.load(bytes);
    const signatures = doc
      .getForm()
      .getFields()
      .filter((field) => field instanceof PDFSignature)
      .map((field) => field.getName());
    expect(signatures).toEqual(["Customer 2", "Technician"]);

    const customer = fieldDict(doc, "Customer 2");
    expect(customer.get(PDFName.of("FT"))).toBe(PDFName.of("Sig"));
    expect(customer.get(PDFName.of("V"))).toBeUndefined();
    expect(customer.lookup(PDFName.of("TU")).decodeText()).toBe(
      "Signature: Customer"
    );
    expect(customer.lookup(PDFName.of("AP"))).toBeInstanceOf(PDFDict);
    expect(rectOf(customer)).toEqual([100, 140, 280, 200]);
    // On its own page.
    const page2 = doc.getPages()[1];
    const technician = fieldDict(doc, "Technician");
    expect(technician.get(PDFName.of("P"))).toBe(page2.ref);
  });

  it("re-saves an unsigned PDF with a classic cross-reference table", async () => {
    const { bytes } = await addInPersonFields(await fixturePdf(), [
      { page: 0, x: 0, y: 0, width: 180, height: 60, name: "A" }
    ]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toMatch(/\nxref\n/);
    expect(text).not.toMatch(/\/ObjStm/);
  });

  it("appends to a signed PDF, leaving its bytes as they were", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    // Enough of a signature for the check: a /ByteRange in the file.
    doc.context.register(
      doc.context.obj({ Type: "Sig", ByteRange: [0, 0, 0, 0] })
    );
    const input = await doc.save({ useObjectStreams: false });
    const { bytes } = await addInPersonFields(input, [
      { page: 0, x: 10, y: 10, width: 180, height: 60, name: "Customer" }
    ]);
    expect(startsWith(bytes, Array.from(input))).toBe(true);
    const reloaded = await PDFDocument.load(bytes);
    expect(fieldDict(reloaded, "Customer")).toBeDefined();
  });

  it("keeps a name in any language", async () => {
    const { bytes, names } = await addInPersonFields(await fixturePdf(), [
      { page: 0, x: 0, y: 0, width: 180, height: 60, name: "Zoë Łukasz" }
    ]);
    expect(names).toEqual(["Zoë Łukasz"]);
    const doc = await PDFDocument.load(bytes);
    expect(fieldDict(doc, "Zoë Łukasz")).toBeDefined();
  });
});
