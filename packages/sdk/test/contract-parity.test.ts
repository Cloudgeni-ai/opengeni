import { describe, expect, test } from "bun:test";
import {
  AcknowledgeStreamRequest as ContractAcknowledgeStreamRequest,
  AcknowledgeStreamResponse as ContractAcknowledgeStreamResponse,
  AddWorkspaceMemberRequest as ContractAddWorkspaceMemberRequest,
  AttachViewerRequest as ContractAttachViewerRequest,
  CAPABILITY_DESCRIPTORS,
  ClientConfig as ContractClientConfig,
  ClientSessionEvent,
  CreateSessionRequest as ContractCreateSessionRequest,
  CreateSessionResponse as ContractCreateSessionResponse,
  CreateKnowledgeMemoryRequest as ContractCreateKnowledgeMemoryRequest,
  KnowledgeMemory as ContractKnowledgeMemory,
  KnowledgeMemoryStatus as ContractKnowledgeMemoryStatus,
  UpdateKnowledgeMemoryRequest as ContractUpdateKnowledgeMemoryRequest,
  UpdateWorkspaceSettingsRequest as ContractUpdateWorkspaceSettingsRequest,
  Workspace as ContractWorkspace,
  WorkspaceMemorySearchRequest as ContractWorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse as ContractWorkspaceMemorySearchResponse,
  DESKTOP_STREAM_PORT,
  ListWorkspaceMembersResponse as ContractListWorkspaceMembersResponse,
  MachineState as ContractMachineState,
  OPENGENI_API_CONTRACT_HEADER as CONTRACT_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION as CONTRACT_API_CONTRACT_REVISION,
  MachineView as ContractMachineView,
  MachinesResponse as ContractMachinesResponse,
  MetricSample as ContractMetricSample,
  MachineMetricsSeriesResponse as ContractMachineMetricsSeriesResponse,
  SandboxBackend as ContractSandboxBackend,
  SandboxOs as ContractSandboxOs,
  Session as ContractSessionSchema,
  SessionCapabilities as ContractSessionCapabilities,
  SessionEvent as ContractSessionEventSchema,
  SessionMcpServerInput as ContractSessionMcpServerInput,
  SessionEventType as ContractSessionEventType,
  SessionHumanInputRequest as ContractSessionHumanInputRequest,
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
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  SESSION_EVENT_TYPES,
} from "../src/types";
import type {
  AcknowledgeStreamRequest,
  AcknowledgeStreamResponse,
  AddWorkspaceMemberRequest,
  AttachViewerRequest,
  CreateKnowledgeMemoryRequest,
  KnowledgeMemory,
  KnowledgeMemoryStatus,
  UpdateKnowledgeMemoryRequest,
  UpdateWorkspaceSettingsRequest,
  Workspace,
  WorkspaceMemorySearchResponse,
  ClientConfig,
  ClientSessionEventInput,
  CreateSessionRequest,
  CreateSessionResponse,
  ListWorkspaceMembersResponse,
  MachineState,
  MachineView,
  MachinesResponse,
  MetricSample,
  MachineMetricsSeriesResponse,
  ReasoningEffort,
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
  SessionCapabilities,
  SessionEvent,
  SessionHumanInputRequest,
  SessionMcpServerInput,
  SessionStatus,
  SessionTurn,
  SessionTurnSource,
  SessionTurnStatus,
  SubmitHumanInputResponseRequest,
  StreamUrlRotatedPayload,
  UpdateWorkspaceMemberRequest,
  ViewerHeartbeatRequest,
  ViewerHeartbeatResponse,
  ViewerHolder,
  WorkspaceMember,
} from "../src/types";

// The SDK ships hand-written wire types so it carries zero runtime
// dependencies. This suite pins them to `@opengeni/contracts`: if the public
// contracts move, these checks (value-level and type-level) fail the gate.

