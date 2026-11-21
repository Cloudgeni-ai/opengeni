/**
 * The parts of an agent's page that set it up (docs/agents.md): Starts when
 * (its triggers, each an ordinary automation that starts a chat with it),
 * Can use (Allow, Ask first or Block per tool in its chats, for any
 * connection), Learns (its Memory entries) and Skills. Each saves on its own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type {
  Agent,
  AgentTemplate,
  AgentToolPermission,
  AgentToolPermissionRule,
  CapabilityCatalogItem,
  KnowledgeEntrySummary,
  ScheduledTask,
} from "@opengeni/sdk";

import { AGENT_BUILT_IN_GITHUB_CONNECTOR, GITHUB_REST_TOOL_NAMES } from "@opengeni/contracts";

import { automationWhenWords } from "../../../components/automations/automation-model";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailSection } from "../../../ui/detail-sheet";
import { RowButton } from "../../../ui/page-actions";
import { SelectMenu } from "../../../ui/select-menu";
import { SettingRow, SettingRowSkeleton } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { Textarea } from "../../../ui/textarea";
import { useAppContext } from "../../app-context";
import { agentErrorCode } from "../../lib/agents";
import { t } from "../../lib/console-text";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { PermissionSelect } from "../capabilities/connector-tool-permissions";

const VERSION_CONFLICT =
  "Someone else changed this agent. Reload to see their change, then try again.";

function saveError(title: string, error: unknown) {
  toast.error(title, {
    description:
      agentErrorCode(error) === "agent_version_conflict" ? VERSION_CONFLICT : userErrorText(error),
  });
}

/* ----------------------------------------------------------------------------
   Starts when.
   -------------------------------------------------------------------------- */

/** The automations whose runs are chats with this agent. */
export function agentTriggers(tasks: readonly ScheduledTask[], agentId: string): ScheduledTask[] {
  return tasks.filter((task) => task.agentConfig.agentId === agentId);
}

