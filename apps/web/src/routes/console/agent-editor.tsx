// An agent's Settings tab: its Instructions, model, built-in tools, tool
// servers (each tool on or off and "Ask first"), workers and where it is
// available. Save draft writes a new version; Publish (the page header) makes
// new chats use it. A code-managed agent shows the same settings read-only.
import type {
  OrgAgent,
  OrgAgentDefinition,
  OrgAgentNewToolsPolicy,
  OrgAgentToolCatalog,
  OrgAgentToolCatalogEntry,
  OrgAgentToolServerConfig,
  OrgToolServer,
  ReasoningEffort,
} from "@opengeni/contracts";
import { PlugIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@opengeni/react/app/app-context";
import { AgentCapabilityPicker } from "@opengeni/react/app/components/agent/agent-capability-picker";
import { payerShortLabel } from "@opengeni/react/app/components/models/models-ui";
import { ModelPicker } from "@opengeni/react/app/components/pickers";
import { WorkspaceChecklist } from "@opengeni/react/app/components/workspace-reach";
import {
  capabilityAvailability,
  draftFromRequest,
  draftsEqual,
  requestFromDraft,
  type AgentCapabilityDraft,
} from "@opengeni/react/app/lib/agent-capabilities";
import { useWorkspaceModelCatalog } from "@opengeni/react/app/lib/use-workspace-model-catalog";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button, buttonVariants } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { Skeleton } from "@opengeni/react/ui/skeleton";
import { cn } from "@opengeni/react/app/lib/utils";

import {
  NEW_TOOLS_OPTIONS,
  definitionOfVersion,
  newToolServerConfig,
  sameDefinition,
  toolRows,
  withNewTools,
  withToolAsk,
  withToolOn,
  type OrgAgentsApi,
} from "@/lib/organization-agents";
import { useConsole, useConsoleQuery } from "./console-shared";

/** The newest version (draft or published): what the editor starts from. */
export function newestVersion(agent: OrgAgent) {
  return agent.draft ?? agent.published;
}

export function initialDefinition(agent: OrgAgent): OrgAgentDefinition {
  const version = newestVersion(agent);
  return version
    ? definitionOfVersion(version)
    : definitionOfVersion({
        name: agent.name,
        description: agent.description,
        instructions: "",
        config: { toolServers: [], workers: { shareInstructions: false } },
      });
}

export type LiveTools = Record<
  string,
  { tools: OrgAgentToolCatalogEntry[]; error: string | null } | undefined
>;

/** Each named server's live tool list. A server that can't be listed keeps an error. */
export function useLiveTools(api: OrgAgentsApi, keys: readonly string[]): LiveTools {
  const [live, setLive] = useState<LiveTools>({});
  const wanted = [...new Set(keys)].sort().join("\n");
  useEffect(() => {
    const controller = new AbortController();
    for (const key of wanted ? wanted.split("\n") : []) {
      if (live[key]) continue;
      api.listToolServerTools(key, controller.signal).then(
        (response) => {
          if (!controller.signal.aborted)
            setLive((current) => ({
              ...current,
              [key]: { tools: response.tools, error: response.error },
            }));
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setLive((current) => ({
              ...current,
              [key]: { tools: [], error: userErrorText(error) },
            }));
        },
      );
    }
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- fetched once per server key
  }, [api, wanted]);
  return live;
}

