import type { OnePasswordConnectionSummary, VaultSummary } from "@opengeni/react";
import { KeyRoundIcon, PlusIcon, RotateCcwIcon, ShieldOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section, SectionStack } from "@/components/ui/section";

import { OnePasswordConnectionsSection } from "./onepassword-connections";
import {
  OnePasswordMark,
  SecretsLoadFailure,
  SyncStatus,
  VaultChips,
  VaultTile,
} from "./vault-parts";
import {
  connectionName,
  groupVaults,
  isMissingKeyError,
  itemsLabel,
  VAULT_GROUP_TITLE,
} from "./vault-model";

/* ----------------------------------------------------------------------------
   Settings › Secrets (S1): the vaults this person can use, grouped by who
   owns them, then the 1Password service accounts connected here. The whole
   row opens the vault's (or the connection's) page.
   -------------------------------------------------------------------------- */

export const SECRETS_DESCRIPTION =
  "Logins, keys and files your agents can use without seeing them.";

const COLUMNS: RowListColumn[] = [
  { id: "items", label: "Items", width: 96, hideLabel: true, leadsWhenFolded: true },
  { id: "updated", label: "Updated", width: 112 },
];

export type SecretsListState = "loading" | "error" | "ready";

export function SecretsListPage({
  state,
  error,
  vaults,
  connections,
  connectionsLoading,
  canList,
  canCreate,
  canConnect,
  capabilityOff,
  agentSettingsHref,
  onRetry,
  onOpenVault,
  onOpenConnection,
  onNewVault,
  onConnectOnePassword,
  onOpenAgentSettings,
}: {
  state: SecretsListState;
  error: unknown;
  vaults: VaultSummary[];
  /** 1Password connections; null until loaded or when they can't be listed. */
  connections: OnePasswordConnectionSummary[] | null;
  connectionsLoading: boolean;
  canList: boolean;
  canCreate: boolean;
  canConnect: boolean;
  /** Agents in this workspace have the Secrets capability off. */
  capabilityOff: boolean;
  agentSettingsHref: string | null;
  onRetry: () => void;
  onOpenVault: (vault: VaultSummary) => void;
  onOpenConnection: (connection: OnePasswordConnectionSummary) => void;
  onNewVault: () => void;
  onConnectOnePassword: () => void;
  onOpenAgentSettings: () => void;
}) {
  const missingKey = state === "error" && isMissingKeyError(error);
  const hasConnections = (connections?.length ?? 0) > 0;
  const empty = state === "ready" && vaults.length === 0 && !hasConnections;
  const newVaultButton = (
    <Button type="button" onClick={onNewVault} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      New vault
    </Button>
  );
  const connectButton = (
    <Button
      type="button"
      variant="outline"
      onClick={onConnectOnePassword}
      className="pointer-coarse:h-11"
    >
      <span aria-hidden="true" className="inline-flex size-4">
        <OnePasswordMark />
      </span>
      Connect 1Password
    </Button>
  );
  const headerActions =
    canList && !empty && state === "ready" && (canCreate || canConnect) ? (
      <div className="flex flex-wrap items-center gap-2">
        {canConnect ? connectButton : null}
        {canCreate ? newVaultButton : null}
      </div>
    ) : null;
  const accountOf = new Map(
    (connections ?? []).map((connection) => [connection.id, connectionName(connection)]),
  );
  const describe = (vault: VaultSummary): string | undefined => {
    if (vault.description) return vault.description;
    if (vault.source !== "onepassword") return undefined;
    const account = vault.providerConnectionId ? accountOf.get(vault.providerConnectionId) : null;
    return account ? `From 1Password · ${account}` : "From 1Password";
  };

  const renderRow = (vault: VaultSummary) => (
    <ListRow
      key={vault.id}
      leading={<VaultTile vault={vault} />}
      title={vault.name}
      titleAddon={<VaultChips vault={vault} />}
      description={describe(vault)}
      status={vault.syncStatus === "ok" ? undefined : <SyncStatus vault={vault} />}
      cells={{
        items: itemsLabel(vault.itemCount),
        updated: <RelativeTime date={vault.updatedAt} />,
      }}
      indicator="open"
      onOpen={() => onOpenVault(vault)}
    />
  );

  let body;
  if (!canList) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="You can't see secrets here"
        description="Ask a workspace admin for access to secrets."
      />
    );
  } else if (missingKey) {
    body = (
      <EmptyState
        variant="page"
        tone="danger"
        icon={<ShieldOffIcon />}
        title="Secrets aren't set up on this server"
        description="The server's encryption key is missing, so secrets can't be stored or read. Ask whoever runs this Opengeni server to set it."
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCcwIcon aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  } else if (state === "loading") {
    body = (
      <RowList label="Vaults" columns={COLUMNS} flush busy>
        <ListRowSkeleton count={4} />
      </RowList>
    );
  } else if (state === "error") {
    body = <SecretsLoadFailure title="Couldn't load secrets" error={error} onRetry={onRetry} />;
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="No vaults yet"
        description={
          canCreate
            ? "Save logins and keys once, and your agents can sign in and call APIs for you."
            : "Someone who can manage secrets can add a vault here."
        }
        action={
          canCreate ? (
            <div className="flex flex-col items-center gap-3">
              {newVaultButton}
              {canConnect ? (
                <EmptyStateLink onClick={onConnectOnePassword}>Or connect 1Password</EmptyStateLink>
              ) : null}
            </div>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <SectionStack>
        {groupVaults(vaults).map((group) => (
          <Section
            key={group.id}
            title={
              <>
                {VAULT_GROUP_TITLE[group.id]}
                <span className="ml-2 font-normal text-fg-subtle tabular-nums">
                  {group.vaults.length}
                </span>
              </>
            }
          >
            <RowList label={`Vaults: ${VAULT_GROUP_TITLE[group.id]}`} columns={COLUMNS} flush>
              {group.vaults.map(renderRow)}
            </RowList>
          </Section>
        ))}
        <OnePasswordConnectionsSection
          connections={connections}
          loading={connectionsLoading}
          vaults={vaults}
          onOpen={onOpenConnection}
        />
      </SectionStack>
    );
  }

  return (
    <div className="min-w-0">
      <PageHeader title="Secrets" description={SECRETS_DESCRIPTION} actions={headerActions} />
      {capabilityOff && canList && !missingKey ? (
        <Notice
          tone="muted"
          className="mt-6"
          actionLayout="responsive"
          action={
            agentSettingsHref ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenAgentSettings}>
                Agent settings
              </Button>
            ) : undefined
          }
        >
          {agentSettingsHref
            ? "Agents in this workspace can't use secrets. Turn on Secrets in agent settings."
            : "Agents in this workspace can't use secrets. A workspace admin can turn them on."}
        </Notice>
      ) : null}
      <div className="min-w-0 pt-6">{body}</div>
    </div>
  );
}
