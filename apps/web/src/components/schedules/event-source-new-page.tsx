/**
 * Add an event source. Without a kind it is a picker of where events can
 * come from; with one it is that kind's short form. Sources that connect by
 * pasting continue on the same page: a webhook shows its signing secret once,
 * and Linear or Sentry show the URL to paste there and take their secret.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { t } from "@opengeni/react/app/lib/console-text";
import {
  EventSourceTile,
  createEventSourceRequest,
  eventSourceAddLabel,
  eventSourceChoiceMeta,
  eventSourceChoices,
  eventSourceSubjectOfChoice,
  isEventSourceChoice,
  pastedWebhookSetup,
  type EventSourceChoice,
} from "@opengeni/react/automations";
import { useAppContext } from "@opengeni/react/app/app-context";
import { connectionAccountLabel } from "@opengeni/react/app/components/capabilities/connection-account-picker";
import {
  enabledWorkspaceCapabilityMcpServers,
  isComposerConnector,
  selectableMcpServers,
  type McpServerOption,
} from "@opengeni/react/app/lib/session-tools";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";
import { Notice } from "@opengeni/react/ui/notice";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import type { ConnectionMetadata, EventSource } from "@opengeni/sdk";

import { SecretOnce } from "@/components/ui/secret-field";

import {
  inAppClick,
  newEventSourcePath,
  useScheduleAccess,
  useScheduleNavigation,
  type ScheduleNavigation,
} from "./schedule-parts";
import { PastedWebhookSteps, StandardWebhookHelp, WebhookUrlField } from "./event-source-setup";
import { useEventSourceLogo, useEventTriggersEnabled } from "./use-event-sources";

const NAME_MAX_LENGTH = 120;

export function EventSourceNewPage({ workspaceId, kind }: { workspaceId: string; kind?: string }) {
  const enabled = useEventTriggersEnabled();
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const choice = isEventSourceChoice(kind) ? kind : null;
  if (!enabled || !access.canManage) {
    return (
      <DetailPage back={{ label: "Event sources", onClick: go.sources }}>
        <DetailPageHeader title="Add an event source" />
        <Notice className="mt-6">
          {!enabled
            ? "Event triggers are off on this Opengeni server, so automations here run on a schedule or by hand."
            : "You need permission to manage automations in this workspace to add an event source. Ask a workspace admin."}
        </Notice>
      </DetailPage>
    );
  }
  if (!choice) return <EventSourcePicker workspaceId={workspaceId} go={go} />;
  return <EventSourceForm key={choice} workspaceId={workspaceId} choice={choice} go={go} />;
}

/* ----------------------------------------------------------------------------
   Where the events come from.
   -------------------------------------------------------------------------- */

