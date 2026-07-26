import { useEffect, useState } from "react";

/* ----------------------------------------------------------------------------
   useThemeType

   Resolve the effective dark/light theme for surfaces (the Pierre/Shiki diff)
   that render outside the reach of host CSS — they need the theme as a value,
   not a cascade. An explicit prop always wins; otherwise read the host's
   `data-og-theme` attribute (set on `<html>` or any ancestor by the same opt-in
   the tokens use) and default to dark, the first-class theme. A MutationObserver
   keeps it live across runtime theme flips.

   One detector, shared by every diff surface (the Files tab and the timeline),
   so the two can never drift onto different themes.
   -------------------------------------------------------------------------- */

/**
 * Resolve the diff theme. An explicit `forced` value wins; otherwise auto-detect
 * from the host `data-og-theme` (defaulting to dark) and track live flips.
 */
export function useThemeType(forced: "dark" | "light" | undefined): "dark" | "light" {
  const [detected, setDetected] = useState<"dark" | "light">("dark");
  useEffect(() => {
    if (forced || typeof document === "undefined") return;
    const read = () => {
      const el = document.querySelector("[data-og-theme]");
      const value = el?.getAttribute("data-og-theme");
      setDetected(value === "light" ? "light" : "dark");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-og-theme"],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [forced]);
  return forced ?? detected;
}
