import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* ----------------------------------------------------------------------------
   Pages opened from inside the catalog (a skill, a plugin) render into the
   route's page slot, outside the catalog that stays mounted (and hidden)
   underneath. The route owns the URL (`?open=<kind>:<id>`); a section only
   says which key it opens and renders its page while that key is open.
   -------------------------------------------------------------------------- */

export type CapabilityPageSlotValue = {
  /** Where open pages render. */
  target: HTMLElement | null;
  /** The open page key, "skill:<id>", or null on the catalog. */
  openKey: string | null;
  /** Opens a page (pushes a history entry). */
  open: (key: string, options?: { replace?: boolean }) => void;
  /** Back to the catalog. */
  close: (options?: { replace?: boolean }) => void;
};

export const CapabilityPageSlotContext = createContext<CapabilityPageSlotValue | null>(null);

export function useCapabilityPageSlot(): CapabilityPageSlotValue | null {
  return useContext(CapabilityPageSlotContext);
}

/** Renders `children` into the page slot while `pageKey` is the open page. */
export function CapabilitySlotPage({
  pageKey,
  children,
}: {
  pageKey: string;
  children: ReactNode;
}) {
  const slot = useCapabilityPageSlot();
  if (!slot?.target || slot.openKey !== pageKey) return null;
  return createPortal(children, slot.target);
}