function EventSourcePicker({ workspaceId, go }: { workspaceId: string; go: ScheduleNavigation }) {
  const logo = useEventSourceLogo();
  return (
    <DetailPage back={{ label: "Event sources", onClick: go.sources }}>
      <DetailPageHeader
        title="Add an event source"
        meta={["Pick the app or service whose events should start automations"]}
      />
      <div className="mt-6 min-w-0">
        <RowList label="Kinds of event source" flush>
          {eventSourceChoices(t).map((choice) => (
            <ListRow
              key={choice.choice}
              leading={
                <EventSourceTile
                  source={eventSourceSubjectOfChoice(t, choice.choice)}
                  logo={logo}
                />
              }
              title={choice.name}
              description={choice.description}
              href={newEventSourcePath(workspaceId, choice.choice)}
              linkProps={{ onClick: inAppClick(() => go.newSource(choice.choice)) }}
            />
          ))}
        </RowList>
      </div>
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   The form for one kind.
   -------------------------------------------------------------------------- */

type Created = { source: EventSource; signingSecret?: string | undefined };

function EventSourceForm({
  workspaceId,
  choice,
  go,
}: {
  workspaceId: string;
  choice: EventSourceChoice;
  go: ScheduleNavigation;
}) {
  const { client } = useAppContext();
  const meta = eventSourceChoiceMeta(t, choice);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "workspace">("workspace");
  const [serverId, setServerId] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; server?: string; account?: string }>({});
  const [created, setCreated] = useState<Created | null>(null);
  const servers = useEventMcpServers(choice === "mcp");
  const gmailAccounts = useGmailAccounts(workspaceId, choice === "gmail");

  if (created?.signingSecret) {
    return (
      <StandardWebhookCreated
        created={created}
        onDone={() => go.source(created.source.id, { replace: true })}
      />
    );
  }
  if (created && created.source.awaitingSigningSecret) {
    return (
      <PastedWebhookConnect
        workspaceId={workspaceId}
        source={created.source}
        onDone={() => go.source(created.source.id, { replace: true })}
      />
    );
  }

  const pasted = meta.setup === "paste";
  return (
    <FormPage
      title={eventSourceAddLabel(t, choice)}
      description={meta.description}
      submitLabel={eventSourceAddLabel(t, choice)}
      pendingLabel="Adding…"
      back={{ label: "Add an event source", onClick: () => go.newSource() }}
      onCancel={go.sources}
      footerStart={
        meta.audience === "workspace"
          ? "Everyone in this workspace can use it."
          : meta.audience === "personal"
            ? "Only you can see it and its events."
            : undefined
      }
      onSubmit={async () => {
        const next: typeof errors = {};
        if (name.trim().length > NAME_MAX_LENGTH) {
          next.name = `Keep the name under ${NAME_MAX_LENGTH} characters.`;
        }
        if (choice === "mcp" && !serverId) next.server = "Choose the MCP server to listen to.";
        if (choice === "gmail" && gmailAccounts.length > 1 && !connectionId) {
          next.account = "Choose the mailbox to listen to.";
        }
        setErrors(next);
        if (Object.keys(next).length > 0) return false;
        const result = await client.createEventSource(
          workspaceId,
          createEventSourceRequest(t, {
            choice,
            name,
            visibility,
            mcpServerId: serverId ?? undefined,
            connectionId: connectionId ?? undefined,
          }),
        );
        if (result.signingSecret || result.source.awaitingSigningSecret) {
          setCreated(result);
          return true;
        }
        toast.success(`${result.source.name} added`, {
          description: "Automations can start when its events arrive.",
        });
        go.source(result.source.id, { replace: true });
        return true;
      }}
    >
      <FieldStack>
        {choice === "mcp" ? (
          <Field
            label="MCP server"
            error={errors.server}
            hint="It needs to offer events. Opengeni listens with your sign-in, so only you can see them."
          >
            <SelectMenu
              options={servers.map((server) => ({ value: server.id, label: server.name }))}
              value={serverId}
              onValueChange={(value) => {
                setServerId(value);
                setErrors((current) => ({ ...current, server: undefined }));
              }}
              placeholder="Choose a server"
              emptyMessage="No MCP servers are added to this workspace yet."
              invalid={Boolean(errors.server)}
            />
          </Field>
        ) : null}
        {choice === "gmail" && gmailAccounts.length > 1 ? (
          <Field label="Mailbox" error={errors.account}>
            <SelectMenu
              options={gmailAccounts.map((account) => ({
                value: account.id,
                label: connectionAccountLabel(account, "Gmail account"),
              }))}
              value={connectionId}
              onValueChange={(value) => {
                setConnectionId(value);
                setErrors((current) => ({ ...current, account: undefined }));
              }}
              placeholder="Choose a mailbox"
              invalid={Boolean(errors.account)}
            />
          </Field>
        ) : null}
        <Field
          label="Name"
          optional
          error={errors.name}
          hint={pasted ? "Helps tell it apart from other webhooks." : undefined}
        >
          <TextInput
            value={name}
            placeholder={choice === "mcp" ? "The server's name" : meta.name}
            maxLength={NAME_MAX_LENGTH + 20}
            onChange={(event) => {
              setName(event.target.value);
              if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
            suppressAutofill
          />
        </Field>
        {meta.audience === "choice" ? (
          <ChoiceCards
            label="Who can use it?"
            value={visibility}
            onValueChange={(value) => setVisibility(value as "private" | "workspace")}
          >
            <ChoiceCard
              value="workspace"
              title="Everyone in this workspace"
              description="Anyone can start automations from its events and read them."
            />
            <ChoiceCard
              value="private"
              title="Only me"
              description="Its events and automations stay yours. Admins can still manage it."
            />
          </ChoiceCards>
        ) : null}
        {pasted ? (
          <Notice>
            {choice === "webhook"
              ? "Next you get a URL and a signing secret for your app."
              : `Next you get a URL to paste into ${meta.name}, then paste back the secret it shows.`}
          </Notice>
        ) : null}
      </FieldStack>
    </FormPage>
  );
}

/** MCP servers a source can listen to: the deployment's and the workspace's, minus Opengeni's own. */
function useEventMcpServers(enabled: boolean): McpServerOption[] {
  const { clientConfig, workspaceCapabilityCatalog } = useAppContext();
  return useMemo(() => {
    if (!enabled) return [];
    const byId = new Map<string, McpServerOption>();
    for (const server of [
      ...selectableMcpServers(clientConfig),
      ...enabledWorkspaceCapabilityMcpServers(workspaceCapabilityCatalog),
    ]) {
      if (isComposerConnector(server) && !byId.has(server.id)) byId.set(server.id, server);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [clientConfig, enabled, workspaceCapabilityCatalog]);
}

/** The viewer's own Gmail connections; a picker shows only when there are several. */
function useGmailAccounts(workspaceId: string, enabled: boolean): ConnectionMetadata[] {
  const { client, accessContext } = useAppContext();
  const [accounts, setAccounts] = useState<ConnectionMetadata[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listConnections(workspaceId).then(
      (connections) => {
        if (!live) return;
        setAccounts(
          connections.filter(
            (connection) =>
              connection.providerDomain.toLowerCase() === "gmailmcp.googleapis.com" &&
              connection.subjectId === accessContext.subjectId &&
              connection.status !== "revoked",
          ),
        );
      },
      // Without the list the server picks the only mailbox, or says to choose.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [accessContext.subjectId, client, enabled, workspaceId]);
  return accounts;
}

/* ----------------------------------------------------------------------------
   After creating: the one-time secret, or the app's secret to paste.
   -------------------------------------------------------------------------- */

function StandardWebhookCreated({ created, onDone }: { created: Created; onDone: () => void }) {
  return (
    <FormPage
      title="Webhook added"
      description={created.source.name}
      submitLabel="I've saved it"
      cancelLabel={null}
      onSubmitted={onDone}
    >
      <FieldStack>
        <WebhookUrlField url={created.source.webhookUrl} />
        <Field label="Signing secret">
          <SecretOnce value={created.signingSecret!} label="signing secret" />
        </Field>
        <StandardWebhookHelp />
      </FieldStack>
    </FormPage>
  );
}

function PastedWebhookConnect({
  workspaceId,
  source,
  onDone,
}: {
  workspaceId: string;
  source: EventSource;
  onDone: () => void;
}) {
  const { client } = useAppContext();
  const setup = pastedWebhookSetup(t, source)!;
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <FormPage
      title={`Connect ${setup.app}`}
      description={`${source.name} is added. It starts receiving events once ${setup.app} has its URL and Opengeni has the ${setup.secretName}.`}
      submitLabel={`Save ${setup.secretName}`}
      pendingLabel="Saving…"
      cancelLabel="Do it later"
      onCancel={onDone}
      onSubmit={async () => {
        const trimmed = secret.trim();
        if (trimmed.length < 8) {
          setError(`Paste the ${setup.secretName} ${setup.app} shows.`);
          return false;
        }
        await client.updateEventSource(workspaceId, source.id, { signingSecret: trimmed });
        toast.success(`${setup.app} connected`, { description: source.name });
        onDone();
        return true;
      }}
    >
      <PastedWebhookSteps
        source={source}
        secret={secret}
        error={error}
        onSecretChange={(value) => {
          setSecret(value);
          if (error) setError(undefined);
        }}
      />
    </FormPage>
  );
}
