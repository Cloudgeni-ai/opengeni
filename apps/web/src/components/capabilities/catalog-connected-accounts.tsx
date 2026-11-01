import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { StatusBadge, type ProductStatus } from "@opengeni/react/ui/status-badge";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { matchingConnectionAccounts } from "@opengeni/react/app/components/capabilities/session-connection-accounts";
import {
  ADD_ACCOUNT_LIMIT_COPY,
  addAccountLimit,
  connectionAccountRows,
  type AccountOriginWorkspace,
} from "@opengeni/react/app/components/capabilities/connection-account-rows";

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
  /** Whether the viewer may remove their own accounts in that workspace
   * (connections:personal there). Your own account is removed in the
   * workspace it was added in. Omit to fall back to `canWrite`. */
  canRemoveOwnIn?: (workspaceId: string) => boolean;
  /** Whether the viewer may sign their own account in again in that workspace
   * (connections:write there: signing in needs it). Omit to fall back to
   * `canWrite`. */
  canReconnectOwnIn?: (workspaceId: string) => boolean;
  busy?: boolean;
  /** Re-run sign-in for exactly this account (OAuth accounts only). */
  onReconnect?: (account: ConnectionMetadata) => void;
  /** Disconnect exactly this account. Resolve false to keep the dialog open. */
  onRemove: (account: ConnectionMetadata) => Promise<boolean | void>;
  /** Sign in a further account; omit when the connector holds a single account. */
  onAdd?: () => void;
  /** Who a further account would belong to, so Add follows the account rule. */
  addOwnership?: "personal" | "workspace";
};

export type CatalogConnectedAccountsProps = {
  item: CapabilityCatalogItem;
  connections: readonly ConnectionMetadata[] | null;
  loadFailed?: boolean;
  accessDenied?: boolean;
  onRetry?: () => void;
  management?: CatalogConnectedAccountsManagement;
  /** The workspace being viewed. Accounts added in another workspace name
   * where they came from. */
  workspaceId?: string | undefined;
  workspaces?: readonly AccountOriginWorkspace[] | undefined;
};

/** Whether the viewer may disconnect this account: their own personal
 * account, wherever it was added, when they may remove their own accounts in
 * that workspace; or a shared account of this workspace when they can manage
 * workspace connections. Another person's personal account is never theirs,
 * and a shared account from another workspace is managed by that workspace's
 * admins. */
export function canRemoveConnectedAccount(
  account: Pick<ConnectionMetadata, "subjectId" | "workspaceId">,
  management:
    | Pick<CatalogConnectedAccountsManagement, "viewerSubjectId" | "canWrite" | "canRemoveOwnIn">
    | undefined,
  workspaceId?: string | undefined,
): boolean {
  return canActOnConnectedAccount(account, management, management?.canRemoveOwnIn, workspaceId);
}

/** Whether the viewer may sign this account in again: as for removal, but
 * signing in needs connections:write in the account's workspace. */
export function canReconnectConnectedAccount(
  account: Pick<ConnectionMetadata, "subjectId" | "workspaceId">,
  management:
    | Pick<CatalogConnectedAccountsManagement, "viewerSubjectId" | "canWrite" | "canReconnectOwnIn">
    | undefined,
  workspaceId?: string | undefined,
): boolean {
  return canActOnConnectedAccount(account, management, management?.canReconnectOwnIn, workspaceId);
}

function canActOnConnectedAccount(
  account: Pick<ConnectionMetadata, "subjectId" | "workspaceId">,
  management: Pick<CatalogConnectedAccountsManagement, "viewerSubjectId" | "canWrite"> | undefined,
  ownIn: ((workspaceId: string) => boolean) | undefined,
  workspaceId: string | undefined,
): boolean {
  if (!management) return false;
  if (management.viewerSubjectId !== null && account.subjectId === management.viewerSubjectId)
    return ownIn ? ownIn(account.workspaceId) : management.canWrite;
  if (account.subjectId !== null || !management.canWrite) return false;
  return !workspaceId || account.workspaceId === workspaceId;
}

/** Sign-in never produced a usable account identity. */
export function connectedAccountSignInUnfinished(
  account: Pick<ConnectionMetadata, "status" | "metadata">,
): boolean {
  // Successful MCP callbacks persist verification and OAuth server metadata even
  // when the provider exposes no readable account name. Missing display text is
  // not evidence that authorization never completed.
  const completed =
    account.metadata.mcpToolsVerification !== undefined ||
    ["tokenEndpoint", "clientId", "authorizationServerIssuer", "slackUserId", "slackTeamId"].some(
      (key) => typeof account.metadata[key] === "string" && account.metadata[key] !== "",
    );
  return (
    account.status !== "active" &&
    !completed &&
    connectionAccountIdentityLabel(account.metadata, "") === ""
  );
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
  workspaceId,
  workspaces,
}: CatalogConnectedAccountsProps) {
  const [removeTarget, setRemoveTarget] = useState<{
    account: ConnectionMetadata;
    label: string;
    origin: string | null;
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
  const rows = connectionAccountRows(accounts, {
    fallbackName: item.name,
    workspaceId,
    workspaces,
    labelOf: (account) => connectionSignInLabel(account, item.name),
  });
  const busy = management?.busy === true;
  // A service that can't tell accounts apart allows one per person; an account
  // connected before it could is signed in again once. Say so instead of Add.
  const limit =
    management?.onAdd && management.addOwnership
      ? addAccountLimit(accounts, {
          viewerSubjectId: management.viewerSubjectId,
          ownership: management.addOwnership,
        })
      : null;
  const addAction =
    management?.onAdd &&
    management.canWrite &&
    !limit &&
    !accessDenied &&
    !loadFailed &&
    connections ? (
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
        <>
          {limit && management?.canWrite ? (
            <p className="m-0 mb-3 text-sm text-fg-muted">{ADD_ACCOUNT_LIMIT_COPY[limit]}</p>
          ) : null}
          <ul
            aria-label={`${item.name} connected accounts`}
            className="m-0 list-none divide-y divide-border p-0"
          >
            {accounts.map((account) => {
              const row = rows.get(account.id)!;
              const label = row.label;
              const unfinished = connectedAccountSignInUnfinished(account);
              // Re-signing in refreshes the same row wherever it was added. An
              // account from before its service could be identified offers it too.
              const reconnect =
                management?.onReconnect &&
                account.kind === "oauth2" &&
                (account.status !== "active" ||
                  (limit === "reconnect" && account.accountIdentity === "reconnect")) &&
                canReconnectConnectedAccount(account, management, workspaceId)
                  ? management.onReconnect
                  : null;
              const removable = canRemoveConnectedAccount(account, management, workspaceId);
              return (
                <li
                  key={account.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="m-0 break-words text-sm leading-5 font-medium text-fg">{label}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <MetaChip>{row.scope}</MetaChip>
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
                          onClick={() => setRemoveTarget({ account, label, origin: row.origin })}
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
        </>
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
              : removeTarget?.origin
                ? `${item.name} stops using this account here and in ${removeTarget.origin}, where it was added. You can add it again later.`
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
  return connectionAccountIdentityLabel(account.metadata, `${itemName} account`);
}
