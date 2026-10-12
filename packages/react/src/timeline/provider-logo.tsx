import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { ToolDisplayMetadata } from "@opengeni/sdk";

/*
 * Connector logos in tool rows. The host resolves a provider domain to a logo
 * it serves itself (the same `resolveProviderLogo` MessageTimeline already
 * takes). Rows from a connector draw that logo in place of their generic icon;
 * without one they keep it.
 */

export type ResolveProviderLogo = (providerDomain: string) => string | null | undefined;

const ProviderLogoContext = createContext<ResolveProviderLogo | undefined>(undefined);

export const ProviderLogoProvider = ProviderLogoContext.Provider;

/** The logo URL for a tool's connector, when the host has one. */
export function useToolConnectorLogo(display: ToolDisplayMetadata | undefined): string | null {
  const resolve = useContext(ProviderLogoContext);
  if (!resolve || !display?.providerDomain) return null;
  return resolve(display.providerDomain) ?? null;
}

/**
 * A connector's logo at icon size, or `fallback` when there is none or it
 * fails to load, so a row never shows a broken image.
 */
export function ConnectorLogoIcon({
  src,
  fallback,
  className,
}: {
  src: string | null;
  fallback: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      data-og-connector-logo=""
      className={className ?? "size-3.5 shrink-0 rounded-[3px] object-contain"}
      onError={() => setFailed(true)}
    />
  );
}
