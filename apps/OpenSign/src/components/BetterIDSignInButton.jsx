import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import { bs } from "../theme/md3Theme";
import { mountSignInButton } from "../vendor/signInWithBetterIDButton/button";
import { signInButtonOptions } from "../constant/bsid";

/**
 * The shared "Sign in with BetterID" button (<betterid-sign-in>, vendored
 * from BetterSignApps), wired to this site's cloud functions (constant/bsid.js)
 * and dressed as the theme's primary button through its CSS custom properties.
 *
 * It shows its own status and errors ("Approve on your phone…", denied,
 * refused) and finishes bs-id's redirect back by itself, so it must be on the
 * page at BSID_CALLBACK_PATH.
 *
 *   onSignedIn(value, method)  value: what bsextlogin / bsidlogin returned
 *   onError(error)             already shown under the button
 *   disabled                   e.g. while the page is busy
 *   label                      the button's text
 *   texts                      { "<the button's English text>": "shown instead" },
 *                              for its status line and "Use passkey instead"
 */
export default function BetterIDSignInButton({
  onSignedIn,
  onError,
  disabled = false,
  label,
  texts = {}
}) {
  const containerRef = useRef(null);
  const elementRef = useRef(null);
  // The element outlives renders; it calls whatever handlers are current.
  const handlers = useRef({ onSignedIn, onError });
  handlers.current = { onSignedIn, onError };

  useEffect(() => {
    // Mounted imperatively so the hooks are set before the element connects:
    // on the callback page it finishes the passkey sign-in as it connects.
    const el = mountSignInButton(containerRef.current, {
      ...signInButtonOptions(),
      label,
      fullWidth: true,
      onSignedIn: (value, method) => handlers.current.onSignedIn?.(value, method),
      onError: (error) => handlers.current.onError?.(error)
    });
    elementRef.current = el;
    return () => {
      el.remove();
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    elementRef.current?.toggleAttribute("disabled", disabled);
  }, [disabled]);

  useEffect(() => {
    if (label) elementRef.current?.setAttribute("label", label);
  }, [label]);

  // The button writes its status and passkey link in English (the kit has no
  // option for them). Swap in `texts` through its documented parts, whenever
  // it writes them.
  const textsKey = JSON.stringify(texts);
  useEffect(() => {
    const root = elementRef.current?.shadowRoot;
    if (!root) return;
    const swap = () => {
      for (const node of root.querySelectorAll('[part="status"], [part="fallback"]')) {
        const shown = texts[node.textContent];
        if (shown && shown !== node.textContent) node.textContent = shown;
      }
    };
    swap();
    const observer = new MutationObserver(swap);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textsKey]);

  return (
    <Box
      ref={containerRef}
      sx={(theme) => ({
        // brand.css `.btn.primary`, as MuiButton containedPrimary.
        "--betterid-bg": bs.gradient,
        "--betterid-fg": bs.onGreen,
        "--betterid-radius": "9999px",
        "--betterid-font": bs.fontFamily,
        "--betterid-focus": bs.greenBr,
        "--betterid-status": theme.palette.text.secondary,
        "--betterid-error": theme.palette.error.main,
        "--betterid-link": theme.palette.primary.main,
        "& betterid-sign-in::part(button)": { minHeight: 50, fontWeight: 700 }
      })}
    />
  );
}
