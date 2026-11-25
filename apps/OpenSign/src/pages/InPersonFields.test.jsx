import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import axios from "axios";
import { PDFDocument, PDFName, PDFSignature } from "@cantoo/pdf-lib";
import InPersonFields from "./InPersonFields";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));

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
// A mouseup on a box ends a drag that didn't move it.
vi.mock("react-rnd", () => ({
  Rnd: ({ children, onDragStop, position }) => (
    <div data-testid="box" onMouseUp={(e) => onDragStop?.(e, position)}>
      {children}
    </div>
  )
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

const renderPage = (path = "/in-person") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <InPersonFields />
    </MemoryRouter>
  );

const choose = (container, file) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [file] }
  });

describe("InPersonFields", () => {
  it("places boxes where the page is clicked and downloads the fields", async () => {
    const { container } = renderPage();
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
    const { container } = renderPage();
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

  it("doesn't add a box when a drag ends outside the box", async () => {
    const { container } = renderPage();
    choose(container, pdfFile(await onePagePdf()));
    const page = await screen.findByTestId("in-person-page-0");
    fireEvent.click(page, { clientX: 100, clientY: 100 });
    // The drag ends, then the browser clicks the page under the pointer.
    fireEvent.mouseUp(screen.getByTestId("box"));
    fireEvent.click(page, { clientX: 400, clientY: 400 });
    expect(screen.getAllByTestId("box")).toHaveLength(1);
    // A later click places a box as usual.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(page, { clientX: 400, clientY: 400 });
    expect(screen.getAllByTestId("box")).toHaveLength(2);
  });

  it("refuses a certified PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(
      PDFName.of("Perms"),
      doc.context.obj({ DocMDP: doc.context.obj({}) })
    );
    const { container } = renderPage();
    choose(container, pdfFile(await doc.save()));
    await waitFor(() =>
      expect(screen.getByText("in-person.certified")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("in-person-page-0")).toBeNull();
  });

  describe("from a template", () => {
    const placeholders = [
      {
        Role: "Homeowner",
        placeHolder: [
          {
            pageNumber: 1,
            pos: [
              { key: "s", type: "signature", xPosition: 100, yPosition: 600 },
              { key: "i", type: "initials", xPosition: 400, yPosition: 600 },
              { key: "d", type: "date", xPosition: 100, yPosition: 100 }
            ]
          }
        ]
      }
    ];

    // getReport lists one template; getTemplate answers `template`, whose
    // PDF fetch() answers.
    const serve = async (template) => {
      const pdf = await onePagePdf();
      axios.post.mockReset();
      axios.post.mockImplementation(async (url, params) => {
        if (url.endsWith("functions/getReport")) {
          return {
            data: { result: [{ objectId: "tpl1", Name: "Work order" }] }
          };
        }
        if (url.endsWith("functions/getTemplate")) {
          return {
            data: {
              result:
                params.templateId === "tpl1"
                  ? template
                  : { error: "template deleted or you don't have access." }
            }
          };
        }
        throw new Error(`unexpected ${url}`);
      });
      // The signed-in session the page sends.
      const session = {
        baseUrl: "https://api.example/app/",
        parseAppId: "app",
        accesstoken: "r:session"
      };
      vi.stubGlobal("localStorage", { getItem: (key) => session[key] ?? null });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () => pdf.buffer
        }))
      );
    };

    const template = {
      objectId: "tpl1",
      Name: "Work order",
      URL: "https://files.example/work-order.pdf?signed",
      Placeholders: placeholders
    };

    it("places a box for each signature and initials field", async () => {
      await serve(template);
      renderPage();
      fireEvent.mouseDown(screen.getByLabelText("in-person.from-template"));
      fireEvent.click(await screen.findByText("Work order"));
      await screen.findByTestId("in-person-page-0");

      const names = screen
        .getAllByLabelText("in-person.signer-name")
        .map((input) => input.value);
      expect(names).toEqual(["Homeowner", "Homeowner (initials)"]);
      expect(
        screen.getByText('in-person.template-skipped {"count":1}')
      ).toBeInTheDocument();
      expect(fetch).toHaveBeenCalledWith(template.URL);
      expect(axios.post).toHaveBeenCalledWith(
        "https://api.example/app/functions/getTemplate",
        { templateId: "tpl1" },
        {
          headers: expect.objectContaining({
            "X-Parse-Application-Id": "app",
            sessiontoken: "r:session"
          })
        }
      );

      fireEvent.click(screen.getByText("in-person.download"));
      await screen.findByText(/in-person.downloaded/);
      const doc = await PDFDocument.load(await readBlob(downloaded));
      expect(
        doc
          .getForm()
          .getFields()
          .filter((field) => field instanceof PDFSignature)
          .map((field) => field.getName())
      ).toEqual(["Homeowner", "Homeowner (initials)"]);
    });

    it("opens the template in the link", async () => {
      await serve(template);
      renderPage("/in-person?templateId=tpl1");
      await screen.findByTestId("in-person-page-0");
      expect(screen.getAllByTestId("box")).toHaveLength(2);
    });

    it("says so when the template can't be opened", async () => {
      await serve(template);
      renderPage("/in-person?templateId=gone");
      await screen.findByText("in-person.template-error");
      expect(screen.queryByTestId("in-person-page-0")).toBeNull();
    });

    it("says so when the template has no signature fields", async () => {
      await serve({ ...template, Placeholders: [] });
      renderPage("/in-person?templateId=tpl1");
      await screen.findByText("in-person.template-no-signatures");
      expect(screen.queryAllByTestId("box")).toHaveLength(0);
    });
  });

  describe("assigning", () => {
    const people = [
      {
        id: "u1",
        name: "Tess Tech",
        email: "tess@example.com",
        teams: ["Field"],
        linked: true
      },
      {
        id: "u2",
        name: "Pat Nolink",
        email: "pat@example.com",
        teams: ["Field"],
        linked: false
      }
    ];
    let assignAnswer;

    beforeEach(() => {
      const session = {
        baseUrl: "https://api.example/app/",
        parseAppId: "app",
        accesstoken: "r:session"
      };
      vi.stubGlobal("localStorage", { getItem: (key) => session[key] ?? null });
      assignAnswer = async (params) => ({
        data: {
          result: {
            id: "doc1",
            name: params.name,
            assignee: { email: "tess@example.com" }
          }
        }
      });
      axios.post.mockReset();
      axios.post.mockImplementation(async (url, params) => {
        if (url.endsWith("functions/inpersonassignees")) {
          return { data: { result: people } };
        }
        if (url.endsWith("functions/inpersonassign")) {
          return assignAnswer(params);
        }
        throw new Error(`unexpected ${url}`);
      });
    });

    // A PDF with one box, and the assign dialog open.
    const openDialog = async () => {
      const { container } = renderPage();
      choose(container, pdfFile(await onePagePdf(), "work-order.pdf"));
      const page = await screen.findByTestId("in-person-page-0");
      fireEvent.change(screen.getByLabelText("in-person.next-name"), {
        target: { value: "Customer" }
      });
      fireEvent.click(page, { clientX: 100, clientY: 100 });
      fireEvent.click(screen.getByText("in-person.assign"));
      fireEvent.mouseDown(await screen.findByLabelText("in-person.assign-to"));
    };

    it("sends the PDF with its fields to a colleague with BetterID", async () => {
      await openDialog();
      expect(screen.getByLabelText("in-person.assign-doc-name").value).toBe(
        "work-order"
      );
      // Someone without BetterID can't be picked.
      expect(
        (await screen.findByText("Pat Nolink")).closest("li")
      ).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(screen.getByText("Tess Tech"));
      fireEvent.click(screen.getByText("in-person.assign-send"));

      await screen.findByText(/in-person.assigned/);
      const [, params, config] = axios.post.mock.calls.find(([url]) =>
        url.endsWith("functions/inpersonassign")
      );
      // As the signed-in user: Parse reads X-Parse-Session-Token.
      expect(config.headers["X-Parse-Session-Token"]).toBe("r:session");
      const [, , listConfig] = axios.post.mock.calls.find(([url]) =>
        url.endsWith("functions/inpersonassignees")
      );
      expect(listConfig.headers["X-Parse-Session-Token"]).toBe("r:session");
      expect(params).toMatchObject({ name: "work-order", assigneeId: "u1" });
      const sent = Uint8Array.from(atob(params.pdf), (c) => c.charCodeAt(0));
      const doc = await PDFDocument.load(sent);
      expect(
        doc
          .getForm()
          .getFields()
          .filter((field) => field instanceof PDFSignature)
          .map((field) => field.getName())
      ).toEqual(["Customer"]);
      expect(
        screen.getByText(
          'in-person.assigned {"name":"work-order","to":"Tess Tech"}'
        )
      ).toBeInTheDocument();
    });

    it("shows the server's answer when it refuses", async () => {
      assignAnswer = async () => {
        const err = new Error("Request failed");
        err.response = {
          data: {
            code: 119,
            error: "You can't assign documents to this person."
          }
        };
        throw err;
      };
      await openDialog();
      fireEvent.click(await screen.findByText("Tess Tech"));
      fireEvent.click(screen.getByText("in-person.assign-send"));
      await screen.findByText("You can't assign documents to this person.");
      expect(screen.queryByText(/in-person.assigned/)).toBeNull();
    });
  });
});
