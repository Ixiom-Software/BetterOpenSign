import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Parse from "parse";
import PhoneSignPdf, { canSignPdfOnPhone, expiryMs } from "./PhoneSignPdf";
import { BS_SESSION_KEY } from "./PhoneSign";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k) => k }) }));
vi.mock("../../primitives/ModalUi", () => ({
  default: ({ isOpen, title, children }) =>
    isOpen ? (
      <div>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null
}));
// Only phoneSignatureWidget is used here; the real module pulls in
// constant/Utils (and i18n). Its own tests are utils/phoneSignBase.test.js.
vi.mock("../../utils/phoneSignBase", () => ({
  phoneSignatureWidget: (widgets) => {
    const sigs = (widgets || []).flatMap((p) =>
      p.pos.filter((x) => x.type === "signature")
    );
    return sigs.length === 1 ? { position: sigs[0] } : null;
  }
}));

// As in PhoneSign.test.jsx: Node's own localStorage shadows jsdom's.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}
vi.stubGlobal("localStorage", memoryStorage());

const run = Parse.Cloud.run;
const later = (value, ms = 5) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  localStorage.clear();
  run.mockReset();
});

const sig = (key) => ({ key, type: "signature" });

describe("canSignPdfOnPhone", () => {
  it("needs a BetterSign session, a document and one signature widget", () => {
    const widgets = [
      { pageNumber: 1, pos: [sig(1), { key: 2, type: "date" }] }
    ];
    expect(canSignPdfOnPhone("doc1", widgets)).toBe(false);
    localStorage.setItem(BS_SESSION_KEY, "r:abc");
    localStorage.setItem("accesstoken", "r:abc");
    expect(canSignPdfOnPhone("doc1", widgets)).toBe(true);
    expect(canSignPdfOnPhone("", widgets)).toBe(false);
    expect(
      canSignPdfOnPhone("doc1", [{ pageNumber: 1, pos: [sig(1), sig(2)] }])
    ).toBe(false);
  });
});

describe("expiryMs", () => {
  it("takes milliseconds, seconds or a date", () => {
    expect(expiryMs(1763300000000)).toBe(1763300000000);
    expect(expiryMs(1763300000)).toBe(1763300000000);
    expect(expiryMs("2025-11-16T13:33:20.000Z")).toBe(1763300000000);
    expect(expiryMs("soon")).toBe(null);
  });
});

describe("PhoneSignPdf", () => {
  it("waits for the approval, then signing, then continues", async () => {
    const start = vi.fn(async () => ({
      reqId: "rq",
      expiresAt: Date.now() + 300000
    }));
    const onSigned = vi.fn();
    run
      .mockImplementationOnce(() => later({ status: "waiting" }))
      .mockImplementationOnce(() => later({ status: "signing" }, 30))
      .mockImplementationOnce(() => later({ status: "signed" }, 30));
    render(<PhoneSignPdf isOpen start={start} onSigned={onSigned} />);
    expect(
      await screen.findByText("phone-sign-pdf.waiting")
    ).toBeInTheDocument();
    expect(screen.getByText("phone-sign-pdf.expires-in")).toBeInTheDocument();
    expect(
      await screen.findByText("phone-sign-pdf.signing")
    ).toBeInTheDocument();
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith("bsphonesignpdfpoll", { reqId: "rq" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows the server's message on denial and can try again", async () => {
    const start = vi.fn(async () => ({ reqId: "rq", expiresAt: 0 }));
    const onSigned = vi.fn();
    run.mockImplementationOnce(() =>
      later({ status: "denied", reason: "user", message: "Declined" })
    );
    render(<PhoneSignPdf isOpen start={start} onSigned={onSigned} />);
    expect(await screen.findByText("Declined")).toBeInTheDocument();
    expect(onSigned).not.toHaveBeenCalled();

    run.mockImplementationOnce(() => later({ status: "expired" }));
    fireEvent.click(screen.getByText("phone-sign-pdf.try-again"));
    expect(
      await screen.findByText("phone-sign-pdf.expired")
    ).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("shows why it couldn't start", async () => {
    const start = vi.fn(async () => {
      throw new Error("Not your turn");
    });
    render(<PhoneSignPdf isOpen start={start} onSigned={vi.fn()} />);
    expect(await screen.findByText("Not your turn")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});
