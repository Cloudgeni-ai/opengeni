import { useEffect, useMemo, useState } from "react";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { toast } from "sonner";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { clearSlackInstallResult, slackInstallFeedback } from "@/lib/slack-install-feedback";
import { userErrorText } from "@/lib/api-error";
import { openGeniSlackBotConnections, openGeniSlackBotUiMetadata } from "@/lib/slack-bot";
import {
  personalSlackCapability,
  enableNewSlackAccountTools,
  hostedSlackConnections,
} from "@/lib/personal-slack";
import type { CapabilityCatalogItem, ConnectionMetadata, SlackInstallationBinding } from "@/types";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { RowList, ListRow } from "@/components/ui/list-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CapabilityPage, CapabilityMark } from "./capability-page";
import { SlackChannelRoutingDialogBody } from "./slack-channel-routing-dialog";
import { SlackBotAccessSection } from "./slack-bot-access-section";
import { ConnectorToolPermissions } from "./connector-tool-permissions";
import { Disclosure } from "@/components/ui/disclosure";
import { IntegrationPage, OptionRow } from "./integration-page";
import { NativeConnectSetup, type NativeConnectRequest } from "./native-connect-setup";
import { useSlackInstallationDiscovery } from "./use-slack-installation-discovery";
import { useSlackIntegration, SLACK_LOGO_URL } from "./use-slack-integration";

/** One inventory in every workspace. Selecting a connection does not navigate
 * away or grant access to its storage workspace; every request keeps its real scope. */
