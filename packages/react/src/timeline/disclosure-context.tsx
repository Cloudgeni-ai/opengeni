import { createContext, useContext, type ReactNode } from "react";

/* ----------------------------------------------------------------------------
   Disclosure defaults context

   A tiny, opt-in context that lets an ancestor seed the INITIAL open state of
   every collapsible in the timeline (ActivityDisclosure rows and TurnSummary
   chips). Its sole intended use is deterministic screenshot capture: a tool can
   force every card open so a headless render shows expanded bodies.

   It is fully inert in normal app usage. With no provider, the hook returns
   `undefined`, every collapsible keeps its own author-chosen default, and there
   is zero change to how the components look or animate. Mounting the provider
   only changes the SEED of the initial `open` state — Radix still owns the
   open/close transition, so animations are untouched.
   -------------------------------------------------------------------------- */

const DisclosureDefaultsContext = createContext<boolean | undefined>(undefined);

/**
 * Seed the initial open state of every timeline collapsible below this node.
 * Intended for screenshot/test instrumentation only; absent by default.
 */
export function DisclosureDefaultsProvider({
  defaultOpen,
  children,
}: {
  defaultOpen: boolean;
  children: ReactNode;
}) {
  return (
    <DisclosureDefaultsContext.Provider value={defaultOpen}>
      {children}
    </DisclosureDefaultsContext.Provider>
  );
}

/**
 * The forced initial-open seed from an ancestor {@link DisclosureDefaultsProvider},
 * or `undefined` when none is mounted (the inert, app-default case).
 */
export function useForcedDefaultOpen(): boolean | undefined {
  return useContext(DisclosureDefaultsContext);
}
