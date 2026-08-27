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
import { resolveWorkspaceSessionToolDefaults } from "@opengeni/contracts";
import { MACHINES_COMPOSER_POLL_MS, useMachines, type MachineView } from "@opengeni/react/machines";
import {
  NewSessionRealtimeControl,
  RealtimeVoiceModelPanel,
  useRealtimeModelSelection,
} from "@opengeni/react/realtime";
import {
  OpenGeniApiError,
  PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING,
  type NewSessionSelectionHistory,
  type Rig,
  type SessionRealtimeModel,
  type VariableSet,
  type VariableSetAttachmentMetadata,
} from "@opengeni/sdk";
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
import { SessionVisibilityPicker } from "@/components/session-visibility-picker";
import { ModelPicker, SessionToolPicker, type SessionToolSelection } from "@/components/pickers";
import { RepositoryContextMenuBody, RepositoryContextPicker } from "@/components/repository-picker";
import { SelectedVariableSetList } from "@/components/session/selected-variable-set-list";
import { Button } from "@/components/ui/button";
import { sessionDisplayTitle } from "@/lib/session-rename";
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
import { useBrowserAccountBridgeBlocker } from "@/lib/browser-account-bridge";
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
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  isPersonalAttachmentConflict,
  newSessionFixedResourceCatalogFailed,
  newSessionPersonalResourceAttachment,
  personalResourceSelectionIdentityKey,
  reconcileNewSessionFixedResources,
  recoverNewSessionPersonalResourceAttachment,
  resolvePersonalResourceOwnerScope,
  selectableSessionVariableSets,
} from "@/lib/personal-resource-attachments";
import { groupSessionsForRail, relativeTimeLabel } from "@/lib/sessions-group";
import {
  useWorkspaceModelCatalog,
  type WorkspaceModelCatalogState,
} from "@/lib/use-workspace-model-catalog";
import {
  emptySessionDraft,
  isSessionDraftComputeReady,
  newSessionCreateVisibility,
  newSessionDraftOptionsFromSessionDraft,
  rememberedMachineFolder,
  rememberedProjectCompute,
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
  const firstPartyMcpToolPolicy = useMemo(
    () => clientFirstPartyMcpToolPolicy(context.clientConfig),
    [context.clientConfig],
  );
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const configuredToolDefaults = useMemo(
    () => resolveWorkspaceSessionToolDefaults(workspace?.settings),
    [workspace?.settings],
  );
  const defaultFirstPartyMcpTools = useMemo(
    () =>
      configuredToolDefaults?.firstPartyMcpTools.filter((tool) =>
        firstPartyMcpToolPolicy.allowed.includes(tool),
      ) ?? firstPartyMcpToolPolicy.default,
    [configuredToolDefaults, firstPartyMcpToolPolicy],
  );
  const firstPartyToolOptions = useMemo(
    () => firstPartySessionToolOptionsFor(firstPartyMcpToolPolicy.allowed),
    [firstPartyMcpToolPolicy],
  );
  const navigate = useNavigate();
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const attachments = useDraftAttachments(workspaceId);
  const channelsQuery = useChannels({ pollIntervalMs: 60_000 });
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    launch.channelId ?? null,
  );
  const [selectionHistory, setSelectionHistory] = useState<NewSessionSelectionHistory>({
    projects: [],
  });
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const { resetSessionView } = context;
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(() =>
    emptySessionDraft(defaultFirstPartyMcpTools),
  );
  const personalWorkspace = isPersonalWorkspace(workspace, context.managedSelfContext);
  const fixedResourceCatalogEnabled = draft.compute.kind === "sandbox";
  const canAttachVariableSets = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "variable-sets:attach",
  );
  const canUseVariableSets = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "variable-sets:use",
  );
  const canListVariableSets = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "variable-sets:list",
  );
  const canListVariableSetSecrets = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "secrets:list",
  );
  const canLoadVariableSetCatalog =
    canAttachVariableSets && canUseVariableSets && canListVariableSets && canListVariableSetSecrets;
  const canResolveVariableSetAttachments =
    canAttachVariableSets && canUseVariableSets && !canLoadVariableSetCatalog;
  const variableSets = useVariableSets({
    enabled: fixedResourceCatalogEnabled && canLoadVariableSetCatalog,
  });
  const rigs = useRigs({ enabled: fixedResourceCatalogEnabled });
  const [tenancyCapabilities, setTenancyCapabilities] = useState<{
    activated: boolean;
    canCreatePrivate: boolean;
    reason: "available" | "not_activated" | "managed_session_required" | "unavailable";
  } | null>(null);
  const tenancyCapabilityGeneration = useRef(0);
  useEffect(() => {
    const generation = ++tenancyCapabilityGeneration.current;
    if (personalWorkspace) {
      setTenancyCapabilities({
        activated: true,
        canCreatePrivate: true,
        reason: "available",
      });
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
  const personalOwnerScope = resolvePersonalResourceOwnerScope({
    authMode: context.clientConfig.auth.mode,
    authSession: context.authSession,
    accessSubjectId: context.accessContext.subjectId,
    managedSelfContext: context.managedSelfContext,
    workspace,
  });
  const personalResourcesAvailable =
    personalOwnerScope !== null && (personalWorkspace || tenancyCapabilities?.activated === true);
  const selectableVariableSets = canLoadVariableSetCatalog
    ? selectableSessionVariableSets(variableSets.variableSets, {
        canAttach: canAttachVariableSets,
        canUse: canUseVariableSets,
        personalResourcesAvailable,
      })
    : [];
  const personalResourceEligibilitySettled =
    personalWorkspace || personalOwnerScope === null || tenancyCapabilities !== null;
  const selectableRigs = rigs.rigs.filter(
    (rig) => rig.scope !== "user" || personalResourcesAvailable,
  );
  const selectedRig = selectableRigs.find((candidate) => candidate.id === draft.rigId);
  const selectedRigDefaultVariableSetIds = selectedRig?.activeVersion?.defaultVariableSetIds ?? [];
  const selectedRigDefaultVariableSetIdsKey = selectedRigDefaultVariableSetIds.join("\u0000");
  const variableSetAttachmentIds = [
    ...new Set([...draft.variableSetIds, ...selectedRigDefaultVariableSetIds]),
  ];
  const variableSetAttachmentIdsKey = variableSetAttachmentIds.join("\u0000");
  const variableSetAttachmentResolutionGeneration = useRef(0);
  const [variableSetAttachmentResolution, setVariableSetAttachmentResolution] = useState<{
    key: string;
    variableSets: VariableSetAttachmentMetadata[];
    error: Error | null;
  }>({ key: "", variableSets: [], error: null });
  const resolveVariableSetAttachments = useLatestCallback(async (): Promise<void> => {
    const generation = ++variableSetAttachmentResolutionGeneration.current;
    if (
      !fixedResourceCatalogEnabled ||
      !canResolveVariableSetAttachments ||
      variableSetAttachmentIds.length === 0
    ) {
      setVariableSetAttachmentResolution({
        key: variableSetAttachmentIdsKey,
        variableSets: [],
        error: null,
      });
      return;
    }
    setVariableSetAttachmentResolution({ key: "", variableSets: [], error: null });
    try {
      const result = await context.client.resolveVariableSetAttachments(workspaceId, {
        variableSetIds: variableSetAttachmentIds,
      });
      if (variableSetAttachmentResolutionGeneration.current !== generation) return;
      setVariableSetAttachmentResolution({
        key: variableSetAttachmentIdsKey,
        variableSets: result.variableSets,
        error: null,
      });
    } catch (cause) {
      if (variableSetAttachmentResolutionGeneration.current !== generation) return;
      setVariableSetAttachmentResolution({
        key: variableSetAttachmentIdsKey,
        variableSets: [],
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  });
  useEffect(() => {
    void resolveVariableSetAttachments();
  }, [
    resolveVariableSetAttachments,
    variableSetAttachmentIdsKey,
    canResolveVariableSetAttachments,
    fixedResourceCatalogEnabled,
  ]);
  const variableSetAttachmentResolutionCurrent =
    variableSetAttachmentResolution.key === variableSetAttachmentIdsKey;
  const resolvedVariableSetAttachments = variableSetAttachmentResolutionCurrent
    ? variableSetAttachmentResolution.variableSets
    : [];
  const resolvedVariableSetIds = canLoadVariableSetCatalog
    ? selectableVariableSets.map((variableSet) => variableSet.id)
    : canResolveVariableSetAttachments
      ? resolvedVariableSetAttachments.map((variableSet) => variableSet.id)
      : [];
  const resolvedVariableSetIdsKey = resolvedVariableSetIds.join("\u0000");
  const variableSetResolutionLoading = canLoadVariableSetCatalog
    ? variableSets.loading
    : canResolveVariableSetAttachments
      ? !variableSetAttachmentResolutionCurrent
      : false;
  const variableSetResolutionError = canLoadVariableSetCatalog
    ? variableSets.error
    : canResolveVariableSetAttachments && variableSetAttachmentResolutionCurrent
      ? variableSetAttachmentResolution.error
      : null;
  const variableSetsSettled =
    (canLoadVariableSetCatalog || canResolveVariableSetAttachments) &&
    personalResourceEligibilitySettled &&
    !variableSetResolutionLoading &&
    variableSetResolutionError === null;
  const selectableRigIdsKey = selectableRigs.map((rig) => rig.id).join("\u0000");
  const selectedFixedResourceKey = [...draft.variableSetIds, `rig:${draft.rigId}`].join("\u0000");
  const fixedResourceSelection = reconcileNewSessionFixedResources({
    selectedVariableSetIds: draft.variableSetIds,
    selectedRigId: draft.rigId,
    selectedRigDefaultVariableSetIds,
    selectableVariableSetIds: fixedResourceCatalogEnabled
      ? resolvedVariableSetIds
      : draft.variableSetIds,
    selectableRigIds: fixedResourceCatalogEnabled
      ? selectableRigs.map((rig) => rig.id)
      : draft.rigId
        ? [draft.rigId]
        : [],
    variableSetsSettled: !fixedResourceCatalogEnabled || variableSetsSettled,
    rigsSettled:
      !fixedResourceCatalogEnabled ||
      (personalResourceEligibilitySettled && !rigs.loading && rigs.error === null),
  });
  const fixedResourceCatalogError =
    draft.compute.kind === "sandbox" &&
    newSessionFixedResourceCatalogFailed({
      selectedVariableSetIds: draft.variableSetIds,
      selectedRigId: draft.rigId,
      selectionResolved: fixedResourceSelection.selectionResolved,
      variableSetCatalogFailed: variableSetResolutionError !== null,
      rigCatalogFailed: rigs.error !== null,
    });
  useEffect(() => {
    setDraft((current) => {
      if (current.compute.kind !== "sandbox") return current;
      const reconciled = reconcileNewSessionFixedResources({
        selectedVariableSetIds: current.variableSetIds,
        selectedRigId: current.rigId,
        selectedRigDefaultVariableSetIds: selectedRigDefaultVariableSetIdsKey
          ? selectedRigDefaultVariableSetIdsKey.split("\u0000")
          : [],
        selectableVariableSetIds: resolvedVariableSetIdsKey
          ? resolvedVariableSetIdsKey.split("\u0000")
          : [],
        selectableRigIds: selectableRigIdsKey ? selectableRigIdsKey.split("\u0000") : [],
        variableSetsSettled,
        rigsSettled: personalResourceEligibilitySettled && !rigs.loading && rigs.error === null,
      });
      if (
        reconciled.variableSetIds.length === current.variableSetIds.length &&
        reconciled.variableSetIds.every((id, index) => id === current.variableSetIds[index]) &&
        reconciled.rigId === current.rigId
      ) {
        return current;
      }
      return {
        ...current,
        variableSetIds: reconciled.variableSetIds,
        variableSetId: reconciled.variableSetIds.at(-1) ?? "",
        rigId: reconciled.rigId,
      };
    });
  }, [
    personalResourceEligibilitySettled,
    rigs.error,
    rigs.loading,
    selectedFixedResourceKey,
    selectedRigDefaultVariableSetIdsKey,
    selectableRigIdsKey,
    resolvedVariableSetIdsKey,
    variableSetsSettled,
  ]);
  const personalAttachmentVariableSetIds = [
    ...new Set([
      ...(selectedRig?.activeVersion?.defaultVariableSetIds ?? []),
      ...draft.variableSetIds,
    ]),
  ];
  const selectedPersonalVariableSets = personalAttachmentVariableSetIds.flatMap((variableSetId) => {
    const variableSet = selectableVariableSets.find((candidate) => candidate.id === variableSetId);
    if (variableSet?.scope === "user") return [{ id: variableSet.id, name: variableSet.name }];
    return resolvedVariableSetAttachments.some(
      (candidate) => candidate.id === variableSetId && candidate.scope === "user",
    )
      ? [{ id: variableSetId, name: "Personal Variable Set" }]
      : [];
  });
  const [fleetPollMs, setFleetPollMs] = useState<number | undefined>(undefined);
  const fleet = useMachines({ pollIntervalMs: fleetPollMs });
  const machines = fleet.machines.filter((machine) => machine.kind === "selfhosted");
  const fleetEmpty = machines.length === 0;
  const fleetLoadFailed =
    fleet.error != null && !(fleet.error instanceof OpenGeniApiError && fleet.error.status === 404);
  useEffect(() => {
    if (fleet.loading) return;
    setFleetPollMs(!fleetEmpty || fleetLoadFailed ? MACHINES_COMPOSER_POLL_MS : undefined);
  }, [fleet.loading, fleetEmpty, fleetLoadFailed]);
  const selectedMachineSandboxId =
    draft.compute.kind === "machine" ? draft.compute.sandboxId : null;
  const selectedMachine = selectedMachineSandboxId
    ? (machines.find((machine) => machine.sandboxId === selectedMachineSandboxId) ?? null)
    : null;
  const personalMachineSelected = selectedMachine?.scope === "user";
  const selectedPersonalResourceNames =
    draft.compute.kind === "sandbox"
      ? [
          ...selectedPersonalVariableSets.map((variableSet) => variableSet.name),
          ...(selectedRig?.scope === "user" ? [selectedRig.name] : []),
        ]
      : personalMachineSelected && selectedMachine
        ? [selectedMachine.name]
        : [];
  const personalResourceSelectionKey = personalResourceSelectionIdentityKey({
    variableSetIds: selectedPersonalVariableSets.map((variableSet) => variableSet.id),
    rigId: selectedRig?.scope === "user" ? selectedRig.id : null,
    connectedMachineId:
      personalMachineSelected && selectedMachine ? selectedMachine.enrollmentId : null,
  });
  const selectedPersonalResourceCount = personalResourceSelectionKey
    ? personalResourceSelectionKey.split("\u0000").length
    : 0;
  const [personalResourcesSharedAcknowledged, setPersonalResourcesSharedAcknowledged] =
    useState(false);
  const [personalResourceCatalogRefreshPending, setPersonalResourceCatalogRefreshPending] =
    useState(false);
  const personalResourceCatalogRefreshGeneration = useRef(0);
  useEffect(() => {
    setPersonalResourcesSharedAcknowledged(false);
  }, [personalResourceSelectionKey, draft.visibility]);
  const personalResourceAttachment = newSessionPersonalResourceAttachment({
    personalResourceCount: selectedPersonalResourceCount,
    visibility: newSessionCreateVisibility(personalWorkspace, draft.visibility),
    sharedAcknowledged: personalResourcesSharedAcknowledged,
  });
  const refreshPersonalResourceCatalogs = useLatestCallback(async (): Promise<void> => {
    const generation = ++personalResourceCatalogRefreshGeneration.current;
    setPersonalResourceCatalogRefreshPending(true);
    try {
      await Promise.all([
        canLoadVariableSetCatalog
          ? variableSets.refresh()
          : canResolveVariableSetAttachments
            ? resolveVariableSetAttachments()
            : Promise.resolve(),
        rigs.refresh(),
      ]);
    } finally {
      if (personalResourceCatalogRefreshGeneration.current === generation) {
        setPersonalResourceCatalogRefreshPending(false);
      }
    }
  });
  const recoverPersonalResourceAttachment = useLatestCallback(
    (error: unknown, attemptedInput: Parameters<typeof isPersonalAttachmentConflict>[1]): void => {
      if (!isPersonalAttachmentConflict(error, attemptedInput)) return;
      void recoverNewSessionPersonalResourceAttachment({
        error,
        attemptedInput,
        resetAcknowledgement: () => setPersonalResourcesSharedAcknowledged(false),
        refreshCatalogs: refreshPersonalResourceCatalogs,
      });
    },
  );
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
      const rememberedCompute = rememberedProjectCompute(selectionHistory, null);
      if (rememberedCompute) {
        setDraft((current) => ({ ...current, compute: rememberedCompute }));
      }
    }
  }, [channelsQuery.channels, channelsQuery.loading, selectedChannelId, selectionHistory]);
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

  const computeReady =
    isSessionDraftComputeReady(draft) &&
    (draft.compute.kind !== "machine" || (!fleet.loading && selectedMachine !== null));
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
      options: newSessionDraftOptionsFromSessionDraft(
        draft,
        defaultFirstPartyMcpTools,
        newSessionCreateVisibility(personalWorkspace, draft.visibility),
      ),
    }),
    [
      attachments.readyResources,
      context.model,
      context.latencyMode,
      context.reasoningEffort,
      context.currentResources,
      draft,
      defaultFirstPartyMcpTools,
      message,
      personalWorkspace,
      persistedToolPolicy,
    ],
  );
  const hydrateResources = useLatestCallback((resources: NewSessionDraftEditable["resources"]) =>
    rehydrateRepositoryResources(resources, context.githubRepos, {
      catalogReady: context.githubCatalogReady,
    }),
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
    (remote: NewSessionDraftEditable, history: NewSessionSelectionHistory) => {
      setMessage(remote.text);
      const restored = sessionDraftFromNewSessionDraftOptions(
        remote.options,
        defaultFirstPartyMcpTools,
      );
      const channelId = launch.channelId ?? history.projects[0]?.channelId ?? null;
      const rememberedCompute = rememberedProjectCompute(history, channelId);
      setSelectionHistory(history);
      setSelectedChannelId(channelId);
      setDraft(rememberedCompute ? { ...restored, compute: rememberedCompute } : restored);
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
      defaultFirstPartyMcpTools,
      launch.channelId,
      workspaceDefaultToolIdsForHydration,
    ],
  );
  const selectProject = useCallback(
    (channelId: string | null) => {
      setSelectedChannelId(channelId);
      const rememberedCompute = rememberedProjectCompute(selectionHistory, channelId);
      if (rememberedCompute) {
        setDraft((current) => ({ ...current, compute: rememberedCompute }));
      }
    },
    [selectionHistory],
  );
  const newSessionDraft = useNewSessionDraft({
    workspaceId,
    client: context.client,
    value: persistedValue,
    onApplyRemote: applyRemoteDraft,
    restoreReadyFiles: attachments.restoreReadyFiles,
    hydrateResources,
    // Tool policy needs the MCP catalog. GitHub is optional: an unreadied
    // catalog must not keep the create composer disabled / unsendable.
    resourceHydrationReady: context.workspaceMcpCatalogReady,
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
        personalResourceCatalogRefreshPending ||
        (createdSessionAuthority === null && !fixedResourceSelection.selectionResolved) ||
        (createdSessionAuthority === null && personalResourceAttachment.requiresAcknowledgement)
      )
        return false;
      if (realtimeModel && personalMachineSelected) {
        toast.error("Voice can't start on a personal Connected Machine", {
          description:
            "Start the session with a message first so OpenGeni can attach the machine to an accepted turn.",
        });
        return false;
      }
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
              if (!flushed) {
                toast.error("Couldn't save the draft", {
                  description:
                    newSessionDraft.error?.message ??
                    newSessionDraft.conflict?.message ??
                    "Resolve the draft conflict, then try again.",
                });
                return null;
              }
              const submission = submissionFromSessionDraft(
                draft,
                defaultFirstPartyMcpTools,
                personalResourceAttachment.intent,
              );
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
                  expectedNewSessionDraftRevision: flushed.revision,
                  visibility: newSessionCreateVisibility(
                    personalWorkspace,
                    submission.options.visibility ?? "workspace",
                  ),
                  onFailure: ({ error, request }) =>
                    recoverPersonalResourceAttachment(error, request),
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
            if (!flushed) {
              toast.error("Couldn't save the draft", {
                description:
                  newSessionDraft.error?.message ??
                  newSessionDraft.conflict?.message ??
                  "Resolve the draft conflict, then try again.",
              });
              return null;
            }
            const submission = submissionFromSessionDraft(
              draft,
              defaultFirstPartyMcpTools,
              personalResourceAttachment.intent,
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
                visibility: newSessionCreateVisibility(
                  personalWorkspace,
                  submission.options.visibility ?? "workspace",
                ),
                onFailure: ({ error, request }) =>
                  recoverPersonalResourceAttachment(error, request),
              },
            );
            if (!created) return null;
            return {
              sessionId: created.id,
              settleDraft: async () => {
                const acknowledged = await newSessionDraft.acknowledgeConsumed(flushed);
                if (acknowledged?.kind === "consumed") {
                  setMessage("");
                  setDraft(emptySessionDraft(defaultFirstPartyMcpTools));
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
      !personalResourceCatalogRefreshPending &&
      (createdSessionAuthority !== null || fixedResourceSelection.selectionResolved) &&
      (createdSessionAuthority !== null || !personalResourceAttachment.requiresAcknowledgement) &&
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
  useBrowserAccountBridgeBlocker(`new-session-composer:${workspaceId}`, () => {
    if (attachments.hasUnresolved) {
      return {
        id: "ignored",
        label: "A file upload is not settled",
        detail: "Wait for the upload or remove it before changing accounts.",
      };
    }
    if (busy || submitting || newSessionDraft.saving) {
      return {
        id: "ignored",
        label: "A new-session mutation is still running",
        detail: "Wait for the current save or session creation to finish.",
      };
    }
    return createComposer.hasDraftContent()
      ? {
          id: "ignored",
          label: "The new-session composer has an unsent draft",
          detail: "Continuing clears the account-bound draft.",
        }
      : null;
  });

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
                  disabled: busy || newSessionDraft.loading || personalMachineSelected,
                  panel: (
                    <RealtimeVoiceModelPanel
                      models={voiceSelection.models}
                      selectedModel={voiceSelection.selectedModel}
                      disabled={busy || newSessionDraft.loading || personalMachineSelected}
                      onSelect={voiceSelection.selectModel}
                    />
                  ),
                }}
              />
            }
            actions={
              <>
                <SessionModelControl
                  modelCatalog={modelCatalog}
                  policyError={newSessionPolicyError}
                  disabled={busy || newSessionDraft.loading}
                />
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
                    personalMachineSelected ||
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
                            : personalMachineSelected
                              ? "Start with a message so personal machine access can attach to an accepted turn."
                              : !context.workspaceMcpCatalogReady
                                ? "Wait for session tools to finish loading."
                                : null
                  }
                  onStart={async (model) => await submitNewSession(model)}
                />
              </>
            }
            header={
              <SessionSetupStrip
                workspaceId={workspaceId}
                disabled={busy || newSessionDraft.loading}
                showRepos={draft.compute.kind === "sandbox"}
                channels={channelsQuery.channels}
                selectedChannelId={selectedChannelId}
                onChannelChange={selectProject}
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
            personalResourceAccess={{
              names: selectedPersonalResourceNames,
              visibility: newSessionCreateVisibility(personalWorkspace, draft.visibility),
              sharedAcknowledged: personalResourcesSharedAcknowledged,
              onSharedAcknowledgedChange: setPersonalResourcesSharedAcknowledged,
            }}
            fleet={fleet}
            machines={machines}
            variableSets={selectableVariableSets}
            rigs={selectableRigs}
            catalogRecovery={{
              error: fixedResourceCatalogError,
              refreshing: personalResourceCatalogRefreshPending,
              onRetry: () => void refreshPersonalResourceCatalogs(),
            }}
            selectedChannelId={selectedChannelId}
            selectionHistory={selectionHistory}
          />
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
  const { sessions, pinned } = useWorkspaceSessions({
    limit: 12,
    pollIntervalMs: 30_000,
  });
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
  const title = sessionDisplayTitle(session);
  const model = recentSessionModelPresentation(session.model, catalogRows);
  const repo = sessionRepoLabel(session);
  const metaBits = [model.label, repo].filter(Boolean);
  const hasBackgroundCommand = session.backgroundCommandActivity !== undefined;
  return (
    <li className="min-w-0">
      <Link
        to="/workspaces/$workspaceId/sessions/$sessionId"
        params={{ workspaceId, sessionId: session.id }}
        className="group flex items-center gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-surface-2/50"
      >
        <StatusDot
          tone={hasBackgroundCommand ? "running" : SESSION_STATUS_TONE[session.status]}
          pulse={hasBackgroundCommand || session.status === "running"}
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

// Setup selections sit above the prompt so the footer remains an action row.
// Repo stays out of the compute band so that band only shows when rigs /
// variable sets exist. On mobile, tools and repos remain under “+”.
function SessionSetupStrip({
  workspaceId,
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
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-3 py-2 sm:px-4">
      <SessionToolPicker
        servers={context.toolMcpServers}
        firstPartyTools={firstPartyToolOptions}
        selection={selection}
        triggerClassName="min-w-0 shrink-0 overflow-hidden max-sm:hidden"
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
          triggerClassName="min-w-0 shrink-0 overflow-hidden max-sm:hidden"
        />
      ) : null}
    </div>
  );
}

