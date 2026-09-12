import {
  ExternalLinkIcon,
  Loader2Icon,
  PlugIcon,
  RefreshCwIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { CapabilityDialogContent } from "@/components/capabilities/detail-dialog";
import {
  capabilityPresentation,
  presentationPermissions,
  type IntegrationPresentationCopy,
} from "@/components/capabilities/integration-experience";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import {
  Dialog as Sheet,
  DialogDescription as SheetDescription,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
} from "@/components/ui/dialog";
import {
  capabilityCategoryLabel,
  capabilityConnectPlan,
  capabilityItemKindLabel,
  capabilityReconnectPlan,
  capabilityRequiresPersonalConnection,
  capabilitySourceLabel,
  curatedSkillProvenance,
  socialConnectionsForOwnership,
  DEFAULT_CONNECTION_OWNERSHIP,
  GENERIC_API_KEY_FIELD,
  type ConnectionHealth,
} from "@/lib/capabilities";
import { focusCapabilitySuccessor } from "@/lib/capability-focus";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem, ConnectionOwnership, SocialConnection } from "@/types";

export type ConnectAction =
  | { type: "enable"; item: CapabilityCatalogItem }
  | { type: "install_skill"; item: CapabilityCatalogItem }
  | { type: "remove_skill"; item: CapabilityCatalogItem }
  | {
      type: "social_oauth";
      item: CapabilityCatalogItem;
      provider: "x" | "reddit";
      ownership: ConnectionOwnership;
    }
  | {
      type: "disconnect_social";
      item: CapabilityCatalogItem;
      connectionId: string;
    }
  // connectionId is the existing Fiken row to rewrite in place (reconnect /
  // replace token), or null for a first connect.
  | {
      type: "fiken_api_token";
      item: CapabilityCatalogItem;
      apiToken: string;
      connectionId: string | null;
    }
  | {
      type: "fiken_disconnect";
      item: CapabilityCatalogItem;
      connectionId: string;
    }
  // OAuth against the registered Fiken app; connectionId re-authorizes an
  // existing row in place.
  | {
      type: "fiken_oauth";
      item: CapabilityCatalogItem;
      connectionId: string | null;
    }
  | {
      type: "oauth";
      item: CapabilityCatalogItem;
      ownership: ConnectionOwnership;
    }
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
  | { type: "disconnect"; item: CapabilityCatalogItem };

// Re-exported from the shared library so the sheet and the row/tile quick-connect
// fast path can never drift on what a new connection defaults to.
export { DEFAULT_CONNECTION_OWNERSHIP };

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
  canManageSkills = false,
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
  canManageSkills?: boolean;
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
      <CapabilityDialogContent
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
            canManageSkills={canManageSkills}
            onAction={onAction}
          />
        ) : null}
      </CapabilityDialogContent>
    </Sheet>
  );
}

