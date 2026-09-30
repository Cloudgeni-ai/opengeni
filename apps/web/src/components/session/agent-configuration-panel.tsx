/**
 * Session dock > Agent: what this session's agent can do and who it is, in
 * product words, with Edit. Changes apply from the next turn (the running
 * turn keeps what it started with). A session created before agent settings
 * (no configuration) says so and converts on its first save, starting from
 * what it can do today. Tool names only appear under Technical details.
 */
import {
  AGENT_IDENTITY_MAX_CHARACTERS,
  legacyEffectiveAgentCapabilities,
} from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import { PencilIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AgentCapabilityPicker,
  AgentCapabilitySummary,
} from "@/components/agent/agent-capability-picker";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppContext } from "@/context";
import {
  AGENT_CAPABILITY_GROUPS,
  AGENT_STARTING_POINTS,
  agentConfigErrorText,
  capabilityAvailability,
  capabilitySummary,
  draftFromResolved,
  draftsEqual,
  requestFromDraft,
  toolOwnerLabel,
  type AgentCapabilityDraft,
} from "@/lib/agent-capabilities";
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

export function AgentConfigurationPanel(props: {
  session: Session;
  /** The latest change to these settings, when one is in the loaded events. */
  lastChange?: { at: string; pending: boolean } | null;
  onReloadSession: () => Promise<void>;
}) {
  const { session } = props;
  const context = useAppContext();
  const workspace =
    context.workspaces.find((candidate) => candidate.id === session.workspaceId) ?? null;
  const canEdit = hasWorkspacePermission(
    context.accessContext,
    session.workspaceId,
    "sessions:control",
  );
  const config = session.agent ?? null;
  const availability = useMemo(
    () => capabilityAvailability(context.clientConfig.agentConfig, config?.unavailable ?? []),
    [context.clientConfig.agentConfig, config?.unavailable],
  );
  // A legacy session: what it can do today, as the server will convert it.
  const legacyValues = useMemo(
    () =>
      config
        ? null
        : legacyEffectiveAgentCapabilities({
            firstPartyMcpTools: session.firstPartyMcpTools,
            tools: session.tools,
            toolPolicy: session.toolPolicy,
            humanInputEnabled: workspace?.settings.agentHumanInputEnabled !== false,
            defaultServerIds: context.workspaceDefaultToolIds,
          }),
    [config, session, workspace?.settings, context.workspaceDefaultToolIds],
  );
  const current: AgentCapabilityDraft = config
    ? draftFromResolved(config)
    : { from: "all", values: legacyValues! };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentCapabilityDraft>(current);
  const [identity, setIdentity] = useState(config?.identity ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone else's save (or a reload) while not editing shows the new truth.
  const configKey = JSON.stringify(config);
  useEffect(() => {
    if (editing) return;
    setDraft(current);
    setIdentity(config?.identity ?? "");
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follow the frozen configuration
  }, [configKey, editing]);

  const identityChanged = identity.trim() !== (config?.identity ?? "").trim();
  const dirty = !draftsEqual(draft, current) || identityChanged || !config;
  const identityTooLong = identity.trim().length > AGENT_IDENTITY_MAX_CHARACTERS;

  async function save() {
    if (!canEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      await context.client.updateSessionAgent(session.workspaceId, session.id, {
        agent: {
          capabilities: requestFromDraft(draft, availability),
          ...(identityChanged ? { identity: identity.trim() || null } : {}),
        },
        expectedVersion: session.toolPolicyVersion,
      });
      await props.onReloadSession();
      setEditing(false);
      toast.success("Agent settings saved", { description: "They apply from the next turn." });
    } catch (failure) {
      setError(
        agentConfigErrorText(failure, "Couldn't save the agent settings. Nothing was changed."),
      );
      if (failure instanceof OpenGeniApiError && failure.status === 409) {
        await props.onReloadSession();
      }
    } finally {
      setSaving(false);
    }
  }

  const startingPoint =
    AGENT_STARTING_POINTS.find((option) => option.value === current.from)?.title ?? "";

  return (
    <div className="flex h-full min-h-[28rem] w-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-fg">{editing ? "Edit agent" : "Agent"}</h2>
          <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
            {editing
              ? "Applies from the next turn."
              : `${config ? startingPoint : "Before agent settings"} · ${capabilitySummary(current.values, availability)}`}
          </p>
        </div>
        {!editing && canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 pointer-coarse:h-11"
            onClick={() => {
              setDraft(current);
              setIdentity(config?.identity ?? "");
              setError(null);
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        ) : null}
      </div>
      <div
        // Focusable so keyboard users can scroll a long list.
        tabIndex={0}
        role="region"
        aria-label={editing ? "Edit agent" : "Agent settings"}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand/55"
      >
        <div className="flex min-w-0 flex-col gap-6 px-4 py-4">
          {editing ? (
            <>
              {!config ? (
                <Notice tone="info">
                  Saving converts this session to agent settings, starting from what it can do now.
                </Notice>
              ) : null}
              <AgentCapabilityPicker
                draft={draft}
                onChange={setDraft}
                availability={availability}
                disabled={saving}
              />
              <Field
                label="Who the agent is"
                optional
                aside={`${identity.trim().length.toLocaleString()} / ${AGENT_IDENTITY_MAX_CHARACTERS.toLocaleString()}`}
                error={
                  identityTooLong
                    ? `Use ${AGENT_IDENTITY_MAX_CHARACTERS.toLocaleString()} characters or fewer.`
                    : undefined
                }
                hint="Empty uses the workspace's identity, or OpenGeni's default."
              >
                <TextArea
                  rows={3}
                  value={identity}
                  disabled={saving}
                  onChange={(event) => setIdentity(event.target.value)}
                />
              </Field>
              {error ? (
                <Notice tone="failed" title="Not saved">
                  {error}
                </Notice>
              ) : null}
            </>
          ) : (
            <>
              {!config ? (
                <Notice>
                  This session started before agent settings and keeps the tools it started with.
                  Editing converts it, starting from what it can do now.
                </Notice>
              ) : props.lastChange ? (
                <p className="text-xs leading-4.5 text-fg-muted">
                  Changed <RelativeTime date={props.lastChange.at} inSentence />.{" "}
                  {props.lastChange.pending
                    ? "Applies from the next turn."
                    : "The latest turn used these settings."}
                </p>
              ) : null}
              {!canEdit ? (
                <p className="text-xs leading-4.5 text-fg-muted">
                  You can see these settings. Changing them needs permission to run this session.
                </p>
              ) : null}
              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="text-xs leading-4.5 font-medium text-fg-subtle">Who the agent is</h3>
                <p
                  className={cn(
                    "text-sm leading-5 break-words whitespace-pre-wrap",
                    config?.identity ? "text-fg" : "text-fg-muted",
                  )}
                >
                  {config?.identity ?? "The workspace's identity, or OpenGeni's default."}
                </p>
              </div>
              <AgentCapabilitySummary values={current.values} availability={availability} />
              <ConnectedApps session={session} />
              <TechnicalDetails session={session} />
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          <p className="mr-auto min-w-0 text-xs leading-4.5 text-fg-muted">
            {capabilitySummary(draft.values, availability)}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={!dirty || saving || identityTooLong}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Apps this session can use: its own, then the workspace's, as names. */
function ConnectedApps({ session }: { session: Session }) {
  const context = useAppContext();
  const servers = session.effectiveTools?.mcpServers ?? [];
  const nameOf = (id: string) =>
    session.mcpServers.find((server) => server.id === id)?.name ??
    context.toolMcpServers.find((server) => server.id === id)?.name ??
    "Custom app";
  const names = (capability: "product" | "workspaceConnectors") =>
    servers
      .filter((server) => server.capability === capability)
      .map((server) => nameOf(server.id))
      .sort((left, right) => left.localeCompare(right));
  const own = names("product");
  const workspace = names("workspaceConnectors");
  if (own.length === 0 && workspace.length === 0) return null;
  return (
    <section aria-labelledby="agent-connected-apps" className="min-w-0">
      <h3 id="agent-connected-apps" className="pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
        Connected apps
      </h3>
      <dl className="m-0 flex min-w-0 flex-col gap-2 text-sm leading-5">
        {own.length > 0 ? (
          <div className="min-w-0">
            <dt className="text-xs leading-4.5 text-fg-muted">Added to this session</dt>
            <dd className="m-0 break-words text-fg">{own.join(", ")}</dd>
          </div>
        ) : null}
        {workspace.length > 0 ? (
          <div className="min-w-0">
            <dt className="text-xs leading-4.5 text-fg-muted">
              From the workspace ({workspace.length})
            </dt>
            <dd className="m-0 break-words text-fg">{workspace.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-2 text-xs leading-4.5 text-fg-muted">
        Each app lists its own tools when a turn starts.
      </p>
    </section>
  );
}

function TechnicalDetails({ session }: { session: Session }) {
  const tools = session.effectiveTools?.tools ?? [];
  const servers = session.effectiveTools?.mcpServers ?? [];
  if (!session.effectiveTools) return null;
  const owners: Array<AgentEffectiveToolOwner> = [
    ...AGENT_CAPABILITY_GROUPS.flatMap((group) => group.capabilities),
    "product",
    "sandbox",
    "runtime",
  ];
  const groups = owners
    .map((owner) => ({ owner, tools: tools.filter((tool) => tool.capability === owner) }))
    .filter((group) => group.tools.length > 0);
  const anyVisibility = tools.some((tool) => tool.visibility !== undefined);
  return (
    <Disclosure
      title="Technical details"
      summary={`${tools.length} tools${servers.length ? ` · ${servers.length} tool servers` : ""}`}
    >
      <div className="flex min-w-0 flex-col gap-5 pt-2 pb-2">
        <p className="text-xs leading-4.5 text-fg-muted">
          {anyVisibility
            ? "Up front: sent with every request. On demand: the agent finds it by search when it needs it."
            : "What this session can use. Each app lists its own tools when a turn starts."}
        </p>
        {groups.map((group) => (
          <section key={group.owner} className="min-w-0">
            <h4 className="pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
              {toolOwnerLabel(group.owner)}
            </h4>
            <ul className="m-0 flex min-w-0 list-none flex-col p-0">
              {group.tools.map((tool) => (
                <li
                  key={`${tool.source}:${tool.name}`}
                  className="flex min-h-7 min-w-0 items-center justify-between gap-3"
                >
                  <code className="min-w-0 font-mono text-xs break-all text-fg">{tool.name}</code>
                  {tool.visibility ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 text-2xs leading-4.5",
                        tool.visibility === "upfront"
                          ? "border-brand/30 text-brand"
                          : "border-border text-fg-muted",
                      )}
                    >
                      {tool.visibility === "upfront" ? "Up front" : "On demand"}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {servers.length > 0 ? (
          <section className="min-w-0">
            <h4 className="pb-1 text-xs leading-4.5 font-medium text-fg-subtle">Tool servers</h4>
            <ul className="m-0 flex min-w-0 list-none flex-col p-0">
              {servers.map((server) => (
                <li
                  key={server.id}
                  className="flex min-h-7 min-w-0 items-center justify-between gap-3"
                >
                  <code className="min-w-0 font-mono text-xs break-all text-fg">{server.id}</code>
                  <span className="shrink-0 text-2xs text-fg-subtle">
                    {server.toolsKnown
                      ? toolOwnerLabel(server.capability)
                      : "Tools listed when a turn starts"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Disclosure>
  );
}

type AgentEffectiveToolOwner = NonNullable<
  Session["effectiveTools"]
>["tools"][number]["capability"];
