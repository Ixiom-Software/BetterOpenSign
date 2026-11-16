import { useEffect, useState } from "react";
import Parse from "parse";
import { useDispatch } from "react-redux";
import axios from "axios";
import { useNavigate, useLocation } from "react-router";
import BrandHero from "../components/BrandHero";
import { bs } from "../theme/md3Theme";
import { useWindowSize } from "../hook/useWindowSize";
import Alert from "../primitives/Alert";
import { appInfo } from "../constant/appinfo";
import { fetchAppInfo } from "../redux/reducers/infoReducer";
import { showTenant } from "../redux/reducers/ShowTenant";
import {
  getAppLogo,
  saveLanguageInLocal
} from "../constant/Utils";
import Loader from "../primitives/Loader";
import { useTranslation } from "react-i18next";
import SelectLanguage from "../components/pdf/SelectLanguage";
import { markBetterSignSession } from "../components/pdf/PhoneSign";
import { BSID_CALLBACK_PATH } from "../constant/bsid";
import BetterSignSignInButton from "../components/BetterSignSignInButton";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

// The vendored sign-in button writes these in English; show them translated.
const SIGN_IN_TEXT_KEYS = {
  "Approve on your phone…": "home.status-approve",
  "Signing in…": "home.status-signing-in",
  "Sign-in was denied on your phone.": "home.sign-in-denied",
  "Use passkey instead": "home.use-passkey-instead"
};

