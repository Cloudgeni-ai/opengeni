// The sessions index: the centered "Start a session" composer. The form is
// organised top-down — (A) message + model/tools/repos pills → (B) WHERE SHOULD
// THIS RUN? (when machines exist) → (C) rig/variable-set or machine fields.
// Goals are set by the agent (or later surfaces), not at create.
//
// "Where should this run?" is a first-class segmented control with two kinds:
// Managed Sandbox (ephemeral, platform-owned — clones repos, injects env) vs
// Connected Machine (a user-owned enrolled machine — its own checkout & git
// auth, a working folder, no clone, no env injection). The kind gates the band
// below it; invalid states ("clone my repo onto a machine") are unreachable by
// construction.
//
// The Connected Machine path is OPT-IN: with an empty self-hosted fleet and no
// explicit opt-in, the segmented control is not rendered at all and the composer
// collapses to the clean sandbox-only flow (just the managed sandbox fields). The
// control appears once machines exist, or once the user reveals it via a
// lightweight local opt-in.
import {
  FILE_ONLY_MESSAGE_TEXT,
  useRigs,
  useVariableSets,
  useWorkspaceSessions,
  type ComposerState,
} from "@opengeni/react";
import { useMachines, type MachineView } from "@opengeni/react/machines";
import { OpenGeniApiError } from "@opengeni/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  FolderIcon,
  MonitorOffIcon,
  ServerCogIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BillingClassMark } from "@/components/billing-class-mark";
import { ConsoleComposer, useDraftAttachments } from "@/components/Composer";
import { ModelPicker, SessionToolPicker, type SessionToolSelection } from "@/components/pickers";
import { RepositoryContextPicker } from "@/components/repository-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext, useLatestCallback } from "@/context";
import { FOCUS_CREATE_COMPOSER_EVENT } from "@/lib/create-composer-focus";
import { displayModel } from "@/lib/format";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import {
  coerceReasoningEffortForModel,
  findPickerRow,
  type PickerModelRow,
} from "@/lib/model-policy";
import { isCodexProductModel } from "@/lib/session-model";
import { groupSessionsForRail, relativeTimeLabel } from "@/lib/sessions-group";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import {
  emptySessionDraft,
  isSessionDraftComputeReady,
  newSessionDraftOptionsFromSessionDraft,
  selfhostedCapabilityChips,
  sessionDraftFromNewSessionDraftOptions,
  submissionFromSessionDraft,
  type ConnectedMachineTarget,
  type SessionDraft,
} from "@/lib/session-create";
import {
  firstPartySessionToolOptions,
  selectableSessionMcpServerIds,
  newSessionDraftToolPolicy,
  rehydrateRepositoryResources,
  repositorySelectionFromResources,
} from "@/lib/session-tools";
import { useNewSessionDraft, type NewSessionDraftEditable } from "@/lib/use-new-session-draft";
import { cn } from "@/lib/utils";
import {
  runNewSessionRouteSubmission,
  type CreatedSessionRouteAuthority,
} from "@/routes/sessions-index-submission";
import type { Session } from "@/types";

export function SessionsIndexRoute({ workspaceId }: { workspaceId: string }) {
  const { accessKeyVersion } = useAppContext();
  return (
    <SessionsIndexRouteContent
      key={`${workspaceId}:${accessKeyVersion}`}
      workspaceId={workspaceId}
    />
  );
}

