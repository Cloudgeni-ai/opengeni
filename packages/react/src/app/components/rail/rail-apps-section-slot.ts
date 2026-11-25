import { createContext } from "react";

/**
 * Where the rail draws the Sessions list's Apps section when apps have a
 * section of their own: below the scrolling list, above the footer, so both
 * stay in view. Null: the list draws it right after itself.
 */
export const RailAppsSectionSlotContext = createContext<HTMLElement | null>(null);

/**
 * The rail's scrolling list, inside a `data-rail` column. With an Apps
 * section it takes only the height it needs, so Apps follows it directly.
 */
export const railScrollViewportClassName =
  "relative z-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [[data-rail]:has(>[data-rail-apps-section]:not(:empty))>&]:flex-initial";

/**
 * The slot for the Apps section. It takes the height its rows need; only
 * when Sessions is long too does it yield, down to about six rows, and then
 * scroll on its own. Empty, it takes no room.
 */
export const railAppsSectionSlotClassName =
  "flex h-[min(14rem,40%)] shrink-[10000] basis-[content] flex-col empty:hidden";
