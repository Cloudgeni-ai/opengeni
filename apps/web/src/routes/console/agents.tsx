// Console > Agents: the organization's agents (Console and code managed) and
// New agent. One agent's page is agent-detail.tsx.
import type { OrgAgentSummary } from "@opengeni/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";

import { ORG_AGENT_KEY_PATTERN } from "@opengeni/contracts";
import { agentKeyFromName } from "@/lib/organization-agents";
import {
  ConsoleForbidden,
  ConsoleLoadError,
  ConsolePage,
  formatMicros,
  useConsole,
  useConsoleCan,
  useConsoleQuery,
  useOrgAgentsApi,
  useOrgAgentsEnabled,
} from "./console-shared";

/** Without the flag: the page that was here before Console agents. */
function AgentsComing() {
  return (
    <ConsolePage>
      <PageHeader title="Agents" icon={<BotIcon />} />
      <EmptyState
        variant="page"
        icon={<BotIcon />}
        title="Organization agents are coming"
        description="For now, agents live in each workspace."
      />
    </ConsolePage>
  );
}

function AgentsLoading() {
  return (
    <ConsolePage>
      <PageHeader title="Agents" icon={<BotIcon />} />
      <ListRowSkeleton count={3} />
    </ConsolePage>
  );
}

/** "v3", "v3 · Draft v4", "Draft v1". */
export function agentVersionText(
  agent: Pick<OrgAgentSummary, "publishedVersion" | "latestVersion">,
) {
  const draft =
    agent.publishedVersion === null || agent.latestVersion > agent.publishedVersion
      ? agent.latestVersion
      : null;
  return { published: agent.publishedVersion, draft };
}

export function ConsoleAgentsRoute() {
  const enabled = useOrgAgentsEnabled();
  // The list is read only once the flag is known to be on (the agent routes
  // answer 404 while it is off).
  if (enabled === null) return <AgentsLoading />;
  return enabled ? <AgentsList /> : <AgentsComing />;
}

function AgentsList() {
  const { search } = useConsole();
  const api = useOrgAgentsApi();
  const navigate = useNavigate();
  const agents = useConsoleQuery((signal) => api.listAgents(signal), [api]);
  const canEdit = useConsoleCan("editor");
  const rows = (agents.data?.agents ?? []).filter((agent) => agent.archivedAt === null);
  const ids = rows.map((agent) => agent.id).join(",");
  // Chats and cost per agent, the last 30 days (one usage read each).
  const usage = useConsoleQuery(
    async (signal) => {
      const entries = await Promise.all(
        (ids ? ids.split(",") : []).map(async (id) => {
          try {
            return [id, await api.usage(id, { signal })] as const;
          } catch (error) {
            if (signal.aborted) throw error;
            return [id, null] as const;
          }
        }),
      );
      return new Map(entries);
    },
    [api, ids],
  );
  const create = () => void navigate({ to: "/console/agents/new", search });
  const open = (agent: OrgAgentSummary) =>
    void navigate({
      to: "/console/agents/$agentId",
      params: { agentId: agent.id },
      search,
    });

  return (
    <ConsolePage>
      <PageHeader
        title="Agents"
        icon={<BotIcon />}
        description="Your product starts chats with an agent by its key. Publish to update new chats."
        actions={
          rows.length > 0 && canEdit ? (
            <Button onClick={create}>
              <PlusIcon aria-hidden="true" />
              New agent
            </Button>
          ) : undefined
        }
      />
      {agents.error ? (
        <ConsoleLoadError error={agents.error} onRetry={agents.reload} />
      ) : agents.loading && rows.length === 0 ? (
        <ListRowSkeleton count={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="No agents yet"
          description="Set up an agent once and start every chat with it, or deploy one from code."
          action={
            canEdit ? (
              <Button onClick={create}>
                <PlusIcon aria-hidden="true" />
                New agent
              </Button>
            ) : undefined
          }
        />
      ) : (
        <RowList
          variant="table"
          label="Agents"
          nameLabel="Agent"
          columns={[
            { id: "managed", label: "Managed in", width: 132 },
            { id: "published", label: "Published", width: 120 },
            { id: "chats", label: "Chats (30d)", width: 96 },
            { id: "cost", label: "Cost (30d)", width: 104 },
            { id: "updated", label: "Updated", width: 112 },
          ]}
        >
          {rows.map((agent) => {
            const { published, draft } = agentVersionText(agent);
            const used = usage.data?.get(agent.id) ?? null;
            return (
              <ListRow
                key={agent.id}
                title={agent.name}
                meta={[
                  <span key="key" translate="no" className="font-mono">
                    {agent.key}
                  </span>,
                  agent.description || null,
                ]}
                cells={{
                  managed:
                    agent.managedBy === "code" ? (
                      <MetaChip variant="soft">Managed by code</MetaChip>
                    ) : (
                      "Console"
                    ),
                  published: (
                    <span className="flex items-center gap-1.5">
                      {published === null ? (
                        <span className="text-fg-subtle">Not yet</span>
                      ) : (
                        `v${published}`
                      )}
                      {draft !== null ? (
                        <MetaChip variant="outline">Draft v{draft}</MetaChip>
                      ) : null}
                    </span>
                  ),
                  chats: used ? String(used.sessions) : "—",
                  cost: used ? formatMicros(used.costMicros) : "—",
                  updated: <RelativeTime date={agent.updatedAt} />,
                }}
                onOpen={() => open(agent)}
              />
            );
          })}
        </RowList>
      )}
    </ConsolePage>
  );
}

/** New agent: name, key and description. Settings come on the agent's page. */
export function ConsoleNewAgentRoute() {
  return useConsoleCan("editor") ? (
    <NewAgentForm />
  ) : (
    <ConsoleForbidden title="Your Console role is Viewer" />
  );
}

function NewAgentForm() {
  const { search } = useConsole();
  const api = useOrgAgentsApi();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<{ name?: string; key?: string }>({});
  const close = () => void navigate({ to: "/console/agents", search });
  const shownKey = keyEdited ? key : agentKeyFromName(name);

  return (
    <FlushFormPage
      backLabel="Agents"
      onClose={close}
      title="New agent"
      submitLabel="Create agent"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const next: { name?: string; key?: string } = {};
        if (!name.trim()) next.name = "Name the agent.";
        if (!ORG_AGENT_KEY_PATTERN.test(shownKey)) {
          next.key = "Use lowercase letters, digits, - or _, starting with a letter or digit.";
        }
        setErrors(next);
        if (next.name || next.key) return false;
        try {
          const created = await api.createAgent({
            key: shownKey,
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
          });
          void navigate({
            to: "/console/agents/$agentId",
            params: { agentId: created.id },
            search,
          });
          return false;
        } catch (error) {
          throw new Error(`The agent wasn't created. ${userErrorText(error)}`, { cause: error });
        }
      }}
    >
      <FieldStack>
        <Field label="Name" error={errors.name}>
          <TextInput
            value={name}
            maxLength={120}
            suppressAutofill
            onChange={(event) => {
              setName(event.target.value);
              setErrors((current) => ({ ...current, name: undefined }));
            }}
          />
        </Field>
        <Field
          label="Key"
          hint="Your code starts chats with this. It can't change later."
          error={errors.key}
        >
          <TextInput
            value={shownKey}
            maxLength={64}
            translate="no"
            className="font-mono"
            suppressAutofill
            onChange={(event) => {
              setKey(event.target.value);
              setKeyEdited(true);
              setErrors((current) => ({ ...current, key: undefined }));
            }}
          />
        </Field>
        <Field label="Description" optional>
          <TextArea
            value={description}
            maxLength={280}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}
