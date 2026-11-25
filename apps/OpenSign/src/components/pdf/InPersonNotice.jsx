// Shown instead of the signing page for a document assigned for signing in
// person (InPerson, apps/OpenSignServer parsefunction/inPersonAssign.js): the
// assignee's BetterID app signs it, so it keeps its blank signature fields.

import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

function InPersonNotice({ name }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        maxWidth: 640,
        mx: "auto",
        my: 6,
        p: { xs: 3, md: 4 },
        bgcolor: "background.paper",
        color: "text.primary",
        boxShadow: 3,
        borderRadius: 3,
        textAlign: "center"
      }}
    >
      <i
        className="fa-light fa-mobile"
        aria-hidden="true"
        style={{ fontSize: 40 }}
      />
      <Typography variant="h5" sx={{ fontWeight: 700, mt: 2, mb: 1 }}>
        {name}
      </Typography>
      <Typography sx={{ color: "text.secondary" }}>
        {t("in-person.assigned-notice")}
      </Typography>
    </Box>
  );
}

export default InPersonNotice;
