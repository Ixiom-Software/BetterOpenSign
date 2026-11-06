/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {}
  },
  plugins: [
    require("daisyui"),
    function ({ addUtilities, addVariant }) {
      // ✅ Variants that match html[data-theme="..."] (or any ancestor with data-theme)
      addVariant("opensigncss", '[data-theme="opensigncss"] &');
      addVariant("opensigndark", '[data-theme="opensigndark"] &');

      addUtilities({
        // Prevent iOS long-press popup
        ".touch-callout-none": {
          "-webkit-touch-callout": "none"
        },
        // VS Code-style disabled button for all themes
        ".op-btn-vscode-disabled": {
          "background-color": "#3C3C3C !important",
          color: "#CCCCCC !important",
          "border-color": "#565656 !important",
          cursor: "not-allowed !important",
          opacity: "1 !important",
          "&:hover": {
            "background-color": "#3C3C3C !important",
            color: "#CCCCCC !important",
            "border-color": "#565656 !important",
            transform: "none !important"
          }
        },
        // Dark mode icon improvements using DaisyUI theme detection
        '[data-theme="opensigndark"] .icon-improved': {
          color: "#CCCCCC !important"
        },
        '[data-theme="opensigndark"] .icon-muted': {
          color: "#999999 !important"
        },
        '[data-theme="opensigndark"] .icon-disabled': {
          color: "#858585 !important"
        },
        // Gray text improvements for dark mode
        '[data-theme="opensigndark"] .text-gray-500': {
          color: "#CCCCCC !important"
        },
        '[data-theme="opensigndark"] .text-gray-400': {
          color: "#999999 !important"
        },
        '[data-theme="opensigndark"] .text-gray-600': {
          color: "#CCCCCC !important"
        },
        // CSS variable utilities that work with arbitrary values
        ".icon-themed": {
          color: "var(--icon-color)"
        },
        ".icon-themed-muted": {
          color: "var(--icon-color-muted)"
        },
        ".icon-themed-disabled": {
          color: "var(--icon-color-disabled)"
        },
        ".btn-themed-disabled": {
          "background-color": "var(--btn-disabled-bg)",
          color: "var(--btn-disabled-color)",
          "border-color": "var(--btn-disabled-border)",
          cursor: "not-allowed",
          "&:hover": {
            "background-color": "var(--btn-disabled-bg)",
            color: "var(--btn-disabled-color)",
            "border-color": "var(--btn-disabled-border)",
            transform: "none"
          }
        }
      });
    }
  ],
  daisyui: {
    // themes: true,
    themes: [
      {
        opensigndark: {
          // BetterSign brand, dark (matches src/theme/md3Theme.js darkColors)
          primary: "#15C79A", // brand green, bright - CTA & highlight color
          "primary-content": "#042019",

          secondary: "#0E2433", // Sidebar background (deep ink)
          "secondary-content": "#E2E8EE",

          accent: "#7FF0CF", // brand teal for hover, minor CTA
          "accent-content": "#042019",

          neutral: "#1B3A4E", // inactive/disabled element background
          "neutral-content": "#A9B8C2", // inactive text color

          "base-100": "#0A1F2C", // App background (ink-2)
          "base-200": "#11293A", // Slight elevation (cards)
          "base-300": "#163246", // Further elevated items (panels)
          "base-content": "#E9F0F4", // Main text color

          info: "#7CC4EC",
          success: "#15C79A",
          warning: "#F5BD4F",
          error: "#FFB4AB",

          "--rounded-btn": "1.9rem",
          "--tab-border": "2px",
          "--tab-radius": "0.7rem",

          // Custom CSS variables for icon and button states
          "--icon-color": "#CCCCCC",
          "--icon-color-muted": "#999999",
          "--icon-color-disabled": "#858585",
          "--btn-disabled-bg": "#1B3A4E",
          "--btn-disabled-color": "#A9B8C2",
          "--btn-disabled-border": "#1F3D51",

          // Optional polish
          "--navbar-padding": "0.8rem",
          "--border-color": "#1F3D51", // Card/table separation
          "--tooltip-color": "#0A1F2C"
        }
      },
      {
        opensigncss: {
          // BetterSign brand, light (matches src/theme/md3Theme.js lightColors)
          primary: "#0E7A5F",
          "primary-content": "#FFFFFF",
          secondary: "#0F2B3D",
          "secondary-content": "#E2E8EE",
          accent: "#15C79A",
          "accent-content": "#042019",
          neutral: "#E2E8EE",
          "neutral-content": "#0F2B3D",
          "base-100": "#FFFFFF",
          "base-200": "#F4F7F9",
          "base-300": "#E2E8EE",
          "base-content": "#0F2B3D",
          info: "#0B5C8A",
          "info-content": "#FFFFFF",
          success: "#0E7A5F",
          "success-content": "#FFFFFF",
          warning: "#F5BD4F",
          "warning-content": "#2F2100",
          error: "#F0C9C6",
          "error-content": "#7A1A14",
          "--rounded-btn": "1.9rem",
          "--tab-border": "2px",
          "--tab-radius": "0.7rem"
        }
      }
    ],
    prefix: "op-"
  }
};
