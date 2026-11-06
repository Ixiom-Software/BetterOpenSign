import Box from "@mui/material/Box";
import bettersignIcon from "../assets/images/bettersign-icon.png";
import { bs } from "../theme/md3Theme";

/**
 * The BetterSign wordmark (logo + name) and the product pill beside it, as in
 * the bettersign.ing top bars (brand.css `.wordmark` + `.product-mark`).
 * Pass `href` for a link, or `onClick` to handle navigation in-app.
 */
export const BrandMark = ({ href, onClick, label = "BetterSign home" }) => {
  const linkProps = href
    ? { component: "a", href }
    : {
        role: "link",
        tabIndex: 0,
        onClick,
        onKeyDown: (e) => e.key === "Enter" && onClick && onClick(e)
      };
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1.25, minWidth: 0 }}>
      <Box
        {...linkProps}
        aria-label={label}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 1.25,
          cursor: "pointer",
          color: "#fff",
          textDecoration: "none",
          fontWeight: 800,
          fontSize: 18,
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
          "&:hover": { color: "#fff", textDecoration: "none" }
        }}
      >
        <Box
          component="img"
          src={bettersignIcon}
          alt=""
          width={30}
          height={30}
          sx={{ borderRadius: "8px", display: "block" }}
        />
        <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
          BetterSign
          <Box
            component="span"
            sx={{ fontSize: 10, opacity: 0.7, position: "relative", top: -6, ml: "1px" }}
          >
            &trade;
          </Box>
        </Box>
      </Box>
      <Box
        component="span"
        sx={{
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: bs.teal,
          border: "1px solid rgba(127,240,207,0.4)",
          borderRadius: 9999,
          px: 1.125,
          py: 0.375,
          whiteSpace: "nowrap"
        }}
      >
        Sign
      </Box>
    </Box>
  );
};

/**
 * The bettersign.ing hero band (brand.css `.hero`) as a full-page backdrop for
 * the signed-out screens: dark ink gradient, green/blue glows, the faint grid,
 * and the wordmark + product mark in a top bar floating over it.
 */
const BrandHero = ({ children, ...rest }) => (
  <Box
    {...rest}
    sx={{
      position: "relative",
      minHeight: "100vh",
      color: "#fff",
      overflow: "hidden",
      background: bs.heroBackground,
      display: "flex",
      flexDirection: "column",
      "&::after": {
        content: '""',
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        backgroundImage: bs.heroGrid,
        backgroundSize: "46px 46px",
        maskImage: "radial-gradient(900px 600px at 72% 35%, #000, transparent 75%)",
        WebkitMaskImage:
          "radial-gradient(900px 600px at 72% 35%, #000, transparent 75%)"
      }
    }}
  >
    <Box
      sx={{
        position: "relative",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        px: { xs: 2, md: 3.5 },
        py: 1.75
      }}
    >
      <BrandMark href="https://www.bettersign.ing/" />
    </Box>
    <Box sx={{ position: "relative", zIndex: 2, flex: 1 }}>{children}</Box>
  </Box>
);

export default BrandHero;
