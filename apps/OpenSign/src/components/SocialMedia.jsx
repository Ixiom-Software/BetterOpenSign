import React from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { APP_NAME, SOURCE_URL } from "../constant/brand";

const SocialMedia = () => {
  const { t } = useTranslation();

  return (
    <React.Fragment>
      <NavLink to={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        <i aria-hidden="true" className="fa-brands fa-github"></i>
        <span className="fa-sr-only">
          {APP_NAME}&apos;s {t("social-media.github")}
        </span>
      </NavLink>
    </React.Fragment>
  );
};

export default SocialMedia;
