import { describe, expect, test } from "bun:test";
import {
  AcknowledgeStreamRequest as ContractAcknowledgeStreamRequest,
  AgentTopologyPageResponse as ContractAgentTopologyPageResponse,
  ActivateCodexRealtimeConnectionRequest as ContractActivateCodexRealtimeConnectionRequest,
  AcknowledgeStreamResponse as ContractAcknowledgeStreamResponse,
  PutOrganizationWorkspaceMemberRequest as ContractPutOrganizationWorkspaceMemberRequest,
  AddWorkspaceMemberRequest as ContractAddWorkspaceMemberRequest,
  IntegrationDefinitionSummary as ContractIntegrationDefinitionSummary,
  IntegrationPresentation as ContractIntegrationPresentation,
  AttachViewerRequest as ContractAttachViewerRequest,
  AttachViewerResponse as ContractAttachViewerResponse,
  BeginSessionRealtimeRequest as ContractBeginSessionRealtimeRequest,
  CreateBillingPortalRequest as ContractCreateBillingPortalRequest,
  CreateBillingPortalResponse as ContractCreateBillingPortalResponse,
  CAPABILITY_DESCRIPTORS,
  ClientConfig as ContractClientConfig,
  CodexRealtimeWebrtcRequest as ContractCodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse as ContractCodexRealtimeWebrtcResponse,
  CodexRealtimeVoice as ContractCodexRealtimeVoice,
  EndSessionRealtimeRequest as ContractEndSessionRealtimeRequest,
  WorkspaceModelCatalogResponse as ContractWorkspaceModelCatalogResponse,
  ClientSessionEvent,
  CreateSessionRequest as ContractCreateSessionRequest,
  CreateSessionResponse as ContractCreateSessionResponse,
  CreateKnowledgeMemoryRequest as ContractCreateKnowledgeMemoryRequest,
  KnowledgeMemory as ContractKnowledgeMemory,
  KnowledgeMemoryStatus as ContractKnowledgeMemoryStatus,
  UpdateKnowledgeMemoryRequest as ContractUpdateKnowledgeMemoryRequest,
  UpdateWorkspaceSettingsRequest as ContractUpdateWorkspaceSettingsRequest,
  Workspace as ContractWorkspace,
  WorkspaceTranscriptionPolicy as ContractWorkspaceTranscriptionPolicy,
  WorkspaceMemorySearchRequest as ContractWorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse as ContractWorkspaceMemorySearchResponse,
  DESKTOP_STREAM_PORT,
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT as CONTRACT_DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  ListWorkspaceMembersResponse as ContractListWorkspaceMembersResponse,
  MachineState as ContractMachineState,
  OPENGENI_API_CONTRACT_HEADER as CONTRACT_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION as CONTRACT_API_CONTRACT_REVISION,
  MachineView as ContractMachineView,
  MachinesResponse as ContractMachinesResponse,
  MetricSample as ContractMetricSample,
  MachineMetricsSeriesResponse as ContractMachineMetricsSeriesResponse,
  NewSessionDraft as ContractNewSessionDraft,
  InstallApiIntegrationRequest as ContractInstallApiIntegrationRequest,
  IntegrationFacetMutationResult as ContractIntegrationFacetMutationResult,
  IntegrationFacetRemovalResult as ContractIntegrationFacetRemovalResult,
  IntegrationInstanceFacetsResponse as ContractIntegrationInstanceFacetsResponse,
  MutateIntegrationFacetRequest as ContractMutateIntegrationFacetRequest,
  InstalledApiIntegration as ContractInstalledApiIntegration,
  ApiIntegrationUninstallPreview as ContractApiIntegrationUninstallPreview,
  UninstallApiIntegrationRequest as ContractUninstallApiIntegrationRequest,
  UninstallApiIntegrationResult as ContractUninstallApiIntegrationResult,
  UpsertIntegrationFacetRequest as ContractUpsertIntegrationFacetRequest,
  CapabilityPack as ContractCapabilityPack,
  InstallPackRequest as ContractInstallPackRequest,
  PackInstallation as ContractPackInstallation,
  PackInstallationPreview as ContractPackInstallationPreview,
  PackUninstallPreview as ContractPackUninstallPreview,
  PreviewPackInstallationRequest as ContractPreviewPackInstallationRequest,
  RegisterCapabilityPackRequest as ContractRegisterCapabilityPackRequest,
  UninstallPackRequest as ContractUninstallPackRequest,
  UninstallPackResult as ContractUninstallPackResult,
  WorkspaceRegisteredPack as ContractWorkspaceRegisteredPack,
  InstallPluginRequest as ContractInstallPluginRequest,
  InstalledPlugin as ContractInstalledPlugin,
  ListInstalledPluginsResponse as ContractListInstalledPluginsResponse,
  PluginManifest as ContractPluginManifest,
  PluginPreview as ContractPluginPreview,
  PluginUninstallPreview as ContractPluginUninstallPreview,
  PreviewPluginRequest as ContractPreviewPluginRequest,
  UninstallPluginRequest as ContractUninstallPluginRequest,
  UninstallPluginResult as ContractUninstallPluginResult,
  SaveNewSessionDraftRequest as ContractSaveNewSessionDraftRequest,
  SubmitComposerDraftRequest as ContractSubmitComposerDraftRequest,
  SlackUserLinkAccessRequest as ContractSlackUserLinkAccessRequest,
  PrepareSlackUserLinkAccessRequest as ContractPrepareSlackUserLinkAccessRequest,
  SlackUserLinkAccessMutationRequest as ContractSlackUserLinkAccessMutationRequest,
  ApproveSlackUserLinkAccessRequest as ContractApproveSlackUserLinkAccessRequest,
  ListSlackUserLinkAccessRequestsResponse as ContractListSlackUserLinkAccessRequestsResponse,
  OPENGENI_CORRELATION_HEADER as CONTRACT_CORRELATION_HEADER,
  SandboxBackend as ContractSandboxBackend,
  SandboxOs as ContractSandboxOs,
  Session as ContractSessionSchema,
  ForkSessionRequest as ContractForkSessionRequest,
  ForkSessionResponse as ContractForkSessionResponse,
  UpdateSessionVisibilityRequest as ContractUpdateSessionVisibilityRequest,
  UpdateSessionVisibilityResponse as ContractUpdateSessionVisibilityResponse,
  IssueUserResourceGrantRequest as ContractIssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesResponse as ContractListUserResourceAuthoritiesResponse,
  SessionCapabilities as ContractSessionCapabilities,
  SessionEvent as ContractSessionEventSchema,
  SessionMcpServerInput as ContractSessionMcpServerInput,
  SessionMcpServerMetadata as ContractSessionMcpServerMetadata,
  UpdateSessionMcpApprovalPolicyRequest as ContractUpdateSessionMcpApprovalPolicyRequest,
  UpdateSessionMcpApprovalPolicyResponse as ContractUpdateSessionMcpApprovalPolicyResponse,
  SessionEventType as ContractSessionEventType,
  TranscriptionEvent as ContractTranscriptionEvent,
  SessionHumanInputRequest as ContractSessionHumanInputRequest,
  SessionRealtimeMode as ContractSessionRealtimeMode,
  SessionRealtimeMutationResponse as ContractSessionRealtimeMutationResponse,
  SyncSessionRealtimeLedgerRequest as ContractSyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse as ContractSyncSessionRealtimeLedgerResponse,
  RenewSessionRealtimeRequest as ContractRenewSessionRealtimeRequest,
  SessionStatus as ContractSessionStatus,
  SessionTurn as ContractSessionTurn,
  SubmitHumanInputResponseRequest as ContractSubmitHumanInputResponseRequest,
  StreamUrlRotatedPayload as ContractStreamUrlRotatedPayload,
  ViewerHeartbeatRequest as ContractViewerHeartbeatRequest,
  ViewerHeartbeatResponse as ContractViewerHeartbeatResponse,
  ViewerHolder as ContractViewerHolder,
  ReasoningEffort as ContractReasoningEffort,
  ScheduledTask as ContractScheduledTask,
  ScheduledTaskOverlapPolicy as ContractScheduledTaskOverlapPolicy,
  ScheduledTaskRunMode as ContractScheduledTaskRunMode,
  ScheduledTaskStatus as ContractScheduledTaskStatus,
  Rig as ContractRig,
  RigVersion as ContractRigVersion,
  RigChange as ContractRigChange,
  RigChangeKind as ContractRigChangeKind,
  RigChangeStatus as ContractRigChangeStatus,
  CreateRigRequest as ContractCreateRigRequest,
  UpdateRigRequest as ContractUpdateRigRequest,
  ProposeRigChangeRequest as ContractProposeRigChangeRequest,
  UpdateWorkspaceMemberRequest as ContractUpdateWorkspaceMemberRequest,
  WorkspaceMember as ContractWorkspaceMember,
} from "@opengeni/contracts";
import { SandboxBackend as DeploymentSandboxBackend } from "@opengeni/deployment";
import type { z } from "zod";
import {
  DEFAULT_FILE_RESOURCE_MOUNT_ROOT,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OPENGENI_CORRELATION_HEADER,
  SESSION_EVENT_TYPES,
} from "../src/types";
import type {
  AcknowledgeStreamRequest,
  AgentTopologyPageResponse,
  IntegrationDefinitionSummary,
  IntegrationPresentation,
  ActivateCodexRealtimeConnectionRequest,
  AcknowledgeStreamResponse,
  PutOrganizationWorkspaceMemberRequest,
  AddWorkspaceMemberRequest,
  AttachViewerRequest,
  AttachViewerResponse,
  BeginSessionRealtimeRequest,
  CreateBillingPortalRequest,
  CreateBillingPortalResponse,
  CreateKnowledgeMemoryRequest,
  FirstPartyMcpToolName,
  KnowledgeMemory,
  KnowledgeMemoryStatus,
  UpdateKnowledgeMemoryRequest,
  UpdateWorkspaceSettingsRequest,
  Workspace,
  WorkspaceMemorySearchResponse,
  ClientConfig,
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
  CodexRealtimeVoice,
  EndSessionRealtimeRequest,
  WorkspaceModelCatalogResponse,
  ClientSessionEventInput,
  CreateSessionRequest,
  CreateSessionResponse,
  ListWorkspaceMembersResponse,
  MachineState,
  MachineView,
  MachinesResponse,
  MetricSample,
  MachineMetricsSeriesResponse,
  NewSessionDraft,
  NewSessionDraftOptions,
  InstallApiIntegrationRequest,
  IntegrationFacetMutationResult,
  IntegrationFacetRemovalResult,
  IntegrationInstanceFacetsResponse,
  MutateIntegrationFacetRequest,
  InstalledApiIntegration,
  ApiIntegrationUninstallPreview,
  UninstallApiIntegrationRequest,
  UninstallApiIntegrationResult,
  UpsertIntegrationFacetRequest,
  CapabilityPack,
  InstallPackRequest,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
  PreviewPackInstallationRequest,
  RegisterCapabilityPackRequest,
  UninstallPackRequest,
  UninstallPackResult,
  WorkspaceRegisteredPack,
  InstallPluginRequest,
  InstalledPlugin,
  ListInstalledPluginsResponse,
  PluginManifest,
  PluginPreview,
  PluginUninstallPreview,
  PreviewPluginRequest,
  ReasoningEffort,
  SaveNewSessionDraftRequest,
  SubmitComposerDraftRequest,
  SlackUserLinkAccessRequest,
  PrepareSlackUserLinkAccessRequest,
  SlackUserLinkAccessMutationRequest,
  ApproveSlackUserLinkAccessRequest,
  ListSlackUserLinkAccessRequestsResponse,
  SandboxBackend,
  SandboxOs,
  ScheduledTask,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRunMode,
  ScheduledTaskStatus,
  Rig,
  RigVersion,
  RigChange,
  RigChangeKind,
  RigChangeStatus,
  CreateRigRequest,
  UpdateRigRequest,
  ProposeRigChangeRequest,
  Session,
  ForkSessionRequest,
  ForkSessionResponse,
  UpdateSessionVisibilityRequest,
  UpdateSessionVisibilityResponse,
  IssueUserResourceGrantRequest,
  ListUserResourceAuthoritiesResponse,
  SessionCapabilities,
  SessionEvent,
  SessionHumanInputRequest,
  SessionMcpServerInput,
  SessionMcpServerMetadata,
  SessionRealtimeMode,
  SessionRealtimeMutationResponse,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
  RenewSessionRealtimeRequest,
  SessionStatus,
  SessionTurn,
  SessionTurnSource,
  SessionTurnStatus,
  SubmitHumanInputResponseRequest,
  UpdateSessionMcpApprovalPolicyRequest,
  UpdateSessionMcpApprovalPolicyResponse,
  UninstallPluginRequest,
  UninstallPluginResult,
  StreamUrlRotatedPayload,
  UpdateWorkspaceMemberRequest,
  ViewerHeartbeatRequest,
  ViewerHeartbeatResponse,
  ViewerHolder,
  WorkspaceMember,
} from "../src/types";
import type { TranscriptionEvent, WorkspaceTranscriptionPolicy } from "../src/transcription";

