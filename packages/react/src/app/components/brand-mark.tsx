import { forwardRef, type ComponentPropsWithoutRef, type SVGProps } from "react";

import { useSimplifiedInterface } from "../lib/simplified-interface";
import { cn } from "../lib/utils";

/*
 * The Opengeni brand: the iconmark and the wordmark. This file is the one
 * place to swap either; every surface (rails, mobile header, sign-in, credits
 * row) renders these components. The favicon and app icons in `public/` use
 * the same mark (`geni-icon.svg` is the simplified interface's tile).
 */

/**
 * The Opengeni iconmark: two stacked filled chevrons, wider than tall
 * (176:138.73). Filled with currentColor, so it takes the surrounding text
 * color (`fg`, never a brand tint). Size it by width (`w-5`); the height
 * follows the aspect ratio.
 */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 176 138.73"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-auto shrink-0", className)}
      {...props}
    >
      <path
        transform="translate(-75 -39.5966)"
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </svg>
  );
}

/** The iconmark's outline, in the 64-unit Geni tile (the gogeni.ai mark). */
const GENI_TILE_MARK_TRANSFORM = "translate(12.16 17) scale(0.22545) translate(-75 -39.6)";

/**
 * The mark that stands beside the Wordmark. In the full console it is the bare
 * iconmark; in the simplified interface it is the Geni mark from gogeni.ai:
 * the same iconmark knocked out of a rounded tile in the primary ink, which
 * inverts with the appearance as the site's does. `className` sizes the bare
 * mark by width (`w-5`); `tileClassName` sizes the square tile (`size-6`) and
 * defaults to `className`. Everywhere else (chips, provider tiles) uses
 * BrandMark, which never changes.
 */
export function WordmarkMark({
  className,
  tileClassName,
}: {
  className?: string | undefined;
  tileClassName?: string | undefined;
}) {
  const { simplified } = useSimplifiedInterface();
  if (!simplified) return <BrandMark className={cn(className)} />;
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-geni-mark=""
      className={cn("shrink-0", tileClassName ?? className)}
    >
      <rect width="64" height="64" rx="15" style={{ fill: "var(--og-color-primary)" }} />
      <path
        transform={GENI_TILE_MARK_TRANSFORM}
        style={{ fill: "var(--og-color-primary-fg)" }}
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </svg>
  );
}

/**
 * The wordmark: DM Sans at weight 550, -0.055em tracking, line height 1. It
 * reads "Opengeni", or "Geni" in the simplified interface.
 * Set the size for the context with a text utility; pair it with a
 * WordmarkMark about 1.35x the font size wide (the Geni tile about 1.4x the
 * font size square).
 */
export const Wordmark = /* @__PURE__ */ forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<"span">
>(function Wordmark({ className, ...props }, ref) {
  const { productName } = useSimplifiedInterface();
  return (
    <span
      className={cn("font-display leading-none font-[550] tracking-[-0.055em]", className)}
      ref={ref}
      {...props}
    >
      {productName}
    </span>
  );
});