export function SlackConnectionsPage(props: {
  workspaceId: string;
  items: CapabilityCatalogItem[];
  connections: ConnectionMetadata[] | null;
  bindings: SlackInstallationBinding[];
  refresh: () => Promise<void>;
  onRuntimeChanged: () => void;
  onBack: () => void;
}) {
  const context = useAppContext();
  const { client, accessContext } = context;
  const discovery = useSlackInstallationDiscovery(props.workspaceId, true);
  const [available, setAvailable] = useState<ConnectionMetadata[]>([]);
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [installFailure, setInstallFailure] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("slack") === "error" ? slackInstallFeedback(params.get("reason")) : null;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [request, setRequest] = useState<NativeConnectRequest | null>(null);
  const [remove, setRemove] = useState<ConnectionMetadata | null>(null);
  const transport = useMemo(() => client.connectTransport(), [client]);
  useEffect(() => {
    let live = true;
    setAvailable([]);
    setSharedIds([]);
    setLoadError(null);
    void client
      .listAvailableOpenGeniSlackBots(props.workspaceId)
      .then((result) => {
        if (!live) return;
        setAvailable(result.connections);
        setSharedIds(result.organizationSharedConnectionIds);
      })
      .catch((error) => {
        if (live) setLoadError(userErrorText(error));
      });
    return () => {
      live = false;
    };
  }, [client, props.workspaceId, revision]);
  const bots = openGeniSlackBotConnections([
    ...new Map(
      [...discovery.connections, ...(props.connections ?? []), ...available].map((row) => [
        row.id,
        row,
      ]),
    ).values(),
  ]).filter((row) => row.status !== "revoked");
  const bindings = [...props.bindings, ...discovery.bindings];
  const selected = bots.find((row) => row.id === selectedId);
  const canWrite = hasWorkspacePermission(accessContext, props.workspaceId, "connections:write");
  const personal = hostedSlackConnections(props.connections ?? []).filter(
    (row) => row.subjectId === accessContext.subjectId && row.status !== "revoked",
  );
  const selectedPersonal = personal.find((row) => row.id === selectedId);
  const personalCapability = personalSlackCapability(props.items);
  async function refresh() {
    await props.refresh();
    discovery.retry();
    setRevision((value) => value + 1);
    props.onRuntimeChanged();
  }
  function connect(providerId: "slack-bot" | "slack-personal", account?: ConnectionMetadata) {
    const workspaceId = account?.workspaceId ?? props.workspaceId;
    setRequest({
      scope: { workspaceId, transport },
      providerId,
      ownership: providerId === "slack-bot" ? "workspace" : "personal",
      displayName: providerId === "slack-bot" ? "Opengeni bot" : "Your Slack account",
      logoUrl: SLACK_LOGO_URL,
      authorizeLabel: "Continue to Slack",
      returnUrl: window.location.href,
      idempotencyKey: crypto.randomUUID(),
      ...(account ? { reconnectAccountId: account.id } : {}),
    });
  }
  if (selected && hasWorkspacePermission(accessContext, selected.workspaceId, "connections:read")) {
    return (
      <SlackBotDetails
        key={selected.id}
        {...props}
        connection={selected}
        bindings={bindings}
        refresh={refresh}
        onBack={() => setSelectedId(null)}
      />
    );
  }
  const workspaceName =
    context.workspaces.find((row) => row.id === props.workspaceId)?.name ?? "this workspace";
  return (
    <>
      {selectedPersonal ? (
        <CapabilityPage
          title={connectionAccountIdentityLabel(selectedPersonal.metadata, "Slack account")}
          mark={<CapabilityMark name="Slack" src={SLACK_LOGO_URL} />}
          onBack={() => setSelectedId(null)}
          backLabel="Slack"
          meta={["Personal account", "Only you"]}
        >
          <DetailSection
            title="Connection"
            description="Reads and sends messages as you."
            action={
              canWrite ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => connect("slack-personal", selectedPersonal)}
                  >
                    Reconnect
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemove(selectedPersonal)}>
                    Remove
                  </Button>
                </div>
              ) : undefined
            }
          >
            <StatusBadge
              variant="dot"
              status={selectedPersonal.status === "active" ? "connected" : "needs_reconnect"}
            />
          </DetailSection>
          {selectedPersonal.status === "active" && personalCapability?.enabled ? (
            <DetailSection title="Approvals" description="Choose which actions run automatically.">
              <ConnectorToolPermissions
                key={`${selectedPersonal.id}:${selectedPersonal.version}`}
                workspaceId={props.workspaceId}
                capabilityId={personalCapability.id}
                connectionId={selectedPersonal.id}
                bare
              />
            </DetailSection>
          ) : null}
        </CapabilityPage>
      ) : (
        <CapabilityPage
          title="Slack"
          mark={<CapabilityMark name="Slack" src={SLACK_LOGO_URL} />}
          onBack={props.onBack}
          backLabel="Capabilities"
          meta={["Bots and personal accounts"]}
        >
          {installFailure ? (
            <Notice
              tone="waiting"
              title={installFailure.title}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setInstallFailure(null);
                    clearSlackInstallResult();
                  }}
                >
                  Dismiss
                </Button>
              }
            >
              {installFailure.description}
            </Notice>
          ) : null}
          {loadError || discovery.failed ? (
            <Notice
              tone="failed"
              title="Couldn't load all Slack connections"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    discovery.retry();
                    setRevision((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
              }
            >
              {loadError ?? "Some connections could not be checked."}
            </Notice>
          ) : null}
          <DetailSection
            title="Opengeni bot"
            description="Posts as Opengeni and responds to you in Slack."
            action={
              canWrite ? (
                <Button size="sm" variant="outline" onClick={() => connect("slack-bot")}>
                  Add Slack workspace
                </Button>
              ) : undefined
            }
          >
            <RowList
              label="Slack bot workspaces"
              flush
              busy={props.connections === null || discovery.loading}
            >
              {bots.map((bot) => {
                const metadata = openGeniSlackBotUiMetadata(bot)!;
                const availableHere =
                  bot.workspaceId === props.workspaceId || sharedIds.includes(bot.id);
                const canInspect = hasWorkspacePermission(
                  accessContext,
                  bot.workspaceId,
                  "connections:read",
                );
                return (
                  <ListRow
                    key={bot.id}
                    title={metadata.slackTeamName}
                    description={
                      availableHere
                        ? `Available in ${workspaceName}`
                        : `Not available in ${workspaceName}`
                    }
                    onOpen={canInspect ? () => setSelectedId(bot.id) : undefined}
                    meta={canInspect ? [] : ["Settings managed by your organization admin"]}
                    status={
                      <StatusBadge
                        variant="dot"
                        status={
                          bot.status === "active" &&
                          (!canInspect ||
                            bindings.some(
                              (binding) =>
                                binding.connectionId === bot.id &&
                                binding.state === "active" &&
                                binding.connectionVersion === bot.version,
                            ))
                            ? "connected"
                            : "needs_reconnect"
                        }
                      />
                    }
                  />
                );
              })}
            </RowList>
            {!bots.length && props.connections !== null && !discovery.loading ? (
              <p className="text-sm text-fg-muted">No Slack workspaces connected.</p>
            ) : null}
          </DetailSection>
          <DetailSection
            title="Your accounts"
            description="Reads and sends messages as you."
            action={
              canWrite ? (
                <Button size="sm" variant="outline" onClick={() => connect("slack-personal")}>
                  Add account
                </Button>
              ) : undefined
            }
          >
            <RowList label="Your Slack accounts" flush>
              {personal.map((account) => (
                <ListRow
                  key={account.id}
                  title={connectionAccountIdentityLabel(account.metadata, "Slack account")}
                  description={
                    account.status === "active"
                      ? "Only you · Connected"
                      : "Only you · Reconnect needed"
                  }
                  onOpen={() => setSelectedId(account.id)}
                />
              ))}
            </RowList>
            {!personal.length && props.connections !== null ? (
              <p className="text-sm text-fg-muted">No personal accounts connected.</p>
            ) : null}
          </DetailSection>
          {bots.some((bot) => bot.workspaceId === props.workspaceId) ? (
            <Disclosure title="Workspace automation" summary={workspaceName}>
              <SlackWorkspaceAutomation
                {...props}
                connections={bots.filter((bot) => bot.workspaceId === props.workspaceId)}
                bindings={bindings}
                refresh={refresh}
              />
            </Disclosure>
          ) : null}
        </CapabilityPage>
      )}
      {request ? (
        <NativeConnectSetup
          request={request}
          transport={transport}
          workspaceId={request.scope.workspaceId}
          onClose={() => setRequest(null)}
          onComplete={(attempt) => {
            setRequest(null);
            void enableNewSlackAccountTools(
              client,
              props.workspaceId,
              personalSlackCapability(props.items),
              attempt,
            )
              .then(refresh)
              .catch((error) =>
                toast.error("Couldn't refresh Slack", { description: userErrorText(error) }),
              );
          }}
        />
      ) : null}
      <ConfirmDialog
        open={remove !== null}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
        title={`Remove ${remove ? connectionAccountIdentityLabel(remove.metadata, "Slack account") : "Slack account"}?`}
        description="Chats and schedules using this account will lose its access. Your other Slack connections stay connected."
        confirmLabel="Remove account"
        onConfirm={async () => {
          if (!remove) return true;
          try {
            await client.deleteConnection(remove.workspaceId, remove.id);
            await refresh();
            setRemove(null);
            return true;
          } catch (error) {
            toast.error("Couldn't remove account", { description: userErrorText(error) });
            return false;
          }
        }}
      />
    </>
  );
}