export function DetailBody({
  item,
  inline = false,
  showIdentity = true,
  onCancel,
  health,
  logoSrc,
  busy,
  errorMessage,
  socialConnections,
  canManageSocial,
  canManageSkills = false,
  onAction,
}: {
  item: CapabilityCatalogItem;
  inline?: boolean;
  /** A conversation card keeps its identity visible while setup expands. */
  showIdentity?: boolean;
  onCancel?: (() => void) | undefined;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  errorMessage: string | null;
  socialConnections?: SocialConnection[];
  canManageSocial: boolean;
  canManageSkills?: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const plan = useMemo(() => capabilityConnectPlan(item), [item]);
  const personalOnly = capabilityRequiresPersonalConnection(item);
  // API-key reconnect reveals the credential form in place of the button.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => setReconnecting(false), [item.id]);
  const [connectionOwnership, setConnectionOwnership] = useState<ConnectionOwnership>(
    personalOnly ? "personal" : DEFAULT_CONNECTION_OWNERSHIP,
  );
  useEffect(
    () => setConnectionOwnership(personalOnly ? "personal" : DEFAULT_CONNECTION_OWNERSHIP),
    [item.id, personalOnly],
  );

  const canDisconnect =
    !inline && item.enabled && item.kind === "mcp" && item.actions.includes("disconnect");
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
    <div
      className={cn("flex min-h-0 flex-col", inline ? "session-capability-card__form" : "flex-1")}
    >
      {inline && !showIdentity ? null : inline ? (
        <div className="flex items-start gap-3">
          <CapabilityLogo
            src={logoSrc}
            name={item.name}
            className="session-capability-identity-logo"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-fg">{item.name}</h3>
            {item.providerDomain ? (
              <p className="mt-0.5 text-xs text-fg-subtle">{item.providerDomain}</p>
            ) : null}
          </div>
          <MetaChip>{capabilityItemKindLabel(item)}</MetaChip>
        </div>
      ) : (
        <SheetHeader className="gap-3 border-b border-border p-6 pr-12 text-left sm:p-8 sm:pr-14">
          <div className="flex items-start gap-3">
            <CapabilityLogo
              src={logoSrc}
              name={item.name}
              size="lg"
              fallback={item.kind === "skill" ? <SparklesIcon className="size-5" /> : undefined}
            />
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-xl font-semibold tracking-tight">{item.name}</SheetTitle>
              <SheetDescription className="mt-0.5 text-xs text-fg-subtle">
                {capabilityItemKindLabel(item)}
                {capabilityCategoryLabel(item.category)
                  ? ` · ${capabilityCategoryLabel(item.category)}`
                  : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
      )}

      {/* Scrollable body */}
      <div
        className={cn(
          "min-h-0 flex-1",
          inline ? "space-y-3 text-xs" : "space-y-6 overflow-y-auto p-6 sm:p-8",
          inline && showIdentity && "mt-3",
        )}
      >
        {item.stale ? (
          <Notice tone="muted">
            No longer listed in the public registry. Existing installations keep working.
          </Notice>
        ) : null}

        {item.description && (!inline || showIdentity) ? (
          <p className="text-sm leading-6 text-fg-muted">{item.description}</p>
        ) : null}

        {!inline && item.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 10).map((tag) => (
              <MetaChip key={tag}>{tag}</MetaChip>
            ))}
          </div>
        ) : null}

        {!inline ? (
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
        ) : null}

        {inline && item.kind === "skill" ? (
          <div className="space-y-3 border-t border-border pt-3">
            <h4 className="text-xs font-medium text-fg">What this skill adds</h4>
            <p className="session-capability-card__lede text-fg-muted">
              {item.description || "Review this skill's source and version before installing."}
            </p>
            {curatedSkillProvenance(item) ? (
              <details className="session-capability-card__fine text-fg-subtle">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  Review source and version
                </summary>
                <div className="pt-3">
                  <CuratedSkillProvenanceSection item={item} />
                </div>
              </details>
            ) : null}
          </div>
        ) : (
          <CuratedSkillProvenanceSection item={item} />
        )}

        {/* Action — flows directly after the content so a sparse item stays a
            compact top-flowing column, with no dead void before a bottom-pinned
            button. The whole body scrolls only when content actually overflows. */}
        <div
          className={cn(
            "space-y-3",
            inline
              ? "[&>button]:ml-auto [&>button]:flex [&>button]:w-auto [&>div>button]:ml-auto [&>div>button]:flex [&>div>button]:w-auto"
              : "border-t border-border pt-5",
          )}
        >
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
          ) : item.kind === "skill" ? (
            <SkillControls
              item={item}
              busy={busy}
              canManage={canManageSkills}
              setupOnly={inline}
              onCancel={onCancel}
              onAction={onAction}
            />
          ) : plan.mode === "social_oauth" ? (
            <SocialConnectorControls
              item={item}
              provider={plan.provider}
              connections={socialConnections ?? []}
              ownership={connectionOwnership}
              onOwnershipChange={setConnectionOwnership}
              busy={busy}
              canManage={canManageSocial}
              setupOnly={inline}
              onAction={onAction}
            />
          ) : plan.mode === "fiken_api_token" ? (
            <FikenConnectorControls
              item={item}
              health={health}
              keyPageUrl={keyPageUrl}
              busy={busy}
              setupOnly={inline}
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
                    compact={inline}
                    onCancel={onCancel}
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
              {canDisconnect ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
                  disabled={busy}
                  onClick={() => onAction({ type: "disconnect", item })}
                >
                  {busy && !reconnect ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
                  Disconnect
                </Button>
              ) : !inline ? (
                <p className="text-center text-xs text-fg-subtle">
                  Manage this capability from its dedicated controls.
                </p>
              ) : null}
            </div>
          ) : plan.mode === "api_key" ? (
            <div className="space-y-3">
              <ConnectorConsentCopy
                presentation={capabilityPresentation(item.metadata)}
                requestedScopes={[]}
              />
              {personalOnly ? (
                <PersonalOnlyConnectionNotice itemName={item.name} />
              ) : (
                <OwnershipSelector
                  compact={inline}
                  value={connectionOwnership}
                  onChange={setConnectionOwnership}
                />
              )}
              <CredentialForm
                compact={inline}
                onCancel={onCancel}
                fields={plan.fields}
                itemName={item.name}
                keyPageUrl={keyPageUrl}
                submitLabel={
                  inline
                    ? "Verify & connect"
                    : connectionOwnership === "workspace"
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
              <ConnectorConsentCopy
                presentation={capabilityPresentation(item.metadata)}
                requestedScopes={plan.requestedScopes}
              />
              {personalOnly ? (
                <PersonalOnlyConnectionNotice itemName={item.name} />
              ) : (
                <OwnershipSelector
                  compact={inline}
                  value={connectionOwnership}
                  onChange={setConnectionOwnership}
                />
              )}
              <p
                className={cn(
                  inline
                    ? "session-capability-card__lede text-fg-subtle"
                    : "text-xs text-center text-fg-subtle",
                )}
              >
                {connectionOwnership === "workspace"
                  ? `You'll authorize ${item.name} once for this workspace. Provider actions may appear as the account you connect.`
                  : `You'll authorize ${item.name} for your personal use, then return here.`}
              </p>
              <ConnectionActions onCancel={onCancel} busy={busy}>
                <Button
                  type="button"
                  className="w-full"
                  disabled={busy}
                  onClick={() =>
                    onAction({
                      type: "oauth",
                      item,
                      ownership: connectionOwnership,
                    })
                  }
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : !inline ? <PlugIcon /> : null}
                  {inline
                    ? "Continue authorization"
                    : connectionOwnership === "workspace"
                      ? "Connect for workspace"
                      : "Connect only for me"}
                </Button>
              </ConnectionActions>
            </div>
          ) : plan.mode === "setup_required" ? (
            <p role="status" className="text-sm text-fg-muted">
              {item.metadata.authDiscovery === "checking"
                ? "Checking sign-in requirements…"
                : "Setup required. Check the provider’s instructions, or reopen to retry."}
            </p>
          ) : item.kind === "mcp" ? (
            <ConnectionActions onCancel={onCancel} busy={busy}>
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
                Add to workspace
              </Button>
            </ConnectionActions>
          ) : (
            <p className="text-center text-xs text-fg-subtle">
              Install or connect this capability from its dedicated controls.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillControls({
  item,
  busy,
  canManage,
  onAction,
  onCancel,
  setupOnly = false,
}: {
  item: CapabilityCatalogItem;
  busy: boolean;
  onCancel?: (() => void) | undefined;
  setupOnly?: boolean;
  canManage: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const updateAvailable = item.metadata.updateAvailable === true;
  return (
    <div className="space-y-3">
      {setupOnly && !item.enabled ? (
        <div className="space-y-2">
          <p className="session-capability-card__fine font-medium text-fg">Install for</p>
          <p className="session-capability-card__install border border-border bg-surface-2 text-fg">
            Workspace
          </p>
          <p className="session-capability-card__fine text-fg-subtle">
            Available to everyone on the team in this workspace.
          </p>
          <p className="session-capability-card__fine text-fg-subtle">
            This library skill can currently be installed for the workspace only.
          </p>
        </div>
      ) : null}
      {item.enabled ? (
        <div className="flex items-center gap-2 text-sm text-status-idle">
          <span className="size-2 rounded-full bg-status-idle" />
          {updateAvailable ? "Installed · update available" : "Installed"}
        </div>
      ) : null}
      {!item.enabled || updateAvailable ? (
        <ConnectionActions onCancel={onCancel} busy={busy}>
          <Button
            type="button"
            className="w-full"
            disabled={busy || !canManage || !item.runtime.available}
            onClick={() => onAction({ type: "install_skill", item })}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : !setupOnly ? <SparklesIcon /> : null}
            {busy && setupOnly
              ? "Installing…"
              : item.enabled
                ? "Update Skill"
                : setupOnly
                  ? "Install & use"
                  : "Install Skill"}
          </Button>
        </ConnectionActions>
      ) : null}
      {item.enabled && !setupOnly ? (
        <Button
          type="button"
          variant="outline"
          className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
          disabled={busy || !canManage}
          onClick={() => onAction({ type: "remove_skill", item })}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
          Remove Skill
        </Button>
      ) : null}
      {!canManage ? (
        <p className="text-center text-xs text-fg-muted">
          Workspace administrator permission is required to install, update, or remove Skills.
        </p>
      ) : null}
      <p className="text-center text-xs text-fg-subtle">
        Skills add reviewed instructions only. They never grant credentials or connect provider
        accounts.
      </p>
    </div>
  );
}

/**
 * Curated consent copy for a connector's OAuth connect: what agents will do
 * and what the requested scopes mean in plain language. Rendered only when the
 * catalog row carries `metadata.presentation`; an uncurated connector keeps
 * the plain connect button exactly as before. Presentation-only - the actual
 * grant is whatever the provider's consent screen shows.
 */
function ConnectorConsentCopy({
  presentation,
  requestedScopes,
}: {
  presentation: IntegrationPresentationCopy | undefined;
  requestedScopes: string[];
}) {
  if (!presentation) return null;
  const permissions = presentationPermissions(requestedScopes, presentation);
  // Content-derived keys with an ordinal suffix only for exact duplicates, so
  // reordering or removing unrelated entries never remounts a row.
  const uniqueKeys = (contents: string[]): string[] => {
    const seen = new Map<string, number>();
    return contents.map((content) => {
      const occurrence = seen.get(content) ?? 0;
      seen.set(content, occurrence + 1);
      return occurrence === 0 ? content : `${content}#${occurrence}`;
    });
  };
  const capabilityKeys = uniqueKeys(
    (presentation.capabilities ?? []).map((entry) => `${entry.title}:${entry.description}`),
  );
  const permissionKeys = uniqueKeys(
    permissions.map((entry) => `${entry.label}:${entry.description}`),
  );
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3 text-left">
      {presentation.introduction ? (
        <p className="text-sm text-fg">{presentation.introduction}</p>
      ) : null}
      {presentation.capabilities?.length ? (
        <ul className="space-y-1.5">
          {presentation.capabilities.map((capability, index) => (
            <li key={capabilityKeys[index]} className="text-xs">
              <span className="font-medium text-fg">{capability.title}</span>{" "}
              <span className="text-fg-muted">{capability.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {permissions.length > 0 ? (
        <ul className="space-y-1">
          {permissions.map((permission, index) => (
            <li key={permissionKeys[index]} className="text-xs">
              <span className="font-medium text-fg">{permission.label}</span>{" "}
              <span className="text-fg-muted">{permission.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {presentation.permissionSummary ? (
        <p className="text-xs text-fg-subtle">{presentation.permissionSummary}</p>
      ) : null}
    </div>
  );
}

function PersonalOnlyConnectionNotice({ itemName }: { itemName: string }) {
  return (
    <Notice tone="info">
      <span className="font-medium">Personal connection.</span> Other workspace members cannot
      discover or use this account. Each member connects their own. {itemName} content added to a
      session follows that session's visibility.
    </Notice>
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
  setupOnly = false,
}: {
  item: CapabilityCatalogItem;
  provider: "x" | "reddit";
  connections: SocialConnection[];
  ownership: ConnectionOwnership;
  onOwnershipChange: (ownership: ConnectionOwnership) => void;
  busy: boolean;
  setupOnly?: boolean;
  canManage: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const visibleConnections = socialConnectionsForOwnership(
    connections.filter((candidate) => candidate.provider === provider),
    ownership,
  );
  const connected = visibleConnections.filter((connection) => connection.status === "connected");
  const needsReauth = visibleConnections.filter(
    (connection) => connection.status === "needs_reauth",
  );
  const hasUsableAccount = connected.length + needsReauth.length > 0;
  const canConnect = ownership === "personal" || canManage;
  return (
    <div className="space-y-3">
      <OwnershipSelector compact={setupOnly} value={ownership} onChange={onOwnershipChange} />
      {visibleConnections.length > 0 ? (
        <div className="divide-y divide-border rounded-lg border border-border" role="list">
          {visibleConnections.map((connection) => (
            <div
              key={connection.id}
              className="flex min-h-14 items-center gap-3 px-3 py-2.5"
              role="listitem"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  connection.status === "connected"
                    ? "bg-status-idle"
                    : connection.status === "needs_reauth"
                      ? "bg-status-waiting"
                      : "bg-status-cancelled",
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-fg">
                  {connection.accountName || `@${connection.accountHandle}`}
                </p>
                <p className="truncate text-2xs text-fg-subtle">
                  @{connection.accountHandle} · {socialConnectionStatusLabel(connection.status)}
                </p>
              </div>
              {!setupOnly && connection.status !== "disabled" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
                  disabled={busy || !canConnect}
                  aria-label={`Disconnect @${connection.accountHandle}`}
                  onClick={() =>
                    onAction({
                      type: "disconnect_social",
                      item,
                      connectionId: connection.id,
                    })
                  }
                >
                  <TrashIcon />
                  Disconnect
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        className="w-full"
        disabled={busy || !canConnect}
        onClick={() => onAction({ type: "social_oauth", item, provider, ownership })}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
        {needsReauth.length > 0
          ? `Reconnect or add ${item.name} account`
          : hasUsableAccount
            ? `Add another ${item.name} account`
            : ownership === "workspace"
              ? `Connect ${item.name} for workspace`
              : `Connect ${item.name} only for me`}
      </Button>
      <p className="text-center text-xs text-fg-subtle">
        {ownership === "workspace"
          ? "Workspace shared. Agents and scheduled automations can use the connected account; connect a brand account rather than a personal one."
          : "Personal. Used only by work carrying your explicit connection authority, including tasks you create from that authority."}
      </p>
      {ownership === "workspace" && !canManage ? (
        <p className="text-center text-xs text-fg-subtle">
          Workspace admin permission is required to manage this connection.
        </p>
      ) : null}
    </div>
  );
}

const FIKEN_TOKEN_FIELD = { name: "apiToken", label: "Personal API token" };

/**
 * Connect / reconnect / disconnect controls for the first-party Fiken
 * connector. Phase 1 is workspace-owned only, so there is no ownership
 * selector; the token is verified against Fiken before it is stored.
 */
export function FikenConnectorControls({
  item,
  health,
  keyPageUrl,
  busy,
  onAction,
  setupOnly = false,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  keyPageUrl: string | null;
  busy: boolean;
  setupOnly?: boolean;
  onAction: (action: ConnectAction) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [usingToken, setUsingToken] = useState(false);
  useEffect(() => {
    setReplacing(false);
    setUsingToken(false);
  }, [item.id]);
  const connection =
    health.state === "connected" || health.state === "attention" ? health.connection : null;

  const tokenForm = (submitLabel: string, submitIcon: ReactNode) => (
    <CredentialForm
      compact={setupOnly}
      fields={[FIKEN_TOKEN_FIELD]}
      itemName={item.name}
      keyPageUrl={keyPageUrl}
      submitLabel={submitLabel}
      submitIcon={submitIcon}
      busy={busy}
      onSubmit={(next) =>
        onAction({
          type: "fiken_api_token",
          item,
          apiToken: next[FIKEN_TOKEN_FIELD.name] ?? "",
          connectionId: connection?.id ?? null,
        })
      }
    />
  );

  const oauthButton = (label: string, icon: ReactNode) => (
    <Button
      type="button"
      className="w-full"
      disabled={busy}
      onClick={() =>
        onAction({
          type: "fiken_oauth",
          item,
          connectionId: connection?.id ?? null,
        })
      }
    >
      {busy ? <Loader2Icon className="animate-spin" /> : icon}
      {label}
    </Button>
  );

  const tokenFallbackToggle = (
    <button
      type="button"
      className="mx-auto block text-xs font-medium text-brand hover:underline"
      onClick={() => setUsingToken(true)}
    >
      Use a personal API token instead
    </button>
  );

  if (health.state === "connected" && connection) {
    return (
      <div className="space-y-3">
        <ConnectionStatus item={item} health={health} />
        {replacing ? (
          <div className="space-y-3">
            {oauthButton("Re-authorize with Fiken", <RefreshCwIcon />)}
            {tokenForm("Replace API token", <RefreshCwIcon />)}
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => setReplacing(true)}
          >
            <RefreshCwIcon />
            Replace credential
          </Button>
        )}
        {!setupOnly ? (
          <Button
            type="button"
            variant="outline"
            className="w-full text-status-failed hover:bg-status-failed/10 hover:text-status-failed pointer-coarse:min-h-11"
            disabled={busy}
            onClick={() =>
              onAction({
                type: "fiken_disconnect",
                item,
                connectionId: connection.id,
              })
            }
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
            Disconnect
          </Button>
        ) : null}
        <p className="text-center text-xs text-fg-subtle">
          Credentials are stored encrypted and used only for this workspace's Fiken tools.
        </p>
      </div>
    );
  }

  if (health.state === "attention") {
    return (
      <div className="space-y-3">
        <ConnectionStatus item={item} health={health} />
        {oauthButton(`Reconnect ${item.name}`, <RefreshCwIcon />)}
        {usingToken
          ? tokenForm("Reconnect with API token", <RefreshCwIcon />)
          : tokenFallbackToggle}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {oauthButton("Connect with Fiken", <PlugIcon />)}
      <p className="text-center text-xs text-fg-subtle">
        You'll sign in at Fiken and approve access once for this workspace. Everyone in the
        workspace can then use the Fiken tools through this connection.
      </p>
      {usingToken ? (
        <div className="space-y-3">
          {tokenForm("Connect for workspace", <PlugIcon />)}
          <p className="text-center text-xs text-fg-subtle">
            Create a personal API token in Fiken under Rediger konto → API. Fiken's terms allow
            personal tokens only for integrating your own company.
          </p>
        </div>
      ) : (
        tokenFallbackToggle
      )}
    </div>
  );
}

function socialConnectionStatusLabel(status: SocialConnection["status"]): string {
  if (status === "connected") return "Connected";
  if (status === "needs_reauth") return "Needs reconnection";
  return "Disconnected";
}

export function OwnershipSelector({
  value,
  onChange,
  compact = false,
}: {
  value: ConnectionOwnership;
  onChange: (value: ConnectionOwnership) => void;
  compact?: boolean;
}) {
  const groupName = useId();
  if (compact) {
    const descriptionId = `${groupName}-description`;
    return (
      <fieldset className="space-y-2" aria-describedby={descriptionId}>
        <legend className="session-capability-card__fine font-medium text-fg">Connect for</legend>
        <div className="session-capability-card__choice">
          {(["workspace", "personal"] as const).map((ownership) => (
            <label key={ownership} className="relative cursor-pointer">
              <input
                className="peer sr-only"
                type="radio"
                name={groupName}
                value={ownership}
                checked={value === ownership}
                onChange={() => onChange(ownership)}
              />
              <span className="session-capability-card__choice-label border border-border text-fg-muted peer-checked:bg-surface-2 peer-checked:text-fg peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {ownership === "workspace" ? "Workspace" : "Only me"}
              </span>
            </label>
          ))}
        </div>
        <p id={descriptionId} className="session-capability-card__fine text-fg-subtle">
          {value === "workspace"
            ? "Shared with agents and automations in this workspace."
            : "Used only when work is authorized to act as you."}
        </p>
      </fieldset>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-fg-muted">Who can use this connection?</legend>
      <OwnershipOption
        groupName={groupName}
        checked={value === "workspace"}
        value="workspace"
        title="Connect for workspace"
        description="Shared with agents and automations in this workspace."
        onChange={() => onChange("workspace")}
      />
      <OwnershipOption
        groupName={groupName}
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
  groupName,
  checked,
  value,
  title,
  description,
  onChange,
}: {
  groupName: string;
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
        name={groupName}
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
        <MetaRow label="Source version">
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
  onCancel,
  compact = false,
}: {
  fields: { name: string; label: string }[];
  itemName: string;
  keyPageUrl: string | null;
  submitLabel: string;
  submitIcon: ReactNode;
  busy: boolean;
  onCancel?: (() => void) | undefined;
  compact?: boolean;
  onSubmit: (headers: Record<string, string>) => void;
}) {
  const inputId = useId();
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
          <Label htmlFor={`${inputId}-cred-${field.name}`} className="text-xs text-fg-muted">
            {field.label}
          </Label>
          <Input
            id={`${inputId}-cred-${field.name}`}
            type="password"
            autoComplete="off"
            value={headers[field.name] ?? ""}
            onChange={(event) =>
              setHeaders((current) => ({
                ...current,
                [field.name]: event.target.value,
              }))
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
          {compact
            ? `Where do I find my ${fields[0]?.label ?? "credentials"}?`
            : `Get your ${fields[0]?.label ?? "credentials"}`}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : !compact ? (
        <p className="text-xs text-fg-subtle">
          Stored encrypted and used only to reach {itemName}.
        </p>
      ) : null}
      {compact ? (
        <p className="session-capability-card__fine text-fg-subtle">
          Your credential is stored encrypted, never in the conversation.
        </p>
      ) : null}
      <ConnectionActions onCancel={onCancel} busy={busy}>
        <Button type="submit" className="w-full" disabled={busy || !ready}>
          {busy ? <Loader2Icon className="animate-spin" /> : compact ? null : submitIcon}
          {busy && compact ? "Connecting…" : submitLabel}
        </Button>
      </ConnectionActions>
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

/** The same action row for inline OAuth review, credentials, and Skills. */
function ConnectionActions({
  onCancel,
  busy,
  children,
}: {
  onCancel?: (() => void) | undefined;
  busy: boolean;
  children: ReactNode;
}) {
  if (!onCancel) return children;
  return (
    <div className="flex items-center justify-end gap-2 [&>button]:w-auto">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      {children}
    </div>
  );
}
