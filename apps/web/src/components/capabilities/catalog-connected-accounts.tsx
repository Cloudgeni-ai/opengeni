import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

/** Per-account management. The API re-checks every action; these rules only
 * keep the page from offering what the server would refuse. */
export type CatalogConnectedAccountsManagement = {
  /** The viewer's subject: only their own personal accounts are theirs to manage. */
  viewerSubjectId: string | null;
  /** The viewer holds connections:write in this workspace. */
  canWrite: boolean;
  busy?: boolean;
  /** Re-run sign-in for exactly this account (OAuth accounts only). */
  onReconnect?: (account: ConnectionMetadata) => void;
  /** Disconnect exactly this account. Resolve false to keep the dialog open. */
  onRemove: (account: ConnectionMetadata) => Promise<boolean | void>;
  /** Sign in a further account; omit when the connector holds a single account. */
  onAdd?: () => void;
};

export type CatalogConnectedAccountsProps = {
  item: CapabilityCatalogItem;
  connections: readonly ConnectionMetadata[] | null;
  loadFailed?: boolean;
  accessDenied?: boolean;
  onRetry?: () => void;
  management?: CatalogConnectedAccountsManagement;
};

/** Whether the viewer may disconnect this account: their own personal account,
 * or a shared workspace account when they can manage workspace connections.
 * Another person's personal account is never theirs to remove. */
export function canRemoveConnectedAccount(
  account: Pick<ConnectionMetadata, "subjectId">,
  management: Pick<CatalogConnectedAccountsManagement, "viewerSubjectId" | "canWrite"> | undefined,
): boolean {
  if (!management?.canWrite) return false;
  return (
    account.subjectId === null ||
    (management.viewerSubjectId !== null && account.subjectId === management.viewerSubjectId)
  );
}

/** Sign-in never produced a usable account identity. */
export function connectedAccountSignInUnfinished(
  account: Pick<ConnectionMetadata, "status" | "metadata">,
): boolean {
  return account.status !== "active" && connectionAccountIdentityLabel(account.metadata, "") === "";
}

/** Displays accounts and, when management is supplied, per-account actions.
 * It never chooses which account a session uses. */
export function CatalogConnectedAccounts({
  item,
  connections,
  loadFailed = false,
  accessDenied = false,
  onRetry,
  management,
}: CatalogConnectedAccountsProps) {
  const [removeTarget, setRemoveTarget] = useState<{
    account: ConnectionMetadata;
    label: string;
  } | null>(null);
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
  // A removed (revoked) account is gone; it is not listed as a dead row.
  const accounts = matchingConnectionAccounts(
    ref,
    connections ?? [],
    item.mcpUrl ?? item.endpointUrl,
  ).filter((account) => account.status !== "revoked");
  const labels = accounts.map((account) => connectionSignInLabel(account, item.name));
  const busy = management?.busy === true;
  const addAction =
    management?.onAdd && management.canWrite && !accessDenied && !loadFailed && connections ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-9"
        disabled={busy}
        onClick={management.onAdd}
      >
        <PlusIcon aria-hidden="true" />
        Add account
      </Button>
    ) : null;

  return (
    <DetailSection
      title="Connected accounts"
      description={
        !item.enabled && accounts.length > 0 && !accessDenied && !loadFailed
          ? "This connector is off. Your saved accounts remain connected."
          : undefined
      }
      action={addAction ?? undefined}
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
            const unfinished = connectedAccountSignInUnfinished(account);
            const reconnect =
              management?.onReconnect &&
              account.kind === "oauth2" &&
              account.status !== "active" &&
              canRemoveConnectedAccount(account, management)
                ? management.onReconnect
                : null;
            const removable = canRemoveConnectedAccount(account, management);
            return (
              <li
                key={account.id}
                className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="m-0 break-words text-sm leading-5 font-medium text-fg">{label}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <MetaChip>{account.subjectId === null ? "This workspace" : "Only me"}</MetaChip>
                    {duplicate || unfinished ? (
                      <span className="text-xs text-fg-muted">
                        Account {account.id.slice(0, 8)}
                      </span>
                    ) : null}
                  </div>
                </div>
                {unfinished ? (
                  <StatusBadge status="needs_reconnect" variant="dot">
                    Sign-in not finished
                  </StatusBadge>
                ) : (
                  <StatusBadge status={ACCOUNT_STATUS[account.status]} variant="dot" />
                )}
                {reconnect || removable ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {reconnect ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-9"
                        disabled={busy}
                        aria-label={`Reconnect ${label}`}
                        onClick={() => reconnect(account)}
                      >
                        <RefreshCwIcon aria-hidden="true" />
                        Reconnect
                      </Button>
                    ) : null}
                    {removable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-9 text-fg-muted hover:text-status-failed"
                        disabled={busy}
                        aria-label={`Remove ${label}`}
                        onClick={() => setRemoveTarget({ account, label })}
                      >
                        <TrashIcon aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {management ? (
        <ConfirmDialog
          open={removeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRemoveTarget(null);
          }}
          title={removeTarget ? `Remove ${removeTarget.label}?` : "Remove account?"}
          description={
            removeTarget?.account.subjectId === null
              ? `${item.name} stops using this account for everyone in this workspace. You can add it again later.`
              : `${item.name} stops using this account. You can add it again later.`
          }
          confirmLabel="Remove account"
          pendingLabel="Removing…"
          onConfirm={async () =>
            removeTarget ? await management.onRemove(removeTarget.account) : undefined
          }
        />
      ) : null}
    </DetailSection>
  );
}

function connectionSignInLabel(account: ConnectionMetadata, itemName: string): string {
  if (connectedAccountSignInUnfinished(account)) return `${itemName} account`;
  return connectionAccountIdentityLabel(
    account.metadata,
    `${itemName} account ${account.id.slice(0, 8)}`,
  );
}
