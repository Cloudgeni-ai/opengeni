import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { ConnectionLogo } from "./connection-logo";
import { capabilityLogoFallback } from "./capability-logo-fallback";

/** The same passive logo loading path for discovery and connected accounts. */
export function ConnectionServiceLogo({
  client,
  item,
  name,
  fallback = null,
}: {
  client?: OpenGeniClient | undefined;
  item?: CapabilityCatalogItem | undefined;
  name: string;
  fallback?: string | null;
}) {
  const path = item?.logoAssetPath;
  const [image, setImage] = useState<{
    client: OpenGeniClient;
    path: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    if (!client || !path?.startsWith("catalog-assets/")) return;
    const abort = new AbortController();
    let url: string | null = null;
    void client
      .downloadCatalogAsset(path, { signal: abort.signal })
      .then((blob) => {
        if (!abort.signal.aborted && blob.type.startsWith("image/") && blob.size <= 2_000_000)
          url = URL.createObjectURL(blob);
      })
      .catch(() => {})
      .finally(() => {
        if (!abort.signal.aborted) setImage({ client, path, url });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, path]);
  const current = image && image.client === client && image.path === path ? image : null;
  const loading = Boolean(client && path?.startsWith("catalog-assets/") && !current);
  return (
    <ConnectionLogo
      name={name}
      loading={loading}
      src={
        current?.url ??
        (loading ? null : ((item ? capabilityLogoFallback(item) : null) ?? fallback))
      }
    />
  );
}
