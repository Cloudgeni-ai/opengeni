import type { OnePasswordConnectionSummary, VaultSummary } from "@opengeni/react";
import { KeyRoundIcon, LinkIcon, RotateCcwIcon, UnplugIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { MoreMenu } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";

import {
  connectionAttention,
  connectionAudience,
  connectionName,
  connectionOwnerLabel,
  itemsLabel,
  MODE_LABEL,
  PLAN_LABEL,
  vaultsOfConnection,
} from "./vault-model";
import { OnePasswordMark, SecretsLoadFailure, SyncStatus, VaultTile } from "./vault-parts";

/* ----------------------------------------------------------------------------
   1Password connections: the service accounts connected in this workspace.
   On the Secrets list they are one section of rows; each row opens the
   connection's page, where its vaults are linked, its token is replaced and
   it is disconnected. A connection carries no status while it is healthy.
   -------------------------------------------------------------------------- */

const CONNECTION_COLUMNS: RowListColumn[] = [
  { id: "vaults", label: "Vaults", width: 96, hideLabel: true, leadsWhenFolded: true },
  { id: "connected", label: "Connected", width: 112 },
];

function linkedLabel(count: number): string {
  return count === 0 ? "No vaults" : count === 1 ? "1 vault" : `${count} vaults`;
}

/** The row's status: null while the connection is healthy, so the row shows none. */
function attentionBadge(vaults: VaultSummary[]): ReactNode {
  const attention = connectionAttention(vaults);
  if (attention === "token_expired") {
    return (
      <StatusBadge
        status="token_expired"
        variant="dot"
        reason="1Password rejected the token. Paste a new one to keep its vaults in sync."
      />
    );
  }
  if (attention === "sync_failed") {
    return (
      <StatusBadge
        status="sync_failed"
        variant="dot"
        reason="A vault from this account didn't sync."
      />
    );
  }
  return null;
}

export function OnePasswordTile() {
  return <LogoTile icon={<OnePasswordMark />} label="1Password" />;
}

/** The "1Password" section of the Secrets list. Renders nothing without connections. */
export function OnePasswordConnectionsSection({
  connections,
  loading,
  vaults,
  onOpen,
}: {
  connections: OnePasswordConnectionSummary[] | null;
  loading: boolean;
  vaults: VaultSummary[];
  onOpen: (connection: OnePasswordConnectionSummary) => void;
}) {
  if (!connections?.length && !loading) return null;
  return (
    <Section
      title="1Password"
      description="Service accounts connected here. Values stay in 1Password; agents read them when they run."
    >
      <RowList
        label="1Password connections"
        columns={CONNECTION_COLUMNS}
        flush
        busy={loading && !connections}
      >
        {connections ? (
          connections.map((connection) => {
            const linked = vaultsOfConnection(vaults, connection.id);
            return (
              <ListRow
                key={connection.id}
                leading={<OnePasswordTile />}
                title={connectionName(connection)}
                titleAddon={<MetaChip>{connectionOwnerLabel(connection.ownership)}</MetaChip>}
                description={
                  linked.length === 0
                    ? connection.canManage
                      ? "No vaults linked yet. Open to choose vaults."
                      : "No vaults linked yet."
                    : linked.map((vault) => vault.name).join(", ")
                }
                status={attentionBadge(linked)}
                cells={{
                  vaults: linkedLabel(linked.length),
                  connected: <RelativeTime date={connection.createdAt} />,
                }}
                indicator="open"
                onOpen={() => onOpen(connection)}
              />
            );
          })
        ) : (
          <ListRowSkeleton count={1} />
        )}
      </RowList>
    </Section>
  );
}

export interface OnePasswordConnectionActions {
  back: () => void;
  chooseVaults: () => void;
  replaceToken: () => void;
  disconnect: () => void;
  openVault: (vault: VaultSummary) => void;
  retry: () => void;
}

/** One connection's page: who can use it, its linked vaults, and what to do. */
export function OnePasswordConnectionPage({
  connection,
  vaults,
  organizationName,
  creatorName,
  actions,
}: {
  connection: OnePasswordConnectionSummary;
  vaults: VaultSummary[];
  organizationName: string;
  creatorName: string | null;
  actions: OnePasswordConnectionActions;
}) {
  const linked = vaultsOfConnection(vaults, connection.id);
  const attention = connectionAttention(linked);
  const manage = connection.canManage;

  const chooseButton = (primary: boolean) => (
    <Button
      type="button"
      size="sm"
      variant={primary ? "default" : "outline"}
      onClick={actions.chooseVaults}
      className="pointer-coarse:h-11"
    >
      <LinkIcon aria-hidden="true" />
      Choose vaults
    </Button>
  );

  const headerActions = manage ? (
    <div className="flex items-center gap-2">
      {linked.length > 0 ? chooseButton(true) : null}
      <MoreMenu label={`More actions for ${connectionName(connection)}`}>
        <DropdownMenuItem onSelect={actions.replaceToken}>
          <KeyRoundIcon aria-hidden="true" />
          Replace token
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={actions.disconnect}>
          <UnplugIcon aria-hidden="true" />
          Disconnect
        </DropdownMenuItem>
      </MoreMenu>
    </div>
  ) : null;

  let notice: ReactNode = null;
  if (attention === "token_expired") {
    notice = (
      <Notice
        tone="waiting"
        title="Token expired"
        actionLayout="responsive"
        action={
          manage ? (
            <Button type="button" size="sm" onClick={actions.replaceToken}>
              Replace token
            </Button>
          ) : undefined
        }
      >
        {manage
          ? "1Password no longer accepts this service account token. Paste a new one; the linked vaults keep their links."
          : "1Password no longer accepts this service account token. Whoever connected it can paste a new one."}
      </Notice>
    );
  } else if (attention === "sync_failed") {
    notice = (
      <Notice
        tone="failed"
        title="A vault didn't sync"
        actionLayout="responsive"
        action={
          <Button type="button" variant="outline" size="sm" onClick={actions.retry}>
            <RotateCcwIcon aria-hidden="true" />
            Check again
          </Button>
        }
      >
        Agents use the last synced items. Open the vault to see what 1Password said.
      </Notice>
    );
  }

  return (
    <DetailPage
      back={{ label: "Secrets", onClick: actions.back }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<OnePasswordTile />}
        title={connectionName(connection)}
        chips={<MetaChip>{connectionOwnerLabel(connection.ownership)}</MetaChip>}
        meta={[
          <span key="plan">{PLAN_LABEL[connection.planTier]} plan</span>,
          <span key="connected">
            connected <RelativeTime date={connection.createdAt} inSentence />
            {creatorName ? ` by ${creatorName}` : ""}
          </span>,
          <span key="checked">
            token checked <RelativeTime date={connection.verifiedAt} inSentence />
          </span>,
        ]}
        actions={headerActions}
      />
      <div className="mt-6 flex min-w-0 flex-col gap-6">
        {notice}
        <p className="m-0 text-sm leading-5 text-fg-muted">
          {connectionAudience(connection.ownership, organizationName)} Values stay in 1Password;
          agents read them when they run.
        </p>
        <Section title="Linked vaults">
          {linked.length === 0 ? (
            <EmptyState
              icon={<LinkIcon />}
              title="No vaults linked yet"
              description={
                manage
                  ? "Choose which of this account's vaults agents can use, and whether they can save to them."
                  : "Someone who can manage this connection can link its vaults."
              }
              action={manage ? chooseButton(true) : undefined}
            />
          ) : (
            <RowList label="Linked vaults" flush>
              {linked.map((vault) => (
                <ListRow
                  key={vault.id}
                  leading={<VaultTile vault={vault} />}
                  title={vault.name}
                  description={`${MODE_LABEL[vault.mode]} · ${itemsLabel(vault.itemCount)}`}
                  status={vault.syncStatus === "ok" ? undefined : <SyncStatus vault={vault} />}
                  indicator="open"
                  onOpen={() => actions.openVault(vault)}
                />
              ))}
            </RowList>
          )}
        </Section>
      </div>
    </DetailPage>
  );
}

/** The connection isn't loaded yet, failed to load, or isn't here. */
export function OnePasswordConnectionMissing({
  loading,
  error,
  onBack,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <DetailPage back={{ label: "Secrets", onClick: onBack }} className={FLUSH_DETAIL_PAGE_CLASS}>
      {loading ? (
        <div role="status" aria-label="Loading 1Password connection">
          <RowList label="Linked vaults" busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </div>
      ) : error ? (
        <SecretsLoadFailure title="Couldn't load 1Password" error={error} onRetry={onRetry} />
      ) : (
        <>
          <h1 className="sr-only">This 1Password connection isn't here</h1>
          <EmptyState
            variant="page"
            icon={<UnplugIcon />}
            title={<span aria-hidden="true">This 1Password connection isn't here</span>}
            description="It may have been disconnected, or it belongs to someone else."
            action={
              <Button type="button" variant="outline" onClick={onBack}>
                Back to secrets
              </Button>
            }
          />
        </>
      )}
    </DetailPage>
  );
}
