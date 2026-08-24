import {
  hasOpenGeniSlackReactionScope,
  resolveWorkspaceSlackOrchestrationNoticeSettings,
  resolveWorkspaceSlackReactionSummonSettings,
  type ResolvedWorkspaceSlackOrchestrationNoticeSettings,
  type WorkspaceSlackReactionSummonSettings,
} from "@opengeni/contracts";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";
import type { MemorySlackPublicationConfiguration, SlackReactionChannel } from "@opengeni/sdk";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type {
  IntegrationAccess,
  IntegrationChip,
  IntegrationFact,
  IntegrationFooter,
  IntegrationOption,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { SlackReactionChannelsDialog } from "@/components/capabilities/slack-reaction-channels-dialog";
import type { IntegrationAdapter } from "@/components/capabilities/use-api-integration-accounts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import { startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import {
  personalSlackAccountState,
  personalSlackCapability,
  personalSlackOAuthTarget,
  preferredPersonalSlackConnection,
  type PersonalSlackAccountState,
} from "@/lib/personal-slack";
import {
  openGeniSlackBotConnections,
  openGeniSlackBotInstallInput,
  openGeniSlackBotUiMetadata,
  preferredOpenGeniSlackBotConnection,
} from "@/lib/slack-bot";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  ConnectorDocumentDestinationAuthority,
  SlackInstallationBinding,
} from "@/types";

// The publication dialog and its SDK client stay behind a lazy boundary: they
// are admin-only detail and would otherwise fold the memory-slack client into
// the shared startup graph.
const MemorySlackPublicationDialog = lazy(async () => {
  const module = await import("@/components/capabilities/memory-slack-publication-dialog");
  return { default: module.MemorySlackPublicationDialog };
});
async function memorySlackClient(client: ReturnType<typeof useAppContext>["client"]) {
  const module = await import("@/components/capabilities/memory-slack-publication-dialog");
  return module.createMemorySlackClient(client);
}

export const SLACK_APP_DESCRIPTION = "Chat with OpenGeni and start work from Slack.";
export const SLACK_LOGO_URL =
  "https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png";
const OPENGENI_REACTION_EMOJI = "genie" as const;

/** A DEV-only connected preview so the sheet can be reviewed without real Slack rows. */
export function localConnectedSlackPreview(
  search: string,
  workspaceId: string,
  enabled = import.meta.env.DEV,
): { bot: ConnectionMetadata; personal: PersonalSlackAccountState } | null {
  if (!enabled || new URLSearchParams(search).get("previewSlack") !== "connected") return null;
  const now = new Date().toISOString();
  const shared = {
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId,
    providerDomain: "slack.com",
    status: "active" as const,
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    createdBySubjectId: "preview-user",
    updatedBySubjectId: "preview-user",
    createdAt: now,
    updatedAt: now,
  };
  const personal: ConnectionMetadata = {
    ...shared,
    id: "00000000-0000-4000-8000-000000000002",
    subjectId: "preview-user",
    kind: "oauth2",
    grantedScopes: ["search:read.public", "channels:history", "chat:write"],
    metadata: {},
  };
  return {
    bot: {
      ...shared,
      id: "00000000-0000-4000-8000-000000000003",
      subjectId: null,
      kind: "app_install" as const,
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      verifiedInstallAt: now,
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: "opengeni_slack_bot",
        credentialLabel: "OpenGeni Slack bot",
        slackTeamId: "T_CLOUDGENI_PREVIEW",
        slackTeamName: "CloudGeni",
        botId: "B_CLOUDGENI_PREVIEW",
        botUserId: "U_CLOUDGENI_PREVIEW",
        botDisplayName: "OpenGeni",
      },
    } satisfies ConnectionMetadata,
    personal: {
      state: "connected" as const,
      connection: personal,
      accessTokenRefreshDue: false,
    },
  };
}

