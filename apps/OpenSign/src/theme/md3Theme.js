import { createTheme } from "@mui/material/styles";

/**
 * Open BetterSign theme: Material UI v7 dressed in the BetterSign brand.
 *
 * Tokens come from the bettersign.ing sites (BetterSignApps
 * website/brand/brand.css), so the app shares their look: deep ink top bar and
 * footer, green gradient pill buttons, teal accents, soft-shadowed 16px cards
 * on a cool grey page, and the system font stack with heavy, tight headings.
 *
 * MUI consumes the standard palette keys; the extra MD3 roles (container
 * tones, surface variants, outline) stay attached under each color so
 * components and `sx` styles can keep referencing them.
 */

// BetterSign brand tokens (mirror of brand.css `:root`).
export const bs = {
  green: "#0e7a5f",
  greenBr: "#15c79a",
  teal: "#7ff0cf",
  blue: "#0b5c8a",
  ink: "#0f2b3d",
  ink2: "#0a1f2c",
  muted: "#5b6b76",
  line: "#e2e8ee",
  bg: "#f4f7f9",
  card: "#ffffff",
  red: "#b3261e",
  onGreen: "#042019",
  gradient: "linear-gradient(135deg, #15c79a, #0e7a5f)",
  shadow: "0 18px 50px rgba(10, 31, 44, 0.12)",
  shadowSoft: "0 18px 50px rgba(10, 31, 44, 0.08)",
  // The dark hero band with its faint grid (brand.css `.hero`).
  heroBackground: [
    "radial-gradient(1200px 600px at 12% -10%, rgba(14,122,95,0.55), transparent 60%)",
    "radial-gradient(1000px 700px at 100% 115%, rgba(11,92,138,0.6), transparent 55%)",
    "linear-gradient(160deg, #0a1f2c, #0f2b3d)"
  ].join(","),
  heroGrid: [
    "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
    "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)"
  ].join(","),
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
};

// ---------------------------------------------------------------------------
// Color schemes
// ---------------------------------------------------------------------------
const lightColors = {
  primary: {
    main: bs.green,
    light: bs.greenBr,
    dark: "#0a5c48",
    contrastText: "#ffffff",
    container: "#dcf7ec",
    onContainer: bs.green
  },
  secondary: {
    // Ink: the brand's dark navy, used for neutral/strong actions.
    main: bs.ink,
    light: "#24465c",
    dark: bs.ink2,
    contrastText: "#ffffff",
    container: "#e6eff6",
    onContainer: bs.ink
  },
  tertiary: {
    main: bs.blue,
    contrastText: "#ffffff",
    container: "#e6eff6",
    onContainer: bs.blue
  },
  error: {
    main: bs.red,
    contrastText: "#ffffff",
    container: "#fdf1f0",
    onContainer: "#7a1a14"
  },
  warning: {
    main: "#8a5300",
    contrastText: "#ffffff",
    container: "#fdf0e1",
    onContainer: "#8a5300"
  },
  info: {
    main: bs.blue,
    contrastText: "#ffffff",
    container: "#e9f3fa",
    onContainer: bs.blue
  },
  success: {
    main: bs.green,
    contrastText: "#ffffff",
    container: "#e7f8f0",
    onContainer: bs.green
  },
  background: {
    default: bs.bg,
    paper: bs.card
  },
  surface: {
    main: bs.card,
    variant: "#eef3f6",
    onMain: bs.ink,
    onVariant: bs.muted,
    container: "#eef3f6",
    containerLow: "#f7fafb",
    containerHigh: "#e8eef2",
    containerHighest: "#e2e8ee"
  },
  outline: {
    main: "#9aa6ad",
    variant: bs.line
  },
  text: {
    primary: bs.ink,
    secondary: bs.muted,
    disabled: "rgba(15,43,61,0.38)"
  },
  divider: bs.line
};

