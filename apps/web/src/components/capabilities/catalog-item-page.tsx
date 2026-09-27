import {
  Loader2Icon,
  PuzzleIcon,
  RefreshCwIcon,
  SparklesIcon,
  TrashIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  capabilityDescription,
  capabilityPublisher,
  capabilityTitle,
  isCommunityCapability,
  ownershipLabel,
  OWNERSHIP_HELP,
  personalOnlyCapability,
} from "@/components/capabilities/capability-copy";
import {
  CredentialForm,
  FikenConnectorControls,
  type ConnectAction,
} from "@/components/capabilities/capability-detail-sheet";
import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  OutcomeList,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import { ConnectorToolPermissions } from "@/components/capabilities/connector-tool-permissions";
import {
  capabilityPresentation,
  presentationPermissions,
} from "@/components/capabilities/integration-experience";
import { MoreMenu, RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import {
  capabilityCategoryLabel,
  capabilityConnectPlan,
  capabilityReconnectPlan,
  capabilitySourceLabel,
  capabilityStateChip,
  curatedSkillProvenance,
  defaultCapabilityConnectionOwnership,
  GENERIC_API_KEY_FIELD,
  socialConnectionsForOwnership,
  type ConnectionHealth,
} from "@/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionOwnership, SocialConnection } from "@/types";

/* ----------------------------------------------------------------------------
   The page for a catalog entry: a connection from the catalog or the public
   registry, a first-party API (Reddit, Fiken) or a library skill. The same
   ConnectAction contract the old dialog used; the page only changes where
   things sit and what they are called.
   -------------------------------------------------------------------------- */

const buttonClass = "rounded-[10px] pointer-coarse:h-11";

export function CatalogItemPage({
  workspaceId,
  item,
  health,
  logoSrc,
  busy,
  errorMessage,
  socialConnections,
  canManageSocial,
  canManageSkills,
  onAction,
  onConnectAccount,
  onBack,
  backLabel,
}: {
  workspaceId: string;
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  errorMessage: string | null;
  socialConnections: SocialConnection[];
  canManageSocial: boolean;
  canManageSkills: boolean;
  onAction: (action: ConnectAction) => void;
  /** Sign-in connections run their short connect step (a popup flow) in a dialog. */
  onConnectAccount?: (() => void) | undefined;
  onBack: () => void;
  backLabel?: string;
}) {
  const plan = useMemo(() => capabilityConnectPlan(item), [item]);
  const personalOnly = personalOnlyCapability(item);
  const defaultOwnership = personalOnly ? "personal" : defaultCapabilityConnectionOwnership(item);
  const [ownership, setOwnership] = useState<ConnectionOwnership>(defaultOwnership);
  useEffect(() => setOwnership(defaultOwnership), [item.id, defaultOwnership]);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => setReconnecting(false), [item.id]);

  const title = capabilityTitle(item);
  const description = capabilityDescription(item);
  const publisher = capabilityPublisher(item);
  const community = isCommunityCapability(item);
  const category = capabilityCategoryLabel(item.category);
  const presentation = capabilityPresentation(item.metadata);
  const outcomes = [
    ...(presentation?.capabilities ?? []),
    ...presentationPermissions(plan.mode === "oauth" ? plan.requestedScopes : [], presentation).map(
      (permission) => ({ title: permission.label, description: permission.description }),
    ),
  ].slice(0, 4);
  const reconnect = capabilityReconnectPlan(item, health);
  const canDisconnect = item.enabled && item.kind === "mcp" && item.actions.includes("disconnect");
  const isSkill = item.kind === "skill";
  const signInFlow =
    item.kind === "mcp" && item.authKind === "oauth2" && !item.enabled && onConnectAccount;
  const keyPageUrl = item.installUrl ?? item.homepageUrl;
  const chip = capabilityStateChip(item, health);
  const status = isSkill
    ? item.enabled
      ? item.metadata.updateAvailable === true
        ? "Update available"
        : "Installed"
      : undefined
    : item.surfaceType === "codex_apps"
      ? item.runtime.available
        ? "Connected"
        : "Unavailable"
      : plan.mode === "social_oauth"
        ? socialConnections.some(
            (connection) =>
              connection.provider === plan.provider && connection.status === "needs_reauth",
          )
          ? "Needs attention"
          : socialConnections.some(
                (connection) =>
                  connection.provider === plan.provider && connection.status === "connected",
              )
            ? "Connected"
            : undefined
        : plan.mode === "fiken_api_token"
          ? health.state === "connected"
            ? "Connected"
            : health.state === "attention"
              ? "Needs attention"
              : undefined
          : chip.label;
  const spinner = <Loader2Icon className="animate-spin" aria-hidden="true" />;
  const socialAccounts =
    plan.mode === "social_oauth"
      ? socialConnectionsForOwnership(
          socialConnections.filter((connection) => connection.provider === plan.provider),
          ownership,
        )
      : [];
  const canConnectSocial = ownership === "personal" || canManageSocial;
  const connectedScope: "personal" | "workspace" | null = item.enabled
    ? item.connectionRef?.subjectScope === "subject" ||
      (health.state === "connected" || health.state === "attention"
        ? (health.connection?.subjectId ?? null) !== null
        : false)
      ? "personal"
      : item.connectionRef
        ? "workspace"
        : null
    : null;

  // --- Header actions: at most one primary, then the ⋯ menu. -----------------
  let primary: ReactNode = null;
  const menu: ReactNode[] = [];
  if (isSkill) {
    const updateAvailable = item.metadata.updateAvailable === true;
    if (!item.enabled || updateAvailable) {
      primary = (
        <Button
          type="button"
          size="sm"
          className={buttonClass}
          disabled={busy || !canManageSkills || !item.runtime.available}
          onClick={() => onAction({ type: "install_skill", item })}
        >
          {busy ? spinner : null}
          {item.enabled ? "Update skill" : "Install skill"}
        </Button>
      );
    }
    if (item.enabled) {
      menu.push(
        <DropdownMenuItem
          key="remove"
          variant="destructive"
          disabled={busy || !canManageSkills}
          onSelect={() => onAction({ type: "remove_skill", item })}
        >
          <TrashIcon />
          Remove skill
        </DropdownMenuItem>,
      );
    }
  } else if (item.surfaceType === "codex_apps") {
    primary = null;
  } else if (plan.mode === "social_oauth") {
    primary = (
      <Button
        type="button"
        size="sm"
        className={buttonClass}
        disabled={busy || !canConnectSocial}
        onClick={() => onAction({ type: "social_oauth", item, provider: plan.provider, ownership })}
      >
        {busy ? spinner : null}
        {socialAccounts.some((connection) => connection.status === "needs_reauth")
          ? `Reconnect ${title}`
          : socialAccounts.some((connection) => connection.status === "connected")
            ? "Add another account"
            : `Connect ${title}`}
      </Button>
    );
  } else if (item.enabled) {
    if (reconnect?.kind === "oauth") {
      primary = (
        <Button
          type="button"
          size="sm"
          className={buttonClass}
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
          {busy ? spinner : <RefreshCwIcon aria-hidden="true" />}
          Reconnect
        </Button>
      );
    } else if (reconnect?.kind === "api_key" && !reconnecting) {
      primary = (
        <Button
          type="button"
          size="sm"
          className={buttonClass}
          disabled={busy}
          onClick={() => setReconnecting(true)}
        >
          <RefreshCwIcon aria-hidden="true" />
          Reconnect
        </Button>
      );
    }
    if (canDisconnect) {
      menu.push(
        <DropdownMenuItem
          key="disconnect"
          variant="destructive"
          disabled={busy}
          onSelect={() => onAction({ type: "disconnect", item })}
        >
          <UnplugIcon />
          Disconnect
        </DropdownMenuItem>,
      );
    }
  } else if (signInFlow) {
    primary = (
      <Button type="button" size="sm" className={buttonClass} onClick={onConnectAccount}>
        {`Connect ${title}`}
      </Button>
    );
  } else if (plan.mode === "oauth") {
    primary = (
      <Button
        type="button"
        size="sm"
        className={buttonClass}
        disabled={busy}
        onClick={() => onAction({ type: "oauth", item, ownership })}
      >
        {busy ? spinner : null}
        {`Connect ${title}`}
      </Button>
    );
  } else if (plan.mode === "enable" && item.kind === "mcp") {
    primary = (
      <Button
        type="button"
        size="sm"
        className={buttonClass}
        disabled={busy || !item.runtime.available}
        title={!item.runtime.available ? (item.runtime.notes ?? undefined) : undefined}
        onClick={() => onAction({ type: "enable", item })}
      >
        {busy ? spinner : null}
        {`Connect ${title}`}
      </Button>
    );
  }

  // --- The one section where you set it up, when setting it up needs input. ---
  const ownershipChoice =
    personalOnly || item.enabled ? null : (
      <ChoiceCards
        label="Who can use it?"
        value={ownership}
        onValueChange={(value) => setOwnership(value as ConnectionOwnership)}
        disabled={busy}
      >
        <ChoiceCard
          value="workspace"
          title="Everyone in this workspace"
          description={OWNERSHIP_HELP.workspace}
        />
        <ChoiceCard value="personal" title="Only me" description={OWNERSHIP_HELP.personal} />
      </ChoiceCards>
    );

  let setup: ReactNode = null;
  if (!isSkill && item.surfaceType !== "codex_apps") {
    if (plan.mode === "social_oauth") {
      setup = (
        <DetailSection title={socialAccounts.length ? "Accounts" : `Connect ${title}`}>
          <div className="grid gap-5">
            <ChoiceCards
              label="Who can use it?"
              value={ownership}
              onValueChange={(value) => setOwnership(value as ConnectionOwnership)}
              disabled={busy}
            >
              <ChoiceCard
                value="workspace"
                title="Everyone in this workspace"
                description={OWNERSHIP_HELP.workspace}
                disabled={!canManageSocial}
                disabledReason={
                  canManageSocial
                    ? undefined
                    : "Only workspace admins can connect a shared account."
                }
              />
              <ChoiceCard value="personal" title="Only me" description={OWNERSHIP_HELP.personal} />
            </ChoiceCards>
            {socialAccounts.length ? (
              <ul className="m-0 list-none divide-y divide-border p-0">
                {socialAccounts.map((connection) => (
                  <li key={connection.id} className="flex min-w-0 items-center gap-3 py-3">
                    <span
                      aria-hidden="true"
                      className={
                        connection.status === "connected"
                          ? "size-2 shrink-0 rounded-full bg-status-idle"
                          : connection.status === "needs_reauth"
                            ? "size-2 shrink-0 rounded-full bg-status-waiting"
                            : "size-2 shrink-0 rounded-full bg-fg-subtle"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-sm leading-5 font-medium text-fg">
                        {connection.accountName || `@${connection.accountHandle}`}
                      </p>
                      <p className="m-0 truncate text-xs leading-4.5 text-fg-muted">
                        {`@${connection.accountHandle} · ${
                          connection.status === "connected"
                            ? "Connected"
                            : connection.status === "needs_reauth"
                              ? "Needs you to sign in again"
                              : "Disconnected"
                        }`}
                      </p>
                    </div>
                    {connection.status !== "disabled" ? (
                      <RowButton
                        disabled={busy || !canConnectSocial}
                        aria-label={`Disconnect @${connection.accountHandle}`}
                        className="text-fg-muted hover:text-danger"
                        onClick={() =>
                          onAction({
                            type: "disconnect_social",
                            item,
                            connectionId: connection.id,
                          })
                        }
                      >
                        Disconnect
                      </RowButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </DetailSection>
      );
    } else if (plan.mode === "fiken_api_token") {
      setup = (
        <DetailSection title="Connection">
          <div className="max-w-md [&_.text-center]:text-left [&_button.w-full]:w-auto [&_button.mx-auto]:mx-0">
            <FikenConnectorControls
              item={item}
              health={health}
              keyPageUrl={keyPageUrl}
              busy={busy}
              onAction={onAction}
            />
          </div>
        </DetailSection>
      );
    } else if (item.enabled) {
      setup =
        reconnecting && reconnect?.kind === "api_key" ? (
          <DetailSection title="Reconnect" description="Paste a new credential to keep it working.">
            <div className="max-w-md">
              <CredentialForm
                fields={
                  plan.mode === "api_key" && plan.fields.length > 0
                    ? plan.fields
                    : [GENERIC_API_KEY_FIELD]
                }
                itemName={title}
                keyPageUrl={keyPageUrl}
                submitLabel="Reconnect"
                submitIcon={<RefreshCwIcon />}
                busy={busy}
                onCancel={() => setReconnecting(false)}
                onSubmit={(headers) =>
                  onAction({
                    type: "reconnect_api_key",
                    item,
                    connectionId: reconnect.connectionId,
                    ownership: reconnect.ownership,
                    headers,
                  })
                }
              />
            </div>
          </DetailSection>
        ) : health.state === "attention" ? (
          <DetailSection>
            <Notice tone="waiting" title={`Sign in again to keep using ${title}`}>
              {connectedScope === "personal"
                ? "Your connection stopped working."
                : "The workspace connection stopped working."}
            </Notice>
          </DetailSection>
        ) : null;
    } else if (plan.mode === "api_key") {
      setup = (
        <DetailSection
          title={`Connect ${title}`}
          description="Use a key for your own account or a service account. It is stored encrypted."
        >
          <div className="grid max-w-md gap-5">
            {ownershipChoice}
            <CredentialForm
              fields={plan.fields}
              itemName={title}
              keyPageUrl={keyPageUrl}
              submitLabel={`Connect ${title}`}
              submitIcon={null}
              busy={busy}
              onSubmit={(headers) => onAction({ type: "api_key", item, ownership, headers })}
            />
          </div>
        </DetailSection>
      );
    } else if (plan.mode === "oauth" && !signInFlow) {
      setup = (
        <DetailSection title={`Connect ${title}`}>
          {ownershipChoice ?? (
            <p className="m-0 text-sm leading-5 text-fg-muted">{OWNERSHIP_HELP.personalOnly}</p>
          )}
        </DetailSection>
      );
    } else if (plan.mode === "setup_required") {
      setup = (
        <DetailSection>
          <p role="status" className="m-0 text-sm leading-5 text-fg-muted">
            {item.metadata.authDiscovery === "checking"
              ? "Checking how to sign in…"
              : "This connection needs setup the catalog can't describe yet. Follow the provider's instructions, then come back to connect it."}
          </p>
        </DetailSection>
      );
    }
  }

  const provenance = curatedSkillProvenance(item);
  const scopes = plan.mode === "oauth" ? plan.requestedScopes : [];

  return (
    <CapabilityPage
      onBack={onBack}
      backLabel={backLabel}
      mark={
        <CapabilityMark
          name={title}
          src={logoSrc}
          icon={isSkill ? <SparklesIcon /> : item.kind === "mcp" ? undefined : <PuzzleIcon />}
        />
      }
      title={title}
      status={status}
      chips={community ? <MetaChip variant="outline">Community</MetaChip> : undefined}
      meta={[publisher ? `By ${publisher}` : null, category, isSkill ? "Skill" : null]}
      actions={
        primary || menu.length ? (
          <>
            {primary}
            {menu.length ? <MoreMenu label={`More actions for ${title}`}>{menu}</MoreMenu> : null}
          </>
        ) : undefined
      }
      aside={
        <CapabilityAside
          name={title}
          items={[
            publisher ? { label: "Made by", value: publisher } : null,
            !isSkill && item.kind === "mcp"
              ? {
                  label: "Who can use it",
                  value: connectedScope
                    ? ownershipLabel(connectedScope)
                    : personalOnly
                      ? "Each person connects their own account"
                      : "You choose when you connect",
                }
              : null,
            community ? { label: "Source", value: "Community - not reviewed by OpenGeni" } : null,
            category ? { label: "Category", value: category } : null,
          ]}
        />
      }
    >
      {item.stale ? (
        <DetailSection>
          <Notice tone="muted">
            No longer listed in the public registry. Existing connections keep working.
          </Notice>
        </DetailSection>
      ) : null}
      {errorMessage ? (
        <DetailSection>
          <Notice tone="failed" title="That didn't work">
            {errorMessage}
          </Notice>
        </DetailSection>
      ) : null}

      <DetailSection title="About">
        {description || presentation?.introduction ? (
          <p className="m-0 text-sm leading-6 text-fg">
            {presentation?.introduction ?? description}
          </p>
        ) : (
          <p className="m-0 text-sm leading-6 text-fg-muted">
            {isSkill
              ? "Instructions agents load when they need them."
              : `Lets agents use ${title}.`}
          </p>
        )}
        {outcomes.length ? (
          <div className="mt-4">
            <OutcomeList items={outcomes} />
          </div>
        ) : null}
        {isSkill ? (
          <p className="mt-4 mb-0 text-xs leading-4.5 text-fg-muted">
            Skills add instructions only. They never get credentials or connect accounts.
            {!canManageSkills ? " Only workspace admins can install or remove skills." : ""}
          </p>
        ) : null}
        {item.surfaceType === "codex_apps" ? (
          <p className="mt-4 mb-0 text-xs leading-4.5 text-fg-muted">
            {item.runtime.available
              ? "Uses the Codex account chosen for Apps in workspace settings. Pick it from a session's tools."
              : "Choose a Codex account for Apps in workspace settings first."}
          </p>
        ) : null}
        {connectedScope ? (
          <p className="mt-4 mb-0 text-xs leading-4.5 text-fg-muted">
            {connectedScope === "personal" ? OWNERSHIP_HELP.personal : OWNERSHIP_HELP.workspace}
          </p>
        ) : null}
      </DetailSection>

      {setup}

      {workspaceId &&
      item.enabled &&
      item.kind === "mcp" &&
      item.source !== "built_in" &&
      item.surfaceType !== "codex_apps" ? (
        <DetailSection
          title="Approvals"
          description="Choose which actions need your OK. Applies to new messages."
        >
          <ConnectorToolPermissions
            key={`${workspaceId}:${item.id}`}
            workspaceId={workspaceId}
            capabilityId={item.id}
            bare
          />
        </DetailSection>
      ) : null}

      <TechnicalDetails
        facts={[
          { label: "Source", value: capabilitySourceLabel(item.source) },
          { label: "Provider", value: item.providerDomain ?? null },
          { label: "Endpoint", value: item.mcpUrl ?? item.endpointUrl ?? null, mono: true },
          {
            label: "Homepage",
            value: item.homepageUrl ? <ExternalLink href={item.homepageUrl} /> : null,
          },
          {
            label: "Setup guide",
            value:
              item.installUrl && item.installUrl !== item.homepageUrl ? (
                <ExternalLink href={item.installUrl} />
              ) : null,
          },
          {
            label: "Access requested",
            value: scopes.length ? scopes.join(", ") : null,
            mono: true,
          },
          {
            label: "Version",
            value: provenance?.version ?? null,
            mono: true,
          },
          { label: "Content hash", value: provenance?.contentSha256 ?? null, mono: true },
          { label: "Source version", value: provenance?.sourceCommit ?? null, mono: true },
          { label: "License", value: provenance?.license ?? null },
          { label: "ID", value: item.id, mono: true },
        ]}
      />
    </CapabilityPage>
  );
}

function ExternalLink({ href }: { href: string }) {
  let label = href;
  try {
    label = new URL(href).hostname;
  } catch {
    // Not a URL: show it as written.
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-brand hover:underline"
    >
      {label}
    </a>
  );
}
