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
  useChannels,
  useRigs,
  useVariableSets,
  useWorkspaceSessions,
  type ComposerState,
} from "@opengeni/react";
import { useMachines, type MachineView } from "@opengeni/react/machines";
import {
  NewSessionRealtimeControl,
  RealtimeVoiceModelPanel,
  useRealtimeModelSelection,
} from "@opengeni/react/realtime";
import { OpenGeniApiError, type SessionRealtimeModel } from "@opengeni/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  MonitorOffIcon,
  PlusIcon,
  ServerCogIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { BillingClassMark } from "@/components/billing-class-mark";
import { ChannelCreateDialog } from "@/components/rail/channel-create-dialog";
import { ConsoleComposer, useDraftAttachments } from "@/components/Composer";
import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import { PersonalResourceAttachmentControl } from "@/components/personal-resource-attachment-control";
import { SessionVisibilityPicker } from "@/components/session-visibility-picker";
import { ModelPicker, SessionToolPicker, type SessionToolSelection } from "@/components/pickers";
import { RepositoryContextMenuBody, RepositoryContextPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext, useLatestCallback } from "@/context";
import {
  EMPTY_COMPOSER_LAUNCH,
  composerLaunchSearchKey,
  type ComposerLaunchSearch,
} from "@/lib/composer-launch";
import { FOCUS_CREATE_COMPOSER_EVENT } from "@/lib/create-composer-focus";
import type { RepoDraft } from "@/lib/session-tools";
import { displayModel } from "@/lib/format";
import { isMachineComputeSelectable } from "@/lib/machine-selectability";
import {
  effortOptionsForModel,
  findPickerRow,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "@/lib/model-policy";
import { isCodexProductModel } from "@/lib/session-model";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { groupSessionsForRail, relativeTimeLabel } from "@/lib/sessions-group";
import {
  useWorkspaceModelCatalog,
  type WorkspaceModelCatalogState,
} from "@/lib/use-workspace-model-catalog";
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
  clientFirstPartyMcpToolPolicy,
  firstPartySessionToolOptionsFor,
  selectableSessionMcpServerIds,
  newSessionDraftToolPolicy,
  rehydrateRepositoryResources,
  repositorySelectionFromResources,
} from "@/lib/session-tools";
import { useNewSessionDraft, type NewSessionDraftEditable } from "@/lib/use-new-session-draft";
import {
  usePersonalResourceAttachment,
  type PersonalResourceAttachmentController,
} from "@/lib/use-personal-resource-attachment";
import { cn } from "@/lib/utils";
import {
  runNewSessionRouteSubmission,
  type CreatedSessionRouteAuthority,
} from "@/routes/sessions-index-submission";
import type { Channel, Session } from "@/types";

export function SessionsIndexRoute({
  workspaceId,
  launch = EMPTY_COMPOSER_LAUNCH,
}: {
  workspaceId: string;
  launch?: ComposerLaunchSearch;
}) {
  const { accessKeyVersion } = useAppContext();
  return (
    <SessionsIndexRouteContent
      key={`${workspaceId}:${accessKeyVersion}`}
      workspaceId={workspaceId}
      launch={launch}
    />
  );
}

