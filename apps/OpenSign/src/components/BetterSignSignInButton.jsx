import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import { bs } from "../theme/md3Theme";
import { mountSignInButton } from "../vendor/signInWithBetterSignButton/button";
import { signInButtonOptions } from "../constant/bsid";

/**
 * The shared "Sign in with BetterSign" button (<bettersign-sign-in>, vendored
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
 */
export default function BetterSignSignInButton({
  onSignedIn,
  onError,
  disabled = false
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

  return (
    <Box
      ref={containerRef}
      sx={(theme) => ({
        // brand.css `.btn.primary`, as MuiButton containedPrimary.
        "--bettersign-bg": bs.gradient,
        "--bettersign-fg": bs.onGreen,
        "--bettersign-radius": "9999px",
        "--bettersign-font": bs.fontFamily,
        "--bettersign-focus": bs.greenBr,
        "--bettersign-status": theme.palette.text.secondary,
        "--bettersign-error": theme.palette.error.main,
        "--bettersign-link": theme.palette.primary.main,
        "& bettersign-sign-in::part(button)": { minHeight: 50, fontWeight: 700 }
      })}
    />
  );
}
