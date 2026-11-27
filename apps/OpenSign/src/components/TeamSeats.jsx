// Users page: Team seats. The teams this admin's BetterID identity manages
// at the license service: seats used and paid for, who holds one (remove),
// who asked to join (approve) and the join code (copy, get a new one).
// Server side: apps/OpenSignServer/cloud/parsefunction/bsLicenseAdmin.js.
import { useEffect, useState } from "react";
import Parse from "parse";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import ModalUi from "../primitives/ModalUi";
import Tooltip from "../primitives/Tooltip";
import Loader from "../primitives/Loader";
import { copytoData } from "../constant/Utils";
import { STORE_URL } from "../constant/brand";
import { withSessionValidation } from "../utils";

const cellSx = { fontSize: "12px" };
const shortVlad = (vlad) =>
  vlad.length > 24 ? `${vlad.slice(0, 12)}…${vlad.slice(-8)}` : vlad;
const storeHost = STORE_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
const GOOD_BILLING = ["active", "trialing", "past_due", "manual"];

// The license service's view of a team (bs-license /v1/product/teams):
// id, name, product, product_name, plan, seats_paid, seats_used, pending,
// billing_status, billing_ok, over, suspend_at, join_code, join_link,
// require_approval, code_expires_at, created_at. A seat: vlad, state
// (active | pending), requested_at, claimed_at, license_exp.
const billingOk = (team) =>
  typeof team.billing_ok === "boolean"
    ? team.billing_ok
    : !team.billing_status || GOOD_BILLING.includes(team.billing_status);

// Times: seconds, milliseconds or an ISO string.
function when(v) {
  if (v === undefined || v === null || v === "") return "-";
  const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return isNaN(d) ? "-" : d.toLocaleDateString();
}

