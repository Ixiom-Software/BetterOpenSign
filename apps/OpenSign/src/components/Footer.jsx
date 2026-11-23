import React, { useEffect, useState } from "react";
import Package from "../../package.json";
import axios from "axios";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Fab from "@mui/material/Fab";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import { openInNewTab } from "../constant/Utils";
import { useTranslation } from "react-i18next";
import { bs } from "../theme/md3Theme";
import { COMPANY_NAME, SOURCE_URL, SUPPORT_EMAIL, UPSTREAM_URL } from "../constant/brand";
const Footer = () => {
  const { t } = useTranslation();
  const [showButton, setShowButton] = useState(false);
  const [version, setVersion] = useState("");
  useEffect(() => {
    axios
      .get("/version.txt")
      .then((response) => {
        setVersion(response.data); // Set the retrieved data to the state variable
      })
      .catch((error) => {
        console.error("Error reading the file:", error);
      });
  }, []);

  const handleScroll = () => {
    if (window.pageYOffset >= 50) {
      setShowButton(true);
    } else {
      setShowButton(false);
    }
  };

  const scrollToTop = () => {
    window.scrollTo(0, 0);
    setShowButton(false);
  };

  useEffect(() => {
    window.addEventListener("scroll", handleScroll);

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const openUrl = () => {
    openInNewTab(
      UPSTREAM_URL + "/releases/tag/" + version
    );
  };
  return (
    <>
      <Box
        component="footer"
        sx={{
          py: 3,
          px: 3,
          bgcolor: bs.ink2,
          color: "rgba(255,255,255,0.6)",
          fontSize: "13.5px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1.5,
          "& a, & .footer-link": {
            color: bs.teal,
            textDecoration: "none",
            cursor: "pointer",
            "&:hover": { textDecoration: "underline", textUnderlineOffset: "3px" }
          }
        }}
      >
        <Typography variant="body2" component="p" sx={{ fontSize: "inherit", m: 0 }}>
          &copy; 2026 {COMPANY_NAME}
          &nbsp;&middot;&nbsp;
          <a href="https://www.betterid.net/" target="_blank" rel="noreferrer">
            betterid.net
          </a>
          &nbsp;&middot;&nbsp;
          <a href="https://www.betterid.net/privacy/" target="_blank" rel="noreferrer">
            Privacy
          </a>
          &nbsp;&middot;&nbsp;
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </Typography>
        <Typography
          variant="body2"
          component="p"
          sx={{ fontSize: "inherit", m: 0, color: "rgba(255,255,255,0.45)" }}
        >
          Built on{" "}
          <Box component="span" className="footer-link" onClick={openUrl}>
            OpenSign ( {t("version")}:{" "}
            {version ? version : `${Package.version} `})
          </Box>
          &nbsp;&middot;&nbsp;
          {/* AGPL-3.0 §13: offer users the source of what runs here. */}
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code
          </a>{" "}
          (
          <a href={`${SOURCE_URL}/blob/staging/LICENSE`} target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>
          )
        </Typography>
      </Box>
      {showButton && (
        <Fab
          onClick={scrollToTop}
          size="medium"
          color="primary"
          aria-label="scroll to top"
          sx={{ position: "fixed", bottom: 16, right: 16 }}
        >
          <KeyboardArrowUpIcon />
        </Fab>
      )}
    </>
  );
};

export default Footer;
