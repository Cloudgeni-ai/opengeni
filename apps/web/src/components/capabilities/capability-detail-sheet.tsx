import { ExternalLinkIcon, Loader2Icon, PlugIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  capabilityConnectPlan,
  capabilityKindLabel,
  capabilityReconnectPlan,
  capabilitySourceLabel,
  curatedSkillProvenance,
  preferredSocialConnection,
  GENERIC_API_KEY_FIELD,
  type ConnectionHealth,
} from "@/lib/capabilities";
import { focusCapabilitySuccessor } from "@/lib/capability-focus";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem, ConnectionOwnership, SocialConnection } from "@/types";

export type ConnectAction =
  | { type: "enable"; item: CapabilityCatalogItem }
  | {
      type: "social_oauth";
      item: CapabilityCatalogItem;
      provider: "x" | "reddit";
      ownership: ConnectionOwnership;
    }
  | { type: "disconnect_social"; item: CapabilityCatalogItem; connectionId: string }
  | { type: "oauth"; item: CapabilityCatalogItem; ownership: ConnectionOwnership }
  | {
      type: "api_key";
      item: CapabilityCatalogItem;
      ownership: ConnectionOwnership;
      headers: Record<string, string>;
    }
  // connectionId is the existing row to reuse, or null when the row was deleted
  // (reconnect then mints a fresh connection and re-enables with its ref).
  | {
      type: "reconnect_oauth";
      item: CapabilityCatalogItem;
      connectionId: string | null;
      ownership: ConnectionOwnership;
    }
  | {
      type: "reconnect_api_key";
      item: CapabilityCatalogItem;
      connectionId: string | null;
      ownership: ConnectionOwnership;
      headers: Record<string, string>;
    }
  | { type: "disable"; item: CapabilityCatalogItem };

export const DEFAULT_CONNECTION_OWNERSHIP: ConnectionOwnership = "workspace";