const TeamSeats = ({ showAlert }) => {
  const { t } = useTranslation();
  const [teams, setTeams] = useState([]);
  const [seats, setSeats] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState({});
  const [confirm, setConfirm] = useState(null); // { kind: 'remove'|'rotate', team, seat? }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTeam(id) {
    const res = await Parse.Cloud.run("bslicenseteam", { id });
    setSeats((s) => ({ ...s, [id]: res.seats || [] }));
    setTeams((prev) =>
      prev.map((x) => (x.id === id ? { ...x, ...res.team } : x))
    );
  }

  async function load() {
    try {
      setIsLoading(true);
      setError("");
      const res = await Parse.Cloud.run("bslicenseteams");
      setConfigured(res.configured !== false);
      const list = res.teams || [];
      setTeams(list);
      await Promise.all(list.map((x) => loadTeam(x.id)));
    } catch (err) {
      console.log("Err in bslicenseteams", err);
      setError(err?.message || t("something-went-wrong-mssg"));
    } finally {
      setIsLoading(false);
    }
  }

  const act = withSessionValidation(async (key, fn, params, done) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await Parse.Cloud.run(fn, params);
      await done?.(res);
    } catch (err) {
      console.log(`Err in ${fn}`, err);
      showAlert("danger", err?.message || t("something-went-wrong-mssg"), 3000);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  });

  const approve = (team, seat) =>
    act(
      `${team.id}:${seat.vlad}`,
      "bslicenseapprove",
      { id: team.id, vlad: seat.vlad },
      async () => {
        showAlert("success", t("team-seats.approved"));
        await loadTeam(team.id);
      }
    );

  const remove = (team, seat) =>
    act(
      `${team.id}:${seat.vlad}`,
      "bslicenseremove",
      { id: team.id, vlad: seat.vlad },
      async () => {
        showAlert("success", t("team-seats.removed"));
        await loadTeam(team.id);
      }
    );

  const rotate = (team) =>
    act(`${team.id}:code`, "bslicenserotate", { id: team.id }, (res) => {
      setTeams((prev) =>
        prev.map((x) =>
          x.id === team.id
            ? {
                ...x,
                join_code: res.join_code,
                join_link: res.join_link || x.join_link
              }
            : x
        )
      );
      showAlert("success", t("team-seats.rotated"));
    });

  const onConfirm = () => {
    const c = confirm;
    setConfirm(null);
    if (c.kind === "remove") remove(c.team, c.seat);
    else rotate(c.team);
  };

  const storeLink = (
    <Box
      component="a"
      href={STORE_URL}
      target="_blank"
      rel="noreferrer"
      sx={{ color: "primary.main" }}
    >
      {storeHost}
    </Box>
  );

  // No license service on this site: nothing to show.
  if (!configured) return null;

  return (
    <Box sx={{ mt: 2 }}>
      <Box
        sx={{
          my: 1,
          mx: 1.5,
          fontSize: { xs: "18px", md: "20px" },
          fontWeight: 300
        }}
      >
        {t("team-seats.title")}{" "}
        <Box
          component="span"
          sx={{ fontSize: { xs: "0.75rem", md: "13px" }, fontWeight: 400 }}
        >
          <Tooltip message={t("team-seats.help")} />
        </Box>
      </Box>
      {isLoading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <Loader />
        </Box>
      ) : error ? (
        <Typography sx={{ ...cellSx, mx: 1.5, mb: 2 }} role="status">
          {error}
        </Typography>
      ) : teams.length === 0 ? (
        <Typography sx={{ ...cellSx, mx: 1.5, mb: 2 }}>
          {t("team-seats.empty")} {t("team-seats.add-seats")} {storeLink}.
        </Typography>
      ) : (
        teams.map((team) => {
          const list = seats[team.id] || [];
          const pending = list.filter((s) => s.state === "pending");
          const holders = list.filter((s) => s.state !== "pending");
          const overBy = Math.max(
            0,
            (team.seats_used || 0) - (team.seats_paid || 0)
          );
          return (
            <Box
              key={team.id}
              data-testid={`team-${team.id}`}
              sx={{ mx: 1.5, mb: 3 }}
            >
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: 2
                }}
              >
                <Typography sx={{ fontWeight: 600 }}>{team.name}</Typography>
                <Typography sx={cellSx}>
                  {t("team-seats.used", {
                    used: team.seats_used ?? 0,
                    paid: team.seats_paid ?? 0
                  })}
                </Typography>
                {team.organization?.organizationName && (
                  <Typography sx={{ ...cellSx, color: "text.secondary" }}>
                    {t("team-seats.organization", {
                      name: team.organization.organizationName
                    })}
                  </Typography>
                )}
              </Box>
              {(team.over || overBy > 0) && (
                <Typography sx={{ ...cellSx, color: "error.main", mt: 0.5 }}>
                  {t("team-seats.over", { count: overBy })}
                  {team.suspend_at
                    ? ` ${t("team-seats.suspend-at", { date: when(team.suspend_at) })}`
                    : ""}
                </Typography>
              )}
              {!billingOk(team) && (
                <Typography sx={{ ...cellSx, color: "error.main", mt: 0.5 }}>
                  {t("team-seats.billing", {
                    status: team.billing_status || "-"
                  })}
                </Typography>
              )}
              <Typography sx={{ ...cellSx, mt: 0.5 }}>
                {t("team-seats.add-seats")} {storeLink}.
              </Typography>

              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 1,
                  mt: 1
                }}
              >
                <Typography sx={cellSx}>{t("team-seats.join-code")}</Typography>
                <Box
                  component="code"
                  data-testid="join-code"
                  sx={{ fontFamily: "monospace", fontSize: "14px" }}
                >
                  {team.join_code || "-"}
                </Box>
                {team.join_code && (
                  <IconButton
                    size="small"
                    title={t("copy")}
                    aria-label={t("copy")}
                    onClick={() => {
                      copytoData(team.join_code);
                      showAlert("success", t("copied"));
                    }}
                  >
                    <i
                      className="fa-light fa-copy"
                      style={{ fontSize: 12 }}
                    ></i>
                  </IconButton>
                )}
                {team.join_link && (
                  <IconButton
                    size="small"
                    title={t("team-seats.copy-link")}
                    aria-label={t("team-seats.copy-link")}
                    onClick={() => {
                      copytoData(team.join_link);
                      showAlert("success", t("copied"));
                    }}
                  >
                    <i
                      className="fa-light fa-link"
                      style={{ fontSize: 12 }}
                    ></i>
                  </IconButton>
                )}
                {team.code_expires_at && (
                  <Typography sx={{ ...cellSx, color: "text.secondary" }}>
                    {t("team-seats.code-expires", {
                      date: when(team.code_expires_at)
                    })}
                  </Typography>
                )}
                <Button
                  size="small"
                  variant="outlined"
                  disabled={!!busy[`${team.id}:code`]}
                  onClick={() => setConfirm({ kind: "rotate", team })}
                >
                  {t("team-seats.rotate")}
                </Button>
                {team.require_approval && (
                  <Typography sx={{ ...cellSx, color: "text.secondary" }}>
                    {t("team-seats.requires-approval")}
                  </Typography>
                )}
              </Box>

              <TableContainer sx={{ width: "100%", overflowX: "auto", mt: 1 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      {["member", "state", "since"].map((h) => (
                        <TableCell
                          key={h}
                          sx={{ fontSize: "14px", fontWeight: 600 }}
                        >
                          {t(`team-seats.${h}`)}
                        </TableCell>
                      ))}
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {list.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          sx={{ ...cellSx, textAlign: "center" }}
                        >
                          {t("team-seats.no-members")}
                        </TableCell>
                      </TableRow>
                    )}
                    {[...pending, ...holders].map((seat) => {
                      const key = `${team.id}:${seat.vlad}`;
                      return (
                        <TableRow
                          key={seat.vlad}
                          sx={{ opacity: busy[key] ? 0.5 : 1 }}
                        >
                          <TableCell sx={cellSx}>
                            {seat.account ? (
                              <Box component="span">
                                {seat.account.email}
                                {seat.account.name
                                  ? ` (${seat.account.name})`
                                  : ""}
                              </Box>
                            ) : null}
                            <Box
                              component="span"
                              title={seat.vlad}
                              sx={{
                                fontFamily: "monospace",
                                display: "block",
                                color: seat.account ? "text.secondary" : ""
                              }}
                            >
                              {shortVlad(seat.vlad)}
                            </Box>
                          </TableCell>
                          <TableCell sx={cellSx}>
                            {t(
                              seat.state === "pending"
                                ? "team-seats.pending"
                                : "team-seats.active"
                            )}
                          </TableCell>
                          <TableCell sx={cellSx}>
                            {when(
                              seat.state === "pending"
                                ? seat.requested_at
                                : seat.claimed_at || seat.requested_at
                            )}
                          </TableCell>
                          <TableCell sx={{ ...cellSx, whiteSpace: "nowrap" }}>
                            {seat.state === "pending" && (
                              <Button
                                size="small"
                                variant="contained"
                                disabled={!!busy[key]}
                                onClick={() => approve(team, seat)}
                                sx={{ mr: 1 }}
                              >
                                {t("team-seats.approve")}
                              </Button>
                            )}
                            {seat.state !== "pending" && (
                              <Button
                                size="small"
                                color="error"
                                disabled={!!busy[key]}
                                onClick={() =>
                                  setConfirm({ kind: "remove", team, seat })
                                }
                              >
                                {t("team-seats.remove")}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          );
        })
      )}

      <ModalUi
        isOpen={!!confirm}
        title={
          confirm?.kind === "remove"
            ? t("team-seats.remove-title")
            : t("team-seats.rotate-title")
        }
        handleClose={() => setConfirm(null)}
      >
        <Box sx={{ m: 2.5 }}>
          <Typography sx={{ fontSize: "1rem", color: "text.primary" }}>
            {confirm?.kind === "remove"
              ? t("team-seats.remove-confirm")
              : t("team-seats.rotate-confirm")}
          </Typography>
          {confirm?.seat && (
            <Typography
              sx={{ fontSize: "0.75rem", fontFamily: "monospace", mt: 1 }}
            >
              {confirm.seat.account?.email || shortVlad(confirm.seat.vlad)}
            </Typography>
          )}
          <Divider sx={{ mt: 2 }} />
          <Box sx={{ display: "flex", alignItems: "center", mt: 1.5, gap: 1 }}>
            <Button
              variant="contained"
              color={confirm?.kind === "remove" ? "error" : "primary"}
              onClick={onConfirm}
            >
              {t("yes")}
            </Button>
            <Button
              variant="contained"
              color="secondary"
              onClick={() => setConfirm(null)}
            >
              {t("no")}
            </Button>
          </Box>
        </Box>
      </ModalUi>
    </Box>
  );
};

export default TeamSeats;