const darkColors = {
  primary: {
    main: bs.greenBr,
    light: bs.teal,
    dark: bs.green,
    contrastText: bs.onGreen,
    container: "#0f3d33",
    onContainer: bs.teal
  },
  secondary: {
    main: "#c9d6df",
    light: "#e2e8ee",
    dark: "#9aa6ad",
    contrastText: bs.ink2,
    container: "#1b3a4e",
    onContainer: "#e2e8ee"
  },
  tertiary: {
    main: "#7cc4ec",
    contrastText: "#002a40",
    container: "#0b4566",
    onContainer: "#d3ecfa"
  },
  error: {
    main: "#ffb4ab",
    contrastText: "#690005",
    container: "#5c1612",
    onContainer: "#ffdad6"
  },
  warning: {
    main: "#f5bd4f",
    contrastText: "#2f2100",
    container: "#4a3500",
    onContainer: "#ffdf9a"
  },
  info: {
    main: "#7cc4ec",
    contrastText: "#002a40",
    container: "#0b4566",
    onContainer: "#d3ecfa"
  },
  success: {
    main: bs.greenBr,
    contrastText: bs.onGreen,
    container: "#0f3d33",
    onContainer: bs.teal
  },
  background: {
    default: bs.ink2,
    paper: "#11293a"
  },
  surface: {
    main: "#11293a",
    variant: "#1b3a4e",
    onMain: "#e9f0f4",
    onVariant: "#a9b8c2",
    container: "#163246",
    containerLow: "#0e2433",
    containerHigh: "#1b3a4e",
    containerHighest: "#224459"
  },
  outline: {
    main: "#5f7a8b",
    variant: "#1f3d51"
  },
  text: {
    primary: "#e9f0f4",
    secondary: "#a9b8c2",
    disabled: "rgba(233,240,244,0.38)"
  },
  divider: "#1f3d51"
};

