import type { VaultItemSummary, VaultSummary } from "@opengeni/react";
import {
  BracesIcon,
  FileIcon,
  FingerprintIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  RotateCcwIcon,
  ServerIcon,
  StickyNoteIcon,
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
import { StatusBadge } from "@/components/ui/status-badge";
import { apiErrorFacts } from "@/lib/api-error";
import { cn } from "@/lib/utils";

import {
  expiryLabel,
  expiryState,
  formatClock,
  vaultErrorText,
  type ExpiryState,
} from "./vault-model";

/* ----------------------------------------------------------------------------
   Small pieces shared by the Secrets pages: tiles, chips, provider status
   (S8), expiry badges and the load failure.
   -------------------------------------------------------------------------- */

/** The 1Password mark, drawn as a keyhole in a ring (no bitmap asset). */
export function OnePasswordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-full", className)} fill="none">
      <circle cx="12" cy="12" r="10.25" fill="#0572EC" />
      <circle cx="12" cy="12" r="6.6" stroke="#fff" strokeWidth="1.7" />
      <rect x="10.85" y="7.6" width="2.3" height="8.8" rx="1.15" fill="#fff" />
    </svg>
  );
}

export function VaultTile({ vault }: { vault: VaultSummary }) {
  if (vault.source === "onepassword") {
    return <LogoTile icon={<OnePasswordMark />} label="1Password" />;
  }
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
   * so only the organization owner and the 1Password source get a chip.
   */
  inHeader?: boolean;
}) {
  const chips: ReactNode[] = [];
  if (vault.ownerKind === "organization") chips.push(<MetaChip key="org">Organization</MetaChip>);
  else if (vault.ownerKind === "task" && !inHeader)
    chips.push(<MetaChip key="task">This task</MetaChip>);
  if (vault.source === "onepassword" && inHeader)
    chips.push(<MetaChip key="source">1Password</MetaChip>);
  if (vault.mode === "read_only") chips.push(<MetaChip key="mode">Read-only</MetaChip>);
  if (chips.length === 0) return null;
  return <span className="inline-flex flex-wrap items-center gap-1.5">{chips}</span>;
}

/** A provider vault's state, only when it needs attention (S8). */
export function SyncStatus({
  vault,
  variant = "dot",
}: {
  vault: VaultSummary;
  variant?: "dot" | "outline";
}) {
  switch (vault.syncStatus) {
    case "ok":
      return null;
    case "syncing":
      return <StatusBadge status="syncing" variant={variant} />;
    case "error":
      return (
        <StatusBadge
          status="sync_failed"
          variant={variant}
          reason={vault.syncErrorMessage ?? "1Password didn't respond to the last sync."}
        />
      );
    case "auth_expired":
      return (
        <StatusBadge
          status="token_expired"
          variant={variant}
          reason="The 1Password service account token expired. Reconnect to keep syncing."
        />
      );
    case "rate_limited": {
      const until = formatClock(vault.rateLimitedUntil);
      return (
        <StatusBadge status="rate_limited" variant={variant}>
          {until ? `Rate limited until ${until}` : "Rate limited"}
        </StatusBadge>
      );
    }
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
  onReconnect: () => void;
  retrying?: boolean;
}) {
  if (vault.source === "opengeni") return null;
  const synced = vault.lastSyncedAt ? (
    <>
      {" "}
      Last synced <RelativeTime date={vault.lastSyncedAt} inSentence />.
    </>
  ) : null;
  switch (vault.syncStatus) {
    case "ok":
      return null;
    case "syncing":
      return <Notice tone="waiting">Syncing with 1Password…</Notice>;
    case "error":
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
          {vault.syncErrorMessage ?? "1Password didn't respond."} Agents use the last synced items.
          {synced}
        </Notice>
      );
    case "auth_expired":
      return (
        <Notice
          tone="waiting"
          title="Token expired"
          actionLayout="responsive"
          action={
            <Button type="button" variant="outline" size="sm" onClick={onReconnect}>
              Reconnect
            </Button>
          }
        >
          Paste a new service account token to keep this vault in sync.{synced}
        </Notice>
      );
    case "rate_limited": {
      const until = formatClock(vault.rateLimitedUntil);
      return (
        <Notice tone="waiting" title="Rate limited">
          1Password is limiting requests{until ? ` until ${until}` : ""}. Syncing resumes on its
          own.{synced}
        </Notice>
      );
    }
  }
}

/* ------------------------------------------------------------- items */

/** One glyph per type, so a mixed list scans by kind before name. */
const ITEM_TYPE_ICON: Record<VaultItemSummary["type"], ReactNode> = {
  login: <KeyRoundIcon />,
  api_key: <BracesIcon />,
  note: <StickyNoteIcon />,
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
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
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
      {vaultErrorText(error, "Check your connection, then try again.")}
    </ErrorMessage>
  );
}
