// NoAccount: where the home page sends someone whose BetterID sign-in worked
// but who has no Better DocSign account (the cloud functions' "no account"
// error, constant/bsid.js BSID_NO_ACCOUNT_CODE). It says so and points to the
// store, where accounts are bought.

import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import BrandHero from "../components/BrandHero";
import { STORE_URL } from "../constant/brand";

const STORE_HOST = new URL(STORE_URL).host;

function NoAccount() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <BrandHero aria-labelledby="noAccountHeading" role="region">
      <Box sx={{ maxWidth: 560, mx: "auto", px: 3, pt: { xs: 2, md: 6 }, pb: 4 }}>
        <Paper
          elevation={0}
          sx={{
            p: { xs: 3, md: 4 },
            bgcolor: "background.paper",
            color: "text.primary",
            borderRadius: "20px",
            border: 1,
            borderColor: "divider",
            boxShadow: "0 30px 60px rgba(10,31,44,0.28)"
          }}
        >
          <Typography id="noAccountHeading" variant="h4" component="h1">
            {t("no-account.title")}
          </Typography>
          <Typography variant="body1" sx={{ color: "text.secondary", mt: 1.5 }}>
            {t("no-account.text")}
          </Typography>
          <Typography variant="body1" sx={{ mt: 2 }}>
            {t("no-account.store-text")}
          </Typography>
          <Button
            variant="contained"
            href={STORE_URL}
            fullWidth
            sx={{ mt: 2.5, minHeight: 50, fontWeight: 700 }}
          >
            {t("no-account.store-button", { store: STORE_HOST })}
          </Button>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 2.5 }}>
            {t("no-account.company")}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
            {t("signer-link-hint")}
          </Typography>
          <Button variant="text" onClick={() => navigate("/")} sx={{ mt: 2 }}>
            {t("no-account.back")}
          </Button>
        </Paper>
      </Box>
    </BrandHero>
  );
}

export default NoAccount;