export function canWriteWorkspaceConnections(
  accessContext: ReturnType<typeof useAppContext>["accessContext"],
  workspaceId: string,
): boolean {
  return hasWorkspacePermission(accessContext, workspaceId, "connections:write");
}

export function canInstallOpenGeniSlackBot(
  accessContext: ReturnType<typeof useAppContext>["accessContext"],
  workspaceId: string,
): boolean {
  return canWriteWorkspaceConnections(accessContext, workspaceId);
}

export function canManageSlackReactionSummon(
  accessContext: ReturnType<typeof useAppContext>["accessContext"],
  workspaceId: string,
): boolean {
  return hasWorkspacePermission(accessContext, workspaceId, "workspace:admin");
}

export function slackBotDocumentDestinationAuthority(
  metadata: Record<string, unknown> | undefined,
): ConnectorDocumentDestinationAuthority {
  const destination = metadata?.documentDestination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return "workspace";
  }
  const authorityKind = (destination as Record<string, unknown>).authorityKind;
  return authorityKind === "organization" || authorityKind === "workspace"
    ? authorityKind
    : "workspace";
}

/**
 * Slack bot knowledge destinations are shared-only (workspace or organization).
 * A legacy stored `personal` value displays as Workspace, and every save
 * persists the same shared coercion instead of echoing `personal` back.
 */
export function slackBotPersistableDestinationAuthority(
  value: string,
): ConnectorDocumentDestinationAuthority {
  return value === "organization" ? "organization" : "workspace";
}

/** The member-facing sentence when personal Slack needs connections:write. */
export const SLACK_PERSONAL_PERMISSION_SENTENCE =
  "Slack connects here as your own personal Slack account. Connection management permission is required to connect or change it; ask a workspace admin to grant it.";

/**
 * Maps Slack onto the shared integration view-model. Anyone with connection
 * management permission (connections:write or workspace admin) sees the
 * OpenGeni bot (its installation, what it can see, and install/reconnect/
 * disconnect; the options stay admin-gated); everyone else sees their own
 * personal Slack account. Nobody is offered both.
 */
