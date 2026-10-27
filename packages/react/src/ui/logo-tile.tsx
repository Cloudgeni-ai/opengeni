import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { cachedLogoFit, measureLogoFit, type LogoFit } from "../logo-fit";

/* ----------------------------------------------------------------------------
   LogoTile (design brief, "Also build").

   One tile for logos, monograms and icons, the same in both themes:
   - a brand logo image: square app icons fill the tile; transparent marks
     sit with padding on a light plate in both themes, so dark and colored
     marks stay legible. By default each image is measured once to tell the
     two apart (see ../logo-fit),
   - a monogram on surface-2 when there is no logo or it fails to load,
   - a lucide glyph for things that are not brands (skills, variable sets,
     API keys), so a fallback never looks like a real logo.

   Sizes: 40 (catalog rows, sheet headers), 32 (resource rows), 24 (tables,
   inline mentions). Radius 10, or 6 at 24px so the small tile stays square.
   Decorative by default: the name next to it is the accessible label.
   -------------------------------------------------------------------------- */

export type LogoTileSize = "sm" | "md" | "lg";
export type LogoTileTone = "neutral" | "brand" | "danger";

const BOX: Record<LogoTileSize, string> = {
  lg: "size-10 rounded-[10px] text-sm",
  md: "size-8 rounded-[10px] text-xs",
  sm: "size-6 rounded-[6px] text-2xs",
};

const GLYPH: Record<LogoTileSize, string> = {
  lg: "[&_svg]:size-5",
  md: "[&_svg]:size-4",
  sm: "[&_svg]:size-3.5",
};

const CONTAIN_PADDING: Record<LogoTileSize, string> = {
  lg: "p-2",
  md: "p-1.5",
  sm: "p-1",
};

const TONE: Record<LogoTileTone, string> = {
  neutral: "text-fg-muted",
  brand: "text-brand",
  danger: "text-danger",
};

/**
 * The default tile size for tiles rendered inside a container, for example a
 * list row. An explicit `size` prop always wins.
 */
const LogoTileSizeContext = createContext<LogoTileSize | null>(null);

export function LogoTileSizeProvider({
  size,
  children,
}: {
  size: LogoTileSize;
  children: ReactNode;
}) {
  return <LogoTileSizeContext.Provider value={size}>{children}</LogoTileSizeContext.Provider>;
}

/** The tile size a container asked for, or null outside one. */
export function useLogoTileSize(): LogoTileSize | null {
  return useContext(LogoTileSizeContext);
}

/** First letter or digit of a name, uppercased. "GitHub automation" becomes "G". */
export function logoMonogram(name: string | undefined): string {
  const match = name?.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase() : "?";
}

export interface LogoTileProps {
  /** 40, 32 or 24px. Defaults to the container's size (list rows set it), else 40px. */
  size?: LogoTileSize | undefined;
  /** A brand logo. Missing or broken logos fall back to the monogram. */
  src?: string | null | undefined;
  /**
   * "auto" (default) measures the image: a square image with an opaque edge
   * fills the tile like an app icon, anything else is padded like a mark.
   * "cover" always fills; "contain" always pads the mark on a light plate.
   */
  fit?: LogoFit | "auto" | undefined;
  /** What the tile stands for. Used for the monogram and the optional label. */
  name?: string | undefined;
  /** One or two letters. Defaults to the first letter of `name`. */
  monogram?: string | undefined;
  /** A lucide glyph for things that are not brands. Takes precedence over the monogram. */
  icon?: ReactNode | undefined;
  /** Glyph color. Neutral by default; brand and danger are for empty states and alerts. */
  tone?: LogoTileTone | undefined;
  /**
   * Accessible name. Omit when the tile sits next to a visible name (the usual
   * case) so screen readers don't hear it twice.
   */
  label?: string | undefined;
  className?: string | undefined;
}

export function LogoTile({
  size: sizeProp,
  src,
  fit = "auto",
  name,
  monogram,
  icon,
  tone = "neutral",
  label,
  className,
}: LogoTileProps) {
  const contextSize = useLogoTileSize();
  const size = sizeProp ?? contextSize ?? "lg";
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  const fallback = icon ? (
    <span className={cn("inline-flex", TONE[tone], GLYPH[size])}>{icon}</span>
  ) : (
    <span className={cn("leading-none font-semibold", TONE[tone])}>
      {monogram ?? logoMonogram(name)}
    </span>
  );

  return (
    <span
      data-slot="logo-tile"
      data-size={size}
      {...a11y}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden select-none",
        // The hairline sits on top of the logo, so full-bleed icons keep a crisp edge.
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-border after:content-['']",
        "bg-surface-2",
        BOX[size],
        className,
      )}
    >
      {src ? (
        // Keyed by src so a new logo gets a fresh load attempt after an error.
        <LogoImage key={src} src={src} fit={fit} size={size} fallback={fallback} />
      ) : (
        fallback
      )}
    </span>
  );
}

function LogoImage({
  src,
  fit,
  size,
  fallback,
}: {
  src: string;
  fit: LogoFit | "auto";
  size: LogoTileSize;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const [measured, setMeasured] = useState<LogoFit | undefined>(() =>
    fit === "auto" ? cachedLogoFit(src) : undefined,
  );
  const resolved = fit === "auto" ? measured : fit;
  // An image already decoded before hydration never fires onLoad again.
  const measureIfLoaded = useCallback(
    (image: HTMLImageElement | null) => {
      if (fit !== "auto" || !image || !image.complete || image.naturalWidth === 0) return;
      setMeasured((current) => current ?? measureLogoFit(src, image));
    },
    [fit, src],
  );
  if (failed) {
    return <span className="grid size-full place-items-center bg-surface-2">{fallback}</span>;
  }
  return (
    <span
      data-fit={resolved ?? "pending"}
      className={cn("grid size-full place-items-center", resolved === "contain" && LIGHT_PLATE)}
    >
      <img
        ref={measureIfLoaded}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={(event) => measureIfLoaded(event.currentTarget)}
        onError={() => setFailed(true)}
        className={cn(
          "size-full",
          // Hidden only until an "auto" image is measured, so it never jumps.
          resolved === undefined && "opacity-0",
          resolved === "contain" ? cn("object-contain", CONTAIN_PADDING[size]) : "object-cover",
        )}
      />
    </span>
  );
}

/** Brand marks are drawn for light backgrounds; give them one in both themes. */
const LIGHT_PLATE = "bg-surface dark:bg-fg";
