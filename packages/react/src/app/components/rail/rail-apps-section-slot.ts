import { createContext } from "react";

/**
 * Where the rail draws the Sessions list's Apps section when apps have a
 * section of their own: below the scrolling list, above the footer, so both
 * stay in view. Null: the list draws it right after itself.
 */
export const RailAppsSectionSlotContext = createContext<HTMLElement | null>(null);
