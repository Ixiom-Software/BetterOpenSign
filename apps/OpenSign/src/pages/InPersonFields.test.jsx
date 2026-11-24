import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument, PDFName, PDFSignature } from "@cantoo/pdf-lib";
import InPersonFields from "./InPersonFields";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k, opts) => (opts ? `${k} ${JSON.stringify(opts)}` : k)
  })
}));
// pdf.js doesn't run in jsdom: the pages are blank boxes here.
vi.mock("react-pdf", () => ({
  Document: ({ children }) => <div>{children}</div>,
  Page: () => <div />
}));
vi.mock("react-rnd", () => ({
  Rnd: ({ children }) => <div data-testid="box">{children}</div>
}));

let downloaded;
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob) => {
      downloaded = blob;
      return "blob:test";
    },
    revokeObjectURL: () => {}
  });
  // jsdom doesn't navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterAll(() => vi.unstubAllGlobals());

const pdfFile = (bytes, name = "work-order.pdf") => {
  const file = new File([bytes], name, { type: "application/pdf" });
  // jsdom's File has no arrayBuffer().
  file.arrayBuffer = async () => bytes.buffer;
  return file;
};

// jsdom's Blob, read as jsdom can.
const readBlob = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

async function onePagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
  return doc.save();
}

const choose = (container, file) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [file] }
  });

describe("InPersonFields", () => {
  it("places boxes where the page is clicked and downloads the fields", async () => {
    const { container } = render(<InPersonFields />);
    choose(container, pdfFile(await onePagePdf()));
    const page = await screen.findByTestId("in-person-page-0");

    fireEvent.click(page, { clientX: 100, clientY: 100 });
    fireEvent.change(screen.getByLabelText("in-person.next-name"), {
      target: { value: "Customer" }
    });
    fireEvent.click(page, { clientX: 150, clientY: 200 });
    expect(screen.getAllByTestId("box")).toHaveLength(2);
    const names = screen
      .getAllByLabelText("in-person.signer-name")
      .map((input) => input.value);
    expect(names).toEqual(['in-person.default-name {"n":1}', "Customer"]);

    fireEvent.click(screen.getByText("in-person.download"));
    await screen.findByText(/in-person.downloaded/);
    const doc = await PDFDocument.load(await readBlob(downloaded));
    const fields = doc
      .getForm()
      .getFields()
      .filter((field) => field instanceof PDFSignature);
    // A field name has no '.' (the stub t() returns the key).
    expect(fields.map((field) => field.getName())).toEqual([
      'in-person default-name {"n":1}',
      "Customer"
    ]);
  });

  it("removes a box", async () => {
    const { container } = render(<InPersonFields />);
    choose(container, pdfFile(await onePagePdf()));
    const page = await screen.findByTestId("in-person-page-0");
    fireEvent.click(page, { clientX: 100, clientY: 100 });
    expect(screen.getAllByTestId("box")).toHaveLength(1);
    fireEvent.click(screen.getAllByLabelText("in-person.remove")[0]);
    expect(screen.queryAllByTestId("box")).toHaveLength(0);
    expect(
      screen.getByText("in-person.download").closest("button")
    ).toBeDisabled();
  });

  it("refuses a certified PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(
      PDFName.of("Perms"),
      doc.context.obj({ DocMDP: doc.context.obj({}) })
    );
    const { container } = render(<InPersonFields />);
    choose(container, pdfFile(await doc.save()));
    await waitFor(() =>
      expect(screen.getByText("in-person.certified")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("in-person-page-0")).toBeNull();
  });
});
