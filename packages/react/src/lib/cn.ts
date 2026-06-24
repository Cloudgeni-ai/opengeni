import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* ----------------------------------------------------------------------------
   tailwind-merge, taught our design tokens.

   Our type scale and color ramp share the `og-` prefix: `text-og-base` is a
   FONT SIZE, `text-og-fg-muted` is a COLOR. Stock tailwind-merge can't tell
   them apart — it lumps every `text-og-*` into one `font-size` group and, when
   two land in the same class list, drops the earlier one. That silently ate the
   size off rows like `text-og-base text-og-fg-muted`, leaving titles at the
   browser-default 16px. Register the custom font-size scale so the size and the
   color live in different conflict groups and both survive a merge.
   -------------------------------------------------------------------------- */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["og-xs", "og-sm", "og-base", "og-md"] }],
    },
  },
});

/** Merge class names with Tailwind-aware conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
