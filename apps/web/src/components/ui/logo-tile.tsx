import { createContext, useContext, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   LogoTile (design brief, "Also build").

   One tile for logos, monograms and icons, the same in both themes:
   - a brand logo image (square app icons fill the tile; transparent marks
     sit on the surface with padding),
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
  size?: LogoTileSize;
  /** A brand logo. Missing or broken logos fall back to the monogram. */
  src?: string | null;
  /**
   * "cover" (default) fills the tile, for square app icons that carry their own
   * background. "contain" pads a transparent mark on the tile's surface.
   */
  fit?: "cover" | "contain";
  /** What the tile stands for. Used for the monogram and the optional label. */
  name?: string;
  /** One or two letters. Defaults to the first letter of `name`. */
  monogram?: string;
  /** A lucide glyph for things that are not brands. Takes precedence over the monogram. */
  icon?: ReactNode;
  /** Glyph color. Neutral by default; brand and danger are for empty states and alerts. */
  tone?: LogoTileTone;
  /**
   * Accessible name. Omit when the tile sits next to a visible name (the usual
   * case) so screen readers don't hear it twice.
   */
  label?: string;
  className?: string;
}

export function LogoTile({
  size: sizeProp,
  src,
  fit = "cover",
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
        src && fit === "contain" ? "bg-surface" : "bg-surface-2",
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
  fit: "cover" | "contain";
  size: LogoTileSize;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="grid size-full place-items-center bg-surface-2">{fallback}</span>;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn(
        "size-full",
        fit === "cover" ? "object-cover" : cn("object-contain", CONTAIN_PADDING[size]),
      )}
    />
  );
}
