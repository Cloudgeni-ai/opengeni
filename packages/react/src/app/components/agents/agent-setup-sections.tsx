/**
 * The parts of an agent's page that set it up (docs/agents.md): Starts when
 * (its triggers, each an ordinary automation that starts a chat with it),
 * Can use (Allow, Ask first or Block per tool in its chats, for any
 * connection), Learns (its Memory entries) and Skills. Each saves on its own.
 */
import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { slackAgentCallText } from "@opengeni/contracts";
import type { Agent, AgentTemplate, KnowledgeEntrySummary, ScheduledTask } from "@opengeni/sdk";

import { automationWhenWords } from "../../../components/automations/automation-model";
import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { DetailSection } from "../../../ui/detail-sheet";
import { RowButton } from "../../../ui/page-actions";
import { SettingRow, SettingRowSkeleton } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { Textarea } from "../../../ui/textarea";
import { useAppContext } from "../../app-context";
import { agentErrorCode } from "../../lib/agents";
import { t } from "../../lib/console-text";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { AgentCanUse as AgentCanUseSection } from "./agent-can-use";
import { AgentSkills as AgentSkillsSection } from "./agent-skills";
import { AgentTriggerDialog } from "./agent-trigger-dialog";
import { githubConnectedOf } from "../../lib/github-connect";
import {
  addAgentSuggestedTrigger,
  agentTriggerOffers,
  agentTriggerSaveError,
  agentUsesGitHub,
  mentionHint,
  type AgentTriggerOffer,
  type AgentTriggerChat,
} from "./agent-trigger-model";

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

/**
 * The automations whose runs are chats with this agent. The server filters
 * by agent; this also drops anything an older server returned unfiltered.
 */
export function agentTriggers(tasks: readonly ScheduledTask[], agentId: string): ScheduledTask[] {
  return tasks.filter((task) => task.agentConfig.agentId === agentId);
}

