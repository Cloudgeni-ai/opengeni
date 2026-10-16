import { vaultErrorCode, type VaultSummary } from "@opengeni/react";
import { KeyRoundIcon, LinkIcon, RotateCcwIcon, UnplugIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { MoreMenu } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";

import { ProviderTile } from "./provider-marks";
import {
  connectionAudience,
  connectionOwnerLabel,
  itemsLabel,
  MODE_LABEL,
  PLAN_LABEL,
  vaultErrorText,
  vaultsOfConnection,
} from "./vault-model";
import { SecretsLoadFailure, SyncStatus, VaultTile } from "./vault-parts";
import {
  connectionAttention,
  connectionName,
  isSelfHosted,
  needsAttention,
  PROVIDERS,
  vaultHealth,
  type ConnectionAttention,
  type VaultConnection,
  type VaultProviderId,
} from "./vault-providers";

/* ----------------------------------------------------------------------------
   Connections: the password manager accounts connected in this workspace
   (1Password service accounts, Proton Pass tokens, Keeper applications,
   Bitwarden bridges and your own vault service). On the Secrets list they are
   one flat section of rows, the tile marking the provider; each row opens the
   connection's page, where its vaults are linked, its access is renewed and
   it is disconnected. A connection carries no status while it is healthy.
   -------------------------------------------------------------------------- */

const CONNECTION_COLUMNS: RowListColumn[] = [
  { id: "vaults", label: "Vaults", width: 96, hideLabel: true, leadsWhenFolded: true },
  { id: "connected", label: "Connected", width: 112 },
];

function linkedLabel(count: number): string {
  return count === 0 ? "No vaults" : count === 1 ? "1 vault" : `${count} vaults`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where a connection reads from, for "can't reach …" sentences. */
function reachTarget(provider: VaultProviderId): string {
  return provider === "bitwarden"
    ? "your Bitwarden bridge"
    : provider === "external"
      ? "your vault service"
      : PROVIDERS[provider].name;
}

/** The row's status: null while the connection is healthy, so the row shows none. */
function attentionBadge(connection: VaultConnection, attention: ConnectionAttention | null) {
  const provider = connection.provider;
  const info = PROVIDERS[provider];
  switch (attention) {
    case null:
      return null;
    case "pending":
      return (
        <StatusBadge
          status="not_finished"
          variant="dot"
          reason="Its access is saved but not checked yet. Open it to finish connecting."
        />
      );
    case "unavailable_here":
      return (
        <StatusBadge
          status="unavailable"
          variant="dot"
          reason={`This server can't run ${info.name} connections right now.`}
        />
      );
    case "auth_expired":
      return (
        <StatusBadge
          status={
            provider === "onepassword" || provider === "protonpass"
              ? "token_expired"
              : "needs_reconnect"
          }
          variant="dot"
          reason={
            provider === "onepassword"
              ? "1Password rejected the token. Paste a new one to keep its vaults in sync."
              : `${info.name} no longer accepts ${info.credential}. ${info.renewLabel} to keep its vaults in sync.`
          }
        />
      );
    case "locked":
      return (
        <StatusBadge
          status="locked"
          variant="dot"
          reason={
            provider === "bitwarden"
              ? "Bitwarden is locked on the bridge. Unlock it there."
              : `${info.name} is locked.`
          }
        />
      );
    case "unavailable":
      return (
        <StatusBadge
          status={isSelfHosted(provider) ? "offline" : "unavailable"}
          variant="dot"
          reason={`Opengeni can't reach ${reachTarget(provider)}.`}
        />
      );
    case "sync_failed":
      return (
        <StatusBadge
          status="sync_failed"
          variant="dot"
          reason="A vault from this account didn't sync."
        />
      );
    case "incomplete":
      return (
        <StatusBadge
          status="incomplete"
          variant="dot"
          reason={`Not every item in ${info.home} could be listed.`}
        />
      );
    case "rate_limited":
      return (
        <StatusBadge
          status="rate_limited"
          variant="dot"
          reason={`${capitalized(info.home)} is limiting requests. Syncing resumes on its own.`}
        />
      );
  }
}

/**
 * The "Connections" section of the Secrets list: every password manager
 * connected here, one row each. Renders nothing without connections.
 */
export function ConnectionsSection({
  connections,
  loading,
  vaults,
  onOpen,
}: {
  connections: VaultConnection[] | null;
  loading: boolean;
  vaults: VaultSummary[];
  onOpen: (connection: VaultConnection) => void;
}) {
  if (!connections?.length && !loading) return null;
  return (
    <Section
      title="Connections"
      description="Password managers linked here. Values stay where they are; agents read them when they run."
    >
      <RowList
        label="Connections"
        columns={CONNECTION_COLUMNS}
        flush
        busy={loading && !connections}
      >
        {connections ? (
          connections.map((connection) => {
            const linked = vaultsOfConnection(vaults, connection.id);
            const noun = PROVIDERS[connection.provider].vaultNoun.many;
            return (
              <ListRow
                key={connection.id}
                leading={<ProviderTile provider={connection.provider} />}
                title={connectionName(connection)}
                titleAddon={<MetaChip>{connectionOwnerLabel(connection.ownership)}</MetaChip>}
                description={
                  linked.length === 0
                    ? connection.canManage
                      ? `No ${noun} linked yet. Open to choose ${noun}.`
                      : `No ${noun} linked yet.`
                    : linked.map((vault) => vault.name).join(", ")
                }
                status={attentionBadge(connection, connectionAttention(linked, connection))}
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

export interface ConnectionPageActions {
  back: () => void;
  chooseVaults: () => void;
  /** Replace token, Reconnect, Update bridge: the provider's renewal page. */
  renew: () => void;
  /** Checks a pending connection again with its saved access (never a spent setup token). */
  finish: () => Promise<void>;
  disconnect: () => void;
  openVault: (vault: VaultSummary) => void;
  retry: () => void;
}

const AUTH_FAILURES = new Set(["provider_auth_invalid", "provider_auth_expired"]);

/**
 * A connection whose access was saved but not yet checked: one action,
 * Finish connecting, which retries with what's saved. When the saved access
 * itself is refused, the action becomes the provider's renewal instead.
 */
export function FinishConnectingNotice({
  provider,
  canManage,
  onFinish,
  onRenew,
}: {
  provider: VaultProviderId;
  canManage: boolean;
  onFinish: () => Promise<void>;
  onRenew?: (() => void) | undefined;
}) {
  const info = PROVIDERS[provider];
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ refused: boolean; text: string } | null>(null);
  const saved =
    provider === "keeper"
      ? "Keeper accepted the one-time token and Opengeni saved this device, but couldn't finish checking its shared folders. You don't need a new token."
      : `${info.name} accepted the access, but Opengeni couldn't finish checking it.`;
  const refused = failure?.refused ?? false;
  const action = !canManage ? undefined : refused && onRenew ? (
    <Button type="button" variant="outline" size="sm" onClick={onRenew}>
      {info.renewLabel}
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        setPending(true);
        setFailure(null);
        void onFinish()
          .catch((caught: unknown) => {
            const error = (caught as { cause?: unknown } | null)?.cause ?? caught;
            const code = vaultErrorCode(error);
            setFailure({
              refused: Boolean(code && AUTH_FAILURES.has(code)),
              text: vaultErrorText(error, `Couldn't finish connecting ${info.name}.`, info.home),
            });
          })
          .finally(() => setPending(false));
      }}
    >
      {pending ? "Checking…" : "Finish connecting"}
    </Button>
  );
  return (
    <Notice tone="waiting" title="Not finished" actionLayout="responsive" action={action}>
      {refused
        ? `${info.name} no longer accepts the saved access. ${info.renewLabel} to connect it again.`
        : `${saved} Agents can't use it until it's checked.`}{" "}
      {canManage ? null : "Someone who manages this connection can finish it."}
      {failure && !refused ? (
        <span className="mt-1 block text-danger" role="alert">
          {failure.text}
        </span>
      ) : null}
    </Notice>
  );
}

/** How someone who manages the connection renews its access, as one sentence. */
function renewHow(provider: VaultProviderId): string {
  switch (provider) {
    case "onepassword":
    case "protonpass":
      return "Paste a new one; the linked vaults keep their links.";
    case "keeper":
      return "Reconnect with a one-time access token from a new device; the linked folders keep their links.";
    case "bitwarden":
      return "Update the bridge's address or signing secret; the linked vaults keep their links.";
    case "external":
      return "Update the service's address or signing secret; the linked vaults keep their links.";
  }
}

/** Where values stay, as the end of the page's audience sentence. */
function valuesStay(provider: VaultProviderId): string {
  return provider === "bitwarden"
    ? "Values stay in Bitwarden on your bridge; agents read them when they run."
    : `Values stay in ${PROVIDERS[provider].home}; agents read them when they run.`;
}

/** One connection's page: who can use it, its linked vaults, and what to do. */
export function ConnectionPage({
  connection,
  vaults,
  organizationName,
  creatorName,
  actions,
}: {
  connection: VaultConnection;
  vaults: VaultSummary[];
  organizationName: string;
  creatorName: string | null;
  actions: ConnectionPageActions;
}) {
  const provider = connection.provider;
  const info = PROVIDERS[provider];
  const linked = vaultsOfConnection(vaults, connection.id);
  const attention = connectionAttention(linked, connection);
  const manage = connection.canManage;
  // Choosing lists the provider's vaults, which needs working access.
  const canChoose =
    manage &&
    attention !== "unavailable_here" &&
    attention !== "pending" &&
    attention !== "auth_expired" &&
    attention !== "locked" &&
    attention !== "unavailable";
  const name = connectionName(connection);

  const chooseButton = (primary: boolean) => (
    <Button
      type="button"
      size="sm"
      variant={primary ? "default" : "outline"}
      onClick={actions.chooseVaults}
      className="pointer-coarse:h-11"
    >
      <LinkIcon aria-hidden="true" />
      Choose {info.vaultNoun.many}
    </Button>
  );

  const headerActions = manage ? (
    <div className="flex items-center gap-2">
      {linked.length > 0 && canChoose ? chooseButton(true) : null}
      <MoreMenu label={`More actions for ${name}`}>
        <DropdownMenuItem onSelect={actions.renew}>
          <KeyRoundIcon aria-hidden="true" />
          {info.renewLabel}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={actions.disconnect}>
          <UnplugIcon aria-hidden="true" />
          Disconnect
        </DropdownMenuItem>
      </MoreMenu>
    </div>
  ) : null;

  const checkAgain = (
    <Button type="button" variant="outline" size="sm" onClick={actions.retry}>
      <RotateCcwIcon aria-hidden="true" />
      Check again
    </Button>
  );

  let notice: ReactNode = null;
  switch (attention) {
    case "pending":
      notice = (
        <FinishConnectingNotice
          provider={provider}
          canManage={manage}
          onFinish={actions.finish}
          onRenew={actions.renew}
        />
      );
      break;
    case "unavailable_here":
      notice = (
        <Notice tone="muted" title="Not available on this server">
          This server can't run {info.name} connections right now, so its vaults can't sync. Ask
          whoever runs this Opengeni server.
        </Notice>
      );
      break;
    case "auth_expired": {
      const refused =
        provider === "onepassword"
          ? "1Password no longer accepts this service account token."
          : `${info.name} no longer accepts ${info.credential}.`;
      notice = (
        <Notice
          tone="waiting"
          title={
            provider === "onepassword" || provider === "protonpass"
              ? "Token expired"
              : "Needs reconnect"
          }
          actionLayout="responsive"
          action={
            manage ? (
              <Button type="button" size="sm" onClick={actions.renew}>
                {info.renewLabel}
              </Button>
            ) : undefined
          }
        >
          {refused}{" "}
          {manage
            ? renewHow(provider)
            : provider === "onepassword" || provider === "protonpass"
              ? "Whoever connected it can paste a new one."
              : "Whoever connected it can reconnect it."}
        </Notice>
      );
      break;
    }
    case "locked":
      notice = (
        <Notice tone="waiting" title="Locked" actionLayout="responsive" action={checkAgain}>
          {provider === "bitwarden"
            ? "Bitwarden is locked on the bridge, so agents can't read its items. Unlock it there; syncing picks up on its own."
            : `${info.name} is locked, so agents can't read its items. Unlock it; syncing picks up on its own.`}
        </Notice>
      );
      break;
    case "unavailable":
      notice = (
        <Notice
          tone="failed"
          title={isSelfHosted(provider) ? "Offline" : "Unavailable"}
          actionLayout="responsive"
          action={checkAgain}
        >
          Opengeni can't reach {reachTarget(provider)}, so agents can't read its items.{" "}
          {isSelfHosted(provider) ? "Check that it's running." : "Try again in a moment."}
        </Notice>
      );
      break;
    case "sync_failed":
      notice = (
        <Notice
          tone="failed"
          title="A vault didn't sync"
          actionLayout="responsive"
          action={checkAgain}
        >
          Agents use the last synced items. Open the vault to see what {info.home} said.
        </Notice>
      );
      break;
    case "incomplete":
      notice = (
        <Notice
          tone="waiting"
          title="Not every item was listed"
          actionLayout="responsive"
          action={checkAgain}
        >
          Some items in {info.home} may be missing here. Open the vault to see which one.
        </Notice>
      );
      break;
    case "rate_limited":
      notice = (
        <Notice tone="waiting" title="Rate limited">
          {capitalized(info.home)} is limiting requests. Syncing resumes on its own.
        </Notice>
      );
      break;
    case null:
      break;
  }

  const meta: ReactNode[] = [];
  if (provider === "onepassword" && connection.planTier)
    meta.push(<span key="plan">{PLAN_LABEL[connection.planTier]} plan</span>);
  meta.push(
    <span key="connected">
      connected <RelativeTime date={connection.createdAt} inSentence />
      {creatorName ? ` by ${creatorName}` : ""}
    </span>,
  );
  meta.push(
    <span key="checked">
      {provider === "onepassword" || provider === "protonpass"
        ? "token checked"
        : provider === "bitwarden"
          ? "bridge checked"
          : "checked"}{" "}
      <RelativeTime date={connection.verifiedAt} inSentence />
    </span>,
  );

  return (
    <DetailPage
      back={{ label: "Secrets", onClick: actions.back }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ProviderTile provider={provider} />}
        title={name}
        chips={<MetaChip>{connectionOwnerLabel(connection.ownership)}</MetaChip>}
        meta={meta}
        actions={headerActions}
      />
      <div className="mt-6 flex min-w-0 flex-col gap-6">
        {notice}
        <p className="m-0 text-sm leading-5 text-fg-muted">
          {connectionAudience(connection.ownership, organizationName)} {valuesStay(provider)}
        </p>
        <Section title="Linked vaults">
          {linked.length === 0 ? (
            <EmptyState
              icon={<LinkIcon />}
              title="No vaults linked yet"
              description={
                canChoose
                  ? provider === "onepassword"
                    ? "Choose which of this account's vaults agents can use, and whether they can save to them."
                    : `Choose which ${info.vaultNoun.many} agents can use, and whether they can save to them.`
                  : !manage
                    ? "Someone who can manage this connection can link its vaults."
                    : attention === "unavailable_here"
                      ? `Vaults can be linked once this server can run ${info.name} connections.`
                      : attention === "pending"
                        ? `Finish connecting first, then choose ${info.vaultNoun.many}.`
                        : `Choose ${info.vaultNoun.many} once ${info.home} can be reached again.`
              }
              action={canChoose ? chooseButton(true) : undefined}
            />
          ) : (
            <RowList label="Linked vaults" flush>
              {linked.map((vault) => (
                <ListRow
                  key={vault.id}
                  leading={<VaultTile vault={vault} />}
                  title={vault.name}
                  description={`${MODE_LABEL[vault.mode]} · ${itemsLabel(vault.itemCount)}`}
                  status={
                    needsAttention(vaultHealth(vault)) ? <SyncStatus vault={vault} /> : undefined
                  }
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
export function ConnectionMissing({
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
        <div role="status" aria-label="Loading connection">
          <RowList label="Linked vaults" busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </div>
      ) : error ? (
        <SecretsLoadFailure title="Couldn't load this connection" error={error} onRetry={onRetry} />
      ) : (
        <>
          <h1 className="sr-only">This connection isn't here</h1>
          <EmptyState
            variant="page"
            icon={<UnplugIcon />}
            title={<span aria-hidden="true">This connection isn't here</span>}
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
