import { useEffect, useState } from "react";
import Parse from "parse";
import { useDispatch } from "react-redux";
import axios from "axios";
import { NavLink, useNavigate, useLocation } from "react-router";
import BrandHero from "../components/BrandHero";
import { bs } from "../theme/md3Theme";
import { useWindowSize } from "../hook/useWindowSize";
import ModalUi from "../primitives/ModalUi";
import {
  emailRegex,
} from "../constant/const";
import Alert from "../primitives/Alert";
import { appInfo } from "../constant/appinfo";
import { fetchAppInfo } from "../redux/reducers/infoReducer";
import { showTenant } from "../redux/reducers/ShowTenant";
import {
  getAppLogo,
  saveLanguageInLocal,
  usertimezone
} from "../constant/Utils";
import Loader from "../primitives/Loader";
import { useTranslation } from "react-i18next";
import SelectLanguage from "../components/pdf/SelectLanguage";
import {
  BSID_CALLBACK_PATH,
  startBsIdLogin,
  takeBsIdCallback
} from "../constant/bsid";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";

function Login() {
  const appName =
    "OpenSign™";
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const { width } = useWindowSize();
  const [state, setState] = useState({
    email: "",
    password: "",
    alertType: "success",
    alertMsg: "",
    passwordVisible: false,
    loading: false,
    thirdpartyLoader: false,
  });
  const [userDetails, setUserDetails] = useState({
    Company: "",
    Destination: ""
  });
  const [isModal, setIsModal] = useState(false);
  const [image, setImage] = useState();
  // A tenant's own logo (white-label); the default one is replaced by the brand mark.
  const isCustomLogo = image && image !== appInfo?.applogo;
  const [errMsg, setErrMsg] = useState();
  useEffect(() => {
    handleUserExist();
    // eslint-disable-next-line
  }, []);

  const handleUserExist = async () => {
    await checkUserExt();
    if (location.pathname === BSID_CALLBACK_PATH) {
      await finishBsIdLogin();
    }
  };

  // Back from bs-id ("Sign in with BetterSign"): trade the code for a session.
  const finishBsIdLogin = async () => {
    const cb = takeBsIdCallback(location.search);
    // Drop the code from the address bar without remounting this page.
    window.history.replaceState(null, "", "/");
    if (cb.error) {
      showToast("danger", cb.error);
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const res = await Parse.Cloud.run("bsidlogin", {
        code: cb.code,
        codeVerifier: cb.codeVerifier,
        nonce: cb.nonce,
        redirectUri: cb.redirectUri
      });
      await thirdpartyLoginfn(res.sessionToken);
    } catch (error) {
      console.error("BetterSign sign-in failed", error);
      showToast("danger", error?.message || t("something-went-wrong-mssg"));
    }
  };


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
  const handleChange = (event) => {
    let { name, value } = event.target;
    if (name === "email") {
      value = value?.toLowerCase()?.replace(/\s/g, "");
    }
    setState({ ...state, [name]: value });
  };

  const handleLogin = async (
  ) => {
    const email = state?.email
    const password = state?.password

    if (!email || !password) {
      return;
    }
    localStorage.removeItem("accesstoken");
    try {
      setState({ ...state, loading: true });
      localStorage.setItem("appLogo", appInfo.applogo);
      const _user = await Parse.Cloud.run("loginuser", { email, password });
      if (!_user) {
        setState({ ...state, loading: false });
        return;
      }
      // Get extended user data (including 2FA status) using cloud function
      try {
        await Parse.User.become(_user.sessionToken);
        setLocalVar(_user);
        await continueLoginFlow();
      } catch (error) {
        console.error("Error checking 2FA status:", error);
        showToast("danger", t("something-went-wrong-mssg"));
      }
    } catch (error) {
      console.error("Error while logging in user", error);
      if (error?.code === 1001) {
        showToast("danger", t("action-prohibited"));
      } else {
        showToast("danger", t("invalid-username-password-region"));
      }
    }
  };
  const handleLoginBtn = async (event) => {
    event.preventDefault();
    if (!emailRegex.test(state.email)) {
      alert(t("valid-email-alert"));
      return;
    }
    await handleLogin();
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
        const payload = { sessionToken: _user.sessionToken };
        handleSubmitbtn(payload);
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

  const togglePasswordVisibility = () => {
    setState({ ...state, passwordVisible: !state.passwordVisible });
  };

  const handleSubmitbtn = async (e) => {
    e.preventDefault();
    if (userDetails.Destination && userDetails.Company) {
      setThirdpartyLoader(true);
      const payload = { sessionToken: localStorage.getItem("accesstoken") };
      const userInformation = JSON.parse(
        localStorage.getItem("UserInformation")
      );
      if (payload && payload.sessionToken) {
        const params = {
          userDetails: {
            name: userInformation.name,
            email: userInformation.email,
            phone: userInformation?.phone || "",
            role: "contracts_User",
            company: userDetails.Company,
            jobTitle: userDetails.Destination,
            timezone: usertimezone
          }
        };
        const userSignUp = await Parse.Cloud.run("usersignup", params);
        if (userSignUp && userSignUp.sessionToken) {
          const LocalUserDetails = {
            name: userInformation.name,
            email: userInformation.email,
            phone: userInformation?.phone || "",
            company: userDetails.Company,
            jobTitle: userDetails.JobTitle
          };
          localStorage.setItem("userDetails", JSON.stringify(LocalUserDetails));
          thirdpartyLoginfn(userSignUp.sessionToken);
        } else {
          alert(userSignUp.message);
        }
      } else if (
        payload &&
        payload.message.replace(/ /g, "_") === "Internal_server_err"
      ) {
        alert(t("server-error"));
      }
    } else {
      showToast("warning", t("fill-required-details!"));
    }
  };

  const logOutUser = async () => {
    setIsModal(false);
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

  const continueLoginFlow = async () => {
    try {
      const userSettings = appInfo.settings;
      const extUser = await Parse.Cloud.run("getUserDetails");
      if (extUser) {
        const IsDisabled = extUser?.get("IsDisabled") || false;
        if (!IsDisabled) {
          const userRole = extUser?.get("UserRole");
          const menu =
            userRole && userSettings?.find((menu) => menu.role === userRole);
          if (menu) {
            const _currentRole = userRole;
            const redirectUrl =
              location?.state?.from || `/${menu.pageType}/${menu.pageId}`;
            const _role = _currentRole.replace("contracts_", "");
            localStorage.setItem("_user_role", _role);
            const checkLanguage = extUser?.get("Language");
            if (checkLanguage) {
              checkLanguage && i18n.changeLanguage(checkLanguage);
            }
            const extInfo = JSON.parse(JSON.stringify(extUser));
            // Continue with storing user data and redirecting
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
              setState({ ...state, loading: false });
              navigate(redirectUrl);
          } else {
            setState({ ...state, loading: false });
            setIsModal(true);
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
      console.error("Error during login flow", error);
      showToast("danger", error.message || t("something-went-wrong-mssg"));
    }
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
                <Box>
                  <Typography
                    variant="overline"
                    component="p"
                    sx={{ color: bs.teal, letterSpacing: "0.22em", mb: 2.25 }}
                  >
                    Open BetterSign &middot; Document signing
                  </Typography>
                  <Typography
                    variant="h1"
                    sx={{
                      fontSize: "clamp(36px, 5vw, 58px)",
                      maxWidth: "15ch",
                      mb: 2.75
                    }}
                  >
                    Sign documents with an identity you hold.
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
                    Send, sign and verify PDFs. Approve sign-in and signatures
                    on your phone with BetterSign, so there is no password to
                    steal.
                  </Typography>
                  <Box
                    component="ul"
                    sx={{ listStyle: "none", p: 0, m: 0, display: "grid", gap: 1.5 }}
                  >
                    {[
                      ["Sign on your phone", "approve each signature with a biometric"],
                      ["Request signatures", "send a document to anyone, in order or all at once"],
                      ["Verify anywhere", "every completed document carries its audit trail"]
                    ].map(([title, text]) => (
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
                  <form onSubmit={handleLoginBtn} aria-label="Login Form">
                    <Typography id="loginHeading" variant="h4" component="h1">
                      {t("welcome")}
                    </Typography>
                    <Box
                      component="fieldset"
                      sx={{ border: "none", p: 0, m: 0 }}
                    >
                      <Typography
                        component="legend"
                        variant="body1"
                        sx={{ color: "text.secondary", mt: 0.5 }}
                      >
                        {t("Login-to-your-account")}
                      </Typography>
                      <Box sx={{ width: "100%", mt: 2.5, mb: 1 }}>
                        <Typography
                          component="label"
                          htmlFor="email"
                          variant="subtitle2"
                          sx={{ display: "block", mb: 0.5 }}
                        >
                          {t("email")}
                        </Typography>
                        <TextField
                          id="email"
                          type="email"
                          name="email"
                          fullWidth
                          size="small"
                          autoComplete="username"
                          value={state.email}
                          onChange={handleChange}
                          slotProps={{
                            htmlInput: {
                              required: true,
                              onInvalid: (e) =>
                                e.target.setCustomValidity(t("input-required")),
                              onInput: (e) => e.target.setCustomValidity("")
                            }
                          }}
                        />
                        <Box sx={{ my: 1 }} />
                        <Typography
                          component="label"
                          htmlFor="password"
                          variant="subtitle2"
                          sx={{ display: "block", mb: 0.5 }}
                        >
                          {t("password")}
                        </Typography>
                        <TextField
                          id="password"
                          type={state.passwordVisible ? "text" : "password"}
                          name="password"
                          fullWidth
                          size="small"
                          autoComplete="current-password"
                          value={state.password}
                          onChange={handleChange}
                          slotProps={{
                            htmlInput: {
                              required: true,
                              onInvalid: (e) =>
                                e.target.setCustomValidity(t("input-required")),
                              onInput: (e) => e.target.setCustomValidity("")
                            },
                            input: {
                              endAdornment: (
                                <InputAdornment position="end">
                                  <IconButton
                                    aria-label="toggle password visibility"
                                    onClick={togglePasswordVisibility}
                                    edge="end"
                                    size="small"
                                  >
                                    {state.passwordVisible ? (
                                      <VisibilityOff fontSize="small" />
                                    ) : (
                                      <Visibility fontSize="small" />
                                    )}
                                  </IconButton>
                                </InputAdornment>
                              )
                            }
                          }}
                        />
                        <Box sx={{ mt: 1 }}>
                          <Link
                            component={NavLink}
                            to="/forgetpassword"
                            underline="hover"
                            sx={{ fontSize: 13, ml: 0.5 }}
                          >
                            {t("forgot-password")}?
                          </Link>
                        </Box>
                      </Box>
                    </Box>
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "1fr",
                        gap: 1.25,
                        mt: 2
                      }}
                    >
                      <Button
                        type="submit"
                        variant="contained"
                        size="large"
                        disabled={state.loading}
                      >
                        {state.loading ? t("loading") : t("login")}
                      </Button>
                      <Button
                        type="button"
                        variant="contained"
                        color="secondary"
                        size="large"
                        disabled={state.loading}
                        onClick={() => startBsIdLogin()}
                        startIcon={
                          <i className="fa-light fa-fingerprint" aria-hidden="true"></i>
                        }
                      >
                        Sign in with BetterSign
                      </Button>
                    </Box>
                  </form>
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
          <ModalUi
            isOpen={isModal}
            title={t("additional-info")}
            showClose={false}
          >
            <Box component="form" sx={{ px: 2, py: 1.5 }}>
              <Box sx={{ mb: 1.5 }}>
                <Typography
                  component="label"
                  htmlFor="Company"
                  variant="caption"
                  sx={{ display: "flex", fontWeight: 600 }}
                >
                  {t("company")}{" "}
                  <Box component="span" sx={{ color: "error.main", ml: 0.25 }}>
                    *
                  </Box>
                </Typography>
                <TextField
                  type="text"
                  id="Company"
                  fullWidth
                  size="small"
                  value={userDetails.Company}
                  onChange={(e) =>
                    setUserDetails({
                      ...userDetails,
                      Company: e.target.value
                    })
                  }
                  slotProps={{
                    htmlInput: {
                      required: true,
                      onInvalid: (e) =>
                        e.target.setCustomValidity(t("input-required")),
                      onInput: (e) => e.target.setCustomValidity("")
                    }
                  }}
                />
              </Box>
              <Box sx={{ mb: 1.5 }}>
                <Typography
                  component="label"
                  htmlFor="JobTitle"
                  variant="caption"
                  sx={{ display: "flex", fontWeight: 600 }}
                >
                  {t("job-title")}
                  <Box component="span" sx={{ color: "error.main", ml: 0.25 }}>
                    *
                  </Box>
                </Typography>
                <TextField
                  type="text"
                  id="JobTitle"
                  fullWidth
                  size="small"
                  value={userDetails.Destination}
                  onChange={(e) =>
                    setUserDetails({
                      ...userDetails,
                      Destination: e.target.value
                    })
                  }
                  slotProps={{
                    htmlInput: {
                      required: true,
                      onInvalid: (e) =>
                        e.target.setCustomValidity(t("input-required")),
                      onInput: (e) => e.target.setCustomValidity("")
                    }
                  }}
                />
              </Box>
              <Box sx={{ mt: 2, gap: 1, display: "flex", flexDirection: "row" }}>
                <Button
                  type="button"
                  variant="contained"
                  onClick={(e) => handleSubmitbtn(e)}
                >
                  {t("login")}
                </Button>
                <Button type="button" variant="text" onClick={logOutUser}>
                  {t("cancel")}
                </Button>
              </Box>
            </Box>
          </ModalUi>
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
