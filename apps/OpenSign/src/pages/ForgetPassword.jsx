import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import BrandHero from "../components/BrandHero";
import Parse from "parse";
import Alert from "../primitives/Alert";
import { appInfo } from "../constant/appinfo";
import { useDispatch } from "react-redux";
import { fetchAppInfo } from "../redux/reducers/infoReducer";
import {
  emailRegex,
} from "../constant/const";
import { useTranslation } from "react-i18next";
import Loader from "../primitives/Loader";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";

function ForgotPassword() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [state, setState] = useState({ email: "", password: "" });
  const [toast, setToast] = useState({ type: "", message: "" });
  const [isLoading, setIsLoading] = useState(false);

  const handleChange = (event) => {
    let { name, value } = event.target;
    if (name === "email") {
      value = value?.toLowerCase()?.replace(/\s/g, "");
    }
    setState({ ...state, [name]: value });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!emailRegex.test(state.email)) {
      alert(t("valid-email-alert"));
    } else {
      setIsLoading(true);
      localStorage.setItem("appLogo", appInfo.applogo);
      localStorage.setItem("userSettings", JSON.stringify(appInfo.settings));
      if (state.email) {
        const username = state.email;
        try {
            await Parse.User.requestPasswordReset(username);
          setToast({ type: "success", message: t("reset-password-alert-1") });
        } catch (err) {
          console.log("err ", err.code);
          setToast({
            type: "danger",
            message: err.message || t("reset-password-alert-2")
          });
        } finally {
          setIsLoading(false);
          setTimeout(() => setToast({ type: "", message: "" }), 1000);
        }
      }
    }
  };

  useEffect(() => {
    dispatch(fetchAppInfo());
    saveLogo();
    // eslint-disable-next-line
  }, []);
  const saveLogo = async () => {
    try {
      await Parse.User.logOut();
    } catch (err) {
      console.log("err while logging out ", err);
    }
  };
  return (
    <Box>
      {isLoading && (
        <Box
          sx={{
            position: "fixed",
            inset: 0,
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
      {toast?.message && <Alert type={toast.type}>{toast.message}</Alert>}
      <BrandHero>
        <Box sx={{ px: 3, pt: { xs: 2, md: 8 }, pb: 6 }}>
          <Card
            sx={{
              maxWidth: 460,
              mx: "auto",
              p: { xs: 3, md: 4 },
              bgcolor: "surface.main",
              color: "surface.onMain",
              borderRadius: "20px",
              boxShadow: "0 30px 60px rgba(10,31,44,0.28)"
            }}
          >
            <form onSubmit={handleSubmit}>
              <Typography variant="h4" component="h1">
                {t("welcome")}
              </Typography>
              <Typography
                component="p"
                sx={{ mt: 0.5, color: "text.secondary" }}
              >
                {t("reset-password-alert-3")}
              </Typography>
              <Box sx={{ mt: 2.5, mb: 2 }}>
                <Typography
                  component="label"
                  variant="subtitle2"
                  sx={{ display: "block", mb: 0.5 }}
                >
                  {t("email")}
                </Typography>
                <TextField
                  type="email"
                  name="email"
                  fullWidth
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
              </Box>
              <Box sx={{ display: "grid", gap: 1.25 }}>
                <Button type="submit" variant="contained" size="large">
                  {t("submit")}
                </Button>
                <Button
                  type="button"
                  variant="outlined"
                  size="large"
                  onClick={() => navigate("/", { replace: true })}
                >
                  {t("login")}
                </Button>
              </Box>
            </form>
          </Card>
        </Box>
      </BrandHero>
    </Box>
  );
}

export default ForgotPassword;
