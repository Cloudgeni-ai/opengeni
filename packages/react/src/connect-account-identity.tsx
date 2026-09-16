import type { ConnectAccount } from "@opengeni/connect";
import type { CapabilityCatalogItem, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { ConnectionLogo } from "./connection-logo";
import { capabilityLogoFallback } from "./capability-logo-fallback";

/** Presentation only: exact credential identity, never a provider-domain match. */
export function ConnectAccountIdentity({
  account,
  client,
  capabilities,
}: {
  account: ConnectAccount;
  client?: OpenGeniClient | undefined;
  capabilities: CapabilityCatalogItem[];
}) {
  const matches = capabilities.filter((item) => item.connectionRef?.connectionId === account.id);
  const item = matches.length === 1 ? matches[0] : undefined;
  const name = item?.name ?? account.label;
  const path = item?.logoAssetPath;
  const [image, setImage] = useState<{ client: OpenGeniClient; path: string; url: string } | null>(
    null,
  );
  const [settled, setSettled] = useState<{ client: OpenGeniClient; path: string } | null>(null);
  useEffect(() => {
    if (!client || !path?.startsWith("catalog-assets/")) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    void client
      .downloadCatalogAsset(path, { signal: abort.signal })
      .then((blob) => {
        if (abort.signal.aborted || !blob.type.startsWith("image/") || blob.size > 2_000_000)
          return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ client, path, url: objectUrl });
      })
      .catch(() => {
        /* A missing passive mark does not invalidate the account. */
      })
      .finally(() => {
        if (!abort.signal.aborted) setSettled({ client, path });
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, path]);
  return (
    <>
      <ConnectionLogo
        loading={Boolean(
          client &&
          path?.startsWith("catalog-assets/") &&
          (settled?.client !== client || settled?.path !== path),
        )}
        src={
          image?.client === client && image?.path === path
            ? (image?.url ?? null)
            : item && (!path || (settled?.client === client && settled?.path === path))
              ? capabilityLogoFallback(item)
              : null
        }
        name={name}
      />
      <div>
        <strong>{name}</strong>
        <small>
          {account.ownership === "personal" ? "Only you" : "Workspace connection"}
          {item ? ` · ${account.label}` : ""}
        </small>
      </div>
    </>
  );
}