function SessionsIndexRouteContent({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const attachments = useDraftAttachments(workspaceId);
  const { resetSessionView } = context;
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(() => emptySessionDraft());
  const [toolSelectionExplicit, setToolSelectionExplicit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdSessionAuthority, setCreatedSessionAuthority] =
    useState<CreatedSessionRouteAuthority | null>(null);
  const composerRegionRef = useRef<HTMLDivElement | null>(null);
  // 0 = no explicit request (mount uses ConsoleComposer autoFocus). >0 = same-route
  // new-session / shortcut asked us to put the caret back in the create composer.
  const [createComposerFocusGen, setCreateComposerFocusGen] = useState(0);

  useEffect(() => {
    resetSessionView();
  }, [resetSessionView, workspaceId]);

  useEffect(() => {
    const onRequest = () => setCreateComposerFocusGen((current) => current + 1);
    window.addEventListener(FOCUS_CREATE_COMPOSER_EVENT, onRequest);
    return () => window.removeEventListener(FOCUS_CREATE_COMPOSER_EVENT, onRequest);
  }, []);

  const computeReady = isSessionDraftComputeReady(draft);
  const persistedToolPolicy = useMemo(
    () =>
      newSessionDraftToolPolicy({
        selectedMcpServerIds: context.selectedCapabilityToolIds,
        workspaceDefaultMcpServerIds: context.workspaceDefaultToolIds,
        catalogReady: context.workspaceMcpCatalogReady,
        explicit: toolSelectionExplicit,
      }),
    [
      context.selectedCapabilityToolIds,
      context.workspaceMcpCatalogReady,
      context.workspaceDefaultToolIds,
      toolSelectionExplicit,
    ],
  );
  const persistedValue = useMemo(
    () => ({
      text: message,
      resources: [...context.currentResources, ...attachments.readyResources],
      tools: persistedToolPolicy.tools,
      toolsProvided: persistedToolPolicy.toolsProvided,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      latencyMode: context.latencyMode,
      options: newSessionDraftOptionsFromSessionDraft(draft),
    }),
    [
      attachments.readyResources,
      context.model,
      context.latencyMode,
      context.reasoningEffort,
      context.currentResources,
      draft,
      message,
      persistedToolPolicy,
    ],
  );
  const hydrateResources = useLatestCallback((resources: NewSessionDraftEditable["resources"]) =>
    rehydrateRepositoryResources(resources, context.githubRepos),
  );
  const setModel = context.setModel;
  const setReasoningEffort = context.setReasoningEffort;
  const setLatencyMode = context.setLatencyMode;
  const setSelectedCapabilityToolIds = context.setSelectedCapabilityToolIds;
  const setManualRepos = context.setManualRepos;
  const setSelectedRepoIds = context.setSelectedRepoIds;
  const setSelectedRepoRefs = context.setSelectedRepoRefs;
  const githubRepos = context.githubRepos;
  const workspaceDefaultToolIdsForHydration = context.workspaceDefaultToolIds;
  const applyRemoteDraft = useCallback(
    (remote: NewSessionDraftEditable) => {
      setMessage(remote.text);
      setDraft(sessionDraftFromNewSessionDraftOptions(remote.options));
      setModel(remote.model);
      setReasoningEffort(remote.reasoningEffort);
      setLatencyMode(remote.latencyMode ?? "standard");
      setToolSelectionExplicit(remote.toolsProvided);
      const selected = new Set(
        remote.toolsProvided
          ? remote.tools.map((tool) => tool.id)
          : workspaceDefaultToolIdsForHydration,
      );
      setSelectedCapabilityToolIds(selectableSessionMcpServerIds(selected));
      const repositorySelection = repositorySelectionFromResources(remote.resources, githubRepos);
      setManualRepos(repositorySelection.manualRepos);
      setSelectedRepoIds(repositorySelection.selectedRepoIds);
      setSelectedRepoRefs(repositorySelection.selectedRepoRefs);
    },
    [
      setManualRepos,
      setModel,
      setLatencyMode,
      setReasoningEffort,
      setSelectedCapabilityToolIds,
      setSelectedRepoIds,
      setSelectedRepoRefs,
      githubRepos,
      workspaceDefaultToolIdsForHydration,
    ],
  );
  const newSessionDraft = useNewSessionDraft({
    workspaceId,
    client: context.client,
    value: persistedValue,
    onApplyRemote: applyRemoteDraft,
    restoreReadyFiles: attachments.restoreReadyFiles,
    hydrateResources,
    resourceHydrationReady: context.githubCatalogReady && context.workspaceMcpCatalogReady,
  });
  const busy = context.busy || submitting;

  useEffect(() => {
    if (createComposerFocusGen === 0 || newSessionDraft.loading) return;
    const textarea = composerRegionRef.current?.querySelector("textarea");
    if (!textarea || textarea.disabled) return;
    textarea.focus();
  }, [createComposerFocusGen, newSessionDraft.loading]);

  // The session does not exist yet, so this surface cannot use `useComposer`
  // (that hook sends to a session). It still renders the package ChatComposer
  // by implementing the same `ComposerState` contract over session creation.
  const createComposer: ComposerState = {
    value: message,
    setValue: setMessage,
    hasDraftContent: () => message.length > 0 || attachments.attachments.length > 0,
    sending: busy,
    // Mirrors useComposer's gate: a ready attachment with no typed draft is a
    // sendable file-only message (the API requires non-empty text, so send()
    // substitutes FILE_ONLY_MESSAGE_TEXT).
    canSend:
      (createdSessionAuthority !== null ||
        message.trim().length > 0 ||
        attachments.readyResources.length > 0) &&
      !busy &&
      !newSessionDraft.loading &&
      !newSessionDraft.conflict &&
      (createdSessionAuthority !== null || (!attachments.hasUnresolved && computeReady)),
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: newSessionDraft.revision,
    draftLoading: newSessionDraft.loading,
    draftSaving: newSessionDraft.saving,
    draftConflict: newSessionDraft.conflict,
    applyDraft: () => {},
    reloadDraft: newSessionDraft.reload,
    resolveDraftConflict: newSessionDraft.resolveConflict,
    restoredResources: [],
    removeRestoredResource: () => {},
    error: newSessionDraft.error,
    clearError: newSessionDraft.clearError,
    send: async () => {
      const text =
        message.trim() || (attachments.readyResources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
      if (busy || newSessionDraft.loading || newSessionDraft.conflict) {
        return false;
      }
      if (
        createdSessionAuthority === null &&
        (!text || attachments.hasUnresolved || !computeReady)
      ) {
        return false;
      }
      setSubmitting(true);
      try {
        return await runNewSessionRouteSubmission({
          authority: createdSessionAuthority,
          onAuthorityChange: setCreatedSessionAuthority,
          create: async () => {
            // This render's resources are the immutable create snapshot. Files
            // can still be added through paste/drop/picker while the request is
            // in flight; those newer ids belong to the next draft.
            const submittedResources =
              draft.compute.kind === "machine"
                ? attachments.readyResources
                : persistedValue.resources;
            const flushed = await newSessionDraft.flush();
            if (!flushed) return null;
            const submission = submissionFromSessionDraft(draft);
            const created = await context.startSession(
              workspaceId,
              {
                text,
                resources: submittedResources,
                tools: persistedValue.tools,
                model: persistedValue.model,
                reasoningEffort: persistedValue.reasoningEffort,
                latencyMode: persistedValue.latencyMode,
                ...submission.extras,
              },
              {
                targetSandboxId: submission.options.targetSandboxId,
                workingDir: submission.options.workingDir,
                omitWorkspaceResources: submission.omitWorkspaceResources,
                expectedNewSessionDraftRevision: flushed.revision,
              },
            );
            if (!created) return null;
            return {
              sessionId: created.id,
              settleDraft: async () => {
                // A programmatic edit made while create was in flight was not
                // submitted and must not be abandoned when this route unmounts.
                // A sibling-tab OCC conflict remains visible, while the route
                // retains exact authority for the already-created session.
                const acknowledged = await newSessionDraft.acknowledgeConsumed(flushed);
                if (acknowledged?.kind === "consumed") {
                  setMessage("");
                  setDraft(emptySessionDraft());
                  attachments.removeReadyFiles(
                    submittedResources.flatMap((resource) =>
                      resource.kind === "file" ? [resource.fileId] : [],
                    ),
                  );
                } else if (
                  !acknowledged ||
                  !newSessionDraft.isCurrentSignature(acknowledged.flushed.signature)
                ) {
                  // A non-conflict revision-zero insert can fail transiently.
                  // Retry it (or prove a concurrently saved current signature)
                  // before allowing this route to unmount through navigation.
                  const preserved = await newSessionDraft.flush();
                  if (!preserved || !newSessionDraft.isCurrentSignature(preserved.signature)) {
                    return false;
                  }
                }
                return true;
              },
            };
          },
          navigate: async (sessionId) => {
            await navigate({
              to: "/workspaces/$workspaceId/sessions/$sessionId",
              params: { workspaceId, sessionId },
            });
          },
        });
      } finally {
        setSubmitting(false);
      }
    },
    steer: async () => {
      const text =
        message.trim() || (attachments.readyResources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
      if (!text || busy || attachments.hasUnresolved || !computeReady) return false;
      return await createComposer.send();
    },
  };

  return (
    // The canvas parent is overflow-hidden, so this route owns its scrolling —
    // without it the page clips (recent sessions were unreachable below the fold).
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
        <section className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            What should the agent do?
          </h1>
        </section>

        <div ref={composerRegionRef} className="mt-8">
          <ConsoleComposer
            workspaceId={workspaceId}
            composer={createComposer}
            attachments={attachments}
            autoFocus
            disabled={newSessionDraft.loading}
            fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
            placeholder="Describe a task for the agent…"
            controls={
              <SessionControlStrip
                workspaceId={workspaceId}
                disabled={busy || newSessionDraft.loading}
                showRepos={draft.compute.kind === "sandbox"}
                selection={{
                  mcpServerIds: context.selectedCapabilityToolIds,
                  firstPartyToolIds: draft.firstPartyMcpTools,
                }}
                onToolSelectionChange={(selection) => {
                  setToolSelectionExplicit(true);
                  context.setSelectedCapabilityToolIds(selection.mcpServerIds);
                  setDraft((current) => ({
                    ...current,
                    firstPartyMcpTools: selection.firstPartyToolIds,
                  }));
                }}
              />
            }
          />

          <ComputeTargetControl
            workspaceId={workspaceId}
            draft={draft}
            onChange={setDraft}
            disabled={busy || newSessionDraft.loading}
          />
        </div>

        <RecentSessions workspaceId={workspaceId} />
      </div>
    </div>
  );
}

// ── Recent sessions — the quiet main-canvas browser the rail can't be (D4.2) ──
// A calm section below the composer: the most recent sessions as compact rows
// (status, title, provider mark + catalog model label, relative time). Reuses
// the rail's session list + the workspace model catalog so labels/marks match
// the model picker — never raw wire ids as the primary display.
function RecentSessions({ workspaceId }: { workspaceId: string }) {
  const { sessions, pinned } = useWorkspaceSessions({ limit: 12, pollIntervalMs: 30_000 });
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const recent = useMemo(() => {
    const ordinary = sessions.filter((session) => !session.pinned);
    const { running, grouped } = groupSessionsForRail(ordinary);
    // Pins are server-authoritative and intentionally sit above ordinary
    // recency rows here too. `sessions` retains the historical all-visible-row
    // contract, so remove its pins before recombining the explicit section.
    return [...pinned, ...running, ...grouped.flatMap((bucket) => bucket.sessions)].slice(0, 6);
  }, [pinned, sessions]);

  if (recent.length === 0) {
    return null;
  }

  return (
    <section className="mt-12">
      <h2 className="mb-1.5 px-0.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Recent sessions
      </h2>
      {/* flex-col, not grid: a grid auto track grows to a nowrap row's full
          min-content width, defeating truncate and overflowing the page. */}
      <ul className="flex min-w-0 flex-col divide-y divide-border/60">
        {recent.map((session) => (
          <RecentSessionRow
            key={session.id}
            workspaceId={workspaceId}
            session={session}
            catalogRows={modelCatalog.rows}
          />
        ))}
      </ul>
    </section>
  );
}

const SESSION_STATUS_TONE: Record<Session["status"], StatusTone> = {
  queued: "queued",
  running: "running",
  recovering: "running",
  waiting_capacity: "waiting",
  requires_action: "waiting",
  idle: "idle",
  failed: "failed",
  cancelled: "cancelled",
};

/** A short `owner/repo` label from the session's first repository resource. */
function sessionRepoLabel(session: Session): string | null {
  const repo = session.resources.find((resource) => resource.kind === "repository");
  if (!repo || repo.kind !== "repository") {
    return null;
  }
  const parts = repo.uri
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : (parts.at(-1) ?? null);
}

function recentSessionModelPresentation(
  modelId: string,
  catalogRows: readonly PickerModelRow[],
): { label: string; billingClass: PickerModelRow["billingClass"] } {
  const row = findPickerRow([...catalogRows], modelId);
  return {
    label: row?.label ?? displayModel(modelId),
    billingClass:
      row?.billingClass ??
      (isCodexProductModel(modelId) ? "codex_subscription" : "opengeni_credits"),
  };
}

function RecentSessionRow({
  workspaceId,
  session,
  catalogRows,
}: {
  workspaceId: string;
  session: Session;
  catalogRows: readonly PickerModelRow[];
}) {
  const title = session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
  const model = recentSessionModelPresentation(session.model, catalogRows);
  const repo = sessionRepoLabel(session);
  const metaBits = [model.label, repo].filter(Boolean);
  return (
    <li className="min-w-0">
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: session.id }}
        className="group flex items-center gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-surface-2/50"
      >
        <StatusDot
          tone={SESSION_STATUS_TONE[session.status]}
          pulse={session.status === "running"}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg group-hover:text-fg">{title}</span>
          {metaBits.length > 0 ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-fg-subtle">
              <BillingClassMark
                billingClass={model.billingClass}
                className="size-3 text-fg-muted"
                aria-label=""
              />
              <span className="truncate">{metaBits.join(" · ")}</span>
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-fg-subtle">
          {relativeTimeLabel(session.updatedAt)}
        </span>
      </Link>
    </li>
  );
}

// Composer footer pills: model, tools, and (for managed sandbox) repos — same
// compact control language. Repo stays out of the compute band so that band
// only shows when rigs / variable sets exist.
function SessionControlStrip({
  workspaceId,
  disabled,
  showRepos,
  selection,
  onToolSelectionChange,
}: {
  workspaceId: string;
  disabled: boolean;
  showRepos: boolean;
  selection: SessionToolSelection;
  onToolSelectionChange: (selection: SessionToolSelection) => void;
}) {
  const context = useAppContext();
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  useEffect(() => {
    const row = findPickerRow(modelCatalog.rows, context.model);
    if (!row?.selectable) {
      return;
    }
    const coerced = coerceReasoningEffortForModel(row.catalog, context.reasoningEffort);
    if (coerced !== context.reasoningEffort) {
      context.setReasoningEffort(coerced);
    }
  }, [
    context,
    context.model,
    context.reasoningEffort,
    context.setReasoningEffort,
    modelCatalog.rows,
  ]);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ModelPicker
        rows={modelCatalog.rows}
        model={context.model}
        effort={context.reasoningEffort}
        latencyMode={context.latencyMode}
        disabled={disabled}
        loading={modelCatalog.loading}
        error={modelCatalog.error}
        onModelChange={context.setModel}
        onEffortChange={context.setReasoningEffort}
        onLatencyModeChange={context.setLatencyMode}
      />
      <SessionToolPicker
        servers={context.toolMcpServers}
        firstPartyTools={firstPartySessionToolOptions}
        selection={selection}
        disabled={disabled}
        onChange={onToolSelectionChange}
      />
      {showRepos ? (
        <WorkspaceRepositoryPicker workspaceId={workspaceId} disabled={disabled} />
      ) : null}
    </div>
  );
}

// The workspace repository picker, wired to the cross-route selection in context.
// Reused in both compute kinds: the primary clone source on a managed sandbox,
// and grayed/disabled on a connected machine (which uses its own checkout).
function WorkspaceRepositoryPicker({
  workspaceId,
  disabled,
}: {
  workspaceId: string;
  disabled: boolean;
}) {
  const context = useAppContext();
  return (
    <RepositoryContextPicker
      setupMode={
        context.githubStatus?.setupMode ??
        (context.clientConfig.productAccessMode === "managed" ? "platform" : "operator")
      }
      configured={context.githubStatus?.configured === true}
      status={context.githubStatus?.status ?? "disabled"}
      installUrl={context.githubStatus?.installUrl ?? null}
      linkUrl={context.githubStatus?.linkUrl ?? null}
      installations={context.githubStatus?.installations ?? []}
      repositories={context.githubRepos}
      groups={context.repositoryGroups}
      selectedRepoIds={context.selectedRepoIds}
      selectedRepoRefs={context.selectedRepoRefs}
      selectedInstallationId={context.selectedInstallationId}
      manualRepos={context.manualRepos}
      manualOpen={context.manualReposOpen}
      githubAppOpen={context.githubAppOpen}
      org={context.githubOrg}
      pending={context.busy || disabled}
      repoBusy={context.repoBusy}
      githubAppBusy={context.githubAppBusy}
      onRefresh={() => context.refreshGitHub(workspaceId, undefined, { sync: true })}
      onToggleRepo={context.toggleGitHubRepository}
      onRefChange={(repoId, ref) =>
        context.setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref }))
      }
      onManualOpenChange={context.setManualReposOpen}
      onManualAdd={context.addManualRepository}
      onManualUpdate={(id, patch) =>
        context.setManualRepos((current) =>
          current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
        )
      }
      onManualRemove={(id) =>
        context.setManualRepos((current) => current.filter((repo) => repo.id !== id))
      }
      onGitHubAppOpenChange={context.setGithubAppOpen}
      onOrgChange={context.setGithubOrg}
      onStartGitHubApp={() => void context.startGitHubAppManifestFlow(workspaceId)}
      onDisconnectInstallation={(installationId) =>
        context.disconnectGitHubInstallation(workspaceId, installationId)
      }
    />
  );
}

