import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFSignature,
  degrees
} from "@cantoo/pdf-lib";
import {
  addInPersonFields,
  displayBoxToRect,
  fieldNameFor,
  readPdf,
  templateBoxes
} from "./inPersonFields";
import { addBlankSignatureField } from "./appendOnlyPdf";

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

// One page with a signed signature field "Seller": enough of a signature for
// the check, a /V on the field. The signature dictionary has no /Type (it's
// optional), so pdf-lib may put it in an object stream.
async function signedPdf(useObjectStreams) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const field = addBlankSignatureField(doc, page, [10, 10, 190, 70], "Seller");
  doc.context
    .lookup(field)
    .set(
      PDFName.of("V"),
      doc.context.register(
        doc.context.obj({ Filter: "Adobe.PPKLite", ByteRange: [0, 0, 0, 0] })
      )
    );
  return doc.save({ useObjectStreams });
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
    // With the signature in a classic file and in an object stream.
    for (const useObjectStreams of [false, true]) {
      const input = await signedPdf(useObjectStreams);
      // In an object stream, /ByteRange is compressed out of sight.
      expect(
        new TextDecoder("latin1").decode(input).includes("/ByteRange")
      ).toBe(!useObjectStreams);
      const { bytes } = await addInPersonFields(input, [
        { page: 0, x: 10, y: 10, width: 180, height: 60, name: "Customer" }
      ]);
      expect(startsWith(bytes, Array.from(input))).toBe(true);
      const reloaded = await PDFDocument.load(bytes);
      expect(fieldDict(reloaded, "Customer")).toBeDefined();
      expect(fieldDict(reloaded, "Seller")).toBeDefined();
    }
  });

  it("appends to a PDF with usage rights (/Perms /UR3)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.catalog.set(
      PDFName.of("Perms"),
      doc.context.obj({ UR3: doc.context.obj({}) })
    );
    const input = await doc.save();
    const { bytes } = await addInPersonFields(input, [
      { page: 0, x: 10, y: 10, width: 180, height: 60, name: "Customer" }
    ]);
    expect(startsWith(bytes, Array.from(input))).toBe(true);
  });

  it("re-saves a PDF whose signature field is still blank", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    addBlankSignatureField(doc, page, [10, 10, 190, 70], "Seller");
    const input = await doc.save();
    const { bytes } = await addInPersonFields(input, [
      { page: 0, x: 300, y: 10, width: 180, height: 60, name: "Customer" }
    ]);
    expect(startsWith(bytes, Array.from(input))).toBe(false);
  });

  it("doesn't take the name of a field group", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    doc
      .getForm()
      .createTextField("Homeowner.phone")
      .addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const { names } = await addInPersonFields(await doc.save(), [
      { page: 0, x: 10, y: 10, width: 180, height: 60, name: "Homeowner" }
    ]);
    expect(names).toEqual(["Homeowner 2"]);
  });

  it("places boxes on the part of the page shown", async () => {
    // A crop box reaching past the media box: pdf.js shows the overlap.
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.setCropBox(-100, 100, 800, 1000);
    // Not a multiple of 90: pdf.js shows the page upright.
    page.node.set(PDFName.of("Rotate"), PDFNumber.of(45));
    const input = await doc.save();
    const info = await readPdf(input);
    expect(info.pages).toEqual([{ width: 600, height: 700 }]);
    const { bytes } = await addInPersonFields(input, [
      { page: 0, x: 0, y: 0, width: 180, height: 60, name: "A" }
    ]);
    const reloaded = await PDFDocument.load(bytes);
    expect(rectOf(fieldDict(reloaded, "A"))).toEqual([0, 740, 180, 800]);
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

describe("templateBoxes", () => {
  const pages = [
    { width: 600, height: 800 },
    { width: 800, height: 600 }
  ];
  const widget = (type, extra = {}) => ({
    key: `${type}-${Math.random()}`,
    type,
    xPosition: 100,
    yPosition: 200,
    Width: 150,
    Height: 60,
    ...extra
  });

  it("makes a box for each signature and initials widget, named for its role", () => {
    const { boxes, skipped } = templateBoxes(
      [
        {
          Role: "Homeowner",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [
                widget("signature"),
                widget("initials", { Width: 50, Height: 50, xPosition: 400 })
              ]
            },
            { pageNumber: 2, pos: [widget("signature", { yPosition: 10 })] }
          ]
        },
        {
          Role: "Technician",
          placeHolder: [{ pageNumber: 1, pos: [widget("signature")] }]
        }
      ],
      pages
    );
    expect(skipped).toBe(0);
    expect(boxes).toEqual([
      { page: 0, x: 100, y: 200, width: 150, height: 60, name: "Homeowner" },
      {
        page: 0,
        x: 400,
        y: 200,
        width: 50,
        height: 50,
        name: "Homeowner (initials)"
      },
      { page: 1, x: 100, y: 10, width: 150, height: 60, name: "Homeowner" },
      { page: 0, x: 100, y: 200, width: 150, height: 60, name: "Technician" }
    ]);
  });

  it("leaves out prefill widgets, and counts other types and missing pages", () => {
    const { boxes, skipped } = templateBoxes(
      [
        {
          Role: "prefill",
          placeHolder: [{ pageNumber: 1, pos: [widget("text")] }]
        },
        {
          Role: "Customer",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [widget("date"), widget("checkbox"), widget("signature")]
            },
            { pageNumber: 5, pos: [widget("signature")] }
          ]
        }
      ],
      pages
    );
    expect(boxes.map((box) => box.name)).toEqual(["Customer"]);
    expect(skipped).toBe(3);
  });

  it("sizes widgets as OpenSign does", () => {
    const { boxes } = templateBoxes(
      [
        {
          Role: "A",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [
                // No size: OpenSign's default.
                widget("signature", { Width: undefined, Height: undefined }),
                widget("initials", { Width: undefined, Height: undefined }),
                // Old mobile data: stored unscaled.
                widget("signature", { isMobile: true, scale: 0.5 }),
                // ... unless resized since.
                widget("signature", {
                  isMobile: true,
                  scale: 0.5,
                  IsResize: true
                })
              ]
            }
          ]
        }
      ],
      pages
    );
    expect(boxes.map(({ width, height }) => [width, height])).toEqual([
      [150, 60],
      [50, 50],
      [75, 30],
      [150, 60]
    ]);
  });

  it("keeps boxes on the page", () => {
    const { boxes } = templateBoxes(
      [
        {
          Role: "",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [widget("signature", { xPosition: 590, yPosition: -20 })]
            }
          ]
        }
      ],
      pages
    );
    expect(boxes).toEqual([
      { page: 0, x: 450, y: 0, width: 150, height: 60, name: "Signature" }
    ]);
  });

  it("gives each box of a role its own field", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    const input = await doc.save();
    const { boxes } = templateBoxes(
      [
        {
          Role: "Homeowner",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [
                widget("signature"),
                widget("signature", { yPosition: 400 })
              ]
            }
          ]
        }
      ],
      (await readPdf(input)).pages
    );
    const { bytes, names } = await addInPersonFields(input, boxes);
    expect(names).toEqual(["Homeowner", "Homeowner 2"]);
    const reloaded = await PDFDocument.load(bytes);
    expect(rectOf(fieldDict(reloaded, "Homeowner"))).toEqual([
      100, 540, 250, 600
    ]);
  });
});
