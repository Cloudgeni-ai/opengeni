// The sessions index: composer-first session creation with the full create
// surface (model, effort, sandbox backend, environment, repositories, tools,
// goal, first-party MCP permissions) plus the workspace session list.
import { SessionStatus as SessionStatusBadge, useEnvironments, useWorkspaceSessions, type ComposerState } from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, ChevronDownIcon, FlagIcon, RefreshCwIcon, ShieldIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ConsoleComposer, useDraftAttachments } from "@/components/Composer";
import { PermissionGroupPicker } from "@/components/permission-picker";
import {
  DocumentSearchToolToggle,
  EnabledMcpToolPicker,
  ModelPicker,
  OpenGeniToolToggle,
} from "@/components/pickers";
import { RepositoryContextPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/context";
import { displayModel } from "@/lib/format";
import { sessionMcpPermissionGroups } from "@/lib/permissions";
import {
  emptyAdvancedSessionDraft,
  submissionExtrasFromAdvancedSessionDraft,
  type AdvancedSessionDraft,
} from "@/lib/session-create";
import { cn } from "@/lib/utils";
import type { SandboxBackend } from "@/types";

const examples = [
  "Inspect the repository and summarize the infrastructure layout.",
  "Run Terraform and Checkov checks, then propose the smallest safe fix.",
  "Create a focused GitHub PR for the failing policy check.",
] as const;

const sandboxBackendOptions: Array<{ value: SandboxBackend | ""; label: string }> = [
  { value: "", label: "Deployment default" },
  { value: "docker", label: "Docker" },
  { value: "modal", label: "Modal" },
  { value: "local", label: "Local" },
  { value: "none", label: "None (no sandbox)" },
];

export function SessionsIndexRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const attachments = useDraftAttachments(workspaceId);
  const [draft, setDraft] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState<AdvancedSessionDraft>(() => emptyAdvancedSessionDraft());

  useEffect(() => {
    context.resetSessionView();
  }, [workspaceId]);

  // The session does not exist yet, so this surface cannot use `useComposer`
  // (that hook sends to a session). It still renders the package ChatComposer
  // by implementing the same `ComposerState` contract over session creation.
  const createComposer: ComposerState = {
    value: draft,
    setValue: setDraft,
    sending: context.busy,
    canSend: draft.trim().length > 0 && !context.busy && !attachments.uploading,
    // Queue-vs-steer is meaningless before the session exists.
    mode: "queue",
    setMode: () => {},
    interrupt: async () => {},
    interrupting: false,
    error: null,
    clearError: () => {},
    send: async () => {
      const text = draft.trim();
      if (!text || context.busy || attachments.uploading) {
        return false;
      }
      const created = await context.startSession(workspaceId, {
        text,
        resources: attachments.readyResources,
        ...submissionExtrasFromAdvancedSessionDraft(advanced),
      });
      if (!created) {
        return false;
      }
      setDraft("");
      attachments.clear();
      await navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: created.id } });
      return true;
    },
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
      <section className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          What should the agent do?
        </h1>
        <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
          Start a durable sandbox session with live streams, a visible turn queue, goals, approvals, and steering.
        </p>
      </section>

      <div className="mt-8">
        <ConsoleComposer
          composer={createComposer}
          attachments={attachments}
          autoFocus
          fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
          placeholder="Describe a task for the agent..."
          controls={<SessionControlStrip workspaceId={workspaceId} />}
        />

        <AdvancedSessionOptions
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          draft={advanced}
          onChange={setAdvanced}
          disabled={context.busy}
        />

        <div className="mt-3 flex flex-wrap gap-1.5">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setDraft(example)}
              disabled={context.busy}
              className={cn(
                "max-w-full truncate rounded-full border px-3 py-1 text-left text-xs",
                "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60",
                "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                "hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]",
                "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {example}
            </button>
          ))}
        </div>
        <WorkspaceSessions
          onSelect={(id) => void navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: id } })}
        />
      </div>
    </div>
  );
}

function SessionControlStrip({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ModelPicker
        config={context.clientConfig}
        model={context.model}
        effort={context.reasoningEffort}
        disabled={context.busy}
        onModelChange={context.setModel}
        onEffortChange={context.setReasoningEffort}
      />
      <RepositoryContextPicker
        configured={context.githubStatus?.configured === true}
        installUrl={context.githubStatus?.installUrl ?? null}
        repositories={context.githubRepos}
        groups={context.repositoryGroups}
        selectedRepoIds={context.selectedRepoIds}
        selectedRepoRefs={context.selectedRepoRefs}
        selectedInstallationId={context.selectedInstallationId}
        manualRepos={context.manualRepos}
        manualOpen={context.manualReposOpen}
        githubAppOpen={context.githubAppOpen}
        org={context.githubOrg}
        pending={context.busy}
        repoBusy={context.repoBusy}
        githubAppBusy={context.githubAppBusy}
        onRefresh={() => context.refreshGitHub(workspaceId, undefined, { sync: true })}
        onToggleRepo={context.toggleGitHubRepository}
        onRefChange={(repoId, ref) => context.setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref }))}
        onManualOpenChange={context.setManualReposOpen}
        onManualAdd={context.addManualRepository}
        onManualUpdate={(id, patch) => context.setManualRepos((current) => current.map((repo) => repo.id === id ? { ...repo, ...patch } : repo))}
        onManualRemove={(id) => context.setManualRepos((current) => current.filter((repo) => repo.id !== id))}
        onGitHubAppOpenChange={context.setGithubAppOpen}
        onOrgChange={context.setGithubOrg}
        onStartGitHubApp={() => void context.startGitHubAppManifestFlow(workspaceId)}
      />
      <DocumentSearchToolToggle
        enabled={context.documentSearchEnabled}
        disabled={context.busy}
        onToggle={() => context.setDocumentSearchEnabled((enabled) => !enabled)}
      />
      <OpenGeniToolToggle
        enabled={context.openGeniToolEnabled}
        disabled={context.busy}
        onToggle={() => context.setOpenGeniToolEnabled((enabled) => !enabled)}
      />
      <EnabledMcpToolPicker
        servers={context.customMcpServers}
        selectedIds={context.selectedCapabilityToolIds}
        disabled={context.busy}
        onChange={context.setSelectedCapabilityToolIds}
      />
    </div>
  );
}