export function CapabilityDetailSheet({
  item,
  health,
  logoSrc,
  open,
  onOpenChange,
  restoreFocusRef,
  restoreFocusFallbackRef,
  busy,
  errorMessage,
  socialConnections,
  canManageSocial = false,
  onAction,
}: {
  item: CapabilityCatalogItem | null;
  health: ConnectionHealth;
  logoSrc: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>;
  busy: boolean;
  errorMessage: string | null;
  socialConnections?: SocialConnection[];
  canManageSocial?: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const localRestoreFocusRef = useRef<HTMLElement | null>(null);
  const focusRef = restoreFocusRef ?? localRestoreFocusRef;
  const focusTargetIdRef = useRef<string | null>(null);

  // The selected item is cleared at the same time the controlled sheet closes.
  // Retain its identity independently so the close autofocus hook can find the
  // newly rendered Enabled control after a successful enable refresh.
  useLayoutEffect(() => {
    if (item) focusTargetIdRef.current = item.id;
  }, [item]);

  // Capture before Radix's focus scope moves focus into the sheet. Routes pass
  // a synchronously captured opener for click/keyboard activation; this local
  // fallback keeps the controlled sheet safe for other callers too.
  useLayoutEffect(() => {
    if (!open) return;
    if (focusRef.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      focusRef.current = active;
    }
  }, [focusRef, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 border-border bg-bg p-0 sm:max-w-[30rem]"
        onCloseAutoFocus={(event) => {
          const opener = focusRef.current;
          focusRef.current = null;
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
            return;
          }

          const restore = () =>
            focusCapabilitySuccessor(
              focusTargetIdRef.current,
              restoreFocusFallbackRef?.current ?? null,
            );
          event.preventDefault();
          // Refresh + close normally commit the Enabled control before Radix
          // invokes this hook. One frame covers the rare slower commit without
          // allowing Radix to restore focus to document.body in the meantime.
          if (!restore()) {
            if (typeof window.requestAnimationFrame === "function") {
              window.requestAnimationFrame(restore);
            } else {
              window.setTimeout(restore, 0);
            }
          }
        }}
      >
        {item ? (
          <DetailBody
            item={item}
            health={health}
            logoSrc={logoSrc}
            busy={busy}
            errorMessage={errorMessage}
            socialConnections={socialConnections}
            canManageSocial={canManageSocial}
            onAction={onAction}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({
  item,
  health,
  logoSrc,
  busy,
  errorMessage,
  socialConnections,
  canManageSocial,
  onAction,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  errorMessage: string | null;
  socialConnections?: SocialConnection[];
  canManageSocial: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const plan = useMemo(() => capabilityConnectPlan(item), [item]);
  // API-key reconnect reveals the credential form in place of the button.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => setReconnecting(false), [item.id]);
  const [connectionOwnership, setConnectionOwnership] = useState<ConnectionOwnership>(
    DEFAULT_CONNECTION_OWNERSHIP,
  );
  useEffect(() => setConnectionOwnership(DEFAULT_CONNECTION_OWNERSHIP), [item.id]);

  const canDisable = item.enabled && item.source !== "built_in" && item.source !== "configured";
  const keyPageUrl = item.installUrl ?? item.homepageUrl;
  // Repair is driven by the installation's OWN connectionRef.kind, not the catalog
  // plan — on catalog/registry drift an enabled item can carry a live connectionRef
  // while its current catalog auth fields read as plain "enable", and gating on the
  // plan would leave "Needs attention" with no Reconnect (the dead end we killed).
  const reconnect = capabilityReconnectPlan(item, health);
  // When the catalog no longer supplies requiredHeaders, fall back to one generic
  // "API key" field so an api-key reconnect still has something to submit.
  const reconnectFields =
    plan.mode === "api_key" && plan.fields.length > 0 ? plan.fields : [GENERIC_API_KEY_FIELD];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <SheetHeader className="gap-3 border-b border-border p-5 pr-12">
        <div className="flex items-start gap-3">
          <CapabilityLogo src={logoSrc} name={item.name} size="lg" />
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-base">{item.name}</SheetTitle>
            <SheetDescription className="mt-0.5 text-xs text-fg-subtle">
              {capabilityKindLabel(item.kind)}
              {item.category && item.category !== "custom" ? ` · ${item.category}` : ""}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {item.stale ? (
          <Notice tone="muted">
            No longer listed in the public registry. Existing installations keep working.
          </Notice>
        ) : null}

        {item.description ? (
          <p className="text-sm leading-6 text-fg-muted">{item.description}</p>
        ) : null}

        {item.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 10).map((tag) => (
              <MetaChip key={tag}>{tag}</MetaChip>
            ))}
          </div>
        ) : null}

        <dl className="grid gap-2.5 text-xs">
          <MetaRow label="Source">{capabilitySourceLabel(item.source)}</MetaRow>
          {item.homepageUrl ? (
            <MetaRow label="Homepage">
              <ExternalMetaLink href={item.homepageUrl} />
            </MetaRow>
          ) : null}
          {item.installUrl && item.installUrl !== item.homepageUrl ? (
            <MetaRow label="Setup">
              <ExternalMetaLink href={item.installUrl} />
            </MetaRow>
          ) : null}
          {item.endpointUrl ? (
            <MetaRow label="Endpoint">
              <span className="min-w-0 truncate font-mono text-fg-muted">{item.endpointUrl}</span>
            </MetaRow>
          ) : null}
        </dl>

        <CuratedSkillProvenanceSection item={item} />

        {/* Action — flows directly after the content so a sparse item stays a
            compact top-flowing column, with no dead void before a bottom-pinned
            button. The whole body scrolls only when content actually overflows. */}
        <div className="space-y-3 border-t border-border pt-5">
          {errorMessage ? <Notice tone="failed">{errorMessage}</Notice> : null}

          {item.surfaceType === "codex_apps" ? (
            <div className="space-y-3">
              <Notice tone={item.runtime.available ? "success" : "waiting"}>
                {item.runtime.available
                  ? "Available through the active workspace Apps designation."
                  : "Unavailable. An active Codex Apps credential must be designated in Workspace Settings before it can be selected."}
              </Notice>
              <p className="text-center text-xs text-fg-subtle">
                {item.runtime.available
                  ? "Select Codex Apps from a session's Tools picker, or leave the policy at the workspace default."
                  : "This surface cannot be enabled from the capability catalog; its authorization is managed by the workspace Codex subscription."}
              </p>
            </div>
          ) : plan.mode === "social_oauth" ? (
            <SocialConnectorControls
              item={item}
              provider={plan.provider}
              connections={socialConnections ?? []}
              ownership={connectionOwnership}
              onOwnershipChange={setConnectionOwnership}
              busy={busy}
              canManage={canManageSocial}
              onAction={onAction}
            />
          ) : item.enabled ? (
            <div className="space-y-3">
              <ConnectionStatus item={item} health={health} />
              {/* Reconnect is the primary repair action when the connection broke;
                Disable drops to secondary. Healthy items show only Disable. */}
              {reconnect ? (
                reconnect.kind === "oauth" ? (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={busy}
                    onClick={() =>
                      onAction({
                        type: "reconnect_oauth",
                        item,
                        connectionId: reconnect.connectionId,
                        ownership: reconnect.ownership,
                      })
                    }
                  >
                    {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                    Reconnect {item.name}
                  </Button>
                ) : reconnecting ? (
                  <CredentialForm
                    fields={reconnectFields}
                    itemName={item.name}
                    keyPageUrl={keyPageUrl}
                    submitLabel="Reconnect"
                    submitIcon={<RefreshCwIcon />}
                    busy={busy}
                    onSubmit={(next) =>
                      onAction({
                        type: "reconnect_api_key",
                        item,
                        connectionId: reconnect.connectionId,
                        ownership: reconnect.ownership,
                        headers: next,
                      })
                    }
                  />
                ) : (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={busy}
                    onClick={() => setReconnecting(true)}
                  >
                    <RefreshCwIcon />
                    Reconnect {item.name}
                  </Button>
                )
              ) : null}
              {canDisable ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
                  disabled={busy}
                  onClick={() => onAction({ type: "disable", item })}
                >
                  {busy && !reconnect ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
                  Disable
                </Button>
              ) : (
                <p className="text-center text-xs text-fg-subtle">Built in — always available.</p>
              )}
            </div>
          ) : plan.mode === "api_key" ? (
            <div className="space-y-3">
              <OwnershipSelector value={connectionOwnership} onChange={setConnectionOwnership} />
              <CredentialForm
                fields={plan.fields}
                itemName={item.name}
                keyPageUrl={keyPageUrl}
                submitLabel={
                  connectionOwnership === "workspace"
                    ? "Connect for workspace"
                    : "Connect only for me"
                }
                submitIcon={<PlugIcon />}
                busy={busy}
                onSubmit={(next) =>
                  onAction({
                    type: "api_key",
                    item,
                    ownership: connectionOwnership,
                    headers: next,
                  })
                }
              />
            </div>
          ) : plan.mode === "oauth" ? (
            <div className="space-y-3">
              <OwnershipSelector value={connectionOwnership} onChange={setConnectionOwnership} />
              <Button
                type="button"
                className="w-full"
                disabled={busy}
                onClick={() => onAction({ type: "oauth", item, ownership: connectionOwnership })}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
                {connectionOwnership === "workspace"
                  ? "Connect for workspace"
                  : "Connect only for me"}
              </Button>
              <p className="text-center text-xs text-fg-subtle">
                {connectionOwnership === "workspace"
                  ? `You'll authorize ${item.name} once for this workspace. Provider actions may appear as the account you connect.`
                  : `You'll authorize ${item.name} for your personal use, then return here.`}
              </p>
            </div>
          ) : (
            <Button
              type="button"
              className="w-full"
              disabled={busy || (item.kind === "mcp" && !item.runtime.available)}
              title={
                item.kind === "mcp" && !item.runtime.available
                  ? (item.runtime.notes ?? undefined)
                  : undefined
              }
              onClick={() => onAction({ type: "enable", item })}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
              Enable
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SocialConnectorControls({
  item,
  provider,
  connections,
  ownership,
  onOwnershipChange,
  busy,
  canManage,
  onAction,
}: {
  item: CapabilityCatalogItem;
  provider: "x" | "reddit";
  connections: SocialConnection[];
  ownership: ConnectionOwnership;
  onOwnershipChange: (ownership: ConnectionOwnership) => void;
  busy: boolean;
  canManage: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const connection = preferredSocialConnection(
    connections.filter((candidate) => candidate.ownership === ownership),
    provider,
  );
  const canConnect = ownership === "personal" || canManage;
  return (
    <div className="space-y-3">
      <OwnershipSelector value={ownership} onChange={onOwnershipChange} />
      {connection ? (
        <Notice tone={connection.status === "connected" ? "success" : "waiting"}>
          <span className="font-medium">
            {connection.status === "connected"
              ? `Connected as @${connection.accountHandle}`
              : connection.status === "needs_reauth"
                ? `@${connection.accountHandle} needs to reconnect`
                : `@${connection.accountHandle} is disconnected`}
          </span>
        </Notice>
      ) : null}
      <Button
        type="button"
        className="w-full"
        disabled={busy || !canConnect}
        onClick={() => onAction({ type: "social_oauth", item, provider, ownership })}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
        {connection && connection.status !== "disabled"
          ? `Reconnect ${item.name}`
          : ownership === "workspace"
            ? `Connect ${item.name} for workspace`
            : `Connect ${item.name} only for me`}
      </Button>
      <p className="text-center text-xs text-fg-subtle">
        {ownership === "workspace"
          ? "Workspace shared. Agents and scheduled automations can use the connected account; connect a brand account rather than a personal one."
          : "Personal. Used only by work carrying your explicit connection authority, including tasks you create from that authority."}
      </p>
      {connection?.status === "connected" ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy || !canConnect}
          onClick={() => onAction({ type: "disconnect_social", item, connectionId: connection.id })}
        >
          <TrashIcon />
          Disconnect
        </Button>
      ) : null}
      {ownership === "workspace" && !canManage ? (
        <p className="text-center text-xs text-fg-subtle">
          Workspace admin permission is required to manage this connection.
        </p>
      ) : null}
    </div>
  );
}

export function OwnershipSelector({
  value,
  onChange,
}: {
  value: ConnectionOwnership;
  onChange: (value: ConnectionOwnership) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-fg-muted">Who can use this connection?</legend>
      <OwnershipOption
        checked={value === "workspace"}
        value="workspace"
        title="Connect for workspace"
        description="Shared with agents and automations in this workspace."
        onChange={() => onChange("workspace")}
      />
      <OwnershipOption
        checked={value === "personal"}
        value="personal"
        title="Connect only for me"
        description="Used only when work is authorized to act as you."
        onChange={() => onChange("personal")}
      />
    </fieldset>
  );
}

function OwnershipOption({
  checked,
  value,
  title,
  description,
  onChange,
}: {
  checked: boolean;
  value: ConnectionOwnership;
  title: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
        checked ? "border-brand bg-brand/5" : "border-border bg-bg hover:bg-surface",
      )}
    >
      <input
        type="radio"
        name="connection-ownership"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-current"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-subtle">{description}</span>
      </span>
    </label>
  );
}

function CuratedSkillProvenanceSection({ item }: { item: CapabilityCatalogItem }) {
  const metadata = curatedSkillProvenance(item);
  if (!metadata) return null;

  return (
    <section
      aria-labelledby="curated-skill-provenance-heading"
      className="space-y-2.5 border-t border-border pt-5"
    >
      <div>
        <h3 id="curated-skill-provenance-heading" className="text-sm font-medium text-fg">
          Curated skill provenance
        </h3>
        <p className="mt-1 text-xs leading-5 text-fg-subtle">
          Immutable reviewed metadata for the exact artifact selected by this workspace.
        </p>
      </div>
      <dl className="grid gap-2.5 text-xs">
        <MetaRow label="Status">
          <span className="font-medium text-fg">
            {metadata.status === "enabled" ? "Enabled" : "Not enabled"}
          </span>
        </MetaRow>
        <MetaRow label="Effective selection">
          <span className="min-w-0 break-words text-right">
            {humanizeSelection(metadata.effectiveSelection)}
          </span>
        </MetaRow>
        <MetaRow label="Version (immutable)">
          <span className="font-mono text-fg-muted">{metadata.version ?? "Unavailable"}</span>
        </MetaRow>
        <MetaRow label="Artifact SHA-256">
          <span className="min-w-0 break-all font-mono text-fg-muted">
            {metadata.contentSha256 ?? "Unavailable"}
          </span>
        </MetaRow>
        <MetaRow label="Source commit">
          <span className="min-w-0 break-all font-mono text-fg-muted">
            {metadata.sourceCommit ?? "Unavailable"}
          </span>
        </MetaRow>
        <MetaRow label="Provenance">
          <span className="min-w-0 break-words text-right text-fg-muted">
            {metadata.provenance ?? "Unavailable"}
          </span>
        </MetaRow>
        {metadata.sourceUrl ? (
          <MetaRow label="Source">
            <ExternalMetaLink href={metadata.sourceUrl} />
          </MetaRow>
        ) : null}
        {metadata.documentationUrl ? (
          <MetaRow label="Documentation">
            <ExternalMetaLink href={metadata.documentationUrl} />
          </MetaRow>
        ) : null}
        {metadata.license ? <MetaRow label="License">{metadata.license}</MetaRow> : null}
      </dl>
    </section>
  );
}

function humanizeSelection(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown";
}

// The labeled credential form, shared by first-time connect and reconnect. It
// owns its own header state so it starts empty each time it mounts (a fresh
// sheet, or the reveal on reconnect) — credentials are never prefilled.
function CredentialForm({
  fields,
  itemName,
  keyPageUrl,
  submitLabel,
  submitIcon,
  busy,
  onSubmit,
}: {
  fields: { name: string; label: string }[];
  itemName: string;
  keyPageUrl: string | null;
  submitLabel: string;
  submitIcon: ReactNode;
  busy: boolean;
  onSubmit: (headers: Record<string, string>) => void;
}) {
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const ready = fields.every((field) => headers[field.name]?.trim());

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit(headers);
      }}
    >
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label htmlFor={`cred-${field.name}`} className="text-xs text-fg-muted">
            {field.label}
          </Label>
          <Input
            id={`cred-${field.name}`}
            type="password"
            autoComplete="off"
            value={headers[field.name] ?? ""}
            onChange={(event) =>
              setHeaders((current) => ({ ...current, [field.name]: event.target.value }))
            }
            placeholder={`Paste your ${field.label}`}
          />
        </div>
      ))}
      {keyPageUrl ? (
        <a
          href={keyPageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          Get your {fields[0]?.label ?? "credentials"}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : (
        <p className="text-xs text-fg-subtle">
          Stored encrypted and used only to reach {itemName}.
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !ready}>
        {busy ? <Loader2Icon className="animate-spin" /> : submitIcon}
        {submitLabel}
      </Button>
    </form>
  );
}

export function ConnectionStatus({
  item,
  health,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
}) {
  // "none" = enabled without a connection (headers-enabled or credential-free);
  // "unverified" = it has a connection but the connections list didn't load, so we
  // can't check it. Both render a neutral "Enabled" — honest, and never a false
  // "Needs attention".
  if (health.state === "none" || health.state === "unverified") {
    return (
      <div className="flex items-center gap-2 text-sm text-status-idle">
        <span className="size-2 rounded-full bg-status-idle" />
        Enabled
      </div>
    );
  }
  const attention = health.state === "attention";
  const personal =
    item.connectionRef?.subjectScope === "subject" ||
    (health.connection ? health.connection.subjectId !== null : false);
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex items-center gap-2 text-sm",
          attention ? "text-status-waiting" : "text-status-idle",
        )}
      >
        <span
          className={cn("size-2 rounded-full", attention ? "bg-status-waiting" : "bg-status-idle")}
        />
        {attention ? "Needs attention" : "Connected"}
      </div>
      <p className="text-xs text-fg-subtle">
        {attention
          ? `${personal ? "Personal" : "Workspace"} connection needs to be reconnected.`
          : personal
            ? `Personal connection to ${health.connection.providerDomain}. Automations use it only when explicitly delegated.`
            : `Workspace connection to ${health.connection.providerDomain}. Shared with agents and automations here.`}
      </p>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-fg-muted">{children}</dd>
    </div>
  );
}

function ExternalMetaLink({ href }: { href: string }) {
  let label = href;
  try {
    label = new URL(href).hostname;
  } catch {
    // Non-URL string: show it verbatim.
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-w-0 items-center gap-1 truncate font-medium text-brand hover:underline"
    >
      <span className="truncate">{label}</span>
      <ExternalLinkIcon className="size-3 shrink-0" />
    </a>
  );
}