function Login() {
  const appName =
    "OpenSign™";
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const { width } = useWindowSize();
  const [state, setState] = useState({
    alertType: "success",
    alertMsg: "",
    loading: false,
    thirdpartyLoader: false,
  });
  const [image, setImage] = useState();
  // A tenant's own logo (white-label); the default one is replaced by the brand mark.
  const isCustomLogo = image && image !== appInfo?.applogo;
  const [errMsg, setErrMsg] = useState();
  useEffect(() => {
    checkUserExt();
    // eslint-disable-next-line
  }, []);

  // Back from bs-id the button has already dropped the code from the address
  // bar; this leaves the callback path too, without remounting this page.
  const leaveCallbackPath = () => {
    if (window.location.pathname === BSID_CALLBACK_PATH) {
      window.history.replaceState(null, "", "/");
    }
  };

  // "Sign in with BetterSign" (the button: a tap on the phone through the
  // BetterSign extension, or the passkey at bs-id) gave us a session.
  const onBetterSignSignedIn = async (value) => {
    leaveCallbackPath();
    setState((prev) => ({ ...prev, loading: true }));
    try {
      // Marks this session as a BetterSign one ("Sign on phone", PhoneSign.jsx).
      markBetterSignSession(value);
      await thirdpartyLoginfn(value.sessionToken);
    } catch (error) {
      console.error("BetterSign sign-in failed", error);
      showToast("danger", error?.message || t("something-went-wrong-mssg"));
    }
  };

  // The button shows the error itself.
  const onBetterSignError = (error) => {
    leaveCallbackPath();
    console.error("BetterSign sign-in failed", error);
  };

  const signInTexts = Object.fromEntries(
    Object.entries(SIGN_IN_TEXT_KEYS).map(([en, key]) => [en, t(key)])
  );

  const setLocalVar = (user) => {
    localStorage.setItem("accesstoken", user.sessionToken);
    localStorage.setItem("UserInformation", JSON.stringify(user));
    localStorage.setItem("userEmail", user.email);
    if (user.ProfilePic) {
      localStorage.setItem("profileImg", user.ProfilePic);
    } else {
      localStorage.setItem("profileImg", "");
    }
  };

  const showToast = (type, msg) => {
    setState({ ...state, loading: false, alertType: type, alertMsg: msg });
    setTimeout(() => setState({ ...state, alertMsg: "" }), 2000);
  };

  const checkUserExt = async () => {
    const app = await getAppLogo();
    if (app?.error === "invalid_json") {
      setErrMsg(t("server-down", { appName: appName }));
    } else if (
      app?.user === "not_exist"
    ) {
      navigate("/addadmin");
    }
    if (app?.logo) {
      setImage(app?.logo);
    } else {
      setImage(appInfo?.applogo || undefined);
    }
    dispatch(fetchAppInfo());
    if (localStorage.getItem("accesstoken")) {
      setState({ ...state, loading: true });
      GetLoginData();
    }
  };
  const setThirdpartyLoader = (value) => {
    setState({ ...state, thirdpartyLoader: value });
  };

  const thirdpartyLoginfn = async (sessionToken) => {
    const baseUrl = localStorage.getItem("baseUrl");
    const parseAppId = localStorage.getItem("parseAppId");
    const res = await axios.get(baseUrl + "users/me", {
      headers: {
        "X-Parse-Session-Token": sessionToken,
        "X-Parse-Application-Id": parseAppId
      }
    });
    await Parse.User.become(sessionToken).then(() => {
      window.localStorage.setItem("accesstoken", sessionToken);
    });
    if (res.data) {
      let _user = res.data;
      setLocalVar(_user);
      // Check extended class user role and tenentId
      try {
        const userSettings = appInfo.settings;
        const extUser = await Parse.Cloud.run("getUserDetails");
        if (extUser) {
          const IsDisabled = extUser?.get("IsDisabled") || false;
          if (!IsDisabled) {
            const userRole = extUser?.get("UserRole");
            const menu =
              userRole && userSettings.find((menu) => menu.role === userRole);
            if (menu) {
              const _currentRole = userRole;
              const redirectUrl =
                location?.state?.from || `/${menu.pageType}/${menu.pageId}`;
              const _role = _currentRole.replace("contracts_", "");
              const extInfo = JSON.parse(JSON.stringify(extUser));
              localStorage.setItem("_user_role", _role);
              localStorage.setItem("Extand_Class", JSON.stringify([extUser]));
              localStorage.setItem("userEmail", extInfo?.Email);
              localStorage.setItem("username", extInfo?.Name);
              if (extInfo?.TenantId) {
                const tenant = {
                  Id: extInfo?.TenantId?.objectId || "",
                  Name: extInfo?.TenantId?.TenantName || ""
                };
                localStorage.setItem("TenantId", tenant?.Id);
                dispatch(showTenant(tenant?.Name));
                localStorage.setItem("TenantName", tenant?.Name);
              }
              localStorage.setItem("PageLanding", menu.pageId);
              localStorage.setItem("defaultmenuid", menu.menuId);
              localStorage.setItem("pageType", menu.pageType);
                navigate(redirectUrl);
            } else {
              showToast("danger", t("role-not-found"));
              logOutUser();
            }
          } else {
            showToast("danger", t("do-not-access-contact-admin"));
            logOutUser();
          }
        } else {
          showToast("danger", t("user-not-found"));
          logOutUser();
        }
      } catch (error) {
        console.error("err in fetching extUser", error);
        showToast("danger", `${error.message}`);
        logOutUser();
      } finally {
        setThirdpartyLoader(false);
      }
    }
  };

  const GetLoginData = async () => {
    setState({ ...state, loading: true });
    try {
      const user = await Parse.User.become(localStorage.getItem("accesstoken"));
      const _user = user.toJSON();
      setLocalVar(_user);
      const userSettings = appInfo.settings;
      const extUser = await Parse.Cloud.run("getUserDetails");
      if (extUser) {
        const IsDisabled = extUser?.get("IsDisabled") || false;
        if (!IsDisabled) {
          const userRole = extUser.get("UserRole");
          const _currentRole = userRole;
          const menu =
            userRole && userSettings.find((menu) => menu.role === userRole);
          if (menu) {
            const extInfo = JSON.parse(JSON.stringify(extUser));
            const _role = _currentRole.replace("contracts_", "");
            localStorage.setItem("_user_role", _role);
            const redirectUrl =
              location?.state?.from || `/${menu.pageType}/${menu.pageId}`;
            localStorage.setItem("Extand_Class", JSON.stringify([extUser]));
            localStorage.setItem("userEmail", extInfo.Email);
            localStorage.setItem("username", extInfo.Name);
            if (extInfo?.TenantId) {
              const tenant = {
                Id: extInfo?.TenantId?.objectId || "",
                Name: extInfo?.TenantId?.TenantName || ""
              };
              localStorage.setItem("TenantId", tenant?.Id);
              dispatch(showTenant(tenant?.Name));
              localStorage.setItem("TenantName", tenant?.Name);
            }
            localStorage.setItem("PageLanding", menu.pageId);
            localStorage.setItem("defaultmenuid", menu.menuId);
            localStorage.setItem("pageType", menu.pageType);
              navigate(redirectUrl);
          } else {
            setState({ ...state, loading: false });
            logOutUser();
          }
        } else {
          showToast("danger", t("do-not-access-contact-admin"));
          logOutUser();
        }
      } else {
        showToast("danger", t("user-not-found"));
        logOutUser();
      }
    } catch (error) {
      showToast("danger", t("something-went-wrong-mssg"));
      console.log("err", error);
    }
  };

  const logOutUser = async () => {
    try {
      await Parse.User.logOut();
    } catch (err) {
      console.log("Err while logging out", err);
    }
    let appdata = localStorage.getItem("userSettings");
    let applogo = localStorage.getItem("appLogo");
    let defaultmenuid = localStorage.getItem("defaultmenuid");
    let PageLanding = localStorage.getItem("PageLanding");
    let baseUrl = localStorage.getItem("baseUrl");
    let appid = localStorage.getItem("parseAppId");
    let favicon = localStorage.getItem("favicon");

    localStorage.clear();
    saveLanguageInLocal(i18n);

    localStorage.setItem("appLogo", applogo);
    localStorage.setItem("defaultmenuid", defaultmenuid);
    localStorage.setItem("PageLanding", PageLanding);
    localStorage.setItem("userSettings", appdata);
    localStorage.setItem("baseUrl", baseUrl);
    localStorage.setItem("parseAppId", appid);
    localStorage.setItem("favicon", favicon);
  };

  return errMsg ? (
    <Box
      sx={{
        height: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        p: 2,
        color: "text.secondary",
        fontSize: "1rem"
      }}
    >
      {errMsg}
    </Box>
  ) : (
    <>
      {state.loading && (
        <Box
          aria-live="assertive"
          sx={{
            position: "fixed",
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            bgcolor: "rgba(0,0,0,0.3)",
            zIndex: 50
          }}
        >
          <Loader />
        </Box>
      )}
      {appInfo && appInfo.appId ? (
        <>
          <BrandHero aria-labelledby="loginHeading" role="region">
            <Box
              sx={{
                maxWidth: 1120,
                mx: "auto",
                px: 3,
                pt: { xs: 2, md: 6 },
                pb: { xs: 4, md: 8 },
                display: "grid",
                gridTemplateColumns: { xs: "1fr", md: "1.05fr 0.95fr" },
                gap: { xs: 3, md: 6 },
                alignItems: "center"
              }}
            >
              {width >= 768 && (
                // keep-all: wrap Korean at spaces, not mid-word.
                <Box sx={{ wordBreak: "keep-all" }}>
                  <Typography
                    variant="overline"
                    component="p"
                    sx={{ color: bs.teal, letterSpacing: "0.22em", mb: 2.25 }}
                  >
                    {t("home.eyebrow")}
                  </Typography>
                  <Typography
                    variant="h1"
                    sx={{
                      fontSize: "clamp(36px, 5vw, 58px)",
                      maxWidth: "15ch",
                      mb: 2.75
                    }}
                  >
                    {t("home.headline")}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: { md: 18, lg: 20 },
                      lineHeight: 1.55,
                      color: "rgba(255,255,255,0.84)",
                      maxWidth: "48ch",
                      mb: 3.25
                    }}
                  >
                    {t("home.intro")}
                  </Typography>
                  <Box
                    component="ul"
                    sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5 }}
                  >
                    {["phone", "request", "verify"]
                      .map((key) => [
                        t(`home.feature-${key}-title`),
                        t(`home.feature-${key}-text`)
                      ])
                      .map(([title, text]) => (
                      <Box
                        component="li"
                        key={title}
                        sx={{
                          position: "relative",
                          pl: 3.5,
                          fontSize: 16,
                          lineHeight: 1.45,
                          color: "rgba(255,255,255,0.86)",
                          "&::before": {
                            content: '""',
                            position: "absolute",
                            left: 2,
                            top: 7,
                            width: 9,
                            height: 9,
                            borderRadius: "3px",
                            background: `linear-gradient(135deg, ${bs.teal}, #4bbf9a)`
                          }
                        }}
                      >
                        <Box component="strong" sx={{ color: "#fff" }}>
                          {title}
                        </Box>
                        : {text}
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
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
              {image && isCustomLogo && (
                <Box sx={{ height: 48, mb: 1 }}>
                  <img
                    src={image}
                    className="object-contain h-full"
                    alt="applogo"
                  />
                </Box>
              )}
              <div>
                <div>
                  <Typography id="loginHeading" variant="h4" component="h1">
                    {t("welcome")}
                  </Typography>
                  <Typography
                    variant="body1"
                    sx={{ color: "text.secondary", mt: 0.5 }}
                  >
                    {t("Login-to-your-account")}
                  </Typography>
                  <Box sx={{ mt: 2.5 }}>
                    <BetterSignSignInButton
                      disabled={state.loading}
                      label={t("home.sign-in-button")}
                      texts={signInTexts}
                      onSignedIn={onBetterSignSignedIn}
                      onError={onBetterSignError}
                    />
                  </Box>
                  <Typography
                    variant="body2"
                    sx={{ color: "text.secondary", mt: 2 }}
                  >
                    {t("signer-link-hint")}
                  </Typography>
                </div>
              </div>
              <Box
                sx={{
                  mt: 2.5,
                  pt: 2,
                  borderTop: 1,
                  borderColor: "divider",
                  "& > .MuiBox-root": { mt: 0, pb: 0 },
                  "& .MuiTextField-root": { width: { xs: "60%", md: "50%" } }
                }}
              >
                <SelectLanguage />
              </Box>
            </Paper>
            </Box>
            {state.alertMsg && (
              <Alert type={state.alertType}>{state.alertMsg}</Alert>
            )}
          </BrandHero>
        </>
      ) : (
        <Box
          aria-live="assertive"
          sx={{
            position: "fixed",
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 50
          }}
        >
          <Loader />
        </Box>
      )}
    </>
  );
}
export default Login;