describe("SDK / contracts parity", () => {
  test("pins the exact API revision and header values", () => {
    expect(OPENGENI_API_CONTRACT_REVISION).toBe(CONTRACT_API_CONTRACT_REVISION);
    expect(OPENGENI_API_CONTRACT_HEADER).toBe(CONTRACT_API_CONTRACT_HEADER);
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
    ];
    const contracts = [...ContractSandboxBackend.options].sort();
    const deployment = [...DeploymentSandboxBackend.options].sort();
    const sdk = [...sdkBackends].sort();
    expect(contracts).toEqual(deployment);
    expect(contracts).toEqual(sdk);
    expect(contracts).toHaveLength(11);
  });

  test("contract-parsed payloads are assignable to SDK types (compile-time)", () => {
    // Server -> client shapes: anything the contracts produce, the SDK accepts.
    const acceptSession = (value: z.infer<typeof ContractSessionSchema>): Session => value;
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
    const sdkMcpServer: SessionMcpServerInput = {
      id: "host_tools",
      url: "https://example.com/mcp",
      requireApproval: ["write_record"],
    };
    const checks = [
      acceptSession,
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
    ];
    expect(checks.every((fn) => typeof fn === "function")).toBe(true);
    expect(ContractSessionMcpServerInput.parse(sdkMcpServer)).toEqual(sdkMcpServer);
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
    const update: UpdateRigRequest = { name: "dev-machine-2", description: null };
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
      ContractProposeRigChangeRequest.safeParse({ kind: "setup_append", payload: {} }).success,
    ).toBe(false);
    // Defaults: checks/hooks/ids default to [].
    expect(ContractCreateRigRequest.parse({ name: "bare" }).checks).toEqual([]);
  });

  test("SDK-built control events parse under the contracts schema", () => {
    const message: ClientSessionEventInput = {
      type: "user.message",
      clientEventId: "ce-1",
      payload: { text: "hello", tools: [{ kind: "mcp", id: "documents" }] },
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

    const add: AddWorkspaceMemberRequest = {
      email: "teammate@example.com",
      role: "member",
      permissions: ["sessions:read"],
    };
    const update: UpdateWorkspaceMemberRequest = {
      permissions: ["sessions:read", "members:manage"],
    };
    expect(ContractAddWorkspaceMemberRequest.safeParse(add).success).toBe(true);
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
    const acceptSearchResponse = (
      value: z.infer<typeof ContractWorkspaceMemorySearchResponse>,
    ): WorkspaceMemorySearchResponse => value;
    expect(
      [acceptMemory, acceptWorkspace, acceptSearchResponse].every((fn) => typeof fn === "function"),
    ).toBe(true);

    // Client -> server: SDK-sent bodies parse under the contract schemas.
    const create: CreateKnowledgeMemoryRequest = {
      text: "Prefer Terraform.",
      kind: "preference",
      pinned: true,
    };
    const update: UpdateKnowledgeMemoryRequest = { pinned: false, status: "archived" };
    const settings: UpdateWorkspaceSettingsRequest = { memoryEnabled: true };
    expect(ContractCreateKnowledgeMemoryRequest.safeParse(create).success).toBe(true);
    expect(ContractUpdateKnowledgeMemoryRequest.safeParse(update).success).toBe(true);
    expect(ContractUpdateWorkspaceSettingsRequest.safeParse(settings).success).toBe(true);
    // Default create status is `active` (memory lane through the write gate).
    expect(ContractCreateKnowledgeMemoryRequest.parse({ text: "x" }).status).toBe("active");
    // Search request requires a query and clamps limit at 20.
    expect(
      ContractWorkspaceMemorySearchRequest.safeParse({ query: "how do we deploy" }).success,
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
          os: "linux",
          arch: "x86_64",
          hasDisplay: true,
          allowScreenControl: false,
          sharedSessionCount: 2,
          lastSeenAt: "2026-06-26T00:00:00.000Z",
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

  test("SDK-built create-session requests parse under the contracts schema", () => {
    const request: CreateSessionRequest = {
      requestedSessionId: "00000000-0000-4000-8000-000000000042",
      initialMessage: "Investigate the failing deploy",
      resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
      tools: [{ kind: "mcp", id: "documents" }],
      metadata: { origin: "sdk-test" },
      sandboxBackend: "none",
      reasoningEffort: "low",
      goal: { text: "Keep deploys green" },
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
    const acceptViewerHolder = (v: z.infer<typeof ContractViewerHolder>): ViewerHolder => v;
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
      acceptViewerHolder,
      acceptHeartbeatResponse,
      acceptAckResponse,
      acceptRotated,
      acceptDesktopCell,
    ];
    expect(serverToClient.every((fn) => typeof fn === "function")).toBe(true);

    // Client -> server: SDK-sent request bodies parse under the contracts schema.
    const attach: AttachViewerRequest = { viewerId: "33333333-3333-4333-8333-333333333333" };
    const ack: AcknowledgeStreamRequest = { acknowledgeUnredacted: true, acknowledgeShared: true };
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