function AdvancedSessionOptions(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AdvancedSessionDraft;
  onChange: (draft: AdvancedSessionDraft) => void;
  disabled: boolean;
}) {
  const environments = useEnvironments();
  const { draft } = props;
  const update = (patch: Partial<AdvancedSessionDraft>) => props.onChange({ ...draft, ...patch });
  const activeSummary = [
    draft.sandboxBackend ? `sandbox: ${draft.sandboxBackend}` : null,
    draft.environmentId ? `env: ${environments.environments.find((environment) => environment.id === draft.environmentId)?.name ?? draft.environmentId}` : null,
    draft.goalText.trim() ? "goal set" : null,
    draft.customMcpPermissions ? `${draft.mcpPermissions.size} MCP scopes` : null,
  ].filter(Boolean);

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} className="mt-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 px-3 py-2 text-left text-xs text-[color:var(--color-fg-muted)] transition-colors hover:bg-[color:var(--color-surface-2)]/60 hover:text-[color:var(--color-fg)]"
        >
          <SlidersHorizontalIcon className="size-3.5 shrink-0" />
          <span className="font-medium">Session setup</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--color-fg-subtle)]">
            {activeSummary.length > 0 ? activeSummary.join(" · ") : "sandbox backend, environment, goal, OpenGeni tool permissions"}
          </span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", props.open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">Sandbox backend</Label>
              <select
                className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
                value={draft.sandboxBackend}
                disabled={props.disabled}
                onChange={(event) => update({ sandboxBackend: event.target.value as AdvancedSessionDraft["sandboxBackend"] })}
              >
                {sandboxBackendOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <BoxIcon className="size-3" />
                Environment
              </Label>
              <select
                className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
                value={draft.environmentId}
                disabled={props.disabled}
                onChange={(event) => update({ environmentId: event.target.value })}
              >
                <option value="">No environment</option>
                {environments.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} ({environment.variables.length} vars)
                  </option>
                ))}
              </select>
              <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                Variables are injected into the sandbox at start; values stay write-only.
              </p>
            </div>
          </div>

          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5 text-xs">
              <FlagIcon className="size-3" />
              Goal (optional)
            </Label>
            <textarea
              value={draft.goalText}
              disabled={props.disabled}
              onChange={(event) => update({ goalText: event.target.value })}
              placeholder="A goal keeps the session working autonomously between your messages..."
              className="min-h-14 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm"
            />
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Input
                value={draft.goalSuccessCriteria}
                disabled={props.disabled || !draft.goalText.trim()}
                onChange={(event) => update({ goalSuccessCriteria: event.target.value })}
                placeholder="Success criteria (optional)"
                className="h-9 text-sm"
              />
              <Input
                value={draft.goalMaxAutoContinuations}
                disabled={props.disabled || !draft.goalText.trim()}
                onChange={(event) => update({ goalMaxAutoContinuations: event.target.value })}
                placeholder="Max continuations"
                inputMode="numeric"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={draft.customMcpPermissions}
                disabled={props.disabled}
                onChange={(event) => update({ customMcpPermissions: event.target.checked })}
              />
              <ShieldIcon className="size-3" />
              Restrict the session&apos;s OpenGeni tool permissions
            </label>
            {draft.customMcpPermissions ? (
              <PermissionGroupPicker
                groups={sessionMcpPermissionGroups}
                selected={draft.mcpPermissions}
                disabled={props.disabled}
                onToggle={(permission) => {
                  const next = new Set(draft.mcpPermissions);
                  if (next.has(permission)) {
                    next.delete(permission);
                  } else {
                    next.add(permission);
                  }
                  update({ mcpPermissions: next });
                }}
              />
            ) : (
              <p className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                By default the session&apos;s OpenGeni MCP tool can use the platform on your behalf inside this workspace.
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function WorkspaceSessions({ onSelect }: { onSelect: (id: string) => void }) {
  // Workspace + credentials come from <OpenGeniProvider>; a new access key
  // produces a new client, which re-runs the hook.
  const { sessions, loading, error, refresh } = useWorkspaceSessions({ limit: 50 });

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">Workspace sessions</h2>
        {error ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCwIcon className="size-4" />
            Retry
          </Button>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        {loading ? (
          <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3 text-sm text-[color:var(--color-fg-muted)]">Loading sessions...</div>
        ) : error ? (
          <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3 text-sm text-[color:var(--color-fg-muted)]">Session history is unavailable.</div>
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3 text-sm text-[color:var(--color-fg-muted)]">No sessions in this workspace yet.</div>
        ) : sessions.map((item) => (
          <button key={item.id} type="button" onClick={() => onSelect(item.id)} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 text-left text-sm hover:bg-[color:var(--color-surface-2)]">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 truncate font-medium">{item.initialMessage}</div>
              <SessionStatusBadge status={item.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[color:var(--color-fg-subtle)]">
              <span>{new Date(item.createdAt).toLocaleString()}</span>
              <span>{displayModel(item.model)}</span>
              <span>{item.sandboxBackend}</span>
              {item.environmentId ? <span>env attached</span> : null}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
