/* ----------------------------------------------------------------------------
   The one menu spec (DESIGN.md section 4, "Menus and popovers").

   Every dropdown, picker, context menu and popover draws the same surface and
   the same rows: the Radix primitives in `dropdown-menu.tsx` and
   `context-menu.tsx` use these, and hand-built popovers (the select menu, the
   composer panels, the agents pill) reuse them so nothing drifts. The SDK keeps
   a mirror in `packages/react/src/lib/menu-styles.ts`; change both together.
   -------------------------------------------------------------------------- */

/** The panel: `surface`, 1px hairline, 16px radius, shadow-md, 6px inset. */
export const MENU_SURFACE_CLASS =
  "rounded-2xl border border-border bg-surface p-1.5 text-fg shadow-og-md";

/**
 * One row: 32px (44px on coarse pointers), 10px radius, 16px icons in
 * `fg-muted`, a 14/400 `fg` label. Highlight and disabled states come from
 * `MENU_ITEM_STATE_CLASS` (Radix items) or `MENU_BUTTON_STATE_CLASS` (buttons).
 */
export const MENU_ITEM_BASE_CLASS =
  "relative flex min-h-8 w-full min-w-0 cursor-default items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-sm font-normal text-fg outline-hidden select-none transition-colors duration-[120ms] pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-fg-muted";

/** Radix menu items: hover and keyboard focus take the `hover` wash; disabled is 50%. */
export const MENU_ITEM_STATE_CLASS =
  "focus:bg-hover data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-danger data-[variant=destructive]:focus:bg-danger/10 data-[variant=destructive]:*:[svg]:text-danger!";

export const MENU_ITEM_CLASS = `${MENU_ITEM_BASE_CLASS} ${MENU_ITEM_STATE_CLASS}`;

/** The same row as a plain button inside a hand-built popover. */
export const MENU_BUTTON_STATE_CLASS =
  "cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-ring/55 disabled:pointer-events-none disabled:opacity-50";

export const MENU_BUTTON_CLASS = `${MENU_ITEM_BASE_CLASS} ${MENU_BUTTON_STATE_CLASS}`;

/** A group heading inside a menu: 12/500 `fg-muted`, sentence case. */
export const MENU_LABEL_CLASS = "px-2.5 pt-2 pb-1 text-xs leading-4.5 font-medium text-fg-muted";

/** The hairline between groups, inside the panel's 6px inset. */
export const MENU_SEPARATOR_CLASS = "my-1.5 h-px shrink-0 bg-border";

/** Right-side meta on a row (counts, the current value): 12px `fg-muted`. */
export const MENU_META_CLASS = "ml-auto shrink-0 text-xs text-fg-muted tabular-nums";

/** The selected option's mark, always on the right, in a reserved 16px slot. */
export const MENU_CHECK_CLASS = "size-4 shrink-0 text-fg";
export const MENU_CHECK_SLOT_CLASS = "ml-auto flex size-4 shrink-0 items-center justify-center";

/** "Opens a submenu" chevron on the right. */
export const MENU_CHEVRON_CLASS = "size-4 shrink-0 text-fg-muted";

/** A plain sentence inside a menu (empty, loading, unavailable). Never a box. */
export const MENU_NOTE_CLASS = "px-2.5 py-2 text-sm leading-5 text-fg-muted";

/** Drill-in header: back button, then the submenu's title, over a hairline. */
export const MENU_BACK_HEADER_CLASS =
  "mb-1.5 flex min-h-9 shrink-0 items-center gap-1 border-b border-border pb-1.5";

export const MENU_BACK_BUTTON_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-fg-muted transition-colors duration-[120ms] hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-ring/55 pointer-coarse:size-11";
