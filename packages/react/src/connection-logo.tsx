import { useState, type ReactNode } from "react";
/** Brand identifier; failed/missing assets use the supplied fallback or stable initials. */
export function ConnectionLogo({
  src,
  name,
  size = 40,
  fallback,
}: {
  src: string | null;
  name: string;
  size?: number;
  fallback?: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className="og-connection-logo" aria-hidden="true" style={{ width: size, height: size }}>
      {src && src !== failedSrc ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
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
