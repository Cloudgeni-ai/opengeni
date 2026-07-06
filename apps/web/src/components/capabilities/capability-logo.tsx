import { useEffect, useState } from "react";

import { capabilityMonogram } from "@/lib/capabilities";
import { cn } from "@/lib/utils";

/**
 * A catalog item's logo. Real vendor logos are served from the public,
 * immutably-cached `/v1/catalog-assets/*` route (via `client.catalogAssetUrl`);
 * a missing path or a load error falls back to a calm letter monogram so the
 * grid never shows broken-image glyphs. Lazy-loaded so 1,000+ tiles don't
 * request every logo at once.
 */
export function CapabilityLogo({
  src,
  name,
  size = "md",
  className,
}: {
  src: string | null;
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A new src (e.g. switching the sheet to another item) gets a fresh attempt.
  useEffect(() => setFailed(false), [src]);

  const box = size === "lg" ? "size-12 rounded-xl text-base" : size === "sm" ? "size-8 rounded-lg text-2xs" : "size-10 rounded-lg text-sm";
  const showImage = src && !failed;

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-2/70 font-semibold text-fg-muted",
        box,
        className,
      )}
      aria-hidden
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{capabilityMonogram(name)}</span>
      )}
    </span>
  );
}
