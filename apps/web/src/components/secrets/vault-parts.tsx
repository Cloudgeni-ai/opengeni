import type { VaultItemSummary, VaultSummary } from "@opengeni/react";
import {
  BracesIcon,
  FileIcon,
  FingerprintIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  NotepadTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge, type ProductStatus } from "@/components/ui/status-badge";
import { apiErrorFacts } from "@/lib/api-error";

import { ProviderTile } from "./provider-marks";
import {
  expiryLabel,
  expiryState,
  formatClock,
  vaultErrorText,
  type ExpiryState,
} from "./vault-model";
import {
  everListed,
  healthLabel,
  isSelfHosted,
  providerOfVault,
  PROVIDERS,
  sourceHome,
  vaultHealth,
  type VaultHealth,
  type VaultProviderId,
} from "./vault-providers";

/* ----------------------------------------------------------------------------
   Small pieces shared by the Secrets pages: tiles, chips, provider status
   (S8), expiry badges and the load failure.
   -------------------------------------------------------------------------- */

export { OnePasswordMark } from "./provider-marks";

export function VaultTile({ vault }: { vault: VaultSummary }) {
  const provider = providerOfVault(vault);
  if (provider) return <ProviderTile provider={provider} />;
  if (vault.source === "host") return <LogoTile icon={<ServerIcon />} />;
  const icon =
    vault.ownerKind === "user" ? (
      <UserIcon />
    ) : vault.ownerKind === "task" ? (
      <LockKeyholeIcon />
    ) : (
      <UsersIcon />
    );
  return <LogoTile icon={icon} />;
}

/**
 * Chips that say what is not the default: Organization, This task,
 * Read-only. Owner and source are already said by the group and the tile.
 */
export function VaultChips({
  vault,
  inHeader = false,
}: {
  vault: VaultSummary;
  /**
   * The vault page header: its meta line already says who can use the vault,
   * so only the organization owner and the password manager get a chip.
   */
  inHeader?: boolean;
}) {
  const chips: ReactNode[] = [];
  const provider = providerOfVault(vault);
  if (vault.ownerKind === "organization") chips.push(<MetaChip key="org">Organization</MetaChip>);
  else if (vault.ownerKind === "task" && !inHeader)
    chips.push(<MetaChip key="task">This task</MetaChip>);
  if (provider && inHeader)
    chips.push(<MetaChip key="source">{PROVIDERS[provider].name}</MetaChip>);
  if (vault.mode === "read_only") chips.push(<MetaChip key="mode">Read-only</MetaChip>);
  if (chips.length === 0) return null;
  return <span className="inline-flex flex-wrap items-center gap-1.5">{chips}</span>;
}

const HEALTH_STATUS: Record<
  Exclude<VaultHealth["kind"], "ok" | "stale">,
  (provider: VaultProviderId | null) => ProductStatus
> = {
  syncing: () => "syncing",
  rate_limited: () => "rate_limited",
  auth_expired: (provider) =>
    provider === "onepassword" || provider === "protonpass" ? "token_expired" : "needs_reconnect",
  locked: () => "locked",
  unavailable: (provider) => (isSelfHosted(provider) ? "offline" : "unavailable"),
  incomplete: () => "incomplete",
  failed: () => "sync_failed",
};

/** Why a linked vault's row shows its status, in one sentence. */
function healthReason(vault: VaultSummary, health: VaultHealth): string | undefined {
  const provider = providerOfVault(vault);
  const home = sourceHome(vault);
  const Home = home.charAt(0).toUpperCase() + home.slice(1);
  switch (health.kind) {
    case "failed":
      return health.message ?? `${Home} didn't respond to the last sync.`;
    case "auth_expired":
      return provider === "onepassword"
        ? "The 1Password service account token expired. Reconnect to keep syncing."
        : `${Home} no longer accepts ${provider ? PROVIDERS[provider].credential : "its access"}. Reconnect to keep syncing.`;
    case "locked":
      return provider === "bitwarden"
        ? "Bitwarden is locked on the bridge. Agents can't read these items until it's unlocked."
        : `${Home} is locked. Agents can't read these items until it's unlocked.`;
    case "unavailable":
      return isSelfHosted(provider)
        ? `Opengeni can't reach ${provider === "bitwarden" ? "your Bitwarden bridge" : "your vault service"}.`
        : `${Home} isn't responding.`;
    case "incomplete":
      return `Not every item in ${home} could be listed, so some may be missing.`;
    default:
      return undefined;
  }
}

