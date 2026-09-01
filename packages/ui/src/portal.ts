export type OpenGeniTokenBridgeOptions = Readonly<{
  publishSourceInlineSize?: boolean | undefined;
}>;

export type OpenGeniTokenBridge = Readonly<{
  sync(): void;
  destroy(): void;
}>;

/** Copy effective OpenGeni tokens from a source subtree into a portal root. */
export function bridgeOpenGeniPortalTokens(
  source: Element,
  target: HTMLElement,
  options: OpenGeniTokenBridgeOptions = {},
): OpenGeniTokenBridge {
  let destroyed = false;
  const observers: MutationObserver[] = [];
  const sync = () => {
    if (destroyed) return;
    const style = getComputedStyle(source);
    for (let index = 0; index < style.length; index += 1) {
      const property = style.item(index);
      if (property.startsWith("--og-"))
        target.style.setProperty(property, style.getPropertyValue(property));
    }
    target.style.colorScheme = style.colorScheme;
    if (options.publishSourceInlineSize) {
      target.style.setProperty(
        "--og-portal-source-inline-size",
        `${source.getBoundingClientRect().width}px`,
      );
    }
  };
  for (let ancestor: Element | null = source; ancestor; ancestor = ancestor.parentElement) {
    const observer = new MutationObserver(sync);
    observer.observe(ancestor, {
      attributes: true,
      attributeFilter: ["class", "style", "data-og-theme", "data-og-density"],
    });
    observers.push(observer);
  }
  const resize =
    options.publishSourceInlineSize && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(sync)
      : null;
  resize?.observe(source);
  const colorScheme =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  colorScheme?.addEventListener?.("change", sync);
  sync();
  return Object.freeze({
    sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const observer of observers) observer.disconnect();
      resize?.disconnect();
      colorScheme?.removeEventListener?.("change", sync);
    },
  });
}
