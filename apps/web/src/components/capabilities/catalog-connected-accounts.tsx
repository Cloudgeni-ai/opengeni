import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import type { ConnectionMetadata } from "@opengeni/sdk";

import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { StatusBadge, type ProductStatus } from "@/components/ui/status-badge";
import type { CapabilityCatalogItem } from "@/types";
import { matchingConnectionAccounts } from "./session-connection-accounts";

const ACCOUNT_STATUS = {
  active: "connected",
  needs_reauth: "needs_reconnect",
  error: "failed",
  revoked: "not_connected",
} as const satisfies Record<ConnectionMetadata["status"], ProductStatus>;

export type CatalogConnectedAccountsProps = {
  item: CapabilityCatalogItem;
  connections: readonly ConnectionMetadata[] | null;
  loadFailed?: boolean;
  accessDenied?: boolean;
  onRetry?: () => void;
};

/** Displays accounts without choosing or changing any credential authority. */
export function CatalogConnectedAccounts({
  item,
  connections,
  loadFailed = false,
  accessDenied = false,
  onRetry,
}: CatalogConnectedAccountsProps) {
  if (
    item.kind !== "mcp" ||
    item.surfaceType === "codex_apps" ||
    item.connectionRef?.authoritySource === "host" ||
    (!item.connectionRef && item.authKind !== "oauth2" && item.authKind !== "api_key")
  )
    return null;

  // Disabling a capability retains its saved accounts. This fallback is only
  // for presentation; it never enables the connector or selects credentials.
  const ref =
    item.connectionRef ??
    (item.providerDomain
      ? {
          providerDomain: item.providerDomain,
          ...(item.authKind === "oauth2" || item.authKind === "api_key"
            ? { kind: item.authKind }
            : {}),
        }
      : null);
  const accounts = matchingConnectionAccounts(
    ref,
    connections ?? [],
    item.mcpUrl ?? item.endpointUrl,
  );
  const labels = accounts.map((account) =>
    connectionAccountIdentityLabel(
      account.metadata,
      `${item.name} account ${account.id.slice(0, 8)}`,
    ),
  );

  return (
    <DetailSection
      title="Connected accounts"
      description={
        !item.enabled && accounts.length > 0 && !accessDenied && !loadFailed
          ? "This connector is off. Your saved accounts remain connected."
          : undefined
      }
    >
      {accessDenied ? (
        <Notice tone="muted" live="polite">
          You don't have permission to view connected accounts in this workspace.
        </Notice>
      ) : loadFailed ? (
        <Notice
          tone="failed"
          title="Couldn't load connected accounts"
          live="polite"
          action={
            onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          Try again to see the current accounts and their status.
        </Notice>
      ) : connections === null ? (
        <p role="status" className="m-0 text-sm text-fg-muted">
          Loading connected accounts…
        </p>
      ) : !ref ? (
        <p className="m-0 text-sm text-fg-muted">Connect this connector to see its accounts.</p>
      ) : accounts.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">No accounts connected to this connector.</p>
      ) : (
        <ul
          aria-label={`${item.name} connected accounts`}
          className="m-0 list-none divide-y divide-border p-0"
        >
          {accounts.map((account, index) => {
            const label = labels[index]!;
            const duplicate = labels.filter((other) => other === label).length > 1;
            return (
              <li
                key={account.id}
                className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="m-0 break-words text-sm leading-5 font-medium text-fg">{label}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <MetaChip>{account.subjectId === null ? "This workspace" : "Only me"}</MetaChip>
                    {duplicate ? (
                      <span className="text-xs text-fg-muted">
                        Account {account.id.slice(0, 8)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <StatusBadge status={ACCOUNT_STATUS[account.status]} variant="dot" />
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>
  );
}