/** A provider vault's state, only when it needs attention (S8). */
export function SyncStatus({
  vault,
  variant = "dot",
}: {
  vault: VaultSummary;
  variant?: "dot" | "outline";
}) {
  const health = vaultHealth(vault);
  if (health.kind === "ok" || health.kind === "stale") return null;
  const provider = providerOfVault(vault);
  const status = HEALTH_STATUS[health.kind](provider);
  const reason = healthReason(vault, health);
  if (health.kind === "rate_limited") {
    return (
      <StatusBadge status={status} variant={variant}>
        {healthLabel(health, provider)}
      </StatusBadge>
    );
  }
  return (
    <StatusBadge status={status} variant={variant} {...(reason ? { reason } : {})}>
      {healthLabel(health, provider)}
    </StatusBadge>
  );
}

/** "Last synced 3 hours ago." while Opengeni has listed the vault before. */
function LastSynced({ vault, lead = "Last synced" }: { vault: VaultSummary; lead?: string }) {
  const at = vault.lastSyncedAt ?? vault.freshness?.lastCheckedAt ?? null;
  if (!at) return null;
  return (
    <>
      {" "}
      {lead} <RelativeTime date={at} inSentence />.
    </>
  );
}

/** What agents get while the source can't be read: the last listing, or nothing yet. */
function MirrorLine({ vault }: { vault: VaultSummary }) {
  if (!everListed(vault)) return <> Nothing has been listed from it yet.</>;
  return <LastSynced vault={vault} lead="Showing items from the last sync" />;
}

/** The renewal sentence for an expired or refused credential. */
function renewSentence(provider: VaultProviderId | null): string {
  switch (provider) {
    case "onepassword":
      return "Paste a new service account token to keep this vault in sync.";
    case "protonpass":
      return "Paste a new personal access token to keep this vault in sync.";
    case "keeper":
      return "Keeper no longer accepts this device. Reconnect with a new one-time access token to keep this vault in sync.";
    case "bitwarden":
      return "The bridge no longer accepts Opengeni's signing secret. Update the bridge to keep this vault in sync.";
    case "external":
      return "Your vault service no longer accepts Opengeni's signing secret. Update the service to keep this vault in sync.";
    default:
      return "The app that provides this vault no longer accepts Opengeni.";
  }
}

/** The vault page banner for a provider vault that needs attention (S8). */
export function VaultSyncNotice({
  vault,
  onRetry,
  onReconnect,
  retrying = false,
}: {
  vault: VaultSummary;
  onRetry: () => void;
  /** Opens the connection's renewal page; absent when nobody here can renew it. */
  onReconnect?: (() => void) | undefined;
  retrying?: boolean;
}) {
  if (vault.source === "opengeni") return null;
  const health = vaultHealth(vault);
  const provider = providerOfVault(vault);
  const home = sourceHome(vault);
  const Home = home.charAt(0).toUpperCase() + home.slice(1);
  const synced = <LastSynced vault={vault} />;
  const checkAgain = (label: string) => (
    <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
      <RotateCcwIcon aria-hidden="true" />
      {retrying ? "Checking…" : label}
    </Button>
  );
  switch (health.kind) {
    case "ok":
      return null;
    case "stale":
      return (
        <Notice
          tone="muted"
          actionLayout="responsive"
          action={
            <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              <RefreshCwIcon aria-hidden="true" />
              {retrying ? "Syncing…" : "Sync now"}
            </Button>
          }
        >
          {health.checkedAt ? (
            <>
              Items as of <RelativeTime date={health.checkedAt} inSentence />. {Home} may have
              changed since.
            </>
          ) : (
            <>{Home} may have changed since these items were listed.</>
          )}
        </Notice>
      );
    case "syncing":
      return <Notice tone="waiting">Syncing with {home}…</Notice>;
    case "failed":
      return (
        <Notice
          tone="failed"
          title="Sync failed"
          actionLayout="responsive"
          action={
            <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              <RotateCcwIcon aria-hidden="true" />
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          }
        >
          {health.message ?? `${Home} didn't respond.`}
          {everListed(vault) ? (
            <>
              {" "}
              Agents use the last synced items.
              {synced}
            </>
          ) : (
            " Nothing has been listed from it yet."
          )}
        </Notice>
      );
    case "auth_expired":
      return (
        <Notice
          tone="waiting"
          title={healthLabel(health, provider)}
          actionLayout="responsive"
          action={
            onReconnect && provider ? (
              <Button type="button" variant="outline" size="sm" onClick={onReconnect}>
                {PROVIDERS[provider].renewLabel}
              </Button>
            ) : undefined
          }
        >
          {renewSentence(provider)}
          {synced}
        </Notice>
      );
    case "locked":
      return (
        <Notice
          tone="waiting"
          title="Locked"
          actionLayout="responsive"
          action={checkAgain("Check again")}
        >
          {provider === "bitwarden"
            ? "Bitwarden is locked on the bridge, so agents can't read these items. Unlock it there; syncing picks up on its own."
            : `${Home} is locked, so agents can't read these items. Unlock it; syncing picks up on its own.`}
          <MirrorLine vault={vault} />
        </Notice>
      );
    case "unavailable":
      return (
        <Notice
          tone="failed"
          title={isSelfHosted(provider) ? "Offline" : "Unavailable"}
          actionLayout="responsive"
          action={checkAgain("Check again")}
        >
          {provider === "bitwarden"
            ? "Opengeni can't reach your Bitwarden bridge. Check that it's running."
            : provider === "external"
              ? "Opengeni can't reach your vault service. Check that it's running."
              : `${Home} isn't responding, so agents can't read these items right now.`}
          <MirrorLine vault={vault} />
        </Notice>
      );
    case "incomplete":
      return (
        <Notice
          tone="waiting"
          title="Incomplete"
          actionLayout="responsive"
          action={checkAgain("Check again")}
        >
          Not every item in {home} could be listed, so some may be missing here.
          <MirrorLine vault={vault} />
        </Notice>
      );
    case "rate_limited": {
      const until = formatClock(health.until);
      return (
        <Notice tone="waiting" title="Rate limited">
          {Home} is limiting requests{until ? ` until ${until}` : ""}. Syncing resumes on its own.
          {synced}
        </Notice>
      );
    }
  }
}