export function AgentStartsWhen({ agent, workspaceId }: { agent: Agent; workspaceId: string }) {
  const context = useAppContext();
  const { client } = context;
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // The light Add trigger dialog, blank or at one offer.
  const [adding, setAdding] = useState<{ offer?: AgentTriggerOffer } | null>(null);
  useEffect(() => {
    let live = true;
    client.listScheduledTasks(workspaceId, { agentId: agent.id, limit: 200 }).then(
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
  // The full form starts at the suggestion, or at the source picked in the dialog.
  const openFullForm = (
    agentTrigger?: number,
    start: {
      sourceId?: string | undefined;
      note?: string | undefined;
      chat?: AgentTriggerChat | undefined;
    } = {},
  ) =>
    void navigate({
      to: "/workspaces/$workspaceId/automations/new",
      params: { workspaceId },
      search: {
        agent: agent.id,
        ...(agentTrigger !== undefined ? { agentTrigger } : {}),
        ...(start.sourceId ? { source: start.sourceId } : {}),
        returnTo: "agent",
      },
      // The note stays out of the address, so links and analytics never carry it.
      ...(start.note || start.chat
        ? {
            state: {
              agentTriggerStart: { note: start.note, chat: start.chat },
            },
          }
        : {}),
    });
  const addSource = (kind?: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/automations/sources/new",
      params: { workspaceId },
      search: kind ? { kind } : {},
    });
  const setOn = async (task: ScheduledTask, on: boolean) => {
    setBusy(task.id);
    try {
      const next = on
        ? await client.resumeScheduledTask(workspaceId, task.id)
        : await client.pauseScheduledTask(workspaceId, task.id);
      setTasks((list) => list?.map((row) => (row.id === next.id ? next : row)) ?? null);
    } catch (error) {
      toast.error("Couldn't change the trigger", {
        description: userErrorText(error),
      });
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
      toast.error("Couldn't remove the trigger", {
        description: userErrorText(error),
      });
    } finally {
      setBusy(null);
    }
  };
  // A one-click offer is added as it is; one that needs a choice opens the dialog.
  const addNow = async (offer: AgentTriggerOffer) => {
    setBusy(offer.key);
    try {
      const outcome = await addAgentSuggestedTrigger(t, {
        client,
        workspaceId,
        agent,
        suggestion: offer.suggestion,
        githubConnected,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: new Date(),
      });
      if (outcome.kind === "needs_setup") {
        setAdding({ offer });
        return;
      }
      const task = outcome.task;
      setTasks((list) => [...(list ?? []).filter((row) => row.id !== task.id), task]);
      toast.success("Trigger added", { description: task.name });
    } catch (error) {
      toast.error("Couldn't add the trigger", {
        description: agentTriggerSaveError(
          error,
          agent.visibility === "private" ? "private" : "workspace",
        ),
      });
    } finally {
      setBusy(null);
    }
  };
  const githubConnected = githubConnectedOf(context.githubStatus?.status);
  // Its template's suggestions and the common triggers it can use, each
  // offered until it is set up.
  const offers = agentTriggerOffers({
    templateSuggestions: template?.suggestedTriggers ?? [],
    usesGitHub: agentUsesGitHub(agent.toolPermissions, githubConnected),
    agentName: agent.name,
    tasks,
  });
  // A shared agent already starts when someone asks it in Slack.
  const inSlack = agent.visibility !== "private" && agent.slack.length > 0;
  return (
    <DetailSection
      title="Starts when"
      action={
        agent.viewer.canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding({})}>
            <PlusIcon />
            Add trigger
          </Button>
        ) : undefined
      }
    >
      {tasks === null ? (
        <SettingRowSkeleton />
      ) : tasks.length === 0 && offers.length === 0 && !inSlack ? (
        <p className="m-0 text-sm text-fg-muted">Only when someone starts a chat with it.</p>
      ) : null}
      {inSlack ? (
        <SettingRow
          data-agent-slack-trigger=""
          label="When mentioned in Slack"
          description={`Always on: ${slackAgentCallText(agent.name)}`}
        />
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
        ? offers.map((offer) => (
            <SettingRow
              key={offer.key}
              data-agent-suggested-trigger=""
              data-agent-common-trigger={offer.common}
              label={offer.suggestion.name}
              description={
                offer.common === "mentioned_on_pull_request"
                  ? mentionHint(agent.name)
                  : offer.suggestion.oneClick
                    ? undefined
                    : "Off until you choose where it listens."
              }
              control={
                offer.suggestion.oneClick ? (
                  <Switch
                    aria-label={`${offer.suggestion.name} on`}
                    checked={false}
                    pending={busy === offer.key}
                    disabled={busy !== null && busy !== offer.key}
                    onCheckedChange={(on) => {
                      if (on) void addNow(offer);
                    }}
                  />
                ) : (
                  <RowButton onClick={() => setAdding({ offer })}>Set up</RowButton>
                )
              }
            />
          ))
        : null}
      {agent.viewer.canEdit ? (
        <AgentTriggerDialog
          agent={agent}
          workspaceId={workspaceId}
          suggestion={adding?.offer?.suggestion}
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          onCreated={(task) => {
            setTasks((list) => [...(list ?? []).filter((row) => row.id !== task.id), task]);
            setAdding(null);
            toast.success("Trigger added", { description: task.name });
          }}
          onOpenFullForm={(start) => openFullForm(adding?.offer?.templateIndex, start)}
          onAddSource={addSource}
        />
      ) : null}
    </DetailSection>
  );
}

/* ----------------------------------------------------------------------------
   Can use (agent-can-use.tsx).
   -------------------------------------------------------------------------- */

export { agentConnectorKey, withAgentRule } from "./agent-can-use";

export function AgentCanUse(props: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  return (
    <AgentCanUseSection
      {...props}
      onError={(error) => saveError("Couldn't change what it can use", error)}
    />
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
      toast.error("Couldn't open this memory", {
        description: userErrorText(error),
      });
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
      toast.error("Couldn't save this memory", {
        description: userErrorText(error),
      });
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
      toast.error("Couldn't remove this memory", {
        description: userErrorText(error),
      });
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
   Skills (agent-skills.tsx).
   -------------------------------------------------------------------------- */

export function AgentSkills(props: {
  agent: Agent;
  workspaceId: string;
  onSaved: (agent: Agent) => void;
}) {
  return (
    <AgentSkillsSection
      {...props}
      onError={(error) => saveError("Couldn't change its Skills", error)}
    />
  );
}
