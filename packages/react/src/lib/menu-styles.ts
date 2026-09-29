/* ----------------------------------------------------------------------------
   The one menu spec, SDK side. Mirrors `apps/web/src/components/ui/menu-styles.ts`
   (and apps/web DESIGN.md "Menus and popovers") in `og-` token names so the
   SDK's menus and pickers draw the same surface and rows as the web app's.
   Change both together.
   -------------------------------------------------------------------------- */

/** The panel: surface-1, 1px hairline, 16px radius, shadow-md, 6px inset. */
export const MENU_SURFACE_CLASS =
  "rounded-2xl border border-og-border bg-og-surface-1 p-1.5 text-og-fg shadow-og-md";

/** One row: 32px (44px on coarse pointers), 10px radius, 16px muted icons, 14/400 label. */
export const MENU_ITEM_BASE_CLASS =
  "relative flex min-h-8 w-full min-w-0 cursor-default items-center gap-2.5 rounded-og-md px-2.5 py-1.5 text-left text-og-menu font-normal text-og-fg outline-hidden select-none transition-colors duration-[120ms] pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-og-fg-muted";

/** Radix menu items: hover and keyboard focus fill surface-2; disabled is 50%. */
export const MENU_ITEM_STATE_CLASS =
  "focus:bg-og-surface-2 data-[highlighted]:bg-og-surface-2 data-[state=open]:bg-og-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-og-danger data-[variant=destructive]:focus:bg-og-danger/10 data-[variant=destructive]:*:[svg]:text-og-danger!";

export const MENU_ITEM_CLASS = `${MENU_ITEM_BASE_CLASS} ${MENU_ITEM_STATE_CLASS}`;

/** The same row as a plain button inside a hand-built popover. */
export const MENU_BUTTON_STATE_CLASS =
  "cursor-pointer hover:bg-og-surface-2 focus-visible:bg-og-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-og-accent/55 disabled:pointer-events-none disabled:opacity-50";

export const MENU_BUTTON_CLASS = `${MENU_ITEM_BASE_CLASS} ${MENU_BUTTON_STATE_CLASS}`;

/** A group heading inside a menu: 12/500 fg-muted, sentence case. */
export const MENU_LABEL_CLASS = "px-2.5 pt-2 pb-1 text-og-sm font-medium text-og-fg-muted";

/** The hairline between groups, inside the panel's 6px inset. */
export const MENU_SEPARATOR_CLASS = "my-1.5 h-px shrink-0 bg-og-border";

/** Right-side meta on a row (counts, the current value). */
export const MENU_META_CLASS = "ml-auto shrink-0 text-og-sm text-og-fg-muted tabular-nums";

/** The selected option's mark, always on the right. */
export const MENU_CHECK_CLASS = "size-4 shrink-0 text-og-fg";

/** "Opens a submenu" chevron on the right. */
export const MENU_CHEVRON_CLASS = "size-4 shrink-0 text-og-fg-muted";

/** A plain sentence inside a menu (empty, loading, unavailable). Never a box. */
export const MENU_NOTE_CLASS = "px-2.5 py-2 text-og-menu text-og-fg-muted";
