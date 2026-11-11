import type { Plugin } from "vite";

/**
 * Runs before the app's code, as a plain inline script. If the browser can't
 * download the app's entry code (one of its files fails: a dropped
 * connection, a certificate or proxy change, a deploy mid-load), nothing
 * would render and the page would stay blank. Instead it reloads once, and if
 * the code still doesn't load it shows a short message with a Reload button.
 *
 * A failed module file fires `error` on the page's module script. The guard
 * only acts before the app has rendered anything and stops at page load, so
 * later failures stay with the app's own error handling.
 */
export const BOOT_RECOVERY_SCRIPT = `(() => {
  const key = "opengeni:boot-recovery";
  let failed = false;
  const storage = () => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  };
  const dark = () => {
    const theme = document.documentElement.dataset.ogTheme;
    if (theme === "dark" || theme === "light") return theme === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const show = () => {
    const host = document.getElementById("root") || document.body;
    if (!host) return;
    const isDark = dark();
    const fg = isDark ? "#ededed" : "#1a1a1a";
    const muted = isDark ? "#a3a3a3" : "#5c5c5c";
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    document.documentElement.style.background = isDark ? "#141414" : "#ffffff";
    const box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("data-og-boot-error", "");
    box.style.cssText =
      "box-sizing:border-box;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:" +
      fg;
    const title = document.createElement("p");
    title.textContent = "This page didn't load.";
    title.style.cssText = "margin:0;font-weight:600;font-size:16px";
    const hint = document.createElement("p");
    hint.textContent = "Check your connection, then reload.";
    hint.style.cssText = "margin:0;max-width:22em;color:" + muted;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload";
    button.style.cssText =
      "margin-top:4px;min-height:36px;padding:6px 16px;border-radius:8px;border:0;font:inherit;font-weight:600;cursor:pointer;background:" +
      fg +
      ";color:" +
      (isDark ? "#141414" : "#ffffff");
    button.addEventListener("click", () => window.location.reload());
    box.append(title, hint, button);
    host.replaceChildren(box);
  };
  const onError = (event) => {
    const target = event.target;
    if (failed || !(target instanceof HTMLScriptElement) || target.type !== "module") return;
    const root = document.getElementById("root");
    if (root && root.childElementCount > 0) return;
    failed = true;
    const build = target.src || "inline";
    const store = storage();
    try {
      if (store && store.getItem(key) !== build) {
        store.setItem(key, build);
        window.location.reload();
        return;
      }
    } catch {}
    const ready = () => show();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
    else ready();
  };
  window.addEventListener("error", onError, true);
  window.addEventListener("load", () => {
    window.removeEventListener("error", onError, true);
    if (failed) return;
    try {
      const store = storage();
      if (store) store.removeItem(key);
    } catch {}
  });
})();`;

/** Adds the boot guard to every HTML page the app builds (the web app and the Excel pane). */
export function bootRecoveryPlugin(): Plugin {
  return {
    name: "opengeni-boot-recovery",
    transformIndexHtml: () => [
      {
        tag: "script",
        attrs: { id: "opengeni-boot-recovery" },
        children: BOOT_RECOVERY_SCRIPT,
        injectTo: "head",
      },
    ],
  };
}