// ── The promoted top-level compute target (the parent that gates the band) ────

function ComputeTargetControl(props: {
  workspaceId: string;
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, onChange } = props;
  // The workspace fleet (no sessionId → no swap; just the picker source). Degrades
  // gracefully: when selfhosted is disabled the API 404s → `machines` is empty and
  // the Connected Machine kind is offered only as a disabled "enroll a machine"
  // affordance, never blocking session creation.
  const fleet = useMachines({ pollIntervalMs: 10000 });
  const machines = fleet.machines.filter((machine) => machine.kind === "selfhosted");
  const fleetEmpty = machines.length === 0;
  // A 404 is the expected "self-hosted machines are disabled here" signal, not a
  // failure — only a genuine load error (network/5xx) is surfaced, so the machine
  // option isn't silently swallowed by a transient outage (states #4).
  const fleetLoadFailed =
    fleet.error != null && !(fleet.error instanceof OpenGeniApiError && fleet.error.status === 404);
  // The Connected Machine path is OPT-IN. With an EMPTY self-hosted fleet and no
  // explicit opt-in, the segmented control is not rendered at all — the composer
  // shows the clean sandbox-only flow (byte-identical submission to before this
  // redesign). Once machines exist, the control is always shown. A lightweight
  // local opt-in lets a user reveal the option before/while enrolling.
  // No teaser for absent hardware: the segmented control exists only when the
  // fleet has machines. Discovery lives on the Machines page, not the composer.
  const showComputeTarget = !fleetEmpty;

  const sandboxBackendOverride = draft.compute.kind === "sandbox" ? draft.compute.backend : "";

  // Defensive: if the segmented control is hidden (clean flow) while a stale draft
  // still points at a machine (e.g. the last machine just left the fleet), fall
  // back to the managed sandbox so a hidden machine target can never be submitted.
  // Also drop any leftover managed-backend override — that control is gone from
  // the composer, so a stale draft must not keep forcing a sandbox type.
  useEffect(() => {
    if (!showComputeTarget && draft.compute.kind === "machine") {
      onChange({ ...draft, compute: { kind: "sandbox", backend: "" } });
      return;
    }
    if (draft.compute.kind === "sandbox" && sandboxBackendOverride) {
      onChange({ ...draft, compute: { kind: "sandbox", backend: "" } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showComputeTarget, draft.compute.kind, sandboxBackendOverride]);

  const selectKind = (kind: ComputeKind) => {
    if (kind === draft.compute.kind) {
      return;
    }
    if (kind === "sandbox") {
      // Composer no longer exposes a managed-backend override — always the
      // deployment default (empty wire field).
      onChange({ ...draft, compute: { kind: "sandbox", backend: "" } });
      return;
    }
    // Auto-pick the first selectable machine so the common single-machine case is
    // submit-ready immediately; otherwise leave it unpicked (submit stays blocked).
    const firstSelectable =
      machines.find((machine) => isMachineComputeSelectable(machine.state)) ?? null;
    onChange({
      ...draft,
      compute: {
        kind: "machine",
        sandboxId: firstSelectable?.sandboxId ?? null,
        folder: { kind: "root" },
      },
    });
  };

  // Clean sandbox-only default: no "Where should this run?" header, no segmented
  // control, no machine clutter — just the managed sandbox fields, plus a subtle
  // opt-in link to reveal the Connected Machine path. The sandbox compute is
  // narrowed defensively (the normalization effect keeps the draft in sync).
  if (!showComputeTarget) {
    // No machines → no compute chooser. Rig/variable-set card only when needed;
    // ManagedSandboxFields returns null when empty so we don't leave a blank gap.
    if (fleetLoadFailed) {
      return (
        <section className="mt-5 grid gap-2">
          <ManagedSandboxFields draft={draft} onChange={onChange} disabled={props.disabled} />
          <FleetErrorNotice onRetry={() => void fleet.refresh()} />
        </section>
      );
    }
    return <ManagedSandboxFields draft={draft} onChange={onChange} disabled={props.disabled} />;
  }

  return (
    <section className="mt-5 grid gap-3">
      <p className="px-0.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
        Where should this run?
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <ComputeKindButton
          selected={draft.compute.kind === "sandbox"}
          disabled={props.disabled}
          icon={<BoxIcon className="size-4 shrink-0" />}
          title="Managed sandbox"
          subtitle="A fresh sandbox, set up for you"
          onClick={() => selectKind("sandbox")}
        />
        <ComputeKindButton
          selected={draft.compute.kind === "machine"}
          disabled={props.disabled || fleetEmpty}
          icon={<ServerIcon className="size-4 shrink-0" />}
          title="Connected machine"
          subtitle={
            fleetLoadFailed
              ? "Couldn't load machines"
              : fleetEmpty
                ? "Connect one to use it"
                : "Run on your own machine"
          }
          onClick={() => selectKind("machine")}
        />
      </div>

      {fleetLoadFailed ? <FleetErrorNotice onRetry={() => void fleet.refresh()} /> : null}

      {draft.compute.kind === "sandbox" ? (
        <ManagedSandboxFields draft={draft} onChange={onChange} disabled={props.disabled} />
      ) : (
        <ConnectedMachineFields
          draft={draft}
          compute={draft.compute}
          machines={machines}
          onChange={onChange}
          disabled={props.disabled}
        />
      )}
    </section>
  );
}

type ComputeKind = SessionDraft["compute"]["kind"];

function ComputeKindButton(props: {
  selected: boolean;
  disabled: boolean;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "group flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-[color,background-color,border-color,box-shadow]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.selected
          ? "border-brand/60 bg-brand/[0.08] ring-1 ring-inset ring-brand/20"
          : "border-border bg-surface/40 hover:border-border-strong hover:bg-surface-2/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 transition-colors",
          props.selected ? "text-brand" : "text-fg-subtle group-hover:text-fg-muted",
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{props.title}</span>
        <span className="mt-0.5 block truncate text-2xs text-fg-subtle">{props.subtitle}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full transition-all",
          props.selected
            ? "scale-100 bg-brand text-brand-fg"
            : "scale-90 border border-border-strong opacity-0 group-hover:opacity-60",
        )}
      >
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    </button>
  );
}

// ── Managed Sandbox extras: rig + variable set only (repos live in the composer pills) ─

function ManagedSandboxFields(props: {
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, onChange } = props;
  const variableSets = useVariableSets();
  const rigs = useRigs();
  const showRigs = rigs.rigs.length > 0;
  const showVariableSets = variableSets.variableSets.length > 0;
  if (!showRigs && !showVariableSets) {
    return null;
  }

  return (
    // One flat card: hairline-separated rows, controls right-aligned, no
    // nested boxes and no restating helper text — the controls speak.
    <div className="mt-5 overflow-hidden rounded-lg border border-border bg-surface/40">
      {/* Rig picker — offered only when the workspace has at least one rig.
          Picking a rig preselects its default variable sets in the control
          below (still user-overridable). Empty ⇒ the workspace default rig,
          resolved server-side. */}
      {showRigs ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <Label className="flex shrink-0 items-center gap-1.5 text-xs">
            <ServerCogIcon className="size-3 shrink-0 text-fg-subtle" />
            Rig
          </Label>
          <Select
            value={draft.rigId}
            disabled={props.disabled}
            onChange={(event) => {
              const rigId = event.target.value;
              const picked = rigs.rigs.find((rig) => rig.id === rigId);
              const defaultVariableSetId = picked?.activeVersion?.defaultVariableSetIds[0];
              onChange({
                ...draft,
                rigId,
                // Preselect the rig's first default variable set into the single
                // session-level control; the rest still apply server-side.
                ...(defaultVariableSetId ? { variableSetId: defaultVariableSetId } : {}),
              });
            }}
            className="h-8 w-auto max-w-56 text-xs"
          >
            <option value="">Workspace default</option>
            {rigs.rigs.map((rig) => (
              <option key={rig.id} value={rig.id}>
                {rig.name}
                {rig.activeVersion ? ` (v${rig.activeVersion.version})` : ""}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {/* Offer variableSets only when some exist — configuration UI for
          resources you don't have is clutter (same rule as machines). */}
      {showVariableSets ? (
        <div
          className={cn(
            "flex items-center justify-between gap-3 px-3 py-2",
            showRigs && "border-t border-border/70",
          )}
        >
          <Label className="flex shrink-0 items-center gap-1.5 text-xs">
            <BoxIcon className="size-3 shrink-0 text-fg-subtle" />
            Variable set
          </Label>
          <Select
            value={draft.variableSetId}
            disabled={props.disabled}
            onChange={(event) => onChange({ ...draft, variableSetId: event.target.value })}
            className="h-8 w-auto max-w-56 text-xs"
          >
            <option value="">No variable set</option>
            {variableSets.variableSets.map((variableSet) => (
              <option key={variableSet.id} value={variableSet.id}>
                {variableSet.name} ({variableSet.variables.length} vars)
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}

// ── Connected Machine kind: machine picker, folder, env note ──────────────────

function ConnectedMachineFields(props: {
  draft: SessionDraft;
  compute: ConnectedMachineTarget;
  machines: MachineView[];
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
}) {
  const { draft, compute, onChange, machines } = props;
  const setCompute = (next: ConnectedMachineTarget) => onChange({ ...draft, compute: next });
  const pickedMachine = compute.sandboxId
    ? (machines.find((machine) => machine.sandboxId === compute.sandboxId) ?? null)
    : null;
  const customPath = compute.folder.kind === "path" ? compute.folder.path : "";
  const capabilityChips = selfhostedCapabilityChips(pickedMachine);

  return (
    <div className="grid gap-4 rounded-lg border border-border bg-surface/40 p-3.5">
      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <ServerIcon className="size-3 shrink-0 text-fg-subtle" />
          Machine
        </Label>
        <Select
          value={compute.sandboxId ?? ""}
          disabled={props.disabled}
          onChange={(event) => setCompute({ ...compute, sandboxId: event.target.value || null })}
        >
          <option value="" disabled>
            Choose a machine…
          </option>
          {machines.map((machine) => (
            <option
              key={machine.sandboxId}
              value={machine.sandboxId}
              disabled={!isMachineComputeSelectable(machine.state)}
            >
              {machine.name}
              {machine.os ? ` · ${machine.os}/${machine.arch}` : ""}
              {machine.state !== "online" ? ` (${machine.state})` : ""}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-center gap-1.5">
          {capabilityChips.map((chip) => (
            <CapabilityChip key={chip}>{chip}</CapabilityChip>
          ))}
          {pickedMachine && !pickedMachine.hasDisplay ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-border-strong px-1.5 py-0.5 text-2xs font-medium text-fg-subtle">
              <MonitorOffIcon className="size-3 shrink-0" />
              No display
            </span>
          ) : null}
        </div>
        {compute.sandboxId === null ? (
          <p className="text-2xs text-fg-muted">Pick a machine to run on.</p>
        ) : null}
      </div>

      {/* Project / folder — the agent's working directory on the machine (D4/D5,
          functional via Stage A's workingDir for root + custom path). */}
      <div className="grid gap-2.5 border-t border-border pt-4">
        <Label className="flex items-center gap-1.5 text-xs">
          <FolderIcon className="size-3 shrink-0 text-fg-subtle" />
          Project / folder
        </Label>
        <div className="grid gap-2">
          <FolderRadio
            checked={compute.folder.kind === "root"}
            disabled={props.disabled}
            onSelect={() => setCompute({ ...compute, folder: { kind: "root" } })}
            label="Machine root"
            hint="the agent's launch directory"
          />
          <FolderRadio
            checked={false}
            disabled
            onSelect={() => {}}
            label="Project"
            hint="a named path"
            badge="Soon"
          />
          <FolderRadio
            checked={compute.folder.kind === "path"}
            disabled={props.disabled}
            onSelect={() => setCompute({ ...compute, folder: { kind: "path", path: customPath } })}
            label="Custom path"
            hint="absolute, or relative to the launch root"
          />
          {compute.folder.kind === "path" ? (
            <Input
              value={customPath}
              disabled={props.disabled}
              onChange={(event) =>
                setCompute({ ...compute, folder: { kind: "path", path: event.target.value } })
              }
              placeholder="e.g. ~/repos/myproject or packages/runtime"
              aria-label="Custom working directory"
              className="ml-[1.375rem] h-9 w-[calc(100%_-_1.375rem)] text-sm"
            />
          ) : null}
        </div>
        <p className="text-2xs text-fg-subtle">
          Where the agent, terminal, and file dock open. Defaults to the machine&apos;s workspace
          root.
        </p>
      </div>

      {/* Variable set injection — hidden on a connected machine (D2). Repos live
          in the composer pills for managed sandboxes only (not cloned here). */}
      <div className="grid gap-1 border-t border-border pt-4">
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <BoxIcon className="size-3 shrink-0" />
          Uses this machine&apos;s checkout, git auth, and environment
        </p>
        <p className="text-2xs text-fg-subtle">
          Workspace repositories and variable sets aren&apos;t injected onto a connected machine.
        </p>
      </div>
    </div>
  );
}

function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-surface-2/60 px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
      {children}
    </span>
  );
}

// A genuine fleet-load failure (not the expected selfhosted-disabled 404): a
// calm, retryable note so the machine option is never silently swallowed.
function FleetErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice
      tone="muted"
      className="p-2.5 text-xs"
      action={
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          Retry
        </button>
      }
    >
      Couldn&apos;t load your connected machines.
    </Notice>
  );
}

function FolderRadio(props: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onSelect}
      className="group flex items-center gap-2 rounded-md text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
          props.checked ? "border-brand" : "border-border-strong group-hover:border-fg-subtle",
        )}
      >
        {props.checked ? <span className="size-1.5 rounded-full bg-brand-strong" /> : null}
      </span>
      <span className="font-medium text-fg">{props.label}</span>
      {props.badge ? (
        <span className="rounded border border-border px-1 py-px text-2xs font-medium uppercase tracking-wide text-fg-subtle">
          {props.badge}
        </span>
      ) : null}
      <span className="text-2xs text-fg-subtle">— {props.hint}</span>
    </button>
  );
}