export function useSlackIntegration({
  workspaceId,
  items,
  connections,
  connectionsLoaded,
  slackInstallationBindings,
  sheetOpen,
  refresh,
  onRuntimeChanged,
}: {
  workspaceId: string;
  items: CapabilityCatalogItem[];
  connections: ConnectionMetadata[] | null;
  connectionsLoaded: boolean;
  slackInstallationBindings: SlackInstallationBinding[];
  sheetOpen: boolean;
  refresh: () => Promise<void>;
  onRuntimeChanged: () => void;
}): IntegrationAdapter {
  const context = useAppContext();
  const client = context.client;
  const isAdmin = canManageSlackReactionSummon(context.accessContext, workspaceId);
  const canInstallBot = canInstallOpenGeniSlackBot(context.accessContext, workspaceId);
  const canManagePersonal = canWriteWorkspaceConnections(context.accessContext, workspaceId);
  const workspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageWorkspaceDestination = isAdmin;
  const canManageOrganizationDestination = Boolean(
    workspaceGrant &&
    hasAccountPermission(context.accessContext, workspaceGrant.accountId, "account:admin"),
  );
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const reactionSettings = useMemo(
    () => resolveWorkspaceSlackReactionSummonSettings(workspace?.settings),
    [workspace?.settings],
  );
  // Both orchestration notices are off until this workspace turns them on.
  const orchestrationNotices = useMemo(
    () => resolveWorkspaceSlackOrchestrationNoticeSettings(workspace?.settings),
    [workspace?.settings],
  );

  const [botBusy, setBotBusy] = useState(false);
  const [personalBusy, setPersonalBusy] = useState(false);
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [reactionBusy, setReactionBusy] = useState(false);
  const [orchestrationNoticeBusy, setOrchestrationNoticeBusy] = useState<
    keyof ResolvedWorkspaceSlackOrchestrationNoticeSettings | null
  >(null);
  // The rendered `busy`/`disabled` flags come from the state above; this ref is
  // the actual mutual exclusion. State is only observable to a closure created
  // by a later render, so a handler captured from an earlier one would sail
  // straight past a state-based guard.
  const orchestrationNoticeWriting = useRef(false);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [personalDisconnectOpen, setPersonalDisconnectOpen] = useState(false);
  const [botDisconnectOpen, setBotDisconnectOpen] = useState(false);
  const [reactionChannelsOpen, setReactionChannelsOpen] = useState(false);
  // True while the channel dialog was opened by an enable attempt on an empty
  // allowlist, so saving from it actually enables the shortcut.
  const [reactionEnableIntent, setReactionEnableIntent] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [invitedChannels, setInvitedChannels] = useState<SlackReactionChannel[] | null>(null);
  const [publication, setPublication] = useState<MemorySlackPublicationConfiguration | null>(null);
  const [publicationLoaded, setPublicationLoaded] = useState(false);

  const preview = localConnectedSlackPreview(window.location.search, workspaceId);
  const readOnly = preview !== null;
  const loaded = connectionsLoaded || readOnly;
  const botConnections = openGeniSlackBotConnections(connections ?? []);
  const botConnection = preview?.bot ?? preferredOpenGeniSlackBotConnection(botConnections);
  const botMetadata = botConnection ? openGeniSlackBotUiMetadata(botConnection) : null;
  const binding = botConnection
    ? (slackInstallationBindings.find((row) => row.connectionId === botConnection.id) ?? null)
    : null;
  const bindingActive = readOnly || binding?.state === "active";
  const botActive = botConnection?.status === "active";
  const botHealthy = Boolean(botConnection && botActive && bindingActive);
  const canMutateInstalledBot = canInstallBot && bindingActive;
  // Reaction summon, knowledge destination, and decision publication remain
  // admin-gated even though any connections:write holder sees the bot sheet.
  const canManageReaction = isAdmin && bindingActive;
  const scopeReady = botConnection
    ? hasOpenGeniSlackReactionScope(botConnection.grantedScopes)
    : false;
  const savedDestination = slackBotDocumentDestinationAuthority(botConnection?.metadata);

  const personalItem = personalSlackCapability(items);
  const personalConnection = preferredPersonalSlackConnection(connections ?? []);
  const personalState = preview?.personal ?? personalSlackAccountState(personalConnection, loaded);
  const personalAvailable = personalItem !== null || readOnly;

  // Slack install callback (bot).
  const slackInstallHandled = useRef(false);
  useEffect(() => {
    if (slackInstallHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("slack");
    if (!outcome) return;
    slackInstallHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "connected") {
      void refresh();
      toast.success("OpenGeni installed in Slack");
    } else {
      toast.error("Couldn't install OpenGeni in Slack", {
        description: "Try again, or reinstall the bot from the Slack integration.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Invited channels and the publication configuration are loaded only while the
  // admin sheet is open; both are cheap reads but not needed for the row.
  const botConnectionId = botConnection?.id ?? null;
  // A reconnect or reinstall may point at a different connection row; drop the
  // cached publication configuration so the sheet refetches it.
  useEffect(() => {
    setPublication(null);
    setPublicationLoaded(false);
  }, [botConnectionId]);
  useEffect(() => {
    if (!sheetOpen || !isAdmin || !botConnectionId || !botHealthy || readOnly) return;
    let cancelled = false;
    void (async () => {
      try {
        const collected: SlackReactionChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await client.listOpenGeniSlackReactionChannels(
            workspaceId,
            botConnectionId,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (!cancelled) {
          setInvitedChannels([...new Map(collected.map((c) => [c.id, c])).values()]);
        }
      } catch {
        if (!cancelled) setInvitedChannels(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botConnectionId, botHealthy, client, isAdmin, readOnly, sheetOpen, workspaceId]);

  useEffect(() => {
    if (!sheetOpen || !isAdmin || !botConnectionId || readOnly || publicationLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const memoryClient = await memorySlackClient(client);
        const config = await memoryClient.getMemorySlackPublicationConfiguration(workspaceId);
        if (!cancelled) {
          setPublication(config.current);
          setPublicationLoaded(true);
        }
      } catch {
        if (!cancelled) setPublicationLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botConnectionId, client, isAdmin, publicationLoaded, readOnly, sheetOpen, workspaceId]);

  async function startPersonalOAuth() {
    const target = personalSlackOAuthTarget(personalItem);
    if (!personalItem || !target) {
      toast.error("Personal Slack is unavailable", {
        description: "The official hosted Slack integration is not present in this catalog.",
      });
      return;
    }
    setPersonalBusy(true);
    try {
      const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(personalItem.id)}`;
      const response = await startMcpOAuthWithTimeout(client, workspaceId, {
        ...target,
        ...(personalConnection ? { connectionId: personalConnection.id } : {}),
        returnPath,
      });
      if (!response.authorizationUrl) {
        throw new Error("Slack did not return an authorization link.");
      }
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      toast.error("Couldn't connect your Slack account", {
        description: error instanceof Error ? error.message : String(error),
      });
      setPersonalBusy(false);
    }
  }

  async function disconnectPersonal(): Promise<boolean> {
    if (!personalConnection) return true;
    setPersonalBusy(true);
    try {
      await client.deleteConnection(workspaceId, personalConnection.id);
      await refresh();
      onRuntimeChanged();
      toast.success("Personal Slack account disconnected");
      return true;
    } catch (error) {
      toast.error("Couldn't disconnect your Slack account", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setPersonalBusy(false);
    }
  }

  async function installBot() {
    if (botConnection && !bindingActive) {
      toast.error("Slack installation repair is blocked", {
        description: "A verified active installation binding is required before Slack can change.",
      });
      return;
    }
    setBotBusy(true);
    try {
      const installation = await client.startOpenGeniSlackBotInstall(
        workspaceId,
        openGeniSlackBotInstallInput(botConnection, false),
      );
      window.location.assign(installation.authorizationUrl);
    } catch (error) {
      toast.error("Couldn't start the OpenGeni Slack installation", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBotBusy(false);
    }
  }

  async function disconnectBot(): Promise<boolean> {
    if (!botConnection) return true;
    setBotBusy(true);
    try {
      await client.deleteConnection(workspaceId, botConnection.id);
      await refresh();
      toast.success("OpenGeni Slack bot disconnected");
      return true;
    } catch (error) {
      toast.error("Couldn't disconnect the OpenGeni Slack bot", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBotBusy(false);
    }
  }

  async function saveDestination(authorityKind: string) {
    if (!botConnection || !bindingActive) return;
    setDestinationBusy(true);
    try {
      await client.updateConnection(workspaceId, botConnection.id, {
        metadata: {
          documentDestination: {
            // Shared destinations only: a legacy `personal` value can never be
            // echoed back through this save path.
            authorityKind: slackBotPersistableDestinationAuthority(authorityKind),
            collectionId: null,
          },
        },
      });
      await refresh();
      toast.success("Slack knowledge destination saved");
    } catch (error) {
      toast.error("Couldn't save the Slack knowledge destination", {
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setDestinationBusy(false);
    }
  }

  async function saveReactionSettings(
    next: WorkspaceSlackReactionSummonSettings,
  ): Promise<boolean> {
    if (next.enabled && !(botActive && scopeReady)) {
      toast.error("Reconnect Slack to allow reading reactions before turning this on");
      return false;
    }
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    setReactionBusy(true);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        slackReactionSummon: { ...next, emoji: OPENGENI_REACTION_EMOJI },
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success("Slack reaction shortcut saved");
      }
      return updated !== null && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition);
    } finally {
      setReactionBusy(false);
    }
  }

  /**
   * Persist one orchestration notice through the ordinary workspace-settings
   * patch. The full resolved pair is written every time so a partially stored
   * object can never resolve back to the fail-closed default and silently
   * switch the other notice off.
   */
  async function saveOrchestrationNotice(
    notice: keyof ResolvedWorkspaceSlackOrchestrationNoticeSettings,
    enabled: boolean,
  ) {
    // One write carries the whole pair, so a second concurrent write would send
    // the pre-write value of the notice it is not changing and revert it. Both
    // toggles render unavailable while one is in flight, and this ref is the
    // authority behind that, because a caller may still hold a handler from an
    // earlier render. Sequential toggles are unaffected: a completed write
    // upserts the workspace, so the next one reads the persisted pair.
    if (orchestrationNoticeWriting.current) return;
    const acceptedTransition = context.captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    orchestrationNoticeWriting.current = true;
    setOrchestrationNoticeBusy(notice);
    try {
      const updated = await context.updateWorkspaceSettings(workspaceId, {
        slackOrchestrationNotices: { ...orchestrationNotices, [notice]: enabled },
      });
      if (updated && context.ownsWorkspaceInvocation(workspaceId, acceptedTransition)) {
        toast.success(enabled ? "Slack notice turned on" : "Slack notice turned off");
      }
    } finally {
      orchestrationNoticeWriting.current = false;
      setOrchestrationNoticeBusy(null);
    }
  }

  function toggleReaction(enabled: boolean) {
    if (
      enabled &&
      reactionSettings.channelPolicy.mode === "allowlist" &&
      reactionSettings.channelPolicy.channelIds.length === 0
    ) {
      setReactionEnableIntent(true);
      setReactionChannelsOpen(true);
      return;
    }
    void saveReactionSettings({ ...reactionSettings, enabled });
  }

  async function togglePublication(enabled: boolean) {
    if (enabled && (!publication?.connectionId || !publication.slackChannelId)) {
      setPublicationOpen(true);
      return;
    }
    setPublicationBusy(true);
    try {
      const memoryClient = await memorySlackClient(client);
      const next = await memoryClient.updateMemorySlackPublicationConfiguration(workspaceId, {
        expectedRevision: publication?.revision ?? 0,
        enabled,
        connectionId: publication?.connectionId ?? null,
        slackChannelId: publication?.slackChannelId ?? null,
        slackChannelName: publication?.slackChannelName ?? null,
        autoImportances: publication?.autoImportances ?? [],
        reviewImportances: publication?.reviewImportances ?? [],
      });
      setPublication(next);
      toast.success(enabled ? "Decision publication turned on" : "Decision publication turned off");
    } catch (error) {
      toast.error("Could not save Slack publication settings", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPublicationBusy(false);
    }
  }

  // Anyone who can manage workspace connections (connections:write or admin)
  // manages the bot; everyone else sees their own personal Slack account.
  const model = canInstallBot ? botModel() : memberModel();

  function botModel(): IntegrationViewModel {
    const chip: IntegrationChip = !loaded
      ? { label: "Loading", tone: "plain" }
      : !botConnection
        ? { label: "Not connected", tone: "idle" }
        : botHealthy
          ? { label: "Connected", tone: "ok" }
          : { label: "Needs attention", tone: "warn" };

    const facts: IntegrationFact[] = [];
    if (botConnection && botMetadata) {
      facts.push({
        label: "Slack workspace",
        value: `${botMetadata.slackTeamName} (${botMetadata.slackTeamId})`,
      });
      facts.push({
        label: "Status",
        value: botActive ? "Installed" : "Reinstall needed",
      });
      facts.push({ label: "Bot", value: `${botMetadata.botId} · user ${botMetadata.botUserId}` });
      if (binding) {
        facts.push({ label: "Bound account", value: binding.accountName });
        facts.push({ label: "Bound workspace", value: binding.workspaceName });
        facts.push({ label: "Binding", value: `${binding.state} · version ${binding.version}` });
      } else if (!readOnly) {
        facts.push({ label: "Binding", value: "No verified installation binding is available" });
      }
      facts.push({ label: "Installed", value: formatDate(botConnection.createdAt) });
    }

    const access: IntegrationAccess | undefined =
      botConnection && botMetadata
        ? {
            title: "What OpenGeni can see",
            items: [
              { name: "All public channels", meta: "searchable without joining" },
              ...(invitedChannels ?? []).map((channel) => ({
                name: channel.isPrivate
                  ? (channel.name ?? channel.id)
                  : `#${channel.name ?? channel.id}`,
                meta: channel.isPrivate ? "private, invited" : "invited",
              })),
              { name: "Anywhere else", meta: "tag @OpenGeni there to invite it" },
            ],
          }
        : undefined;

    const options: IntegrationOption[] = [];
    if (botConnection && botMetadata) {
      options.push({
        kind: "toggle",
        id: "slack-reaction",
        label: "Start work with a reaction",
        description: scopeReady
          ? `React with :${OPENGENI_REACTION_EMOJI}: on any message OpenGeni can see. ${
              reactionSettings.channelPolicy.mode === "allowlist"
                ? `Works in ${reactionSettings.channelPolicy.channelIds.length} selected conversation${reactionSettings.channelPolicy.channelIds.length === 1 ? "" : "s"}.`
                : "Works anywhere OpenGeni is a member."
            }`
          : "Reconnect Slack to allow reading reactions first.",
        checked: reactionSettings.enabled,
        disabled: !canManageReaction || !botActive || !scopeReady || readOnly,
        busy: reactionBusy,
        onChange: toggleReaction,
        ...(canManageReaction && botActive && scopeReady && !readOnly
          ? {
              action: {
                label: "Choose where it works",
                onClick: () => setReactionChannelsOpen(true),
              },
            }
          : {}),
      });
      options.push({
        kind: "choice",
        id: "slack-knowledge-destination",
        label: "Save Slack knowledge to",
        description: "Where knowledge captured from Slack is stored.",
        value: savedDestination,
        choices: [
          { value: "workspace", label: "Workspace", disabled: !canManageWorkspaceDestination },
          {
            value: "organization",
            label: "Organization",
            disabled: !canManageOrganizationDestination,
          },
        ],
        disabled:
          !canMutateInstalledBot ||
          readOnly ||
          (!canManageWorkspaceDestination && !canManageOrganizationDestination),
        busy: destinationBusy,
        onChange: (value) => void saveDestination(value),
      });
      // Both default off: an unsolicited Slack post is worse than a missed one,
      // and the in-app rail and priority feed already surface this work. Each
      // write sends the whole pair, so an in-flight write makes BOTH toggles
      // unavailable: toggling the second one meanwhile would read the pre-write
      // pair and silently revert the first.
      const orchestrationNoticeWriteInFlight = orchestrationNoticeBusy !== null;
      options.push({
        kind: "toggle",
        id: "slack-child-requires-action-notice",
        label: "Tell me in Slack when a worker I started needs input",
        description:
          "Posts one pointer to the blocked worker in the task's thread. You still answer on its OpenGeni card.",
        checked: orchestrationNotices.childRequiresAction,
        disabled: !canManageReaction || !botActive || readOnly || orchestrationNoticeWriteInFlight,
        busy: orchestrationNoticeBusy === "childRequiresAction",
        onChange: (checked) => void saveOrchestrationNotice("childRequiresAction", checked),
      });
      options.push({
        kind: "toggle",
        id: "slack-goal-paused-notice",
        label: "Tell me in Slack when a goal pauses for budget or the continuation cap",
        description: "Posts one line in the task's thread. Pauses you asked for stay quiet.",
        checked: orchestrationNotices.goalPaused,
        disabled: !canManageReaction || !botActive || readOnly || orchestrationNoticeWriteInFlight,
        busy: orchestrationNoticeBusy === "goalPaused",
        onChange: (checked) => void saveOrchestrationNotice("goalPaused", checked),
      });
      options.push({
        kind: "toggle",
        id: "slack-publication",
        label: "Publish important decisions to Slack",
        description: publication?.slackChannelName
          ? `Posts to ${publication.slackChannelName}. Major items publish automatically; lower-signal items wait for review or stay quiet.`
          : "Posts bounded summaries of workspace Memory changes to one channel you choose.",
        checked: publication?.enabled ?? false,
        disabled: !isAdmin || !botActive || readOnly || !publicationLoaded,
        busy: publicationBusy,
        onChange: (checked) => void togglePublication(checked),
        ...(isAdmin && botActive && !readOnly
          ? { action: { label: "Configure", onClick: () => setPublicationOpen(true) } }
          : {}),
      });
    }

    const footer: IntegrationFooter = !loaded
      ? { kind: "setup", onSetup: () => {}, disabled: true }
      : !botConnection
        ? canInstallBot
          ? { kind: "setup", onSetup: () => void installBot(), busy: botBusy, disabled: readOnly }
          : { kind: "locked" }
        : {
            kind: botHealthy ? "connected" : "repair",
            onReconnect: () => void installBot(),
            onDisconnect: () => setBotDisconnectOpen(true),
            reconnectDisabled: !canMutateInstalledBot || readOnly,
            disconnectDisabled: !canInstallBot || !botActive || readOnly,
            busy: botBusy,
          };

    const quarantine = binding?.quarantineReason;
    const notice: IntegrationViewModel["notice"] = botConnection
      ? quarantine
        ? {
            tone: "failed",
            title: "Slack installation needs repair",
            description:
              quarantine === "legacy_conflicting_installations"
                ? "Legacy installations conflict; repair is blocked until the binding is reconciled."
                : quarantine,
          }
        : !binding && !readOnly
          ? {
              tone: "waiting",
              title: "No verified installation binding is available",
              description: "Reconnect is blocked until the installation is verified.",
            }
          : undefined
      : undefined;

    return {
      id: "slack",
      name: "Slack",
      description: SLACK_APP_DESCRIPTION,
      mark: { logoSrc: SLACK_LOGO_URL, monogram: "S" },
      chip,
      connection: facts,
      ...(access ? { access } : {}),
      options,
      footer,
      ...(notice ? { notice } : {}),
    };
  }

  function memberModel(): IntegrationViewModel {
    const state = personalState;
    const connectedPersonal = state.state === "connected";
    const chip: IntegrationChip =
      state.state === "unverified"
        ? { label: "Loading", tone: "plain" }
        : connectedPersonal
          ? { label: "Connected", tone: "ok" }
          : state.state === "reconnect_required"
            ? { label: "Needs attention", tone: "warn" }
            : botConnection && !canManagePersonal
              ? { label: "Set up by an admin", tone: "plain" }
              : { label: "Not connected", tone: "idle" };

    const facts: IntegrationFact[] = [];
    if (botMetadata) {
      facts.push({ label: "Slack workspace", value: botMetadata.slackTeamName });
    }
    if ("connection" in state) {
      facts.push({
        label: "Your account",
        value:
          state.state === "connected"
            ? state.accessTokenRefreshDue
              ? "Connected · refresh pending"
              : "Connected"
            : state.state === "reconnect_required"
              ? "Reconnect needed"
              : "Disconnected",
      });
      facts.push({ label: "Last used", value: formatDate(state.connection.lastUsedAt) });
    }

    const notice: IntegrationViewModel["notice"] =
      state.state === "reconnect_required"
        ? {
            tone: "waiting",
            title: "Your Slack account needs to be reconnected",
            description:
              state.reason === "expired"
                ? "The connection expired. Reconnect it to restore access."
                : state.reason === "provider_rejected"
                  ? "Slack no longer accepts this connection. Reconnect it to restore access."
                  : "OpenGeni could not use this connection. Reconnect it to restore access.",
          }
        : !personalAvailable && state.state === "not_connected"
          ? {
              tone: "muted",
              title: "Personal Slack is not available in this deployment's catalog.",
            }
          : undefined;

    const canStartOAuth = personalAvailable && canManagePersonal && !readOnly;
    // Personal Slack is personal-only: no admin can connect it for a member, so
    // a member without connections:write gets the truthful permission sentence
    // rather than the generic admin-managed one.
    const lockedFooter: IntegrationFooter = !canManagePersonal
      ? { kind: "locked", message: SLACK_PERSONAL_PERMISSION_SENTENCE }
      : !personalAvailable
        ? {
            kind: "locked",
            message: "Personal Slack is not available in this deployment's catalog.",
          }
        : { kind: "locked" };
    const footer: IntegrationFooter =
      state.state === "unverified"
        ? { kind: "setup", onSetup: () => {}, disabled: true }
        : state.state === "not_connected"
          ? canStartOAuth
            ? { kind: "setup", onSetup: () => void startPersonalOAuth(), busy: personalBusy }
            : lockedFooter
          : canManagePersonal
            ? {
                kind: connectedPersonal ? "connected" : "repair",
                onReconnect: () => void startPersonalOAuth(),
                onDisconnect: () => setPersonalDisconnectOpen(true),
                reconnectDisabled: !canStartOAuth,
                disconnectDisabled: readOnly || state.state === "disconnected",
                busy: personalBusy,
              }
            : lockedFooter;

    return {
      id: "slack",
      name: "Slack",
      description: SLACK_APP_DESCRIPTION,
      mark: { logoSrc: SLACK_LOGO_URL, monogram: "S" },
      chip,
      connection: facts,
      ...(connectedPersonal
        ? {
            access: {
              title: "What OpenGeni can see as you",
              items: [
                {
                  name: "Everything you can see in Slack",
                  meta: "including private channels and DMs",
                },
              ],
            },
          }
        : {}),
      options: [],
      footer,
      ...(notice ? { notice } : {}),
    };
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={personalDisconnectOpen}
        onOpenChange={setPersonalDisconnectOpen}
        title="Disconnect your Slack account?"
        description="OpenGeni will stop using your personal Slack connection. This does not disconnect the workspace bot or revoke access inside Slack."
        confirmLabel="Disconnect my Slack account"
        cancelAutoFocus
        onConfirm={disconnectPersonal}
      />
      <ConfirmDialog
        open={botDisconnectOpen}
        onOpenChange={setBotDisconnectOpen}
        title="Disconnect the OpenGeni Slack bot?"
        description="OpenGeni stops answering in this Slack workspace and its scheduled Slack posts stop. The app stays installed in Slack until you remove it there."
        confirmLabel="Disconnect Slack bot"
        cancelAutoFocus
        onConfirm={disconnectBot}
      />
      {isAdmin ? (
        <>
          <SlackReactionChannelsDialog
            workspaceId={workspaceId}
            connectionId={botConnectionId}
            // Opened by an enable attempt, the dialog carries that intent so
            // picking channels and saving actually enables the shortcut.
            settings={
              reactionEnableIntent ? { ...reactionSettings, enabled: true } : reactionSettings
            }
            open={reactionChannelsOpen}
            canManage={canManageReaction && !readOnly}
            onOpenChange={(open) => {
              setReactionChannelsOpen(open);
              if (!open) setReactionEnableIntent(false);
            }}
            onSave={saveReactionSettings}
          />
          {publicationOpen ? (
            <Suspense fallback={null}>
              <MemorySlackPublicationDialog
                workspaceId={workspaceId}
                connections={botConnections}
                canManage={isAdmin && !readOnly}
                open={publicationOpen}
                onOpenChange={setPublicationOpen}
                onSaved={setPublication}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </>
  );

  return { model, dialogs };
}

function formatDate(value: string | null): string {
  if (!value) return "Not reported";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Not reported";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}
