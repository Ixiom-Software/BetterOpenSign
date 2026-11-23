import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import axios from "axios";
import PublishedCerts, { certsApi, linkKind } from "./PublishedCerts";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));
let params = {};
vi.mock("react-router", () => ({ useParams: () => params }));
// English strings from the real locale file, so the tests read like the page.
vi.mock("react-i18next", async () => {
  const en = (await import("../../public/locales/en/translation.json")).default;
  const t = (k, vars = {}) =>
    String(k.split(".").reduce((o, p) => o?.[p], en) ?? k).replace(
      /{{(\w+)}}/g,
      (_, v) => vars[v] ?? ""
    );
  return { useTranslation: () => ({ t }) };
});
vi.mock("../constant/appinfo", () => ({
  serverUrl_fn: () => "https://api.example.com/app"
}));

const API = "https://api.example.com/api/v1";
// Real VLADs are about 400 bytes.
const VLAD = "8724" + "ab".repeat(398);
const sha = (c) => c.repeat(64);
const cert = (s, over = {}) => ({
  sha256: s,
  fingerprint: s.toUpperCase().match(/.{2}/g).join(":"),
  subject_cn: "Alice",
  issuer_cn: "Alice root",
  serial: "01",
  is_ca: false,
  vlad: VLAD,
  issuer_sha256: null,
  not_before: "2026-01-01T00:00:00.000Z",
  not_after: "2027-01-01T00:00:00.000Z",
  download_url: `${API}/certs/${s}.cer`,
  page_url: `https://docsign.betterid.net/certs/${VLAD}`,
  ...over
});
const root = cert(sha("a"), {
  subject_cn: "Alice root",
  issuer_cn: "Alice root",
  is_ca: true
});
const leaf = cert(sha("b"), { issuer_sha256: sha("a") });
const notFound = () =>
  Promise.reject(
    Object.assign(new Error("404"), { response: { status: 404 } })
  );

const answers = (map) =>
  axios.get.mockImplementation(async (url) => {
    const v = map[url];
    if (v === undefined) return notFound();
    if (v instanceof Error) throw v;
    return { data: v };
  });

beforeEach(() => {
  axios.get.mockReset();
  params = {};
});

describe("linkKind", () => {
  it("tells a hash from a VLAD and refuses anything else", () => {
    expect(linkKind(sha("A"))).toEqual({ kind: "sha256", id: sha("a") });
    expect(linkKind(VLAD)).toEqual({ kind: "vlad", id: VLAD });
    expect(linkKind("xyz")).toBeNull();
    expect(linkKind("abc")).toBeNull();
    expect(linkKind("ab".repeat(4097))).toBeNull();
    expect(linkKind(undefined)).toBeNull();
  });

  it("finds the API beside Parse's /app", () => {
    expect(certsApi()).toBe(API);
  });
});

describe("PublishedCerts", () => {
  it("shows an identity's roots with download links and the Acrobat steps", async () => {
    params = { id: VLAD };
    answers({
      [`${API}/identities/${VLAD}/certs`]: {
        vlad: VLAD,
        roots: [root],
        leaves: [leaf]
      }
    });
    render(<PublishedCerts />);
    const rootCard = await screen.findByTestId(`cert-${sha("a")}`);
    expect(within(rootCard).getByText("Alice root")).toBeInTheDocument();
    expect(within(rootCard).getByText(root.fingerprint)).toBeInTheDocument();
    expect(
      within(rootCard).getByRole("link", {
        name: "Download certificate (.cer)"
      })
    ).toHaveAttribute("href", `${API}/certs/${sha("a")}.cer`);
    expect(screen.getByText("Root certificates")).toBeInTheDocument();
    expect(screen.getByText("Signing certificates")).toBeInTheDocument();
    expect(screen.getByTestId(`cert-${sha("b")}`)).toBeInTheDocument();
    expect(
      screen.getByText(/Identities & Trusted Certificates › More…/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Use this certificate as a trusted root/)
    ).toBeInTheDocument();
    expect(screen.getByTitle(VLAD)).toBeInTheDocument();
    expect(screen.getByText(/Anyone with this link/)).toBeInTheDocument();
  });

  it("shows one signing certificate and the root that issued it", async () => {
    params = { id: sha("b") };
    answers({
      [`${API}/certs/${sha("b")}`]: leaf,
      [`${API}/certs/${sha("a")}`]: root
    });
    render(<PublishedCerts />);
    await screen.findByTestId(`cert-${sha("b")}`);
    expect(screen.getByText("Certificate")).toBeInTheDocument();
    expect(screen.getByText("Its root")).toBeInTheDocument();
    expect(screen.getByTestId(`cert-${sha("a")}`)).toBeInTheDocument();
    expect(
      screen.getByText(/Use this certificate as a trusted root/)
    ).toBeInTheDocument();
  });

  it("tries a 64-digit link as a VLAD when no certificate has that hash", async () => {
    const shortVlad = "8724" + "cd".repeat(30);
    params = { id: shortVlad };
    answers({
      [`${API}/identities/${shortVlad}/certs`]: {
        vlad: shortVlad,
        roots: [root],
        leaves: []
      }
    });
    render(<PublishedCerts />);
    await screen.findByTestId(`cert-${sha("a")}`);
  });

  it("says when nothing is published, without asking for a malformed link", async () => {
    params = { id: VLAD };
    answers({});
    render(<PublishedCerts />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No published certificates here."
    );

    params = { id: "not-a-cert" };
    axios.get.mockReset();
    render(<PublishedCerts />);
    await waitFor(() =>
      expect(
        screen.getByText("This isn't a certificate or identity link.")
      ).toBeInTheDocument()
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("says when the server fails", async () => {
    params = { id: VLAD };
    answers({ [`${API}/identities/${VLAD}/certs`]: new Error("network") });
    render(<PublishedCerts />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the certificates."
    );
  });
});
