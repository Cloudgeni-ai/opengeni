import { useCallback, useState, type ReactNode } from "react";

import { cachedLogoFit, measureLogoFit, type LogoFit } from "./logo-fit";

/**
 * Brand identifier; failed/missing assets use the supplied fallback or stable
 * initials. Each image is measured once (see ./logo-fit) and exposed as
 * `data-fit`, so square app icons fill the mark while transparent marks keep
 * the host-themable padded plate.
 */
export function ConnectionLogo({
  src,
  name,
  size = 40,
  fallback,
  loading = false,
}: {
  src: string | null;
  name: string;
  size?: number;
  fallback?: ReactNode;
  loading?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{ src: string; fit: LogoFit } | null>(null);
  const showImage = Boolean(src && src !== failedSrc);
  const fit = src ? (measured?.src === src ? measured.fit : cachedLogoFit(src)) : undefined;
  // An image already decoded before hydration never fires onLoad again.
  const measureIfLoaded = useCallback(
    (image: HTMLImageElement | null) => {
      if (!src || !image || !image.complete || image.naturalWidth === 0) return;
      setMeasured((current) =>
        current?.src === src ? current : { src, fit: measureLogoFit(src, image) },
      );
    },
    [src],
  );
  return (
    <span
      className="og-connection-logo"
      aria-hidden="true"
      data-fit={showImage ? (fit ?? "pending") : undefined}
      style={{ width: size, height: size }}
    >
      {src && showImage ? (
        <img
          key={src}
          ref={measureIfLoaded}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={(event) => measureIfLoaded(event.currentTarget)}
          onError={() => setFailedSrc(src)}
        />
      ) : loading ? (
        <span className="og-connection-skeleton-mark" />
      ) : (
        (fallback ?? (
          <span>
            {name
              .split(/\s+/)
              .map((part) => part[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
        ))
      )}
    </span>
  );
}
