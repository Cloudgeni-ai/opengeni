import type { ReactNode } from "react";

import { LogoTile, type LogoTileSize } from "../../../ui/logo-tile";
import { capabilityMonogram } from "../../lib/capabilities";
import { cn } from "../../lib/utils";

const TILE_SIZE: Record<"sm" | "md" | "lg", LogoTileSize> = { sm: "md", md: "lg", lg: "lg" };

/**
 * A catalog item's logo, drawn by the shared LogoTile so every capability
 * surface treats logos the same way: square app icons fill the tile, marks sit
 * padded on a light plate, and a missing or broken logo becomes a calm
 * monogram. Sizes keep their footprint: sm 32px, md 40px, lg 48px (sheet
 * headers). Images load lazily, so 1,000+ tiles don't request every logo at once.
 */
export function CapabilityLogo({
  src,
  name,
  size = "md",
  className,
  fallback,
}: {
  src: string | null;
  name: string;
  size?: "sm" | "md" | "lg" | undefined;
  className?: string | undefined;
  /** Optional reviewed initials or a glyph; catalog rows derive initials from the name. */
  fallback?: ReactNode | undefined;
}) {
  return (
    <LogoTile
      src={src}
      name={name}
      size={TILE_SIZE[size]}
      monogram={typeof fallback === "string" ? fallback : capabilityMonogram(name)}
      icon={fallback !== undefined && typeof fallback !== "string" ? fallback : undefined}
      className={cn(size === "lg" && "size-12 rounded-xl text-base", className)}
    />
  );
}