export function AgentEditor({
  agent,
  api,
  toolServers,
  onSaved,
  onDirtyChange,
}: {
  agent: OrgAgent;
  api: OrgAgentsApi;
  toolServers: readonly OrgToolServer[] | null;
  onSaved: (agent: OrgAgent) => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const context = useAppContext();
  const { client, organizationId, appWorkspaceId } = useConsole();
  const readOnly = agent.managedBy === "code";
  const base = useMemo(() => initialDefinition(agent), [agent]);
  const [definition, setDefinition] = useState<OrgAgentDefinition>(base);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(agent.workspaceIds);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDefinition(base);
    setWorkspaceIds(agent.workspaceIds);
  }, [agent.workspaceIds, base]);

  const config = definition.config;
  const setConfig = (next: Partial<OrgAgentDefinition["config"]>) =>
    setDefinition((current) => ({ ...current, config: { ...current.config, ...next } }));

  const live = useLiveTools(
    api,
    config.toolServers.map((server) => server.server),
  );
  const catalog = newestVersion(agent)?.toolCatalog ?? null;
  const availability = useMemo(
    () => capabilityAvailability(context.clientConfig.agentConfig),
    [context.clientConfig.agentConfig],
  );
  const baseCapabilities = useMemo(
    () => draftFromRequest(base.config.capabilities),
    [base.config.capabilities],
  );
  const capabilityDraft = useMemo(
    () => draftFromRequest(config.capabilities),
    [config.capabilities],
  );
  const setCapabilities = (draft: AgentCapabilityDraft) =>
    setConfig({
      capabilities:
        base.config.capabilities === undefined && draftsEqual(draft, baseCapabilities)
          ? undefined
          : requestFromDraft(draft, availability),
    });

  const teamWorkspaces = useConsoleQuery(
    (signal) =>
      client
        .listConsoleWorkspaces(organizationId, { kind: "team", signal })
        .then((response) => response.workspaces.map(({ id, name }) => ({ id, name }))),
    [client, organizationId],
  );

  const definitionChanged = !sameDefinition(definition, base);
  const reachChanged = [...workspaceIds].sort().join() !== [...agent.workspaceIds].sort().join();
  const dirty = definitionChanged || reachChanged;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true);
    try {
      let saved = agent;
      if (definitionChanged) {
        saved = await api.saveDraft(agent.id, { ...definition, expectedVersion: saved.rowVersion });
      }
      if (reachChanged) {
        saved = await api.updateAgent(agent.id, {
          expectedVersion: saved.rowVersion,
          workspaceIds,
        });
      }
      toast.success(
        definitionChanged ? `Saved draft v${saved.latestVersion}` : "Saved where it's available",
        definitionChanged ? { description: "Publish it to update new chats." } : undefined,
      );
      onSaved(saved);
    } catch (error) {
      toast.error("Couldn't save the agent", { description: userErrorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const unused = (toolServers ?? []).filter(
    (server) => !config.toolServers.some((entry) => entry.server === server.key),
  );
  const serverNamed = (key: string) => toolServers?.find((server) => server.key === key) ?? null;
  const replaceServer = (next: OrgAgentToolServerConfig) =>
    setConfig({
      toolServers: config.toolServers.map((entry) => (entry.server === next.server ? next : entry)),
    });

  return (
    <div className="flex min-w-0 flex-col">
      <DetailSection title="Details">
        <FieldStack>
          <Field label="Name">
            <TextInput
              value={definition.name}
              maxLength={120}
              disabled={readOnly}
              suppressAutofill
              onChange={(event) =>
                setDefinition((current) => ({ ...current, name: event.target.value }))
              }
            />
          </Field>
          <Field label="Description" optional>
            <TextArea
              value={definition.description}
              maxLength={280}
              rows={2}
              disabled={readOnly}
              onChange={(event) =>
                setDefinition((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
        </FieldStack>
      </DetailSection>

      <DetailSection
        title="Instructions"
        description="Chats can add their own instructions after these."
      >
        <TextArea
          aria-label="Instructions"
          value={definition.instructions}
          maxLength={20_000}
          rows={10}
          disabled={readOnly}
          onChange={(event) =>
            setDefinition((current) => ({ ...current, instructions: event.target.value }))
          }
        />
      </DetailSection>

      <DetailSection title="Model">
        <AgentModelField
          workspaceId={appWorkspaceId}
          model={config.model ?? null}
          effort={config.reasoningEffort ?? null}
          disabled={readOnly}
          onChange={(model, effort) =>
            setConfig({
              model: model ?? undefined,
              reasoningEffort: effort ?? undefined,
            })
          }
        />
      </DetailSection>

      <DetailSection title="Built-in tools">
        <AgentCapabilityPicker
          draft={capabilityDraft}
          onChange={setCapabilities}
          availability={availability}
          disabled={readOnly}
        />
      </DetailSection>

      <DetailSection
        title="Tool servers"
        description="New tools a server adds later stay off unless you choose otherwise."
        action={
          !readOnly && unused.length > 0 ? (
            <SelectMenu
              aria-label="Add tool server"
              placeholder="Add tool server"
              size="sm"
              options={unused.map((server) => ({ value: server.key, label: server.name }))}
              value={null}
              onValueChange={(key) => {
                const tools = live[key]?.tools ?? [];
                setConfig({
                  toolServers: [
                    ...config.toolServers,
                    newToolServerConfig(
                      key,
                      tools.map((tool) => tool.name),
                    ),
                  ],
                });
              }}
            />
          ) : undefined
        }
      >
        {config.toolServers.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            {toolServers && toolServers.length === 0
              ? "Add a tool server on Tool servers, then choose its tools here."
              : "No tool servers."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {config.toolServers.map((server) => (
              <ToolServerTools
                key={server.server}
                server={server}
                registered={serverNamed(server.server)}
                live={live[server.server]}
                catalog={catalog}
                readOnly={readOnly}
                onChange={replaceServer}
                onRemove={() =>
                  setConfig({
                    toolServers: config.toolServers.filter(
                      (entry) => entry.server !== server.server,
                    ),
                  })
                }
              />
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Workers">
        <CheckboxField
          label="Share instructions with workers"
          description="Workers a chat starts always get its tools, approvals and logins."
          checked={config.workers.shareInstructions}
          disabled={readOnly}
          onCheckedChange={(checked) => setConfig({ workers: { shareInstructions: checked } })}
        />
      </DetailSection>

      <DetailSection
        title="Available in"
        description="Every workspace your product manages has it. Add team workspaces to use it in the app too."
      >
        <WorkspaceChecklist
          legend="Team workspaces"
          workspaces={teamWorkspaces.data}
          workspacesError={Boolean(teamWorkspaces.error)}
          onRetryWorkspaces={teamWorkspaces.reload}
          selected={workspaceIds}
          onSelectedChange={setWorkspaceIds}
          disabled={readOnly}
          emptyText="This organization has no team workspaces."
        />
      </DetailSection>

      {readOnly ? null : (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 border-t border-border bg-bg px-1 py-3">
          {dirty ? <span className="mr-auto text-sm text-fg-muted">Unsaved changes</span> : null}
          {dirty ? (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDefinition(base);
                setWorkspaceIds(agent.workspaceIds);
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button
            disabled={!dirty || saving || !definition.name.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save draft"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The model with its payment source, or the workspace default. */
function AgentModelField({
  workspaceId,
  model,
  effort,
  disabled,
  onChange,
}: {
  workspaceId: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  disabled: boolean;
  onChange: (model: string | null, effort: ReasoningEffort | null) => void;
}) {
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const fallback = catalog.defaultSelection?.model ?? catalog.rows[0]?.id ?? "";
  const shown = model ?? fallback;
  const selected = catalog.rows.find((row) => row.id === shown);
  return (
    <Field label="Model" hint={model === null ? "Uses the workspace default." : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <ModelPicker
          rows={catalog.rows}
          model={shown}
          effort={effort ?? catalog.defaultSelection?.reasoningEffort ?? "medium"}
          latencyMode="standard"
          allowLatencyMode={false}
          loading={catalog.loading}
          error={catalog.error}
          disabled={disabled}
          messages={{ label: "Agent model" }}
          triggerStyle="field"
          triggerMeta={selected ? payerShortLabel(selected) : model ? null : "Default"}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "max-w-full min-w-[180px] justify-start gap-2 self-start rounded-[10px] px-2.5 pointer-coarse:h-11",
          )}
          onModelChange={(next) => onChange(next, effort)}
          onEffortChange={(next) => onChange(model ?? (fallback || null), next)}
          onLatencyModeChange={() => {}}
        />
        {model !== null && !disabled ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(null, null)}>
            Use workspace default
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

/** One server: its tools with a switch and "Ask first" each, and what new tools do. */
function ToolServerTools({
  server,
  registered,
  live,
  catalog,
  readOnly,
  onChange,
  onRemove,
}: {
  server: OrgAgentToolServerConfig;
  registered: OrgToolServer | null;
  live: LiveTools[string];
  catalog: OrgAgentToolCatalog | null;
  readOnly: boolean;
  onChange: (server: OrgAgentToolServerConfig) => void;
  onRemove: () => void;
}) {
  const tools = live?.tools ?? [];
  const rows = toolRows(server, tools, catalog);
  const names = tools.map((tool) => tool.name);
  const on = rows.filter((row) => row.on).length;
  return (
    <section
      aria-label={registered?.name ?? server.server}
      className="rounded-[12px] border border-border"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <PlugIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-sm font-medium text-fg">
            {registered?.name ?? server.server}
          </p>
          <p className="m-0 truncate text-xs text-fg-muted">
            {live ? `${on} of ${rows.length} tools on` : "Loading tools…"}
          </p>
        </div>
        {readOnly ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${registered?.name ?? server.server}`}
            onClick={onRemove}
          >
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </header>
      {registered === null ? (
        <Notice tone="failed" className="m-3">
          This organization has no tool server with the key {server.server}.
        </Notice>
      ) : null}
      {live?.error ? (
        <Notice tone="waiting" className="m-3">
          Couldn't list its tools: {live.error}
        </Notice>
      ) : null}
      {live === undefined ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : rows.length > 0 ? (
        <ul className="m-0 list-none divide-y divide-border p-0" aria-label="Tools">
          {rows.map((row) => (
            <li key={row.name} className="flex items-start gap-3 px-4 py-2.5">
              <CheckboxField
                className="min-w-0 flex-1"
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span translate="no" className="truncate font-mono text-[13px]">
                      {row.name}
                    </span>
                    {row.isNew ? <MetaChip variant="soft">New</MetaChip> : null}
                    {row.gone ? <MetaChip variant="soft">No longer offered</MetaChip> : null}
                  </span>
                }
                description={row.description}
                checked={row.on}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  onChange(withToolOn(server, row.name, checked, names))
                }
              />
              <CheckboxField
                label="Ask first"
                className="shrink-0"
                checked={row.ask}
                disabled={readOnly || !row.on}
                onCheckedChange={(checked) =>
                  onChange(withToolAsk(server, row.name, checked, names))
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-sm text-fg">New tools</span>
        <SegmentedControl
          size="sm"
          aria-label="New tools"
          options={NEW_TOOLS_OPTIONS}
          value={server.newTools}
          disabled={readOnly}
          onValueChange={(value) => onChange(withNewTools(server, value as OrgAgentNewToolsPolicy))}
        />
      </div>
    </section>
  );
}