// ---------------------------------------------------------------------------
// Type scale: the brand's system stack, heavy and tight at display sizes
// ---------------------------------------------------------------------------
const heading = { fontWeight: 800, letterSpacing: "-0.025em" };
const typography = {
  fontFamily: bs.fontFamily,
  h1: { ...heading, fontSize: "3.5rem", lineHeight: 1.05, letterSpacing: "-0.03em" },
  h2: { ...heading, fontSize: "2.625rem", lineHeight: 1.08 },
  h3: { ...heading, fontSize: "2.25rem", lineHeight: 1.12 },
  h4: { ...heading, fontSize: "2rem", lineHeight: 1.15 },
  h5: { ...heading, fontSize: "1.5rem", lineHeight: 1.2, letterSpacing: "-0.02em" },
  h6: { fontSize: "1.25rem", lineHeight: 1.27, fontWeight: 700, letterSpacing: "-0.015em" },
  subtitle1: { fontSize: "1rem", lineHeight: 1.5, fontWeight: 600 },
  subtitle2: { fontSize: "0.875rem", lineHeight: 1.43, fontWeight: 600 },
  body1: { fontSize: "1rem", lineHeight: 1.6, fontWeight: 400 },
  body2: { fontSize: "0.875rem", lineHeight: 1.5, fontWeight: 400 },
  button: { fontSize: "0.9375rem", lineHeight: 1.43, fontWeight: 700, textTransform: "none" },
  caption: { fontSize: "0.75rem", lineHeight: 1.33, fontWeight: 400 },
  // brand.css `.eyebrow` / `.sec-eyebrow`
  overline: { fontSize: "0.75rem", lineHeight: 1.45, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase" }
};

// Base unit for `sx` radii (2 = the brand's 16px --radius). Cards, dialogs
// and menus get their brand radii in the overrides below.
const shape = { borderRadius: 8 };

// ---------------------------------------------------------------------------
// Component overrides: the brand's buttons, cards, inputs and chips
// ---------------------------------------------------------------------------
const components = {
  MuiCssBaseline: {
    styleOverrides: (theme) => ({
      "*": { boxSizing: "border-box" },
      body: {
        margin: 0,
        backgroundColor: theme.palette.background.default,
        WebkitFontSmoothing: "antialiased"
      },
      "code, kbd, pre": { fontFamily: bs.mono }
    })
  },
  MuiButton: {
    defaultProps: { disableElevation: true },
    styleOverrides: {
      // brand.css `.btn`: full pill, bold label.
      root: {
        borderRadius: 9999,
        paddingInline: 22,
        minHeight: 42,
        textTransform: "none",
        fontWeight: 700,
        whiteSpace: "nowrap",
        transition: "transform .12s ease, filter .12s ease, background .15s ease",
        "&:active": { transform: "translateY(1px)" }
      },
      sizeSmall: { minHeight: 34, paddingInline: 16, fontSize: "0.875rem" },
      sizeLarge: { minHeight: 50, paddingInline: 28 },
      // `.btn.primary`: green gradient with ink-on-green text.
      containedPrimary: {
        background: bs.gradient,
        color: bs.onGreen,
        "&:hover": { background: bs.gradient, filter: "brightness(1.07)" },
        "&.Mui-disabled": {
          background: bs.gradient,
          color: bs.onGreen,
          filter: "grayscale(0.5) brightness(0.95)",
          opacity: 0.6
        }
      },
      // `.btn.secondary`: white with a hairline border, green on hover.
      outlined: ({ theme }) => ({
        backgroundColor: theme.palette.background.paper,
        borderColor: theme.palette.divider,
        color: theme.palette.text.primary,
        "&:hover": {
          backgroundColor: theme.palette.background.paper,
          borderColor: bs.greenBr
        }
      }),
      outlinedError: ({ theme }) => ({
        borderColor: theme.palette.mode === "dark" ? theme.palette.error.container : "#f0c9c6",
        color: theme.palette.error.main,
        "&:hover": {
          backgroundColor: theme.palette.error.container,
          borderColor: theme.palette.error.main
        }
      }),
      text: { "&:hover": { backgroundColor: "rgba(21,199,154,0.08)" } }
    }
  },
  MuiIconButton: {
    styleOverrides: { root: { borderRadius: 9999 } }
  },
  MuiFab: {
    styleOverrides: {
      primary: {
        background: bs.gradient,
        color: bs.onGreen,
        "&:hover": { background: bs.gradient, filter: "brightness(1.07)" }
      }
    }
  },
  MuiToggleButton: {
    styleOverrides: { root: { borderRadius: 9999, textTransform: "none", fontWeight: 700 } }
  },
  MuiChip: {
    // brand.css `.badge`: small, bold, pill.
    styleOverrides: { root: { borderRadius: 9999, fontWeight: 700 } }
  },
  MuiCard: {
    defaultProps: { elevation: 0 },
    styleOverrides: {
      // brand.css `.card`
      root: ({ theme }) => ({
        borderRadius: 16,
        border: `1px solid ${theme.palette.divider}`,
        backgroundImage: "none",
        boxShadow: theme.palette.mode === "dark" ? "none" : bs.shadowSoft
      })
    }
  },
  MuiPaper: {
    styleOverrides: {
      root: { backgroundImage: "none" },
      rounded: { borderRadius: 16 }
    }
  },
  MuiDialog: {
    styleOverrides: {
      paper: ({ theme }) => ({
        borderRadius: 20,
        backgroundImage: "none",
        boxShadow: theme.palette.mode === "dark" ? undefined : bs.shadow
      })
    }
  },
  MuiDialogTitle: {
    styleOverrides: { root: { fontWeight: 800, letterSpacing: "-0.02em" } }
  },
  MuiTextField: {
    defaultProps: { variant: "outlined", size: "small" }
  },
  MuiOutlinedInput: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderRadius: 10,
        "& .MuiOutlinedInput-notchedOutline": { borderColor: theme.palette.divider },
        "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: bs.greenBr },
        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
          borderColor: theme.palette.primary.main
        }
      })
    }
  },
  MuiTooltip: {
    styleOverrides: {
      tooltip: {
        borderRadius: 8,
        fontSize: "0.75rem",
        backgroundColor: bs.ink2
      },
      arrow: { color: bs.ink2 }
    }
  },
  MuiAppBar: {
    defaultProps: { elevation: 0, color: "inherit" }
  },
  MuiMenu: {
    styleOverrides: { paper: ({ theme }) => ({ borderRadius: 14, border: `1px solid ${theme.palette.divider}` }) }
  },
  MuiTableHead: {
    // brand.css `.doc-table th`
    styleOverrides: {
      root: ({ theme }) => ({
        "& .MuiTableCell-head": {
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: theme.palette.text.secondary,
          backgroundColor: theme.palette.surface.containerLow
        }
      })
    }
  },
  MuiTableCell: {
    styleOverrides: { root: ({ theme }) => ({ borderBottomColor: theme.palette.divider }) }
  },
  MuiTab: {
    styleOverrides: { root: { textTransform: "none", fontWeight: 700 } }
  },
  MuiLink: {
    styleOverrides: { root: { fontWeight: 600, textUnderlineOffset: 3 } }
  },
  MuiAlert: {
    styleOverrides: { root: { borderRadius: 16 } }
  }
};

/**
 * Build the Open BetterSign theme for the given mode.
 * @param {"light"|"dark"} mode
 */
export function createMd3Theme(mode) {
  const c = mode === "dark" ? darkColors : lightColors;
  return createTheme({
    palette: {
      mode,
      primary: c.primary,
      secondary: c.secondary,
      tertiary: c.tertiary,
      error: c.error,
      warning: c.warning,
      info: c.info,
      success: c.success,
      background: c.background,
      surface: c.surface,
      outline: c.outline,
      text: c.text,
      divider: c.divider,
      contrastThreshold: 4.5
    },
    typography,
    shape,
    components
  });
}

export default createMd3Theme;
