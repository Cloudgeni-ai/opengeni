import { createContext, useContext, type RefObject } from "react";

/** The measurement surface used by responsive composer chrome. */
export type ResponsiveBasis = "viewport" | "container";

export type ComposerResponsiveContextValue = {
  responsiveBasis: ResponsiveBasis;
  rootRef: RefObject<HTMLDivElement | null>;
};

export const ComposerResponsiveContext = createContext<ComposerResponsiveContextValue | null>(null);

export function useComposerResponsiveContext(): ComposerResponsiveContextValue | null {
  return useContext(ComposerResponsiveContext);
}