function SlackBotDetails(props: {
  workspaceId: string;
  connection: ConnectionMetadata;
  bindings: SlackInstallationBinding[];
  items: CapabilityCatalogItem[];
  refresh: () => Promise<void>;
  onRuntimeChanged: () => void;
  onBack: () => void;
}) {
  const [channelsOpen, setChannelsOpen] = useState(false);
  const { accessContext } = useAppContext();
  const adapter = useSlackIntegration({
    workspaceId: props.connection.workspaceId,
    items: props.items,
    connections: [props.connection],
    connectionsLoaded: true,
    slackInstallationBindings: props.bindings.filter(
      (row) => row.connectionId === props.connection.id,
    ),
    selectedBotConnectionId: props.connection.id,
    sheetOpen: true,
    refresh: props.refresh,
    onRuntimeChanged: props.onRuntimeChanged,
  });
  const model = {
    ...adapter.model,
    name: openGeniSlackBotUiMetadata(props.connection)!.slackTeamName,
    outcomes: undefined,
    access: undefined,
    options: adapter.model.options.filter((option) => option.id === "slack-knowledge-destination"),
    presentation: adapter.model.presentation
      ? {
          ...adapter.model.presentation,
          summary: {
            ...adapter.model.presentation.summary,
            description: "Opengeni bot · Messages are sent as Opengeni.",
          },
          routing: adapter.model.presentation.routing
            ? {
                ...adapter.model.presentation.routing,
                description: "Choose where work starts when someone messages the bot in a channel.",
                action: adapter.model.presentation.routing.action
                  ? { label: "Channels", onClick: () => setChannelsOpen(true) }
                  : undefined,
              }
            : undefined,
        }
      : undefined,
  };
  if (channelsOpen)
    return (
      <SlackChannelRoutingDialogBody
        pageMode
        workspaceId={props.connection.workspaceId}
        connectionId={props.connection.id}
        canManage={hasWorkspacePermission(
          accessContext,
          props.connection.workspaceId,
          "capabilities:manage",
        )}
        onClose={() => setChannelsOpen(false)}
        onSaved={() => void props.refresh()}
      />
    );
  return (
    <>
      <IntegrationPage model={model} onBack={props.onBack} backLabel="Slack" compactSettings>
        <SlackBotAccessSection connection={props.connection} onSaved={props.refresh} />
      </IntegrationPage>
      {adapter.dialogs}
    </>
  );
}

/** Workspace-wide behavior is deliberately outside any selected bot page. */
function SlackWorkspaceAutomation(props: {
  workspaceId: string;
  connections: ConnectionMetadata[];
  bindings: SlackInstallationBinding[];
  items: CapabilityCatalogItem[];
  refresh: () => Promise<void>;
  onRuntimeChanged: () => void;
}) {
  const { workspaces } = useAppContext();
  const workspace = workspaces.find((row) => row.id === props.workspaceId);
  const adapter = useSlackIntegration({
    workspaceId: props.workspaceId,
    items: props.items,
    connections: props.connections,
    connectionsLoaded: true,
    slackInstallationBindings: props.bindings,
    sheetOpen: true,
    refresh: props.refresh,
    onRuntimeChanged: props.onRuntimeChanged,
  });
  const options = adapter.model.options.filter((option) =>
    [
      "slack-reaction",
      "slack-child-requires-action-notice",
      "slack-goal-paused-notice",
      "slack-publication",
    ].includes(option.id),
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Settings for the {workspace?.name ?? "current"} Opengeni workspace. Reaction settings apply
        to all bots installed here.
      </p>
      {options.map((option) => (
        <OptionRow key={option.id} option={option} />
      ))}
      {adapter.dialogs}
    </div>
  );
}
