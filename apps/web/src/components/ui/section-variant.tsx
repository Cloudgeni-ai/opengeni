import { createContext, useContext, type ReactNode } from "react";

/*
 * Which way Sections hold their rows, shared without importing the Section
 * primitive itself: the settings shell sets it, and resource lists read it to
 * decide whether they are the card. Kept dependency-free so an import from an
 * eager module (a list, the settings shell) never pulls the management UI
 * primitives into the session bundle.
 */

export type SectionVariant = "open" | "group" | "tiles";

export const SectionVariantContext = createContext<SectionVariant | null>(null);

/** True inside a grouped Section's card, so nested lists don't draw a second card. */
export const SectionCardContext = createContext(false);

/**
 * Sets the default variant for every SectionStack and Section below it. The
 * settings shell provides `group`, so every settings page gets grouped cards.
 */
export function SectionVariantProvider({
  variant,
  children,
}: {
  variant: SectionVariant;
  children?: ReactNode;
}) {
  return (
    <SectionVariantContext.Provider value={variant}>{children}</SectionVariantContext.Provider>
  );
}

/**
 * How a resource list should hold itself here: `card` when the page groups its
 * sections into cards but the list is not already inside one, `inside` when it
 * sits in a grouped Section's card, `open` otherwise.
 */
export function useSectionListFrame(): "card" | "inside" | "open" {
  const variant = useContext(SectionVariantContext);
  const inCard = useContext(SectionCardContext);
  if (inCard) return "inside";
  return variant === "group" ? "card" : "open";
}
