import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Parse from "parse";
import TeamSeats from "./TeamSeats";
import { copytoData } from "../constant/Utils";

vi.mock("parse", () => ({ default: { Cloud: { run: vi.fn() } } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k)
  })
}));
vi.mock("../constant/Utils", () => ({
  copytoData: vi.fn(),
  openInNewTab: vi.fn()
}));
vi.mock("../utils", () => ({ withSessionValidation: (fn) => fn }));

const HOLDER = "8724" + "ab".repeat(40);
const ASKING = "8724" + "cd".repeat(40);
const team = {
  id: "team1",
  name: "Acme Legal",
  product: "docsign",
  plan: "hosted-unlimited",
  seats_paid: 5,
  seats_used: 1,
  billing_status: "active",
  over: false,
  join_code: "DOCS-7K4M-QX2P-9HTW",
  require_approval: true,
  organization: null
};
const seats = [
  {
    vlad: HOLDER,
    state: "active",
    claimed_at: 1800000000,
    account: { name: "Ada", email: "ada@example.com" }
  },
  { vlad: ASKING, state: "pending", claimed_at: 1800000100, account: null }
];

function mockServer(over = {}) {
  Parse.Cloud.run.mockImplementation(async (fn) => {
    if (fn in over) return over[fn]();
    if (fn === "bslicenseteams") return { configured: true, teams: [team] };
    if (fn === "bslicenseteam") return { team, seats };
    if (fn === "bslicenserotate") return { join_code: "DOCS-AAAA-BBBB-CCCC" };
    return { ok: true };
  });
}

const rowOf = (vlad) =>
  screen.getByText((t) => t.startsWith(vlad.slice(0, 12))).closest("tr");

describe("TeamSeats", () => {
  beforeEach(() => {
    Parse.Cloud.run.mockReset();
    copytoData.mockReset();
    mockServer();
  });

  it("shows seats used and paid, the join code, holders and people asking to join", async () => {
    render(<TeamSeats showAlert={vi.fn()} />);
    await screen.findByText("Acme Legal");
    expect(
      screen.getByText('team-seats.used {"used":1,"paid":5}')
    ).toBeTruthy();
    expect(screen.getByTestId("join-code").textContent).toBe(
      "DOCS-7K4M-QX2P-9HTW"
    );
    await waitFor(() => expect(rowOf(HOLDER)).toBeTruthy());
    expect(
      within(rowOf(HOLDER)).getByText("ada@example.com (Ada)")
    ).toBeTruthy();
    expect(within(rowOf(HOLDER)).getByText("team-seats.remove")).toBeTruthy();
    expect(within(rowOf(ASKING)).getByText("team-seats.approve")).toBeTruthy();
    expect(screen.getAllByText("store.betterid.net").length).toBeGreaterThan(0);
  });

  it("approves someone asking to join", async () => {
    const user = userEvent.setup();
    const showAlert = vi.fn();
    render(<TeamSeats showAlert={showAlert} />);
    await waitFor(() => expect(rowOf(ASKING)).toBeTruthy());
    await user.click(within(rowOf(ASKING)).getByText("team-seats.approve"));
    expect(Parse.Cloud.run).toHaveBeenCalledWith("bslicenseapprove", {
      id: "team1",
      vlad: ASKING
    });
    await waitFor(() =>
      expect(showAlert).toHaveBeenCalledWith("success", "team-seats.approved")
    );
  });

  it("removes a holder after confirming", async () => {
    const user = userEvent.setup();
    render(<TeamSeats showAlert={vi.fn()} />);
    await waitFor(() => expect(rowOf(HOLDER)).toBeTruthy());
    await user.click(within(rowOf(HOLDER)).getByText("team-seats.remove"));
    expect(Parse.Cloud.run).not.toHaveBeenCalledWith(
      "bslicenseremove",
      expect.anything()
    );
    await user.click(await screen.findByText("yes"));
    expect(Parse.Cloud.run).toHaveBeenCalledWith("bslicenseremove", {
      id: "team1",
      vlad: HOLDER
    });
  });

  it("copies the join code and gets a new one", async () => {
    const user = userEvent.setup();
    render(<TeamSeats showAlert={vi.fn()} />);
    await screen.findByText("Acme Legal");
    await user.click(screen.getByTitle("copy"));
    expect(copytoData).toHaveBeenCalledWith("DOCS-7K4M-QX2P-9HTW");
    await user.click(screen.getByText("team-seats.rotate"));
    await user.click(await screen.findByText("yes"));
    await waitFor(() =>
      expect(screen.getByTestId("join-code").textContent).toBe(
        "DOCS-AAAA-BBBB-CCCC"
      )
    );
  });

  it("says when the identity manages no teams, with the store", async () => {
    mockServer({ bslicenseteams: () => ({ configured: true, teams: [] }) });
    render(<TeamSeats showAlert={vi.fn()} />);
    await screen.findByText((t) => t.startsWith("team-seats.empty"));
  });

  it("shows the server's reason when it can't list teams", async () => {
    mockServer({
      bslicenseteams: () => {
        throw new Error("Couldn't reach the license service. Try again.");
      }
    });
    render(<TeamSeats showAlert={vi.fn()} />);
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Couldn't reach/
    );
  });

  it("isn't shown on a site without the license service", async () => {
    mockServer({ bslicenseteams: () => ({ configured: false, teams: [] }) });
    const { container } = render(<TeamSeats showAlert={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
