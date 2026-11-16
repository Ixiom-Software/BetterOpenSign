import logo from "../assets/images/logo.png";
import { getEnv } from "./Utils";

export function serverUrl_fn() {
  const env = getEnv();
  const serverurl = env?.REACT_APP_SERVERURL
    ? env.REACT_APP_SERVERURL // env.REACT_APP_SERVERURL is used for prod
    : process.env.REACT_APP_SERVERURL; //  process.env.REACT_APP_SERVERURL is used for dev (locally)
  let baseUrl = serverurl ? serverurl : window.location.origin + "/api/app";
  return baseUrl;
}
export const appInfo = {
  applogo: logo,
  appId: process.env.REACT_APP_APPID ? process.env.REACT_APP_APPID : "opensign",
  baseUrl: serverUrl_fn(),
  defaultRole: "contracts_User",
  fev_Icon:
    "data:image/png;base64,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",
  googleClientId: process.env.REACT_APP_GOOGLECLIENTID
    ? `${process.env.REACT_APP_GOOGLECLIENTID}`
    : "",
  metaDescription:
    "The fastest way to sign PDFs & request signatures from others.",
  settings: [
    {
      role: "contracts_Admin",
      menuId: "VPh91h0ZHk",
      pageType: "dashboard",
      pageId: "35KBoSgoAK",
      extended_class: "contracts_Users"
    },
    {
      role: "contracts_OrgAdmin",
      menuId: "VPh91h0ZHk",
      pageType: "dashboard",
      pageId: "35KBoSgoAK",
      extended_class: "contracts_Users"
    },
    {
      role: "contracts_Editor",
      menuId: "H9vRfEYKhT",
      pageType: "dashboard",
      pageId: "35KBoSgoAK",
      extended_class: "contracts_Users"
    },
    {
      role: "contracts_User",
      menuId: "H9vRfEYKhT",
      pageType: "dashboard",
      pageId: "35KBoSgoAK",
      extended_class: "contracts_Users"
    }
  ]
};
