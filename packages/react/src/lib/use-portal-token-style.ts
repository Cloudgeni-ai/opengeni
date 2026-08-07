import {
  type CSSProperties,
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useComposerResponsiveContext } from "./composer-responsive-context";

export type PortalTokenStyle = Pick<CSSProperties, "colorScheme"> &
  Partial<Record<`--${string}`, string>>;

export const PORTAL_SOURCE_INLINE_SIZE = "--og-portal-source-inline-size";

/**
 * A callback ref that publishes the currently mounted source element through
 * React state. Unlike a bare mutable ref, late mounts and replacements cause
 * consumers to render and restart their observers without polling.
 */
export function usePortalTokenSource<T extends HTMLElement>(): {
  source: T | null;
  currentRef: RefObject<T | null>;
  ref: RefCallback<T>;
} {
  const currentRef = useRef<T | null>(null);
  const [source, setSource] = useState<T | null>(null);
  const ref = useCallback<RefCallback<T>>((node) => {
    currentRef.current = node;
    setSource((current) => (current === node ? current : node));
  }, []);
  return { source, currentRef, ref };
}

/**
 * Copy the effective SDK tokens across a portal boundary. A locally themed or
 * rebranded embed cannot rely on CSS inheritance once a portal mounts under
 * `<body>`. Ancestor theme/class/style mutations and OS color-scheme changes
 * keep the copied values live.
 */
export function usePortalTokenStyle(source: HTMLElement | null): PortalTokenStyle {
  const responsiveContext = useComposerResponsiveContext();
  const [style, setStyle] = useState<PortalTokenStyle>({});
  useEffect(() => {
    if (!source || typeof window === "undefined") return;
    const layoutSource =
      responsiveContext?.responsiveBasis === "container" ? responsiveContext.rootRef.current : null;
    let signature = "";
    const sync = () => {
      const computed = getComputedStyle(source);
      const next: PortalTokenStyle = { colorScheme: computed.colorScheme };
      for (let index = 0; index < computed.length; index += 1) {
        const property = computed.item(index);
        if (!property.startsWith("--og-")) continue;
        next[property as `--${string}`] = computed.getPropertyValue(property);
      }
      if (layoutSource) {
        const inlineSize = layoutSource.clientWidth || layoutSource.getBoundingClientRect().width;
        if (inlineSize > 0) {
          next[PORTAL_SOURCE_INLINE_SIZE] = `${Math.round(inlineSize * 1000) / 1000}px`;
        }
      }
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== signature) {
        signature = nextSignature;
        setStyle(next);
      }
    };
    const observers: MutationObserver[] = [];
    if (typeof MutationObserver !== "undefined") {
      let ancestor: HTMLElement | null = source;
      while (ancestor) {
        const observer = new MutationObserver(sync);
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: ["class", "data-og-density", "data-og-theme", "style"],
        });
        observers.push(observer);
        ancestor = ancestor.parentElement;
      }
    }
    const resizeObserver =
      layoutSource && typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    if (layoutSource) resizeObserver?.observe(layoutSource);
    const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    colorScheme?.addEventListener?.("change", sync);
    sync();
    return () => {
      for (const observer of observers) observer.disconnect();
      resizeObserver?.disconnect();
      colorScheme?.removeEventListener?.("change", sync);
    };
  }, [responsiveContext?.responsiveBasis, responsiveContext?.rootRef, source]);
  return style;
}