export function AgentStartsWhen({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.listScheduledTasks(workspaceId, { limit: 200 }).then(
      (list) => live && setTasks(agentTriggers(list, agent.id)),
      () => live && setTasks([]),
    );
    // Names the sources its triggers listen to.
    client.listEventSources(workspaceId).then(
      (list) => live && setSources(list),
      () => undefined,
    );
    if (agent.templateKey) {
      client.listAgentTemplates(workspaceId).then(
        (list) =>
          live && setTemplate(list.find((entry) => entry.key === agent.templateKey) ?? null),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [agent.id, agent.templateKey, client, workspaceId]);
  const add = (agentTrigger?: number) =>
    void navigate({
      to: "/workspaces/$workspaceId/automations/new",
      params: { workspaceId },
      search: { agent: agent.id, ...(agentTrigger !== undefined ? { agentTrigger } : {}) },
    });
  const setOn = async (task: ScheduledTask, on: boolean) => {
    setBusy(task.id);
    try {
      const next = on
        ? await client.resumeScheduledTask(workspaceId, task.id)
        : await client.pauseScheduledTask(workspaceId, task.id);
      setTasks((list) => list?.map((row) => (row.id === next.id ? next : row)) ?? null);
    } catch (error) {
      toast.error("Couldn't change the trigger", { description: userErrorText(error) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (task: ScheduledTask) => {
    setBusy(task.id);
    try {
      await client.deleteScheduledTask(workspaceId, task.id);
      setTasks((list) => list?.filter((row) => row.id !== task.id) ?? null);
    } catch (error) {
      toast.error("Couldn't remove the trigger", { description: userErrorText(error) });
    } finally {
      setBusy(null);
    }
  };
  // A suggestion the person already set up is not offered again.
  const suggestions = (template?.suggestedTriggers ?? [])
    .map((suggestion, index) => ({ suggestion, index }))
    .filter(({ suggestion }) => !tasks?.some((task) => task.name.endsWith(suggestion.name)));
  return (
    <DetailSection
      title="Starts when"
      action={
        agent.viewer.canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => add()}>
            <PlusIcon />
            Add trigger
          </Button>
        ) : undefined
      }
    >
      {tasks === null ? (
        <SettingRowSkeleton />
      ) : tasks.length === 0 && suggestions.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Only when someone starts a chat with it.</p>
      ) : null}
      {tasks?.map((task) => (
        <SettingRow
          key={task.id}
          data-agent-trigger=""
          label={automationWhenWords(t, task, sources, new Date())}
          description={task.name}
          control={
            <div className="flex items-center gap-1">
              <Switch
                aria-label={`${task.name} on`}
                checked={task.status === "active"}
                pending={busy === task.id}
                onCheckedChange={(on) => void setOn(task, on)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${task.name}`}
                disabled={busy === task.id}
                onClick={() => void remove(task)}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        />
      ))}
      {agent.viewer.canEdit
        ? suggestions.map(({ suggestion, index }) => (
            <SettingRow
              key={`suggestion-${index}`}
              data-agent-suggested-trigger=""
              label={suggestion.name}
              description="Suggested. Off until you choose where it listens."
              control={<RowButton onClick={() => add(index)}>Set up</RowButton>}
            />
          ))
        : null}
    </DetailSection>
  );
}

/* ----------------------------------------------------------------------------
   Can use.
   -------------------------------------------------------------------------- */

/** The rule key a connection is named by: its provider's domain, else its server id. */
export function agentConnectorKey(
  item: Pick<CapabilityCatalogItem, "id" | "providerDomain" | "connectionRef" | "tools">,
): string {
  const domain = item.connectionRef?.providerDomain ?? null;
  if (domain) return domain;
  return item.tools.find((tool) => tool.kind === "mcp")?.id ?? item.id;
}

/** The rules with one connector's choice for one tool (`*`: all its tools) set, or cleared with null. */
export function withAgentRule(
  rules: readonly AgentToolPermissionRule[],
  connector: string,
  tool: string,
  permission: AgentToolPermission | null,
): AgentToolPermissionRule[] {
  const rest = rules.filter((rule) => !(rule.connector === connector && rule.tool === tool));
  return permission === null ? rest : [...rest, { connector, tool, permission }];
}

/** Opengeni's own GitHub tools (`github_app`, `github_personal`), for their Can use row. */
const loadBuiltInGitHubTools = async () => [...GITHUB_REST_TOOL_NAMES];

function canUseTarget(item: CapabilityCatalogItem): boolean {
  return item.enabled && item.kind === "mcp" && item.source !== "built_in";
}

function ConnectorCanUse({
  agent,
  connector,
  name,
  loadTools,
  rules,
  saving,
  onChange,
  defaultLabel = "Connection's setting",
}: {
  agent: Agent;
  /** The rule key: a provider domain or a server id. */
  connector: string;
  name: string;
  /** The connector's tool names, read when "Choose per tool" opens. */
  loadTools: () => Promise<string[]>;
  rules: readonly AgentToolPermissionRule[];
  saving: boolean;
  onChange: (rules: AgentToolPermissionRule[]) => void;
  /** The reset choice's name: what applies without a rule. */
  defaultLabel?: string;
}) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const own = rules.filter((rule) => rule.connector === connector);
  const all = own.find((rule) => rule.tool === "*")?.permission;
  const toolRules = own.filter((rule) => rule.tool !== "*");
  // Read once, the first time the list opens.
  const loadToolsOnce = useRef(loadTools);
  loadToolsOnce.current = loadTools;
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    loadToolsOnce.current().then(setTools, () => setTools([]));
  }, [open]);
  const disabled = !agent.viewer.canEdit || saving;
  return (
    <SettingRow
      data-agent-can-use={connector}
      label={name}
      description={
        <button
          type="button"
          className="text-xs text-fg-muted underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
          onClick={() => setOpen((value) => !value)}
        >
          {toolRules.length > 0
            ? `${toolRules.length} tool${toolRules.length === 1 ? "" : "s"} set on their own`
            : open
              ? "Hide tools"
              : "Choose per tool"}
        </button>
      }
      controlWidth="select"
      control={
        <PermissionSelect
          label={`${name}: all tools`}
          value={all ?? "default"}
          disabled={disabled}
          resetLabel={defaultLabel}
          onChange={(permission) => onChange(withAgentRule(rules, connector, "*", permission))}
        />
      }
    >
      {open
        ? [...new Set([...(tools ?? []), ...toolRules.map((rule) => rule.tool)])].map((tool) => (
            <SettingRow
              key={tool}
              label={<code className="text-xs">{tool}</code>}
              controlWidth="select"
              control={
                <PermissionSelect
                  label={`${name}: ${tool}`}
                  value={toolRules.find((rule) => rule.tool === tool)?.permission ?? "default"}
                  disabled={disabled}
                  resetLabel={all ? "Same as all tools" : defaultLabel}
                  onChange={(permission) =>
                    onChange(withAgentRule(rules, connector, tool, permission))
                  }
                />
              }
            />
          ))
        : null}
    </SettingRow>
  );
}

export function AgentCanUse({
  agent,
  workspaceId,
  onSaved,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  const { client } = useAppContext();
  const [items, setItems] = useState<CapabilityCatalogItem[] | null>(null);
  useEffect(() => {
    let live = true;
    client.listCapabilities(workspaceId).then(
      (catalog) => live && setItems(catalog.items.filter(canUseTarget)),
      () => live && setItems([]),
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  // One change at a time: each saves at the version the last one returned.
  const [saving, setSaving] = useState(false);
  const save = async (rules: AgentToolPermissionRule[]) => {
    setSaving(true);
    try {
      onSaved(
        await client.updateAgent(workspaceId, agent.id, {
          expectedVersion: agent.version,
          toolPermissions: rules,
        }),
      );
    } catch (error) {
      saveError("Couldn't change what it can use", error);
    } finally {
      setSaving(false);
    }
  };
  // Rules for connections not listed here (another person's, or not set up
  // yet, such as a ready-made agent's suggestion) still show and can go.
  const listed = useMemo(() => new Set((items ?? []).map(agentConnectorKey)), [items]);
  // Opengeni's own GitHub tools have a row of their own (a github.com rule
  // also covers GitHub connections, so a listed GitHub connection's row
  // already does).
  const unlisted = agent.toolPermissions.filter(
    (rule) =>
      items !== null &&
      !listed.has(rule.connector) &&
      rule.connector !== AGENT_BUILT_IN_GITHUB_CONNECTOR,
  );
  return (
    <DetailSection
      title="Can use"
      description="Ask first or Block applies in this agent's chats. Allow follows the connection's own setting."
    >
      {items === null ? <SettingRowSkeleton /> : null}
      {items?.map((item) => (
        <ConnectorCanUse
          key={item.id}
          agent={agent}
          connector={agentConnectorKey(item)}
          name={item.name}
          loadTools={() =>
            client.getConnectorToolPermissions(workspaceId, item.id).then((response) => {
              const names = response.tools.map((tool) => tool.name);
              // A github.com rule also covers Opengeni's own GitHub tools.
              return agentConnectorKey(item) === AGENT_BUILT_IN_GITHUB_CONNECTOR
                ? [...new Set([...names, ...GITHUB_REST_TOOL_NAMES])]
                : names;
            })
          }
          rules={agent.toolPermissions}
          saving={saving}
          onChange={(rules) => void save(rules)}
        />
      ))}
      {items !== null && !listed.has(AGENT_BUILT_IN_GITHUB_CONNECTOR) ? (
        <ConnectorCanUse
          agent={agent}
          connector={AGENT_BUILT_IN_GITHUB_CONNECTOR}
          name="GitHub"
          loadTools={loadBuiltInGitHubTools}
          defaultLabel="Default"
          rules={agent.toolPermissions}
          saving={saving}
          onChange={(rules) => void save(rules)}
        />
      ) : null}
      {unlisted.map((rule) => (
        <SettingRow
          key={`${rule.connector}:${rule.tool}`}
          label={rule.tool === "*" ? rule.connector : `${rule.connector} · ${rule.tool}`}
          controlWidth="select"
          control={
            <PermissionSelect
              label={`${rule.connector}: ${rule.tool}`}
              value={rule.permission}
              disabled={!agent.viewer.canEdit || saving}
              resetLabel="Remove"
              onChange={(permission) =>
                void save(
                  withAgentRule(agent.toolPermissions, rule.connector, rule.tool, permission),
                )
              }
            />
          }
        />
      ))}
    </DetailSection>
  );
}

/* ----------------------------------------------------------------------------
   Learns.
   -------------------------------------------------------------------------- */

function MemoryEntryRow({
  entry,
  workspaceId,
  canEdit,
  onRemoved,
}: {
  entry: KnowledgeEntrySummary;
  workspaceId: string;
  canEdit: boolean;
  onRemoved: (id: string) => void;
}) {
  const { client } = useAppContext();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState(entry.revision.preview);
  const [version, setVersion] = useState(entry.version);
  const [busy, setBusy] = useState(false);
  const startEdit = async () => {
    setBusy(true);
    try {
      const full = await client.getKnowledgeEntry(workspaceId, entry.id);
      setVersion(full.version);
      setEditing(full.revision.entry.content);
    } catch (error) {
      toast.error("Couldn't open this memory", { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (editing === null) return;
    setBusy(true);
    try {
      const full = await client.getKnowledgeEntry(workspaceId, entry.id);
      const receipt = await client.saveKnowledgeEntry(workspaceId, {
        operationId: crypto.randomUUID(),
        entryId: entry.id,
        // The version read when editing started: a change made since is
        // reported, never overwritten.
        expectedVersion: version,
        entry: {
          title: full.revision.entry.title,
          kind: full.revision.entry.kind,
          content: editing,
          groupIds: full.revision.entry.groupIds,
        },
      });
      setVersion((receipt as { version?: number }).version ?? full.version + 1);
      setText(editing);
      setEditing(null);
    } catch (error) {
      toast.error("Couldn't save this memory", { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await client.archiveKnowledgeEntry(workspaceId, entry.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: version,
      });
      onRemoved(entry.id);
    } catch (error) {
      toast.error("Couldn't remove this memory", { description: userErrorText(error) });
      setBusy(false);
    }
  };
  if (editing !== null) {
    return (
      <SettingRow
        variant="stacked"
        label={entry.revision.title}
        control={
          <div className="grid gap-2">
            <Textarea
              aria-label={entry.revision.title}
              value={editing}
              rows={4}
              onChange={(event) => setEditing(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={busy || !editing.trim()} onClick={save}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        }
      />
    );
  }
  return (
    <SettingRow
      data-agent-memory-entry=""
      label={entry.revision.title}
      description={<span className="line-clamp-2">{text}</span>}
      control={
        canEdit ? (
          <div className="flex items-center gap-1">
            <RowButton disabled={busy} onClick={() => void startEdit()}>
              Edit
            </RowButton>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${entry.revision.title}`}
              disabled={busy}
              onClick={() => void remove()}
            >
              <Trash2Icon />
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}

/** What the agent's Memory holds: each entry, editable and removable. */
export function AgentMemoryEntries({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const { client } = useAppContext();
  const [entries, setEntries] = useState<KnowledgeEntrySummary[] | null>(null);
  const collectionId = agent.memory.enabled ? agent.memory.collectionId : null;
  useEffect(() => {
    if (!collectionId) {
      setEntries([]);
      return;
    }
    let live = true;
    client.listKnowledgeEntries(workspaceId, { groupId: collectionId, limit: 50 }).then(
      (response) =>
        live && setEntries(response.entries.filter((entry) => entry.id !== collectionId)),
      () => live && setEntries([]),
    );
    return () => {
      live = false;
    };
  }, [client, collectionId, workspaceId]);
  if (!collectionId) return null;
  if (entries === null) return <SettingRowSkeleton />;
  if (entries.length === 0) {
    return <p className="m-0 text-sm text-fg-muted">Nothing remembered yet.</p>;
  }
  return (
    <>
      {entries.map((entry) => (
        <MemoryEntryRow
          key={entry.id}
          entry={entry}
          workspaceId={workspaceId}
          canEdit={agent.viewer.canEdit}
          onRemoved={(id) => setEntries((list) => list?.filter((row) => row.id !== id) ?? null)}
        />
      ))}
    </>
  );
}

/* ----------------------------------------------------------------------------
   Skills.
   -------------------------------------------------------------------------- */

export function AgentSkills({
  agent,
  workspaceId,
  onSaved,
}: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [names, setNames] = useState<{ key: string; title: string }[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!adding || names !== null) return;
    // The workspace's own and installed Skills; Opengeni's built-in ones are not listed.
    client.listWorkspaceSkills(workspaceId, { limit: 200 }).then(
      (list) =>
        setNames(
          list.skills.map((skill) => ({
            key: skill.stableKey,
            title: skill.title ?? skill.stableKey,
          })),
        ),
      () => setNames([]),
    );
  }, [adding, client, names, workspaceId]);
  const save = async (skills: { name: string }[]) => {
    setSaving(true);
    try {
      onSaved(
        await client.updateAgent(workspaceId, agent.id, { expectedVersion: agent.version, skills }),
      );
    } catch (error) {
      saveError("Couldn't change its Skills", error);
    } finally {
      setSaving(false);
    }
  };
  const listed = new Set(agent.skills.map((skill) => skill.name));
  return (
    <DetailSection
      title="Skills"
      action={
        agent.viewer.canEdit && !adding ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add
          </Button>
        ) : undefined
      }
    >
      {agent.skills.length === 0 && !adding ? (
        <p className="m-0 text-sm text-fg-muted">
          Every Skill in the workspace is available. Add the ones it relies on.
        </p>
      ) : null}
      {agent.skills.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {agent.skills.map((skill) => (
            <li key={skill.name} className="flex items-center gap-1">
              <a
                href={`/workspaces/${encodeURIComponent(workspaceId)}/skills?skill=${encodeURIComponent(skill.name)}`}
                onClick={(event) => {
                  event.preventDefault();
                  void navigate({
                    href: `/workspaces/${encodeURIComponent(workspaceId)}/skills?skill=${encodeURIComponent(skill.name)}`,
                  });
                }}
                className="rounded-[4px] text-sm text-fg underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
              >
                {skill.name}
              </a>
              {agent.viewer.canEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${skill.name}`}
                  disabled={saving}
                  onClick={() =>
                    void save(agent.skills.filter((entry) => entry.name !== skill.name))
                  }
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <SelectMenu
          aria-label="Add a Skill"
          name="skill"
          size="sm"
          value=""
          placeholder={names === null ? "Loading…" : "Choose a Skill"}
          options={(names ?? [])
            .filter((skill) => !listed.has(skill.key))
            .map((skill) => ({ value: skill.key, label: skill.title }))}
          onValueChange={(name) => {
            setAdding(false);
            if (name) void save([...agent.skills, { name }]);
          }}
        />
      ) : null}
    </DetailSection>
  );
}
