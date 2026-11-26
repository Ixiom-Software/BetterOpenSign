import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Parse from "parse";
import MailInboxCard from "./MailInboxCard";
import { copytoData } from "../constant/Utils";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k })
}));
vi.mock("../constant/Utils", () => ({ copytoData: vi.fn() }));
vi.mock("../utils", () => ({ withSessionValidation: (fn) => fn }));

const TOKEN = "abcdefghijklmnopqrst";
const OFF = {
  enabled: false,
  addresses: null,
  accountEmail: "ada@example.com",
  allowedSenders: [],
  recent: []
};
const inbox = (over = {}) => ({
  enabled: true,
  addresses: {
    document: `${TOKEN}@in.betterid.net`,
    template: `${TOKEN}+template@in.betterid.net`
  },
  accountEmail: "ada@example.com",
  allowedSenders: [],
  recent: [
    {
      at: "2026-11-25T10:00:00.000Z",
      from: "ada@example.com",
      subject: "Lease",
      status: "created",
      reason: "",
      created: [{ kind: "document", id: "d1", name: "Lease" }]
    },
    {
      at: "2026-11-25T09:30:00.000Z",
      from: "ada@example.com",
      subject: "Big batch",
      status: "processing",
      reason: "",
      created: []
    },
    {
      at: "2026-11-25T09:00:00.000Z",
      from: "x@example.org",
      subject: "Spam",
      status: "rejected",
      reason: "x@example.org can’t send to this address.",
      created: []
    }
  ],
  ...over
});

describe("MailInboxCard", () => {
  let state;
  beforeEach(() => {
    state = inbox();
    Parse.Cloud.run.mockReset();
    Parse.Cloud.run.mockImplementation(async (fn, params) => {
      if (fn === "mailinboxupdate") {
        if (params.allowedSenders?.includes("bad@x")) {
          throw new Error("“bad@x” isn’t an email address.");
        }
        state = {
          ...(state.addresses ? state : inbox({ enabled: false, recent: [] })),
          ...("enabled" in params ? { enabled: params.enabled } : {}),
          ...(params.allowedSenders
            ? { allowedSenders: params.allowedSenders }
            : {})
        };
      }
      if (fn === "mailinboxrotate") {
        state = inbox({
          addresses: {
            document: "zzzzzzzzzzzzzzzzzzzz@in.betterid.net",
            template: "zzzzzzzzzzzzzzzzzzzz+template@in.betterid.net"
          }
        });
      }
      return state;
    });
  });

  it("shows both addresses, who may send and recent mail", async () => {
    render(<MailInboxCard />);
    expect(
      await screen.findByText(`${TOKEN}@in.betterid.net`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${TOKEN}+template@in.betterid.net`)
    ).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("mail-inbox.made")).toBeInTheDocument();
    expect(screen.getByText("mail-inbox.processing")).toBeInTheDocument();
    expect(
      screen.getByText("x@example.org can’t send to this address.")
    ).toBeInTheDocument();
  });

  it("is off with no address until turned on", async () => {
    state = OFF;
    render(<MailInboxCard />);
    expect(await screen.findByText("mail-inbox.off")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "mail-inbox.rotate" })
    ).not.toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "mail-inbox.enabled" });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(Parse.Cloud.run).toHaveBeenCalledWith("mailinboxupdate", {
      enabled: true
    });
    expect(
      await screen.findByText(`${TOKEN}@in.betterid.net`)
    ).toBeInTheDocument();
    expect(toggle).toBeChecked();
  });

  it("says so when it can't load", async () => {
    Parse.Cloud.run.mockRejectedValueOnce(new Error("offline"));
    render(<MailInboxCard />);
    expect(
      await screen.findByText("something-went-wrong-mssg")
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("copies an address", async () => {
    render(<MailInboxCard />);
    await screen.findByText(`${TOKEN}@in.betterid.net`);
    await userEvent.click(
      screen.getAllByRole("button", { name: "mail-inbox.copy" })[1]
    );
    expect(copytoData).toHaveBeenCalledWith(
      `${TOKEN}+template@in.betterid.net`
    );
  });

  it("adds and removes senders, and shows the server's refusal", async () => {
    render(<MailInboxCard />);
    const input = await screen.findByPlaceholderText("mail-inbox.add-sender");
    await userEvent.type(input, "bob@example.org");
    await userEvent.click(
      screen.getByRole("button", { name: "mail-inbox.add" })
    );
    expect(Parse.Cloud.run).toHaveBeenCalledWith("mailinboxupdate", {
      allowedSenders: ["bob@example.org"]
    });
    expect(await screen.findByText("bob@example.org")).toBeInTheDocument();
    expect(input).toHaveValue("");

    // Passes the field's own check (type="email"), not the server's.
    await userEvent.type(input, "bad@x");
    await userEvent.click(
      screen.getByRole("button", { name: "mail-inbox.add" })
    );
    expect(
      await screen.findByText("“bad@x” isn’t an email address.")
    ).toBeInTheDocument();
    expect(input).toHaveValue("bad@x");
  });

  it("turns the address off", async () => {
    render(<MailInboxCard />);
    const toggle = await screen.findByRole("switch", {
      name: "mail-inbox.enabled"
    });
    await userEvent.click(toggle);
    expect(Parse.Cloud.run).toHaveBeenCalledWith("mailinboxupdate", {
      enabled: false
    });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("gets a new address after confirming in a dialog", async () => {
    render(<MailInboxCard />);
    await screen.findByText(`${TOKEN}@in.betterid.net`);

    await userEvent.click(
      screen.getByRole("button", { name: "mail-inbox.rotate" })
    );
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("mail-inbox.rotate-confirm")
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "no" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(Parse.Cloud.run).not.toHaveBeenCalledWith("mailinboxrotate", {});

    await userEvent.click(
      screen.getByRole("button", { name: "mail-inbox.rotate" })
    );
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "yes" }));
    expect(
      await screen.findByText("zzzzzzzzzzzzzzzzzzzz@in.betterid.net")
    ).toBeInTheDocument();
    expect(screen.getByText("mail-inbox.rotated")).toBeInTheDocument();
  });
});
