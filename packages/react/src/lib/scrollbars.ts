/**
 * Where a platform draws classic, always-visible scrollbars (Windows, and Linux
 * or macOS when set to always show them), Chromium paints arrow buttons on the
 * thin, colored scrollbars the stylesheet asks for with `scrollbar-width` and
 * `scrollbar-color`. This marks such documents with
 * `data-og-scrollbars="classic"` on <html> so the stylesheet can use a slim
 * rounded thumb there instead. Overlay-scrollbar platforms keep their native
 * scrollbars.
 */
export const CLASSIC_SCROLLBARS_ATTRIBUTE = "data-og-scrollbars";

const marked = new WeakSet<Document>();

export function markClassicScrollbars(doc: Document | undefined = globalThis.document): void {
  if (!doc?.documentElement || marked.has(doc)) return;
  marked.add(doc);
  const root = doc.documentElement;
  // Probe with the platform default: the page's own scrollbar styles must not
  // decide what the platform draws.
  root.removeAttribute(CLASSIC_SCROLLBARS_ATTRIBUTE);
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;" +
    "overflow:scroll;visibility:hidden;scrollbar-width:auto;scrollbar-color:auto";
  root.append(probe);
  const classic = probe.offsetWidth - probe.clientWidth > 0;
  probe.remove();
  if (classic) root.setAttribute(CLASSIC_SCROLLBARS_ATTRIBUTE, "classic");
}
