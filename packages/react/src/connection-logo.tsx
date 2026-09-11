import { useState } from "react";
/** Brand identifier; failed/missing assets use a stable text fallback. */
export function ConnectionLogo({
  src,
  name,
  size = 40,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className="og-connection-logo" aria-hidden="true" style={{ width: size, height: size }}>
      {src && src !== failedSrc ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
      ) : (
        <span>
          {name
            .split(/\s+/)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </span>
      )}
    </span>
  );
}