function SessionsIndexRouteContent({
  workspaceId,
  launch,
}: {
  workspaceId: string;
  launch: ComposerLaunchSearch;
}) {
  const context = useAppContext();
  const firstPartyMcpToolPolicy = clientFirstPartyMcpToolPolicy(context.clientConfig);
  const firstPartyToolOptions = firstPartySessionToolOptionsFor(firstPartyMcpToolPolicy.allowed);
  const navigate = useNavigate();
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const attachments = useDraftAttachments(workspaceId);
  const channelsQuery = useChannels({ pollIntervalMs: 60_000 });
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    launch.channelId ?? null,
  );
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const { resetSessionView } = context;
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(() =>
    emptySessionDraft(firstPartyMcpToolPolicy.default),
  );
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const personalWorkspace = isPersonalWorkspace(workspace, context.managedSelfContext);
  const [tenancyCapabilities, setTenancyCapabilities] = useState<{
    activated: boolean;
    canCreatePrivate: boolean;
    reason: "available" | "not_activated" | "managed_session_required" | "unavailable";
  } | null>(null);
  const tenancyCapabilityGeneration = useRef(0);
  useEffect(() => {
    const generation = ++tenancyCapabilityGeneration.current;
    if (personalWorkspace) {
      setTenancyCapabilities({ activated: true, canCreatePrivate: true, reason: "available" });
      return;
    }
    setTenancyCapabilities(null);
    void context.client
      .getSessionTenancyCreateCapabilities(workspaceId)
      .then((capabilities) => {
        if (tenancyCapabilityGeneration.current !== generation) return;
        setTenancyCapabilities(capabilities);
        if (!capabilities.canCreatePrivate) {
          setDraft((current) =>
            current.visibility === "private" ? { ...current, visibility: "workspace" } : current,
          );
        }
      })
      .catch(() => {
        if (tenancyCapabilityGeneration.current !== generation) return;
        setTenancyCapabilities({
          activated: false,
          canCreatePrivate: false,
          reason: "unavailable",
        });
        setDraft((current) =>
          current.visibility === "private" ? { ...current, visibility: "workspace" } : current,
        );
      });
  }, [context.client, personalWorkspace, workspaceId]);
  const personalAttachment = usePersonalResourceAttachment({
    client: context.client,
    authMode: context.clientConfig.auth.mode,
    authSession: context.authSession,
    accessSubjectId: context.accessContext.subjectId,
    managedSelfContext: context.managedSelfContext,
    workspace,
    enabled: draft.compute.kind === "sandbox",
    fixed: {
      variableSetId: draft.compute.kind === "sandbox" ? draft.variableSetId || null : null,
      rigId: draft.compute.kind === "sandbox" ? draft.rigId || null : null,
    },
    personalWorkspaceTarget: isPersonalWorkspace(workspace, context.managedSelfContext),
    createVisibility: personalWorkspace ? "private" : draft.visibility,
  });
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

  // Folder-launch links preselect their destination, while the ordinary New
  // session entry starts in Recents. Keep the selection local so choosing a
  // folder does not turn the composer URL into application state.
  useEffect(() => {
    setSelectedChannelId(launch.channelId ?? null);
  }, [launch.channelId]);

  useEffect(() => {
    if (
      selectedChannelId !== null &&
      !channelsQuery.loading &&
      !channelsQuery.channels.some((channel) => channel.id === selectedChannelId)
    ) {
      setSelectedChannelId(null);
    }
  }, [channelsQuery.channels, channelsQuery.loading, selectedChannelId]);
  const createProject = useCallback(async () => {
    const name = projectNameDraft.trim();
    if (!name) return;
    const project = await channelsQuery.create({ name });
    if (!project) {
      toast.error("Couldn't create the project. The name may already be in use.");
      return;
    }
    setSelectedChannelId(project.id);
    setProjectDialogOpen(false);
    setProjectNameDraft("");
  }, [channelsQuery, projectNameDraft]);

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
      resources: [
        ...(draft.compute.kind === "machine" ? [] : context.currentResources),
        ...attachments.readyResources,
      ],
      tools: persistedToolPolicy.tools,
      toolsProvided: persistedToolPolicy.toolsProvided,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      latencyMode: context.latencyMode,
      options: newSessionDraftOptionsFromSessionDraft(draft, firstPartyMcpToolPolicy.default),
    }),
    [
      attachments.readyResources,
      context.model,
      context.latencyMode,
      context.reasoningEffort,
      context.currentResources,
      draft,
      firstPartyMcpToolPolicy.default,
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
      setDraft(
        sessionDraftFromNewSessionDraftOptions(remote.options, firstPartyMcpToolPolicy.default),
      );
      setModel(remote.model);
      setReasoningEffort(remote.reasoningEffort);
      setLatencyMode(remote.latencyMode);
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
      firstPartyMcpToolPolicy.default,
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
  const privateCreateUnavailable =
    !personalWorkspace &&
    draft.visibility === "private" &&
    tenancyCapabilities?.canCreatePrivate !== true;
  const selectedPolicyRow = findPickerRow(modelCatalog.rows, context.model);
  const newSessionPolicyValid = Boolean(
    selectedPolicyRow?.selectable &&
    effortOptionsForModel(selectedPolicyRow.catalog).includes(context.reasoningEffort) &&
    (context.latencyMode === "standard" ||
      runnableLatencyModesForModel(selectedPolicyRow.catalog).includes(context.latencyMode)),
  );
  const newSessionPolicyError =
    !modelCatalog.loading && !newSessionPolicyValid
      ? "Choose a supported model, reasoning level, and speed."
      : null;
  const codexConnected = modelCatalog.models.some(
    (candidate) =>
      candidate.provider === "codex-subscription" &&
      candidate.credentialReadiness.status === "ready",
  );
  // Shared with the bar start control and the mobile “+ → Voice model” panel.
  const voiceSelection = useRealtimeModelSelection({
    client: context.client,
    workspaceId,
    codexConnected,
  });

  useEffect(() => {
    if (createComposerFocusGen === 0 || newSessionDraft.loading) return;
    const textarea = composerRegionRef.current?.querySelector("textarea");
    if (!textarea || textarea.disabled) return;
    textarea.focus();
  }, [createComposerFocusGen, newSessionDraft.loading]);

  const submitNewSession = useLatestCallback(
    async (
      realtimeModel: SessionRealtimeModel | null,
      policy?: Pick<ComposerLaunchSearch, "model" | "effort" | "latency">,
    ): Promise<boolean> => {
      const hasTypedText = message.trim().length > 0;
      const text = hasTypedText
        ? message
        : attachments.readyResources.length > 0
          ? FILE_ONLY_MESSAGE_TEXT
          : "";
      if (
        busy ||
        newSessionDraft.loading ||
        newSessionDraft.conflict ||
        !newSessionPolicyValid ||
        privateCreateUnavailable ||
        (createdSessionAuthority === null && personalAttachment.requiresDecision) ||
        (createdSessionAuthority === null && personalAttachment.loading) ||
        (createdSessionAuthority === null && personalAttachment.refreshing)
      )
        return false;
      if (
        createdSessionAuthority === null &&
        ((!text && !realtimeModel) || attachments.hasUnresolved || !computeReady)
      ) {
        return false;
      }
      const model = policy?.model ?? persistedValue.model;
      const reasoningEffort = policy?.effort ?? persistedValue.reasoningEffort;
      const latencyMode = policy?.latency ?? persistedValue.latencyMode;
      setSubmitting(true);
      try {
        return await runNewSessionRouteSubmission({
          authority: createdSessionAuthority,
          onAuthorityChange: setCreatedSessionAuthority,
          create: async () => {
            // Voice launch is realtime-only: never turn composer text/files into
            // an initial message. Persist the draft so a pending autosave is not
            // lost on navigate, but do not consume it — text stays for later.
            if (realtimeModel) {
              const flushed = await newSessionDraft.flush();
              if (!flushed) return null;
              const submission = submissionFromSessionDraft(draft, firstPartyMcpToolPolicy.default);
              const created = await context.startSession(
                workspaceId,
                {
                  text: "",
                  resources: [],
                  tools: persistedValue.tools,
                  model,
                  reasoningEffort,
                  latencyMode,
                  ...submission.extras,
                },
                {
                  targetSandboxId: submission.options.targetSandboxId,
                  workingDir: submission.options.workingDir,
                  channelId: selectedChannelId,
                  omitWorkspaceResources: submission.omitWorkspaceResources,
                  startMode: "realtime",
                  visibility: personalWorkspace ? "workspace" : submission.options.visibility,
                },
              );
              if (!created) return null;
              return {
                sessionId: created.id,
                settleDraft: async () => true,
              };
            }

            const submittedResources = persistedValue.resources;
            const flushed = await newSessionDraft.flush();
            if (!flushed) return null;
            const submission = submissionFromSessionDraft(
              draft,
              firstPartyMcpToolPolicy.default,
              personalAttachment.intent,
            );
            const created = await context.startSession(
              workspaceId,
              {
                text,
                resources: submittedResources,
                tools: persistedValue.tools,
                model,
                reasoningEffort,
                latencyMode,
                ...submission.extras,
              },
              {
                targetSandboxId: submission.options.targetSandboxId,
                workingDir: submission.options.workingDir,
                channelId: selectedChannelId,
                omitWorkspaceResources: submission.omitWorkspaceResources,
                expectedNewSessionDraftRevision: flushed.revision,
                visibility: personalWorkspace ? "workspace" : submission.options.visibility,
                onFailure: ({ error, request }) =>
                  personalAttachment.onDeliveryError(error, request, "create"),
              },
            );
            if (!created) return null;
            return {
              sessionId: created.id,
              settleDraft: async () => {
                const acknowledged = await newSessionDraft.acknowledgeConsumed(flushed);
                if (acknowledged?.kind === "consumed") {
                  setMessage("");
                  setDraft(emptySessionDraft(firstPartyMcpToolPolicy.default));
                  attachments.removeReadyFiles(
                    submittedResources.flatMap((resource) =>
                      resource.kind === "file" ? [resource.fileId] : [],
                    ),
                  );
                } else if (
                  !acknowledged ||
                  !newSessionDraft.isCurrentSignature(acknowledged.flushed.signature)
                ) {
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
              search: realtimeModel ? { realtime: realtimeModel } : {},
            });
          },
        });
      } finally {
        setSubmitting(false);
      }
    },
  );

  // URL launch: ?model=&effort=&latency= prefill the composer; +?realtime= also
  // creates a realtime-first session and autostarts voice on the session page.
  // Wait for the durable new-session draft so remote hydrate cannot stomp the
  // URL policy after we apply it.
  const launchModel = launch.model;
  const launchEffort = launch.effort;
  const launchLatency = launch.latency;
  const launchRealtime = launch.realtime;
  const launchKey = composerLaunchSearchKey(launch);
  const handledLaunchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!launchKey || handledLaunchKeyRef.current === launchKey) return;
    if (newSessionDraft.loading || newSessionDraft.conflict !== null) return;
    if (launchModel) setModel(launchModel);
    if (launchEffort) setReasoningEffort(launchEffort);
    if (launchLatency) setLatencyMode(launchLatency);
    if (!launchRealtime) {
      handledLaunchKeyRef.current = launchKey;
      void navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId },
        search: launch.channelId ? { channelId: launch.channelId } : {},
        replace: true,
      });
      return;
    }
    if (
      busy ||
      !computeReady ||
      !newSessionPolicyValid ||
      !context.workspaceMcpCatalogReady ||
      attachments.hasUnresolved
    ) {
      return;
    }
    handledLaunchKeyRef.current = launchKey;
    void submitNewSession(launchRealtime, {
      model: launchModel,
      effort: launchEffort,
      latency: launchLatency,
    }).then((ok) => {
      if (!ok) handledLaunchKeyRef.current = null;
    });
  }, [
    attachments.hasUnresolved,
    busy,
    computeReady,
    context.workspaceMcpCatalogReady,
    launchEffort,
    launchLatency,
    launchModel,
    launchRealtime,
    launchKey,
    launch.channelId,
    navigate,
    newSessionDraft.conflict,
    newSessionDraft.loading,
    newSessionPolicyValid,
    setLatencyMode,
    setModel,
    setReasoningEffort,
    submitNewSession,
    workspaceId,
  ]);

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
      newSessionPolicyValid &&
      (createdSessionAuthority !== null || !personalAttachment.requiresDecision) &&
      (createdSessionAuthority !== null || !personalAttachment.loading) &&
      (createdSessionAuthority !== null || !personalAttachment.refreshing) &&
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
    policy: {
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      latencyMode: context.latencyMode,
    },
    setModel: context.setModel,
    setReasoningEffort: context.setReasoningEffort,
    setLatencyMode: context.setLatencyMode,
    draftPersistence: "disabled",
    applyDraft: () => {},
    reloadDraft: newSessionDraft.reload,
    resolveDraftConflict: newSessionDraft.resolveConflict,
    restoredResources: [],
    removeRestoredResource: () => {},
    error: newSessionDraft.error,
    clearError: newSessionDraft.clearError,
    send: async () => await submitNewSession(null),
    steer: async () => {
      const text =
        message.trim() || (attachments.readyResources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
      if (!text || busy || attachments.hasUnresolved || !computeReady || !newSessionPolicyValid) {
        return false;
      }
      return await createComposer.send();
    },
  };

  return (
    // The canvas parent is overflow-hidden, so this route owns its scrolling —
    // without it the page clips (recent sessions were unreachable below the fold).
    <div data-workspace-scroll-owner="self-managed" className="min-h-0 flex-1 overflow-y-auto">
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
            controlsLeading={
              <ComposerMobilePlus
                disabled={busy || newSessionDraft.loading}
                fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
                servers={context.toolMcpServers}
                firstPartyTools={firstPartyToolOptions}
                selection={{
                  mcpServerIds: context.selectedCapabilityToolIds,
                  firstPartyToolIds: draft.firstPartyMcpTools,
                }}
                toolsDisabled={busy || newSessionDraft.loading}
                onToolSelectionChange={(selection) => {
                  setToolSelectionExplicit(true);
                  context.setSelectedCapabilityToolIds(selection.mcpServerIds);
                  setDraft((current) => ({
                    ...current,
                    firstPartyMcpTools: selection.firstPartyToolIds,
                  }));
                }}
                {...(draft.compute.kind === "sandbox"
                  ? {
                      repositories: {
                        selectedCount:
                          context.selectedRepoIds.size +
                          context.manualRepos.filter((repo) => repo.url.trim().length > 0).length,
                        disabled: busy || newSessionDraft.loading,
                        panel: (
                          <WorkspaceRepositoryMenuBody
                            workspaceId={workspaceId}
                            disabled={busy || newSessionDraft.loading}
                          />
                        ),
                      },
                    }
                  : {})}
                voiceModel={{
                  selectedLabel: voiceSelection.selectedModel.label,
                  disabled: busy || newSessionDraft.loading,
                  panel: (
                    <RealtimeVoiceModelPanel
                      models={voiceSelection.models}
                      selectedModel={voiceSelection.selectedModel}
                      disabled={busy || newSessionDraft.loading}
                      onSelect={voiceSelection.selectModel}
                    />
                  ),
                }}
              />
            }
            actions={
              <NewSessionRealtimeControl
                client={context.client}
                workspaceId={workspaceId}
                codexConnected={codexConnected}
                models={voiceSelection.models}
                selectedModel={voiceSelection.selectedModel}
                onSelectModel={voiceSelection.selectModel}
                modelMenu="split-desktop"
                disabled={
                  busy ||
                  newSessionDraft.loading ||
                  newSessionDraft.conflict !== null ||
                  attachments.hasUnresolved ||
                  !newSessionPolicyValid ||
                  !computeReady ||
                  !context.workspaceMcpCatalogReady
                }
                disabledReason={
                  newSessionDraft.conflict
                    ? "Resolve the draft conflict before starting voice."
                    : attachments.hasUnresolved
                      ? "Wait for attachments to finish before starting voice."
                      : !newSessionPolicyValid
                        ? "Choose supported model settings before starting voice."
                        : !computeReady
                          ? "Choose where this session should run first."
                          : !context.workspaceMcpCatalogReady
                            ? "Wait for session tools to finish loading."
                            : null
                }
                onStart={async (model) => await submitNewSession(model)}
              />
            }
            controls={
              <SessionControlStrip
                workspaceId={workspaceId}
                modelCatalog={modelCatalog}
                policyError={newSessionPolicyError}
                disabled={busy || newSessionDraft.loading}
                showRepos={draft.compute.kind === "sandbox"}
                channels={channelsQuery.channels}
                selectedChannelId={selectedChannelId}
                onChannelChange={setSelectedChannelId}
                onCreateProject={() => setProjectDialogOpen(true)}
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

          <SessionVisibilityPicker
            id="new-session"
            personalWorkspace={personalWorkspace}
            value={personalWorkspace ? "private" : draft.visibility}
            capabilities={tenancyCapabilities}
            disabled={busy || newSessionDraft.loading}
            onChange={(visibility) => setDraft((current) => ({ ...current, visibility }))}
          />

          <ComputeTargetControl
            workspaceId={workspaceId}
            draft={draft}
            onChange={setDraft}
            disabled={busy || newSessionDraft.loading}
            personalAttachment={personalAttachment}
          />
          {draft.compute.kind === "sandbox" ? (
            <PersonalResourceAttachmentControl
              controller={personalAttachment}
              disabled={busy || newSessionDraft.loading}
            />
          ) : null}
        </div>

        <RecentSessions workspaceId={workspaceId} />
      </div>
      <ChannelCreateDialog
        open={projectDialogOpen}
        name={projectNameDraft}
        busy={channelsQuery.mutating}
        onNameChange={setProjectNameDraft}
        onOpenChange={(open) => {
          setProjectDialogOpen(open);
          if (!open) setProjectNameDraft("");
        }}
        onSubmit={() => void createProject()}
      />
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
// only shows when rigs / variable sets exist. On mobile, tools move under “+”.
function SessionControlStrip({
  workspaceId,
  modelCatalog,
  policyError,
  disabled,
  showRepos,
  channels,
  selectedChannelId,
  onChannelChange,
  onCreateProject,
  selection,
  onToolSelectionChange,
}: {
  workspaceId: string;
  modelCatalog: WorkspaceModelCatalogState;
  policyError: string | null;
  disabled: boolean;
  showRepos: boolean;
  channels: Channel[];
  selectedChannelId: string | null;
  onChannelChange: (channelId: string | null) => void;
  onCreateProject: () => void;
  selection: SessionToolSelection;
  onToolSelectionChange: (selection: SessionToolSelection) => void;
}) {
  const context = useAppContext();
  const firstPartyToolOptions = firstPartySessionToolOptionsFor(
    clientFirstPartyMcpToolPolicy(context.clientConfig).allowed,
  );
  return (
    <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
      <ModelPicker
        rows={modelCatalog.rows}
        model={context.model}
        effort={context.reasoningEffort}
        latencyMode={context.latencyMode}
        disabled={disabled}
        loading={modelCatalog.loading}
        error={modelCatalog.error ?? policyError}
        className="shrink"
        onModelChange={context.setModel}
        onEffortChange={context.setReasoningEffort}
        onLatencyModeChange={context.setLatencyMode}
      />
      <SessionToolPicker
        servers={context.toolMcpServers}
        firstPartyTools={firstPartyToolOptions}
        selection={selection}
        triggerClassName="min-w-0 shrink overflow-hidden max-sm:hidden"
        disabled={disabled}
        onChange={onToolSelectionChange}
      />
      <SessionFolderPicker
        channels={channels}
        selectedChannelId={selectedChannelId}
        disabled={disabled}
        onChange={onChannelChange}
        onCreateProject={onCreateProject}
      />
      {showRepos ? (
        <WorkspaceRepositoryPicker
          workspaceId={workspaceId}
          disabled={disabled}
          triggerClassName="min-w-0 shrink overflow-hidden max-sm:hidden"
        />
      ) : null}
    </div>
  );
}

function SessionFolderPicker({
  channels,
  selectedChannelId,
  disabled,
  onChange,
  onCreateProject,
}: {
  channels: Channel[];
  selectedChannelId: string | null;
  disabled: boolean;
  onChange: (channelId: string | null) => void;
  onCreateProject: () => void;
}) {
  const selected = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const label = selected?.name ?? "Default";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-label={`Project: ${label}`}
          className="h-8 min-w-0 max-w-[12rem] shrink gap-1.5 overflow-hidden rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg"
        >
          <FolderIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-56">
        <DropdownMenuLabel>Save new session in</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <FolderIcon className="size-4" />
          <span className="min-w-0 flex-1 truncate">Default</span>
          {selectedChannelId === null ? <CheckIcon className="size-4" /> : null}
        </DropdownMenuItem>
        {channels.map((channel) => (
          <DropdownMenuItem key={channel.id} onSelect={() => onChange(channel.id)}>
            <FolderIcon className="size-4" />
            <span className="min-w-0 flex-1 truncate">{channel.name}</span>
            {channel.id === selectedChannelId ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreateProject}>
          <PlusIcon className="size-4" />
          New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function workspaceRepositoryPickerProps(
  context: ReturnType<typeof useAppContext>,
  workspaceId: string,
  disabled: boolean,
) {
  return {
    setupMode:
      context.githubStatus?.setupMode ??
      (context.clientConfig.productAccessMode === "managed" ? "platform" : "operator"),
    configured: context.githubStatus?.configured === true,
    status: context.githubStatus?.status ?? ("disabled" as const),
    installUrl: context.githubStatus?.installUrl ?? null,
    linkUrl: context.githubStatus?.linkUrl ?? null,
    installations: context.githubStatus?.installations ?? [],
    repositories: context.githubRepos,
    groups: context.repositoryGroups,
    selectedRepoIds: context.selectedRepoIds,
    selectedRepoRefs: context.selectedRepoRefs,
    selectedInstallationId: context.selectedInstallationId,
    manualRepos: context.manualRepos,
    manualOpen: context.manualReposOpen,
    githubAppOpen: context.githubAppOpen,
    org: context.githubOrg,
    pending: context.busy || disabled,
    repoBusy: context.repoBusy,
    githubAppBusy: context.githubAppBusy,
    onRefresh: () => context.refreshGitHub(workspaceId, undefined, { sync: true }),
    onToggleRepo: context.toggleGitHubRepository,
    onRefChange: (repoId: number, ref: string) =>
      context.setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref })),
    onManualOpenChange: context.setManualReposOpen,
    onManualAdd: context.addManualRepository,
    onManualUpdate: (id: number, patch: Partial<RepoDraft>) =>
      context.setManualRepos((current) =>
        current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
      ),
    onManualRemove: (id: number) =>
      context.setManualRepos((current) => current.filter((repo) => repo.id !== id)),
    onGitHubAppOpenChange: context.setGithubAppOpen,
    onOrgChange: context.setGithubOrg,
    onStartGitHubApp: () => void context.startGitHubAppManifestFlow(workspaceId),
    onDisconnectInstallation: async (installationId: number) => {
      await context.disconnectGitHubInstallation(workspaceId, installationId);
    },
  };
}

// The workspace repository picker, wired to the cross-route selection in context.
// Reused in both compute kinds: the primary clone source on a managed sandbox,
// and grayed/disabled on a connected machine (which uses its own checkout).
// Mobile opens the same body from ComposerMobilePlus — hide the bar pill there.
function WorkspaceRepositoryPicker({
  workspaceId,
  disabled,
  triggerClassName,
}: {
  workspaceId: string;
  disabled: boolean;
  triggerClassName?: string;
}) {
  const context = useAppContext();
  return (
    <RepositoryContextPicker
      {...workspaceRepositoryPickerProps(context, workspaceId, disabled)}
      {...(triggerClassName ? { triggerClassName } : {})}
    />
  );
}

function WorkspaceRepositoryMenuBody({
  workspaceId,
  disabled,
  leading,
}: {
  workspaceId: string;
  disabled: boolean;
  leading?: ReactNode;
}) {
  const context = useAppContext();
  return (
    <RepositoryContextMenuBody
      {...workspaceRepositoryPickerProps(context, workspaceId, disabled)}
      {...(leading ? { leading } : {})}
    />
  );
}

// ── The promoted top-level compute target (the parent that gates the band) ────

function ComputeTargetControl(props: {
  workspaceId: string;
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
  personalAttachment: PersonalResourceAttachmentController;
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
          <ManagedSandboxFields
            draft={draft}
            onChange={onChange}
            disabled={props.disabled}
            personalAttachment={props.personalAttachment}
          />
          <FleetErrorNotice onRetry={() => void fleet.refresh()} />
        </section>
      );
    }
    return (
      <ManagedSandboxFields
        draft={draft}
        onChange={onChange}
        disabled={props.disabled}
        personalAttachment={props.personalAttachment}
      />
    );
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
        <ManagedSandboxFields
          draft={draft}
          onChange={onChange}
          disabled={props.disabled}
          personalAttachment={props.personalAttachment}
        />
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
  personalAttachment: PersonalResourceAttachmentController;
}) {
  const { draft, onChange } = props;
  const variableSets = useVariableSets();
  const rigs = useRigs();
  const personalRigs = props.personalAttachment.catalog?.rigs ?? [];
  const personalVariableSets = props.personalAttachment.catalog?.variableSets ?? [];
  const personalRigIds = new Set(personalRigs.map((resource) => resource.id));
  const personalVariableSetIds = new Set(personalVariableSets.map((resource) => resource.id));
  const workspaceRigs = rigs.rigs.filter((resource) => !personalRigIds.has(resource.id));
  const workspaceVariableSets = variableSets.variableSets.filter(
    (resource) => !personalVariableSetIds.has(resource.id),
  );
  const showRigs = workspaceRigs.length > 0 || personalRigs.length > 0;
  const showVariableSets = workspaceVariableSets.length > 0 || personalVariableSets.length > 0;
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
              const picked = [...workspaceRigs, ...personalRigs].find((rig) => rig.id === rigId);
              const defaultVariableSetId = picked?.activeVersion?.defaultVariableSetIds[0];
              props.personalAttachment.setMode(null);
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
            {workspaceRigs.map((rig) => (
              <option key={rig.id} value={rig.id}>
                {rig.name}
                {rig.activeVersion ? ` (v${rig.activeVersion.version})` : ""}
              </option>
            ))}
            {personalRigs.length > 0 ? (
              <optgroup label="Only me">
                {personalRigs.map((rig) => (
                  <option key={rig.id} value={rig.id}>
                    {rig.name}
                    {rig.activeVersion ? ` (v${rig.activeVersion.version})` : ""}
                  </option>
                ))}
              </optgroup>
            ) : null}
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
            onChange={(event) => {
              props.personalAttachment.setMode(null);
              onChange({ ...draft, variableSetId: event.target.value });
            }}
            className="h-8 w-auto max-w-56 text-xs"
          >
            <option value="">No variable set</option>
            {workspaceVariableSets.map((variableSet) => (
              <option key={variableSet.id} value={variableSet.id}>
                {variableSet.name} ({variableSet.variables.length} vars)
              </option>
            ))}
            {personalVariableSets.length > 0 ? (
              <optgroup label="Only me">
                {personalVariableSets.map((variableSet) => (
                  <option key={variableSet.id} value={variableSet.id}>
                    {variableSet.name} ({variableSet.variables.length} vars)
                  </option>
                ))}
              </optgroup>
            ) : null}
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