// The SDK ships hand-written general wire types so ordinary entries do not
// import the contracts runtime. This suite pins them to `@opengeni/contracts`:
// if the public contracts move, these checks fail the gate.

describe("SDK / contracts parity", () => {
  test("Stripe billing portal shapes stay in parity", () => {
    const sdkRequestAcceptsContract = (
      value: z.infer<typeof ContractCreateBillingPortalRequest>,
    ): CreateBillingPortalRequest => value;
    const contractRequestAcceptsSdk = (
      value: CreateBillingPortalRequest,
    ): z.input<typeof ContractCreateBillingPortalRequest> => value;
    const sdkResponseAcceptsContract = (
      value: z.infer<typeof ContractCreateBillingPortalResponse>,
    ): CreateBillingPortalResponse => value;
    const contractResponseAcceptsSdk = (
      value: CreateBillingPortalResponse,
    ): z.input<typeof ContractCreateBillingPortalResponse> => value;
    expect(
      [
        sdkRequestAcceptsContract,
        contractRequestAcceptsSdk,
        sdkResponseAcceptsContract,
        contractResponseAcceptsSdk,
      ].every((fn) => typeof fn === "function"),
    ).toBe(true);
  });

  test("personal-resource management request and page shapes stay in parity", () => {
    const request = (
      value: IssueUserResourceGrantRequest,
    ): z.input<typeof ContractIssueUserResourceGrantRequest> => value;
    const pageFromSdk = (
      value: ListUserResourceAuthoritiesResponse,
    ): z.input<typeof ContractListUserResourceAuthoritiesResponse> => value;
    const pageFromContract = (
      value: z.infer<typeof ContractListUserResourceAuthoritiesResponse>,
    ): ListUserResourceAuthoritiesResponse => value;
    expect([request, pageFromSdk, pageFromContract].every((fn) => typeof fn === "function")).toBe(
      true,
    );
  });

  test("session visibility and explicit fork request/response shapes stay in parity", () => {
    const visibilityRequest = (
      value: UpdateSessionVisibilityRequest,
    ): z.input<typeof ContractUpdateSessionVisibilityRequest> => value;
    const visibilityResponse = (
      value: z.infer<typeof ContractUpdateSessionVisibilityResponse>,
    ): UpdateSessionVisibilityResponse => value;
    const forkRequest = (value: ForkSessionRequest): z.input<typeof ContractForkSessionRequest> =>
      value;
    const forkResponse = (
      value: z.infer<typeof ContractForkSessionResponse>,
    ): ForkSessionResponse => value;
    expect(
      [visibilityRequest, visibilityResponse, forkRequest, forkResponse].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);
  });

  test("pins the exact API revision and transport header values", () => {
    expect(OPENGENI_API_CONTRACT_REVISION).toBe(CONTRACT_API_CONTRACT_REVISION);
    expect(OPENGENI_API_CONTRACT_HEADER).toBe(CONTRACT_API_CONTRACT_HEADER);
    expect(OPENGENI_CORRELATION_HEADER).toBe(CONTRACT_CORRELATION_HEADER);
  });
  test("pins the default uploaded-file mount root", () => {
    expect(DEFAULT_FILE_RESOURCE_MOUNT_ROOT).toBe(CONTRACT_DEFAULT_FILE_RESOURCE_MOUNT_ROOT);
  });

  test("Slack user-link access continuation shapes match the public contracts", () => {
    const acceptRequest = (
      value: z.infer<typeof ContractSlackUserLinkAccessRequest>,
    ): SlackUserLinkAccessRequest => value;
    const acceptPrepare = (
      value: PrepareSlackUserLinkAccessRequest,
    ): z.input<typeof ContractPrepareSlackUserLinkAccessRequest> => value;
    const acceptMutation = (
      value: SlackUserLinkAccessMutationRequest,
    ): z.input<typeof ContractSlackUserLinkAccessMutationRequest> => value;
    const acceptApproval = (
      value: Omit<ApproveSlackUserLinkAccessRequest, "permissions">,
    ): Omit<z.input<typeof ContractApproveSlackUserLinkAccessRequest>, "permissions"> => value;
    const acceptList = (
      value: z.infer<typeof ContractListSlackUserLinkAccessRequestsResponse>,
    ): ListSlackUserLinkAccessRequestsResponse => value;
    expect(
      [acceptRequest, acceptPrepare, acceptMutation, acceptApproval, acceptList].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);
  });
  test("integration definition and presentation shapes match the public contracts", () => {
    const acceptDefinition = (
      value: z.infer<typeof ContractIntegrationDefinitionSummary>,
    ): IntegrationDefinitionSummary => value;
    const acceptDefinitionInput = (
      value: IntegrationDefinitionSummary,
    ): z.input<typeof ContractIntegrationDefinitionSummary> => value;
    const acceptPresentation = (
      value: z.infer<typeof ContractIntegrationPresentation>,
    ): IntegrationPresentation => value;
    const acceptPresentationInput = (
      value: IntegrationPresentation,
    ): z.input<typeof ContractIntegrationPresentation> => value;
    expect(
      [acceptDefinition, acceptDefinitionInput, acceptPresentation, acceptPresentationInput].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);
  });
  test("known session event types match the contracts enum exactly", () => {
    expect([...SESSION_EVENT_TYPES].sort()).toEqual([...ContractSessionEventType.options].sort());
  });

  test("session status, sandbox backend, and reasoning effort literals match", () => {
    const statuses: readonly SessionStatus[] = ContractSessionStatus.options;
    const backends: readonly SandboxBackend[] = ContractSandboxBackend.options;
    const efforts: readonly ReasoningEffort[] = ContractReasoningEffort.options;
    expect(statuses).toEqual(ContractSessionStatus.options);
    expect(backends).toEqual(ContractSandboxBackend.options);
    expect(efforts).toEqual(ContractReasoningEffort.options);
  });

  test("first-party MCP tool-name union matches the contracts enum", () => {
    type ContractFirstPartyMcpToolName = z.infer<
      typeof import("@opengeni/contracts").FirstPartyMcpToolName
    >;
    const sdkAcceptsContract = (value: ContractFirstPartyMcpToolName): FirstPartyMcpToolName =>
      value;
    const contractAcceptsSdk = (value: FirstPartyMcpToolName): ContractFirstPartyMcpToolName =>
      value;
    expect([sdkAcceptsContract, contractAcceptsSdk].every((fn) => typeof fn === "function")).toBe(
      true,
    );
  });

  test("Codex realtime V3 wire shapes and voices match", () => {
    const voices: readonly CodexRealtimeVoice[] = ContractCodexRealtimeVoice.options;
    expect(voices).toEqual(ContractCodexRealtimeVoice.options);
    const acceptResponse = (
      value: z.infer<typeof ContractCodexRealtimeWebrtcResponse>,
    ): CodexRealtimeWebrtcResponse => value;
    const acceptRequest = (
      value: CodexRealtimeWebrtcRequest,
    ): z.input<typeof ContractCodexRealtimeWebrtcRequest> => value;
    const acceptActivation = (
      value: ActivateCodexRealtimeConnectionRequest,
    ): z.input<typeof ContractActivateCodexRealtimeConnectionRequest> => value;
    const acceptBegin = (
      value: BeginSessionRealtimeRequest,
    ): z.input<typeof ContractBeginSessionRealtimeRequest> => value;
    const acceptRenew = (
      value: RenewSessionRealtimeRequest,
    ): z.input<typeof ContractRenewSessionRealtimeRequest> => value;
    const acceptEnd = (
      value: EndSessionRealtimeRequest,
    ): z.input<typeof ContractEndSessionRealtimeRequest> => value;
    const acceptMode = (value: z.infer<typeof ContractSessionRealtimeMode>): SessionRealtimeMode =>
      value;
    const acceptMutation = (
      value: z.infer<typeof ContractSessionRealtimeMutationResponse>,
    ): SessionRealtimeMutationResponse => value;
    const acceptSyncRequest = (
      value: SyncSessionRealtimeLedgerRequest,
    ): z.input<typeof ContractSyncSessionRealtimeLedgerRequest> => value;
    const acceptSyncResponse = (
      value: z.infer<typeof ContractSyncSessionRealtimeLedgerResponse>,
    ): SyncSessionRealtimeLedgerResponse => value;
    expect(
      [
        acceptResponse,
        acceptRequest,
        acceptActivation,
        acceptBegin,
        acceptRenew,
        acceptEnd,
        acceptMode,
        acceptMutation,
        acceptSyncRequest,
        acceptSyncResponse,
      ].every((fn) => typeof fn === "function"),
    ).toBe(true);
  });

  test("sandbox backend enum is 3-way parity across contracts / sdk / deployment", () => {
    // The SDK ships a hand-written `SandboxBackend` type (no runtime array), so
    // we pin a runtime literal list to that type: TS rejects this assignment if
    // any value drifts from the SDK type, and the sorted-equality below pins it
    // to the two runtime Zod enums. All three sources must agree.
    const sdkBackends: readonly SandboxBackend[] = [
      "docker",
      "modal",
      "local",
      "none",
      "daytona",
      "runloop",
      "e2b",
      "blaxel",
      "cloudflare",
      "vercel",
      "selfhosted",
      "opensandbox",
    ];
    const contracts = [...ContractSandboxBackend.options].sort();
    const deployment = [...DeploymentSandboxBackend.options].sort();
    const sdk = [...sdkBackends].sort();
    expect(contracts).toEqual(deployment);
    expect(contracts).toEqual(sdk);
    expect(contracts).toHaveLength(12);
  });

  test("contract-parsed payloads are assignable to SDK types (compile-time)", () => {
    // Server -> client shapes: anything the contracts produce, the SDK accepts.
    const acceptSession = (value: z.infer<typeof ContractSessionSchema>): Session => value;
    const acceptAgentTopologyPage = (
      value: z.infer<typeof ContractAgentTopologyPageResponse>,
    ): AgentTopologyPageResponse => value;
    const acceptCreateResponse = (
      value: z.infer<typeof ContractCreateSessionResponse>,
    ): CreateSessionResponse => value;
    const acceptEvent = (value: z.infer<typeof ContractSessionEventSchema>): SessionEvent => value;
    const acceptHumanInputRequest = (
      value: z.infer<typeof ContractSessionHumanInputRequest>,
    ): SessionHumanInputRequest => value;
    const acceptTurn = (value: z.infer<typeof ContractSessionTurn>): SessionTurn => value;
    const acceptTurnStatus = (
      value: z.infer<typeof ContractSessionTurn>["status"],
    ): SessionTurnStatus => value;
    const acceptTurnSource = (
      value: z.infer<typeof ContractSessionTurn>["source"],
    ): SessionTurnSource => value;
    // Client -> server shapes: anything the SDK sends, the contracts accept.
    // firstPartyMcpPermissions is deliberately `string[]` in the SDK (forward
    // compatible with new server-side permissions), so it is checked at
    // runtime by the server rather than at compile time here.
    const acceptCreateRequest = (
      value: Omit<CreateSessionRequest, "firstPartyMcpPermissions">,
    ): z.input<typeof ContractCreateSessionRequest> => value;
    const acceptClientEvent = (
      value: ClientSessionEventInput,
    ): z.input<typeof ClientSessionEvent> => value;
    const acceptHumanInputResponse = (
      value: SubmitHumanInputResponseRequest,
    ): z.input<typeof ContractSubmitHumanInputResponseRequest> => value;
    const acceptMcpServer = (
      value: z.infer<typeof ContractSessionMcpServerInput>,
    ): SessionMcpServerInput => value;
    const acceptMcpMetadata = (
      value: z.infer<typeof ContractSessionMcpServerMetadata>,
    ): SessionMcpServerMetadata => value;
    const acceptMcpPolicyResponse = (
      value: z.infer<typeof ContractUpdateSessionMcpApprovalPolicyResponse>,
    ): UpdateSessionMcpApprovalPolicyResponse => value;
    const acceptMcpPolicyRequest = (
      value: UpdateSessionMcpApprovalPolicyRequest,
    ): z.input<typeof ContractUpdateSessionMcpApprovalPolicyRequest> => value;
    const sdkMcpServer: SessionMcpServerInput = {
      id: "host_tools",
      url: "https://example.com/mcp",
      requireApproval: ["write_record"],
    };
    const checks = [
      acceptSession,
      acceptAgentTopologyPage,
      acceptCreateResponse,
      acceptEvent,
      acceptHumanInputRequest,
      acceptTurn,
      acceptTurnStatus,
      acceptTurnSource,
      acceptCreateRequest,
      acceptClientEvent,
      acceptHumanInputResponse,
      acceptMcpServer,
      acceptMcpMetadata,
      acceptMcpPolicyResponse,
      acceptMcpPolicyRequest,
    ];
    expect(checks.every((fn) => typeof fn === "function")).toBe(true);
    expect(ContractSessionMcpServerInput.parse(sdkMcpServer)).toEqual(sdkMcpServer);
  });

  test("new-session draft response and save shapes stay in SDK/contracts parity", () => {
    const acceptDraft = (value: z.infer<typeof ContractNewSessionDraft>): NewSessionDraft => value;
    // Like CreateSessionRequest, the dependency-free SDK deliberately accepts
    // forward-compatible permission strings and leaves their runtime check to
    // the server contract.
    const acceptSave = (
      value: Omit<SaveNewSessionDraftRequest, "options"> & {
        options: Omit<NewSessionDraftOptions, "firstPartyMcpPermissions">;
      },
    ): z.input<typeof ContractSaveNewSessionDraftRequest> => value;
    expect([acceptDraft, acceptSave].every((fn) => typeof fn === "function")).toBe(true);

    const save: SaveNewSessionDraftRequest = {
      expectedRevision: 4,
      text: "recover this",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      latencyMode: "standard",
      options: {
        sandboxBackend: "modal",
        goal: { text: "finish", maxAutoContinuations: 8 },
        firstPartyMcpPermissions: ["workspace:read", "sessions:read"],
      },
    };
    expect(ContractSaveNewSessionDraftRequest.safeParse(save).success).toBe(true);
  });

  test("established-session submit requires one exact policy snapshot", () => {
    const submit: SubmitComposerDraftRequest = {
      expectedDraftRevision: 4,
      clientEventId: "submit-draft-4",
      delivery: "steer",
      text: "freeze this",
      annotations: [],
      resources: [],
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      latencyMode: "priority",
      connectionAuthorities: [],
    };
    expect(ContractSubmitComposerDraftRequest.safeParse(submit).success).toBe(true);
    const { latencyMode: _latencyMode, ...missingLatency } = submit;
    expect(ContractSubmitComposerDraftRequest.safeParse(missingLatency).success).toBe(false);
  });

  test("scheduled task literals and shapes match the contracts", () => {
    const statuses: readonly ScheduledTaskStatus[] = ContractScheduledTaskStatus.options;
    const runModes: readonly ScheduledTaskRunMode[] = ContractScheduledTaskRunMode.options;
    const overlapPolicies: readonly ScheduledTaskOverlapPolicy[] =
      ContractScheduledTaskOverlapPolicy.options;
    expect(statuses).toEqual(ContractScheduledTaskStatus.options);
    expect(runModes).toEqual(ContractScheduledTaskRunMode.options);
    expect(overlapPolicies).toEqual(ContractScheduledTaskOverlapPolicy.options);
    // Server -> client: anything the contract produces, the SDK type accepts.
    const acceptScheduledTask = (value: z.infer<typeof ContractScheduledTask>): ScheduledTask =>
      value;
    expect(typeof acceptScheduledTask).toBe("function");
  });

  test("rig literals and shapes match the contracts (compile-time + runtime, M2)", () => {
    const kinds: readonly RigChangeKind[] = ContractRigChangeKind.options;
    const statuses: readonly RigChangeStatus[] = ContractRigChangeStatus.options;
    expect([...kinds].sort()).toEqual([...ContractRigChangeKind.options].sort());
    expect([...statuses].sort()).toEqual([...ContractRigChangeStatus.options].sort());

    // Server -> client: contract-produced shapes are assignable to the SDK mirrors.
    const acceptRig = (value: z.infer<typeof ContractRig>): Rig => value;
    const acceptVersion = (value: z.infer<typeof ContractRigVersion>): RigVersion => value;
    const acceptChange = (value: z.infer<typeof ContractRigChange>): RigChange => value;
    expect([acceptRig, acceptVersion, acceptChange].every((fn) => typeof fn === "function")).toBe(
      true,
    );

    // Client -> server: SDK-sent bodies parse under the contract schemas.
    const create: CreateRigRequest = {
      name: "dev-machine",
      description: "cloudgeni-dev stress rig",
      image: "ubuntu:24.04",
      setupScript: "apt-get install -y ripgrep",
      checks: [{ name: "rg", command: "rg --version" }],
      credentialHooks: ["azure-cli-login"],
      defaultVariableSetIds: [],
    };
    const update: UpdateRigRequest = {
      name: "dev-machine-2",
      description: null,
    };
    const append: ProposeRigChangeRequest = {
      kind: "setup_append",
      payload: { command: "apt-get install -y jq", note: "needed jq" },
    };
    const edit: ProposeRigChangeRequest = {
      kind: "definition_edit",
      payload: { image: "ubuntu:24.10", changelog: "bump base" },
    };
    expect(ContractCreateRigRequest.safeParse(create).success).toBe(true);
    expect(ContractUpdateRigRequest.safeParse(update).success).toBe(true);
    expect(ContractProposeRigChangeRequest.safeParse(append).success).toBe(true);
    expect(ContractProposeRigChangeRequest.safeParse(edit).success).toBe(true);
    // Bad check shape and unknown change kind are rejected.
    expect(ContractCreateRigRequest.safeParse({ name: "x", checks: [{ name: "" }] }).success).toBe(
      false,
    );
    expect(ContractProposeRigChangeRequest.safeParse({ kind: "nope", payload: {} }).success).toBe(
      false,
    );
    // setup_append requires a command.
    expect(
      ContractProposeRigChangeRequest.safeParse({
        kind: "setup_append",
        payload: {},
      }).success,
    ).toBe(false);
    // Defaults: checks/hooks/ids default to [].
    expect(ContractCreateRigRequest.parse({ name: "bare" }).checks).toEqual([]);
  });

  test("SDK-built control events parse under the contracts schema", () => {
    const message: ClientSessionEventInput = {
      type: "user.message",
      clientEventId: "ce-1",
      payload: {
        text: "hello",
        controlEtag: "control-1",
        expectedDraftRevision: 3,
        connectionAuthorities: [],
      },
    };
    const approval: ClientSessionEventInput = {
      type: "user.approvalDecision",
      payload: { approvalId: "ap-1", decision: "approve" },
    };
    const humanInput: ClientSessionEventInput = {
      type: "user.humanInputResponse",
      clientEventId: "ce-2",
      payload: {
        requestId: "00000000-0000-4000-8000-000000000001",
        response: {
          outcome: "answered",
          answers: [{ questionId: "choice", values: ["staging"] }],
        },
      },
    };
    for (const event of [message, approval, humanInput]) {
      expect(ClientSessionEvent.safeParse(event).success).toBe(true);
    }
  });

  test("workspace member shapes match the contracts (compile-time + runtime)", () => {
    // Server -> client: anything the contract produces, the SDK type accepts.
    const acceptMember = (value: z.infer<typeof ContractWorkspaceMember>): WorkspaceMember => value;
    const acceptList = (
      value: z.infer<typeof ContractListWorkspaceMembersResponse>,
    ): ListWorkspaceMembersResponse => value;
    // Client -> server: anything the SDK sends, the contracts accept. `permissions`
    // is deliberately the open `Permission[]` in the SDK (forward compatible with
    // new server-side permissions), so like firstPartyMcpPermissions it is checked
    // at runtime by the server (the safeParse calls below) rather than here.
    const acceptAdd = (
      value: Omit<AddWorkspaceMemberRequest, "permissions">,
    ): Omit<z.input<typeof ContractAddWorkspaceMemberRequest>, "permissions"> => value;
    const acceptUpdate = (
      value: Omit<UpdateWorkspaceMemberRequest, "permissions">,
    ): Omit<z.input<typeof ContractUpdateWorkspaceMemberRequest>, "permissions"> => value;
    expect(
      [acceptMember, acceptList, acceptAdd, acceptUpdate].every((fn) => typeof fn === "function"),
    ).toBe(true);

    const acceptOrganizationPut = (
      value: Omit<PutOrganizationWorkspaceMemberRequest, "permissions">,
    ): Omit<z.input<typeof ContractPutOrganizationWorkspaceMemberRequest>, "permissions"> => value;
    expect(typeof acceptOrganizationPut).toBe("function");

    const add: AddWorkspaceMemberRequest = {
      email: "teammate@example.com",
      role: "member",
      permissions: ["sessions:read"],
    };
    const update: UpdateWorkspaceMemberRequest = {
      permissions: ["sessions:read", "members:manage"],
    };
    expect(ContractAddWorkspaceMemberRequest.safeParse(add).success).toBe(true);
    expect(
      ContractPutOrganizationWorkspaceMemberRequest.safeParse({
        role: "member",
        expectedUpdatedAt: null,
        operationId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
    expect(ContractUpdateWorkspaceMemberRequest.safeParse(update).success).toBe(true);
    expect(
      ContractWorkspaceMember.safeParse({
        subjectId: "user:u1",
        subjectLabel: "teammate@example.com",
        role: "member",
        permissions: ["sessions:read"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("workspace memory shapes match the contracts (compile-time + runtime)", () => {
    // Status enum is literal-for-literal identical (curated + memory states).
    const statuses: readonly KnowledgeMemoryStatus[] = ContractKnowledgeMemoryStatus.options;
    expect([...statuses].sort()).toEqual([...ContractKnowledgeMemoryStatus.options].sort());
    expect(ContractKnowledgeMemoryStatus.options).toContain("active");

    // Server -> client: contract-produced shapes are assignable to the SDK mirrors.
    const acceptMemory = (value: z.infer<typeof ContractKnowledgeMemory>): KnowledgeMemory => value;
    const acceptWorkspace = (value: z.infer<typeof ContractWorkspace>): Workspace => value;
    const acceptTranscriptionPolicy = (
      value: z.infer<typeof ContractWorkspaceTranscriptionPolicy>,
    ): WorkspaceTranscriptionPolicy => value;
    const acceptSearchResponse = (
      value: z.infer<typeof ContractWorkspaceMemorySearchResponse>,
    ): WorkspaceMemorySearchResponse => value;
    expect(
      [acceptMemory, acceptWorkspace, acceptTranscriptionPolicy, acceptSearchResponse].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);

    // Client -> server: SDK-sent bodies parse under the contract schemas.
    const create: CreateKnowledgeMemoryRequest = {
      text: "Prefer Terraform.",
      kind: "preference",
      pinned: true,
    };
    const update: UpdateKnowledgeMemoryRequest = {
      pinned: false,
      status: "archived",
    };
    const settings: UpdateWorkspaceSettingsRequest = {
      memoryEnabled: true,
      memoryPromptMode: "retrieval_only",
      sessionDefaults: {
        model: "codex/gpt-5.6-sol",
        reasoningEffort: "high",
      },
    };
    expect(ContractCreateKnowledgeMemoryRequest.safeParse(create).success).toBe(true);
    expect(ContractUpdateKnowledgeMemoryRequest.safeParse(update).success).toBe(true);
    expect(ContractUpdateWorkspaceSettingsRequest.safeParse(settings).success).toBe(true);
    const humanInputPolicy: UpdateWorkspaceSettingsRequest = { agentHumanInputEnabled: false };
    expect(ContractUpdateWorkspaceSettingsRequest.safeParse(humanInputPolicy).success).toBe(true);
    const slackReactionSummon: UpdateWorkspaceSettingsRequest = {
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: ["C123"] },
      },
    };
    expect(ContractUpdateWorkspaceSettingsRequest.safeParse(slackReactionSummon).success).toBe(
      true,
    );
    const slackOrchestrationNotices: UpdateWorkspaceSettingsRequest = {
      slackOrchestrationNotices: { childRequiresAction: true, goalPaused: true },
    };
    expect(
      ContractUpdateWorkspaceSettingsRequest.safeParse(slackOrchestrationNotices).success,
    ).toBe(true);
    const transcription: WorkspaceTranscriptionPolicy = {
      enabled: true,
      acceptanceId: "11111111-1111-4111-8111-111111111111",
      primary: {
        provider: "fixture-speech",
        model: "fixture-v1",
        credentialMode: "byok",
        credentialConnectionId: "22222222-2222-4222-8222-222222222222",
        region: "eu-test-1",
      },
      language: "en-US",
      autoDetectLanguage: false,
      diarization: { enabled: false, maxSpeakers: null },
      retention: { mode: "none", maxDays: null },
      privacy: { allowProviderLogging: false, allowProviderTraining: false },
      fallback: { mode: "disabled", targets: [] },
      cost: { currency: "USD", maxPerHour: 1, maxPerMonth: 10 },
    };
    expect(ContractUpdateWorkspaceSettingsRequest.safeParse({ transcription }).success).toBe(true);
    expect(
      ContractUpdateWorkspaceSettingsRequest.safeParse({ voiceInput: { enabled: true } }).success,
    ).toBe(true);
    const transcriptEvent: TranscriptionEvent = {
      type: "transcript.final",
      localSessionId: "local-session-1",
      sequence: 3,
      occurredAt: "2026-07-21T12:00:00.000Z",
      segmentId: "segment-1",
      text: "hello world",
      providerAcceptanceId: "acceptance-1",
      metadata: {
        detectedLanguage: "en-US",
        span: { startMilliseconds: 0, endMilliseconds: 800 },
        confidence: 0.97,
        speaker: { id: "speaker-1" },
        words: [
          {
            text: "hello",
            span: { startMilliseconds: 0, endMilliseconds: 350 },
            confidence: 0.99,
          },
        ],
      },
    };
    expect(ContractTranscriptionEvent.safeParse(transcriptEvent).success).toBe(true);
    const contractToSdk = (value: z.infer<typeof ContractTranscriptionEvent>): TranscriptionEvent =>
      value;
    expect(contractToSdk(ContractTranscriptionEvent.parse(transcriptEvent))).toEqual(
      transcriptEvent,
    );
    // Default create status is `active` (memory lane through the write gate).
    expect(ContractCreateKnowledgeMemoryRequest.parse({ text: "x" }).status).toBe("active");
    // Search request requires a query and clamps limit at 20.
    expect(
      ContractWorkspaceMemorySearchRequest.safeParse({
        query: "how do we deploy",
      }).success,
    ).toBe(true);
    expect(ContractWorkspaceMemorySearchRequest.safeParse({ query: "x", limit: 999 }).success).toBe(
      false,
    );
    // Unknown settings keys survive validation (passthrough / forward-compat).
    expect(ContractUpdateWorkspaceSettingsRequest.parse({ futureFlag: 1 })).toHaveProperty(
      "futureFlag",
      1,
    );
  });

  test("machines + metrics shapes match the contracts (compile-time + runtime, M10)", () => {
    // State enum is literal-for-literal identical.
    const states: readonly MachineState[] = ContractMachineState.options;
    expect(states).toEqual(ContractMachineState.options);
    // Server -> client: anything the contracts produce, the SDK type accepts.
    const acceptSample = (value: z.infer<typeof ContractMetricSample>): MetricSample => value;
    const acceptMachine = (value: z.infer<typeof ContractMachineView>): MachineView => value;
    const acceptList = (value: z.infer<typeof ContractMachinesResponse>): MachinesResponse => value;
    const acceptSeries = (
      value: z.infer<typeof ContractMachineMetricsSeriesResponse>,
    ): MachineMetricsSeriesResponse => value;
    expect(
      [acceptSample, acceptMachine, acceptList, acceptSeries].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);

    // A representative MachinesResponse round-trips through the contract schema.
    const sample = {
      cpuPct: 12.5,
      load1: 0.4,
      load5: 0.3,
      load15: 0.2,
      memUsedBytes: 1_000,
      memTotalBytes: 2_000,
      diskUsedBytes: 3_000,
      diskTotalBytes: 4_000,
      gpuUtilPct: null,
      gpuMemBytes: null,
      runQueue: 1,
      sampledAt: "2026-06-26T00:00:00.000Z",
    };
    const response = {
      activeSandboxId: null,
      activeEpoch: 0,
      machines: [
        {
          sandboxId: "sb-1",
          enrollmentId: "en-1",
          name: "build-box",
          kind: "selfhosted",
          state: "consent_required",
          active: false,
          isSessionGroup: false,
          workspaceGeneration: 7,
          archiveGeneration: 7,
          archiveComplete: true,
          os: "linux",
          arch: "x86_64",
          hasDisplay: true,
          allowScreenControl: false,
          sharedSessionCount: 2,
          lastSeenAt: "2026-06-26T00:00:00.000Z",
          connectionAuthority: {
            state: "active",
            generation: 2,
            supersededCount: 1,
            leaseExpiresAt: "2026-06-26T00:01:00.000Z",
            duplicateRunnerDeniedCount: 1,
            duplicateRunnerDeniedAt: "2026-06-26T00:00:30.000Z",
          },
          metrics: sample,
        },
      ],
    };
    expect(ContractMachinesResponse.safeParse(response).success).toBe(true);
    expect(ContractMachineMetricsSeriesResponse.safeParse({ samples: [sample] }).success).toBe(
      true,
    );
    // The SDK view-model accepts the parsed value (server -> client direction).
    const parsed = ContractMachinesResponse.parse(response);
    const asSdk: MachinesResponse = parsed;
    expect(asSdk.machines[0]!.kind).toBe("selfhosted");
  });

  test("Plugin package request and response shapes match the contracts", () => {
    const acceptManifest = (value: z.infer<typeof ContractPluginManifest>): PluginManifest => value;
    const acceptPreview = (value: z.infer<typeof ContractPluginPreview>): PluginPreview => value;
    const acceptInstalled = (value: z.infer<typeof ContractInstalledPlugin>): InstalledPlugin =>
      value;
    const acceptList = (
      value: z.infer<typeof ContractListInstalledPluginsResponse>,
    ): ListInstalledPluginsResponse => value;
    const acceptUninstallPreview = (
      value: z.infer<typeof ContractPluginUninstallPreview>,
    ): PluginUninstallPreview => value;
    const acceptUninstallResult = (
      value: z.infer<typeof ContractUninstallPluginResult>,
    ): UninstallPluginResult => value;
    expect(
      [
        acceptManifest,
        acceptPreview,
        acceptInstalled,
        acceptList,
        acceptUninstallPreview,
        acceptUninstallResult,
      ].every((fn) => typeof fn === "function"),
    ).toBe(true);

    const previewRequest: PreviewPluginRequest = {
      url: "https://plugins.example.test/research.json",
    };
    const installRequest: InstallPluginRequest = {
      url: previewRequest.url,
      expectedManifestDigest: "a".repeat(64),
      expectedComponents: [{ key: "research", digest: "b".repeat(64) }],
      idempotencyKey: "00000000-0000-4000-8000-000000000100",
    };
    const uninstallRequest: UninstallPluginRequest = {
      expectedInstallationVersion: 2,
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
    };
    expect(ContractPreviewPluginRequest.safeParse(previewRequest).success).toBe(true);
    expect(ContractInstallPluginRequest.safeParse(installRequest).success).toBe(true);
    expect(ContractUninstallPluginRequest.safeParse(uninstallRequest).success).toBe(true);
  });

  test("Pack composition request and response shapes match the contracts", () => {
    const acceptManifest = (value: z.infer<typeof ContractCapabilityPack>): CapabilityPack => value;
    const acceptRegistered = (
      value: z.infer<typeof ContractWorkspaceRegisteredPack>,
    ): WorkspaceRegisteredPack => value;
    const acceptInstallation = (
      value: z.infer<typeof ContractPackInstallation>,
    ): PackInstallation => value;
    const acceptPreview = (
      value: z.infer<typeof ContractPackInstallationPreview>,
    ): PackInstallationPreview => value;
    const acceptUninstallPreview = (
      value: z.infer<typeof ContractPackUninstallPreview>,
    ): PackUninstallPreview => value;
    const acceptUninstallResult = (
      value: z.infer<typeof ContractUninstallPackResult>,
    ): UninstallPackResult => value;
    expect(
      [
        acceptManifest,
        acceptRegistered,
        acceptInstallation,
        acceptPreview,
        acceptUninstallPreview,
        acceptUninstallResult,
      ].every((fn) => typeof fn === "function"),
    ).toBe(true);

    const manifest: RegisterCapabilityPackRequest = {
      id: "infrastructure/safe-operations",
      name: "Safe infrastructure operations",
      description: "Pinned infrastructure capabilities and runtime requirements.",
      role: "infrastructure",
      category: "operations",
      version: "2.0.0",
      components: [
        {
          key: "skill/safe-operations",
          kind: "skill",
          capabilityId: "skill:portable/safe-operations",
          contentSha256: "a".repeat(64),
        },
        {
          key: "integration/linear/main",
          kind: "integration",
          capabilityId: "integration:linear",
          instanceKey: "main",
          revisionId: "openapi:linear-v1",
          contentSha256: "b".repeat(64),
        },
      ],
      rig: {
        required: true,
        requireVerified: true,
      },
    };
    const previewRequest: PreviewPackInstallationRequest = {
      rigId: "00000000-0000-4000-8000-000000000300",
      variableSetId: "00000000-0000-4000-8000-000000000301",
    };
    const installRequest: InstallPackRequest = {
      expectedManifestDigest: "c".repeat(64),
      expectedInstallationVersion: 3,
      rigId: previewRequest.rigId,
      variableSetId: previewRequest.variableSetId,
      idempotencyKey: "00000000-0000-4000-8000-000000000302",
      metadata: { source: "capabilities-ui" },
    };
    const uninstallRequest: UninstallPackRequest = {
      expectedInstallationVersion: 4,
      idempotencyKey: "00000000-0000-4000-8000-000000000303",
    };
    expect(ContractRegisterCapabilityPackRequest.safeParse(manifest).success).toBe(true);
    expect(ContractPreviewPackInstallationRequest.safeParse(previewRequest).success).toBe(true);
    expect(ContractInstallPackRequest.safeParse(installRequest).success).toBe(true);
    expect(ContractUninstallPackRequest.safeParse(uninstallRequest).success).toBe(true);
  });

  test("multi-instance API Integration shapes match the contracts", () => {
    const acceptInstalled = (
      value: z.infer<typeof ContractInstalledApiIntegration>,
    ): InstalledApiIntegration => value;
    const acceptUninstallPreview = (
      value: z.infer<typeof ContractApiIntegrationUninstallPreview>,
    ): ApiIntegrationUninstallPreview => value;
    const acceptUninstallResult = (
      value: z.infer<typeof ContractUninstallApiIntegrationResult>,
    ): UninstallApiIntegrationResult => value;
    expect(
      [acceptInstalled, acceptUninstallPreview, acceptUninstallResult].every(
        (fn) => typeof fn === "function",
      ),
    ).toBe(true);

    const installRequest: InstallApiIntegrationRequest = {
      source: { kind: "definition", definitionId: "google-gmail" },
      expectedRevisionId: "openapi:aaaaaaaaaaaaaaaaaaaaaaaa",
      expectedContentSha256: "b".repeat(64),
      connectionId: "00000000-0000-4000-8000-000000000200",
      instanceKey: "finance",
      displayName: "Gmail — Finance",
      expectedInstanceVersion: 2,
    };
    const uninstallRequest: UninstallApiIntegrationRequest = {
      expectedInstallationVersion: 4,
      expectedInstanceVersion: 2,
    };
    expect(ContractInstallApiIntegrationRequest.safeParse(installRequest).success).toBe(true);
    expect(ContractUninstallApiIntegrationRequest.safeParse(uninstallRequest).success).toBe(true);
  });

  test("generic Integration facet lifecycle shapes match the contracts", () => {
    const acceptList = (
      value: z.infer<typeof ContractIntegrationInstanceFacetsResponse>,
    ): IntegrationInstanceFacetsResponse => value;
    const acceptMutation = (
      value: z.infer<typeof ContractIntegrationFacetMutationResult>,
    ): IntegrationFacetMutationResult => value;
    const acceptRemoval = (
      value: z.infer<typeof ContractIntegrationFacetRemovalResult>,
    ): IntegrationFacetRemovalResult => value;
    expect(
      [acceptList, acceptMutation, acceptRemoval].every((fn) => typeof fn === "function"),
    ).toBe(true);

    const upsert: UpsertIntegrationFacetRequest = {
      displayName: "Finance inbox",
      config: { unreadOnly: true },
      expectedVersion: 2,
      idempotencyKey: "00000000-0000-4000-8000-000000000301",
    };
    const mutation: MutateIntegrationFacetRequest = {
      expectedVersion: 3,
      idempotencyKey: "00000000-0000-4000-8000-000000000302",
    };
    expect(ContractUpsertIntegrationFacetRequest.safeParse(upsert).success).toBe(true);
    expect(ContractMutateIntegrationFacetRequest.safeParse(mutation).success).toBe(true);
  });

  test("SDK-built create-session requests parse under the contracts schema", () => {
    const request: CreateSessionRequest = {
      requestedSessionId: "00000000-0000-4000-8000-000000000042",
      initialMessage: "Investigate the failing deploy",
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/acme/app.git",
          ref: "main",
        },
      ],
      tools: [{ kind: "mcp", id: "documents" }],
      metadata: { origin: "sdk-test" },
      sandboxBackend: "none",
      reasoningEffort: "low",
      goal: { text: "Keep deploys green" },
      firstPartyMcpTools: ["set_session_title"],
    };
    expect(ContractCreateSessionRequest.safeParse(request).success).toBe(true);
  });

  test("every sandbox backend has a capability descriptor row keyed by itself", () => {
    const backends = [...ContractSandboxBackend.options].sort();
    const descriptorKeys = Object.keys(CAPABILITY_DESCRIPTORS).sort();
    expect(descriptorKeys).toEqual(backends);
    for (const backend of ContractSandboxBackend.options) {
      const descriptor = CAPABILITY_DESCRIPTORS[backend];
      expect(descriptor).toBeDefined();
      // The record key and the `backend` field agree. backendId is pinned to the
      // SDK client's actual backendId (asserted against the real clients in
      // packages/runtime — P0.3): it == the enum key for every backend except
      // local, whose UnixLocalSandboxClient reports "unix_local".
      expect(descriptor.backend).toBe(backend);
      expect(descriptor.backendId).toBe(backend === "local" ? "unix_local" : backend);
    }
  });

  test("descriptor invariants: Recording feasibility, OS, and the 6080 desktop port", () => {
    for (const backend of ContractSandboxBackend.options) {
      const descriptor = CAPABILITY_DESCRIPTORS[backend];
      const desktopCapable = descriptor.capabilities.DesktopStream.available;
      const isLinux =
        descriptor.os.default === "linux" && descriptor.os.supported.includes("linux");

      // Recording feasibility == DesktopStream.available && os==linux (x11grab
      // is X11-only). In v1 every reachable cell is Linux, so this reduces to
      // Recording.available === DesktopStream.available.
      expect(descriptor.capabilities.Recording.available).toBe(desktopCapable && isLinux);

      if (desktopCapable) {
        // Desktop-capable backends are Linux in v1 and must carry a real VNC
        // transport (never null).
        expect(isLinux).toBe(true);
        expect(descriptor.capabilities.DesktopStream.transport).not.toBeNull();
        // 6080 is the websockify/noVNC port; it is merged into exposedPorts by
        // createSandboxClient (P0.3). The descriptor must reserve the canonical
        // port constant for every desktop-capable (backend, os).
        expect(DESKTOP_STREAM_PORT).toBe(6080);
      } else {
        // Non-desktop backends never advertise a DesktopStream transport and
        // are never recording-capable.
        expect(descriptor.capabilities.DesktopStream.transport).toBeNull();
        expect(descriptor.capabilities.Recording.available).toBe(false);
      }
    }
  });

  test("stream-surfacing shapes are parity-pinned (Phase 5)", () => {
    // Server -> client: contract-produced shapes are assignable to the SDK
    // mirrors the capability-gated client consumes.
    const acceptCapabilities = (
      v: z.infer<typeof ContractSessionCapabilities>,
    ): SessionCapabilities => v;
    const acceptClientConfig = (v: z.infer<typeof ContractClientConfig>): ClientConfig => v;
    const acceptWorkspaceModelCatalog = (
      v: z.infer<typeof ContractWorkspaceModelCatalogResponse>,
    ): WorkspaceModelCatalogResponse => v;
    const acceptViewerHolder = (v: z.infer<typeof ContractViewerHolder>): ViewerHolder => v;
    const acceptAttachResponse = (
      v: z.infer<typeof ContractAttachViewerResponse>,
    ): AttachViewerResponse => v;
    const acceptContractAttachResponse = (
      v: AttachViewerResponse,
    ): z.infer<typeof ContractAttachViewerResponse> => v;
    const acceptHeartbeatResponse = (
      v: z.infer<typeof ContractViewerHeartbeatResponse>,
    ): ViewerHeartbeatResponse => v;
    const acceptAckResponse = (
      v: z.infer<typeof ContractAcknowledgeStreamResponse>,
    ): AcknowledgeStreamResponse => v;
    const acceptRotated = (
      v: z.infer<typeof ContractStreamUrlRotatedPayload>,
    ): StreamUrlRotatedPayload => v;
    // The desktop-cell alias is an exact view of the doc's DesktopStream cell.
    const acceptDesktopCell = (
      v: z.infer<typeof ContractSessionCapabilities>["DesktopStream"],
    ): SessionCapabilities["DesktopStream"] => v;
    const serverToClient = [
      acceptCapabilities,
      acceptClientConfig,
      acceptWorkspaceModelCatalog,
      acceptViewerHolder,
      acceptAttachResponse,
      acceptContractAttachResponse,
      acceptHeartbeatResponse,
      acceptAckResponse,
      acceptRotated,
      acceptDesktopCell,
    ];
    expect(serverToClient.every((fn) => typeof fn === "function")).toBe(true);

    // Client -> server: SDK-sent request bodies parse under the contracts schema.
    const attach: AttachViewerRequest = {
      viewerId: "33333333-3333-4333-8333-333333333333",
      desktop: false,
      terminal: false,
      files: true,
    };
    const ack: AcknowledgeStreamRequest = {
      acknowledgeUnredacted: true,
      acknowledgeShared: true,
    };
    const heartbeat: ViewerHeartbeatRequest = { leaseEpoch: 7 };
    expect(ContractAttachViewerRequest.safeParse(attach).success).toBe(true);
    expect(ContractAcknowledgeStreamRequest.safeParse(ack).success).toBe(true);
    expect(ContractViewerHeartbeatRequest.safeParse(heartbeat).success).toBe(true);

    // The OS axis the capability doc carries is 3-value (only linux is reachable
    // in v1; the axis exists so macOS/Windows light up without a schema change).
    const sdkOs: readonly SandboxOs[] = ["linux", "macos", "windows"];
    expect([...sdkOs].sort()).toEqual([...ContractSandboxOs.options].sort());
  });
});
