import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The settings page header's action slot, provided by the settings shell. */
export const SettingsActionsSlotContext = createContext<HTMLElement | null>(null);

/**
 * Page header actions, rendered from inside the page body so the page decides
 * (for example, hide "Create API key" while the empty state shows it).
 */
export function SettingsHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsActionsSlotContext);
  if (!slot) return null;
  return createPortal(children, slot);
}