/**
 * Where the items come from when the source serves a copy: a Bitwarden bridge
 * reads its own synced vault, so its last sync with Bitwarden is a fact worth
 * one quiet line. Nothing for live sources.
 */
export function SourceCopyLine({ vault }: { vault: VaultSummary }) {
  const freshness = vault.freshness;
  if (!freshness || freshness.source !== "cache" || !freshness.sourceSyncedAt) return null;
  const provider = providerOfVault(vault);
  return (
    <p className="m-0 text-sm leading-5 text-fg-muted">
      {provider === "bitwarden"
        ? "Your bridge last synced with Bitwarden"
        : "The source last synced"}{" "}
      <RelativeTime date={freshness.sourceSyncedAt} inSentence />.
    </p>
  );
}

/* ------------------------------------------------------------- items */

/** One glyph per type, so a mixed list scans by kind before name. */
const ITEM_TYPE_ICON: Record<VaultItemSummary["type"], ReactNode> = {
  login: <KeyRoundIcon />,
  api_key: <BracesIcon />,
  note: <NotepadTextIcon />,
  file: <FileIcon />,
  passkey: <FingerprintIcon />,
};

export function ItemTile({ item }: { item: Pick<VaultItemSummary, "type"> }) {
  return <LogoTile icon={ITEM_TYPE_ICON[item.type]} />;
}

export function ExpiryBadge({
  expiresAt,
  variant = "dot",
  now,
}: {
  expiresAt: string | null;
  variant?: "dot" | "outline";
  now?: number;
}) {
  const state: ExpiryState = expiryState(expiresAt, now);
  if (!state) return null;
  const exact = state.at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <StatusBadge
      status={state.kind === "expired" ? "expired" : "expiring"}
      variant={variant}
      icon="auto"
      reason={state.kind === "expired" ? `Expired ${exact}` : `Expires ${exact}`}
    >
      {expiryLabel(state)}
    </StatusBadge>
  );
}

/* ------------------------------------------------------------- failure */

export function SecretsLoadFailure({
  title,
  error,
  onRetry,
  home,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
  /** The password manager the request went to, for its error copy. */
  home?: string | undefined;
}) {
  const facts = apiErrorFacts(error);
  return (
    <ErrorMessage
      variant="block"
      align="center"
      title={title}
      reference={facts.reference}
      details={[
        ...(facts.status !== undefined ? [{ label: "Status", value: `HTTP ${facts.status}` }] : []),
        ...(facts.code ? [{ label: "Code", value: facts.code }] : []),
      ]}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
          Try again
        </Button>
      }
    >
      {vaultErrorText(error, "Check your connection, then try again.", home)}
    </ErrorMessage>
  );
}
