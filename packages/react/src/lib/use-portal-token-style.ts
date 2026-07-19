import { type CSSProperties, type RefObject, useEffect, useState } from "react";

export type PortalTokenStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * Copy the effective SDK tokens across a portal boundary. A locally themed or
 * rebranded embed cannot rely on CSS inheritance once a portal mounts under
 * `<body>`. Ancestor theme/class/style mutations and OS color-scheme changes
 * keep the copied values live.
 */
export function usePortalTokenStyle(sourceRef: RefObject<HTMLElement | null>): PortalTokenStyle {
  const [style, setStyle] = useState<PortalTokenStyle>({});
  useEffect(() => {
    const source = sourceRef.current;
    if (!source || typeof MutationObserver === "undefined") return;
    let signature = "";
    const sync = () => {
      const computed = getComputedStyle(source);
      const next: PortalTokenStyle = { colorScheme: computed.colorScheme };
      for (let index = 0; index < computed.length; index += 1) {
        const property = computed.item(index);
        if (!property.startsWith("--og-")) continue;
        next[property as `--${string}`] = computed.getPropertyValue(property);
      }
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== signature) {
        signature = nextSignature;
        setStyle(next);
      }
    };
    const observers: MutationObserver[] = [];
    let ancestor: HTMLElement | null = source;
    while (ancestor) {
      const observer = new MutationObserver(sync);
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "data-og-theme", "style"],
      });
      observers.push(observer);
      ancestor = ancestor.parentElement;
    }
    const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    colorScheme?.addEventListener?.("change", sync);
    sync();
    return () => {
      for (const observer of observers) observer.disconnect();
      colorScheme?.removeEventListener?.("change", sync);
    };
  }, [sourceRef]);
  return style;
}