/** Keep model policy adjacent to voice/send in the bottom action row. */
function SessionModelControl({
  modelCatalog,
  policyError,
  disabled,
}: {
  modelCatalog: WorkspaceModelCatalogState;
  policyError: string | null;
  disabled: boolean;
}) {
  const context = useAppContext();
  return (
    <ModelPicker
      rows={modelCatalog.rows}
      model={context.model}
      effort={context.reasoningEffort}
      latencyMode={context.latencyMode}
      disabled={disabled}
      loading={modelCatalog.loading}
      error={modelCatalog.error ?? policyError}
      className="max-w-[8.5rem] shrink sm:max-w-[13rem] sm:shrink-0"
      onModelChange={context.setModel}
      onEffortChange={context.setReasoningEffort}
      onLatencyModeChange={context.setLatencyMode}
    />
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
          title={label}
          className="h-8 min-w-0 max-w-[12rem] shrink gap-1.5 overflow-hidden rounded-full border border-transparent px-2.5 text-xs text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg sm:shrink-0"
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

type NewSessionPersonalResourceAccess = {
  names: string[];
  visibility: "private" | "workspace";
  sharedAcknowledged: boolean;
  onSharedAcknowledgedChange: (acknowledged: boolean) => void;
};

type FixedResourceCatalogRecovery = {
  error: boolean;
  refreshing: boolean;
  onRetry: () => void;
};

function ComputeTargetControl(props: {
  workspaceId: string;
  draft: SessionDraft;
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
  personalResourceAccess: NewSessionPersonalResourceAccess;
  fleet: ReturnType<typeof useMachines>;
  machines: MachineView[];
  variableSets: VariableSet[];
  rigs: Rig[];
  catalogRecovery: FixedResourceCatalogRecovery;
  selectedChannelId: string | null;
  selectionHistory: NewSessionSelectionHistory;
}) {
  const { draft, onChange } = props;
  const { fleet, machines } = props;
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
  const showComputeTarget = fleet.loading || !fleetEmpty;
  const machineAvailabilityKey = machines
    .map((machine) => `${machine.sandboxId}:${machine.state}`)
    .join("\u0000");

  const sandboxBackendOverride = draft.compute.kind === "sandbox" ? draft.compute.backend : "";
  const selectedMachineSandboxId =
    draft.compute.kind === "machine" ? draft.compute.sandboxId : null;

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
    if (
      !fleet.loading &&
      draft.compute.kind === "machine" &&
      selectedMachineSandboxId !== null &&
      !machines.some((machine) => machine.sandboxId === selectedMachineSandboxId)
    ) {
      const fallback = machines.find((machine) => isMachineComputeSelectable(machine.state));
      onChange({
        ...draft,
        compute: fallback
          ? {
              kind: "machine",
              sandboxId: fallback.sandboxId,
              folder: rememberedMachineFolder(
                props.selectionHistory,
                props.selectedChannelId,
                fallback.sandboxId,
              ),
            }
          : { kind: "sandbox", backend: "" },
      });
      return;
    }
    if (draft.compute.kind === "sandbox" && sandboxBackendOverride) {
      onChange({ ...draft, compute: { kind: "sandbox", backend: "" } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showComputeTarget,
    fleet.loading,
    machineAvailabilityKey,
    draft.compute.kind,
    selectedMachineSandboxId,
    sandboxBackendOverride,
    props.selectedChannelId,
    props.selectionHistory,
  ]);

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
    const project = props.selectionHistory.projects.find(
      (candidate) => candidate.channelId === props.selectedChannelId,
    );
    const rememberedMachine = project?.machines.find((remembered) =>
      machines.some(
        (machine) =>
          machine.sandboxId === remembered.sandboxId && isMachineComputeSelectable(machine.state),
      ),
    );
    const firstSelectable =
      (rememberedMachine
        ? machines.find((machine) => machine.sandboxId === rememberedMachine.sandboxId)
        : null) ??
      machines.find((machine) => isMachineComputeSelectable(machine.state)) ??
      null;
    onChange({
      ...draft,
      compute: {
        kind: "machine",
        sandboxId: firstSelectable?.sandboxId ?? null,
        folder: firstSelectable
          ? rememberedMachineFolder(
              props.selectionHistory,
              props.selectedChannelId,
              firstSelectable.sandboxId,
            )
          : { kind: "root" },
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
            personalResourceAccess={props.personalResourceAccess}
            variableSets={props.variableSets}
            rigs={props.rigs}
            catalogRecovery={props.catalogRecovery}
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
        personalResourceAccess={props.personalResourceAccess}
        variableSets={props.variableSets}
        rigs={props.rigs}
        catalogRecovery={props.catalogRecovery}
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
          personalResourceAccess={props.personalResourceAccess}
          variableSets={props.variableSets}
          rigs={props.rigs}
          catalogRecovery={props.catalogRecovery}
        />
      ) : (
        <ConnectedMachineFields
          draft={draft}
          compute={draft.compute}
          machines={machines}
          onChange={onChange}
          disabled={props.disabled}
          selectedChannelId={props.selectedChannelId}
          selectionHistory={props.selectionHistory}
        />
      )}
      {draft.compute.kind === "machine" ? (
        <PersonalResourceAccessInline
          access={props.personalResourceAccess}
          disabled={props.disabled}
        />
      ) : null}
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
  personalResourceAccess: NewSessionPersonalResourceAccess;
  variableSets: VariableSet[];
  rigs: Rig[];
  catalogRecovery: FixedResourceCatalogRecovery;
}) {
  const { draft, onChange } = props;
  const personalRigs = props.rigs.filter((resource) => resource.scope === "user");
  const personalVariableSets = props.variableSets.filter((resource) => resource.scope === "user");
  const workspaceRigs = props.rigs.filter((resource) => resource.scope !== "user");
  const workspaceVariableSets = props.variableSets.filter((resource) => resource.scope !== "user");
  const showRigs = workspaceRigs.length > 0 || personalRigs.length > 0;
  const hasEnumerableVariableSets =
    workspaceVariableSets.length > 0 || personalVariableSets.length > 0;
  const availableWorkspaceVariableSets = workspaceVariableSets.filter(
    (variableSet) => !draft.variableSetIds.includes(variableSet.id),
  );
  const availablePersonalVariableSets = personalVariableSets.filter(
    (variableSet) => !draft.variableSetIds.includes(variableSet.id),
  );
  const hasVariableSetChoices =
    availableWorkspaceVariableSets.length > 0 || availablePersonalVariableSets.length > 0;
  const showVariableSets = draft.variableSetIds.length > 0 || hasEnumerableVariableSets;
  if (!showRigs && !showVariableSets && !props.catalogRecovery.error) {
    return null;
  }

  return (
    // One flat card: hairline-separated rows, controls right-aligned, no
    // nested boxes and no restating helper text — the controls speak.
    <div className="mt-5 overflow-hidden rounded-lg border border-border bg-surface/40">
      {props.catalogRecovery.error ? (
        <div
          role="alert"
          className={cn((showRigs || showVariableSets) && "border-b border-border/70", "p-2.5")}
        >
          <Notice
            tone="failed"
            className="p-2.5 text-xs"
            title="Couldn’t verify the selected Variable Set or Rig"
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={props.disabled || props.catalogRecovery.refreshing}
                onClick={props.catalogRecovery.onRetry}
              >
                Retry
              </Button>
            }
          >
            Retry to reload your available resources before starting this session.
          </Notice>
        </div>
      ) : null}
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
              onChange({
                ...draft,
                rigId,
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

      {/* Keep restored selections visible even when the caller may attach/use
          exact IDs but cannot enumerate the Variable Set catalog. */}
      {showVariableSets ? (
        <div
          className={cn(
            "flex items-center justify-between gap-3 px-3 py-2",
            showRigs && "border-t border-border/70",
          )}
        >
          <Label className="flex shrink-0 items-center gap-1.5 self-start pt-1.5 text-xs">
            <BoxIcon className="size-3 shrink-0 text-fg-subtle" />
            Variable sets
          </Label>
          <div className="min-w-0 max-w-80 flex-1 space-y-2">
            {draft.variableSetIds.length > 0 ? (
              <SelectedVariableSetList
                selectedIds={draft.variableSetIds}
                variableSets={[...workspaceVariableSets, ...personalVariableSets]}
                disabled={props.disabled}
                onChange={(variableSetIds) => {
                  onChange({
                    ...draft,
                    variableSetIds,
                    variableSetId: variableSetIds.at(-1) ?? "",
                  });
                }}
              />
            ) : (
              <p className="text-right text-xs text-fg-subtle">No Variable Sets selected</p>
            )}
            {hasVariableSetChoices && draft.variableSetIds.length < 25 ? (
              <Select
                value=""
                disabled={props.disabled}
                onChange={(event) => {
                  const variableSetId = event.target.value;
                  if (!variableSetId) return;
                  const next = [...draft.variableSetIds, variableSetId];
                  onChange({ ...draft, variableSetIds: next, variableSetId });
                }}
                className="h-8 w-full text-xs"
              >
                <option value="">Add Variable Set…</option>
                {availableWorkspaceVariableSets.map((variableSet) => (
                  <option key={variableSet.id} value={variableSet.id}>
                    {variableSet.name} ({variableSet.variables.length} vars)
                  </option>
                ))}
                {availablePersonalVariableSets.length > 0 ? (
                  <optgroup label="Only me">
                    {availablePersonalVariableSets.map((variableSet) => (
                      <option key={variableSet.id} value={variableSet.id}>
                        {variableSet.name} ({variableSet.variables.length} vars)
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            ) : null}
            <p className="text-right text-2xs text-fg-subtle">
              Later sets override earlier sets when names collide.
            </p>
          </div>
        </div>
      ) : null}
      <PersonalResourceAccessInline
        access={props.personalResourceAccess}
        disabled={props.disabled}
        embedded
      />
    </div>
  );
}

function PersonalResourceAccessInline(props: {
  access: NewSessionPersonalResourceAccess;
  disabled: boolean;
  embedded?: boolean;
}) {
  if (props.access.names.length === 0) return null;
  const content =
    props.access.visibility === "workspace" ? (
      <label className="flex cursor-pointer items-start gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={props.access.sharedAcknowledged}
          disabled={props.disabled}
          onChange={(event) => props.access.onSharedAcknowledgedChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <span>
          <span className="block font-medium text-fg">
            Use {props.access.names.join(", ")} in this workspace-visible session
          </span>
          <span className="mt-0.5 block text-2xs leading-4 text-fg-subtle">
            {PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING}
          </span>
        </span>
      </label>
    ) : (
      <p className="text-2xs text-fg-subtle">
        {props.access.names.join(", ")} will be available only to this session.
      </p>
    );
  return props.embedded ? (
    <div className="border-t border-border/70 px-3 py-2.5">{content}</div>
  ) : (
    <div className="px-0.5">{content}</div>
  );
}

// ── Connected Machine kind: machine picker, folder, env note ──────────────────

function ConnectedMachineFields(props: {
  draft: SessionDraft;
  compute: ConnectedMachineTarget;
  machines: MachineView[];
  onChange: (draft: SessionDraft) => void;
  disabled: boolean;
  selectedChannelId: string | null;
  selectionHistory: NewSessionSelectionHistory;
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
          onChange={(event) => {
            const sandboxId = event.target.value || null;
            setCompute({
              ...compute,
              sandboxId,
              folder: sandboxId
                ? rememberedMachineFolder(
                    props.selectionHistory,
                    props.selectedChannelId,
                    sandboxId,
                  )
                : { kind: "root" },
            });
          }}
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
            onSelect={() =>
              setCompute({
                ...compute,
                folder: { kind: "path", path: customPath },
              })
            }
            label="Custom path"
            hint="absolute, or relative to the launch root"
          />
          {compute.folder.kind === "path" ? (
            <Input
              value={customPath}
              disabled={props.disabled}
              onChange={(event) =>
                setCompute({
                  ...compute,
                  folder: { kind: "path", path: event.target.value },
                })
              }
              placeholder="e.g. /home/me/repos/project or packages/runtime"
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
