import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";

function SelectLanguage(props) {
  const { t, i18n } = useTranslation();
  const languages = [
    { value: "en", text: "English" }, //english
    { value: "es", text: "Español" }, //spanish
    { value: "fr", text: "Français" }, //french
    { value: "it", text: "Italiano" }, //italian
    { value: "de", text: "Deutsch" }, //german
    { value: "hi", text: "हिन्दी" }, //hindi
    { value: "kr", text: "한국어" } //korean
  ];
  // Read the language from i18n on every render (useTranslation re-renders on
  // change), so the dropdown never drifts from the language actually shown.
  const current = i18n.resolvedLanguage || i18n.language;
  const lang = languages.some((l) => l.value === current) ? current : "en";
  const handleChangeLang = (e) => {
    i18n.changeLanguage(e.target.value);
    props?.updateExtUser && props.updateExtUser({ language: e.target.value });
  };
  return (
    <Box
      sx={{
        ...(!props.isProfile && { mt: "9px", pb: { xs: 1, md: 0 } }),
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        color: "text.primary"
      }}
    >
      <TextField
        select
        size="small"
        value={lang}
        onChange={handleChangeLang}
        // The profile page shows its own "Language:" text beside the field.
        label={!props.isProfile ? t("language") : undefined}
        slotProps={{
          htmlInput: { "aria-label": t("language") },
          select: {
            renderValue: (value) => (
              <Box component="span" sx={{ display: "inline-flex", gap: 1, alignItems: "center" }}>
                <i className="fa-light fa-globe" aria-hidden="true"></i>
                {languages.find((l) => l.value === value)?.text}
              </Box>
            )
          }
        }}
        sx={{
          width: !props.isProfile ? { xs: "50%", md: "15%" } : "180px"
        }}
      >
        {languages.map((item) => {
          return (
            <MenuItem key={item.value} value={item.value} lang={item.value === "kr" ? "ko" : item.value}>
              {item.text}
            </MenuItem>
          );
        })}
      </TextField>
    </Box>
  );
}

export default SelectLanguage;
