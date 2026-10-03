import {
  getAttemptToolCatalog,
  createChannel,
  listChannels,
  getChannel,
  updateChannel,
  reorderChannels,
  deleteChannel,
  setSessionChannel,
} from "@opengeni/db";
import { createHash, randomUUID } from "node:crypto";
import { mintEnrollToken } from "../sandbox/enrollment";
import { capabilityAccountReadiness } from "./capability-account-readiness";
import {
  prepareWorkspaceArtifactUpload,
  prepareWorkspaceArtifactPublication,
  workspaceArtifactDownloads,
} from "../site-uploads";
import {
  CreateScheduledTaskRequest,
  ScheduledTaskAgentConfigInput,
  ResourceRef,
  ToolRef,
  SessionMcpServerInput,
  CreateSessionRequest,
  GoalSpec,
  SessionGoalReportRequirements,
  SessionGoalReportDeliveries,
  boundSessionMcpText as capSessionDiscoveryText,
  compactSessionMcpListRow,
  sessionMcpIncludesRelatedWork,
  FIRST_PARTY_MCP_TOOL_NAMES,
  SESSION_EVENT_RAW_DELTA_TYPES,
  SessionEventLatestClass,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
  SessionEventResultMode,
  SessionEventSemanticClass,
  SessionEventType,
  stableJson,
  compactSessionEventResult,
  turnCompletedReply,
  sessionEventLatestClassToSemanticClass,
  SessionMcpCredentialUpdateInput,
  ToolAuthNeededPayload,
  VariableSetVariableName,
  capabilityCatalogItemIsTrustedForExposure,
  type AccessGrant,
  type CapabilityCatalogItem,
  type GitHubRepository,
  type FirstPartyMcpToolName,
  Permission,
  type SessionAuthorizationOperation,
  type SessionAuthorizationActor,
  type SessionAuthorizationSurface,
  type Session,
  type WorkspaceMemoryPromptMode,
  type WorkspaceArtifactMutationResponse,
  type ScheduledTask,
  UpdateScheduledTaskRequest,
  normalizeWorkspaceArtifactSlug,
  WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES,
  WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX,
  WORKSPACE_ARTIFACT_SOURCE_MAX_FILES,
  SESSION_GOAL_PROGRESS_MAX_BYTES,
  SESSION_GOAL_RATIONALE_MAX_BYTES,
  SESSION_GOAL_SUCCESS_CRITERIA_MAX_BYTES,
  SESSION_GOAL_TEXT_MAX_BYTES,
  SESSION_INSTRUCTIONS_MAX_CHARACTERS,
  AGENT_IDENTITY_MAX_CHARACTERS,
  SESSION_TITLE_MAX_CHARACTERS,
  MAX_SELECTED_VARIABLE_SETS,
  sessionGoalUtf8Bytes,
  TASK_NOTE_LIST_DEFAULT_LIMIT,
  TASK_NOTE_LIST_MAX_LIMIT,
  TASK_NOTE_MAX_LIFETIME_DAYS,
  TASK_NOTE_REASON_MAX_BYTES,
  TASK_NOTE_TEXT_MAX_BYTES,
  WORK_CLAIM_CANONICAL_KEY_MAX_BYTES,
  WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES,
  WORK_CLAIM_DISCOVERY_LIMIT,
  WORK_CLAIM_NAMESPACE_MAX_BYTES,
  WORK_CLAIM_VERSION_VALUE_MAX_BYTES,
  WORK_DISCOVERY_QUERY_MAX_CHARS,
  WORK_DISCOVERY_RECENT_HOURS_MAX,
  WorkClaimSubjectType,
  type WorkClaimSubjectFilter,
  type SessionStatus,
  SubmitHumanInputResponseRequest,
  FIRST_PARTY_MCP_CALLER_META_KEY,
} from "@opengeni/contracts";
import {
  countVariableSets,
  SessionCreateConnectionSelectionUnavailableError,
  beginRigChangeVerificationAttempt,
  createVariableSet,
  decryptVariableSetValue,
  encryptVariableSetValue,
  getSession,
  getScheduledTaskRevisionAuthoritySubject,
  getSessionGoal,
  getSessionMcpMonitoringSummary,
  getSessionQueueSnapshot,
  getSessionTurn,
  getSessionTurnMcpAccountBindings,
  getOrCreatePreferenceRegistrySnapshot,
  getPreferenceRegistryFullContent,
  getVariableSet,
  getVariableSetByName,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEventPage,
  listOutstandingSessionSystemUpdates,
  listSessionDiscoverySummaries,
  listEnrollments,
  projectEffectiveControlForRelatedAccess,
  projectSessionForRelatedAccess,
  type SessionDiscoveryCursor,
  type SessionDiscoveryOrderBy,
  listRigs,
  listRigChangeMonitoringSummaries,
  listRigVersionMonitoringSummaries,
  listSocialPosts,
  recordAuditEvent,
  removeEnrollment,
  readVariableSetSecretAtomically,
  recordSyncedSocialPosts,
  listVariableSets,
  requireScheduledTask,
  requireSession,
  type MemoryAgentScope,
  serializeEffectiveSessionControl,
  setSessionGoalStatusWithEvent,
  recordSessionGoalProgressWithEvent,
  waitForSessionInputWithEvent,
  SESSION_INPUT_WAIT_MAX_SECONDS,
  SESSION_INPUT_WAIT_MIN_SECONDS,
  setVariableSetVariable,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
  RigChangeTransitionError,
  createWorkspaceArtifact,
  getWorkspaceArtifact,
  getWorkspaceArtifactContentRef,
  listWorkspaceArtifacts,
  publishWorkspaceArtifactVersion,
  rollbackWorkspaceArtifact,
  setWorkspaceArtifactStatus,
  archiveTaskNote,
  createTaskNote,
  listTaskNotes,
  replaceTaskNote,
  releaseWorkClaim,
  upsertWorkClaim,
  acceptSessionHumanInputResponse,
  HumanInputResponseValidationError,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced, publishDurableSessionEvents } from "@opengeni/events";
import {
  agentConfigDeploymentPolicy,
  allowedFirstPartyMcpToolsForSession,
  codemodeWorkspaceUrl,
} from "@opengeni/config";
import {
  createSignedState,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
} from "@opengeni/github";
import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { assertDescribedToolInput, contractToolInput } from "./contract-input";
import { editableArtifactActorForGrant } from "../routes/editable-artifacts";
import { registerKnowledgeEntryTools } from "./knowledge-entries";
import {
  FIRST_PARTY_TOOL_AUTHORIZATION,
  type FirstPartyToolAuthorization,
} from "./first-party-tool-permissions";
import {
  hasLiteralPermission,
  hasPermission,
  authorizedSocialConnectionsForGrant,
  buildCapabilityCatalog,
  nativeConnectionCapabilityRecommendations,
  requireLiveAgentAttemptAuthorization,
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  resolveWorkspaceCatalogSettings,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  searchCapabilityCatalogItems,
  type ResolvedSessionAuthorization,
} from "@opengeni/core";
import {
  recordWorkspaceUsage,
  requireLimit,
  resolveScheduledTaskPreflightModel,
  workflowIdForSession,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { requireAgentConfigAdmission, scheduledTaskAgentInput } from "@opengeni/core";
import {
  githubBindingStatus,
  listWorkspaceGitHubInstallationBindings,
  githubRepositoryResourceRef,
  listWorkspaceGitHubRepositories,
} from "../github-access";
import { githubBrowserBaseUrl, githubBrowserGrantClaims } from "../github-browser-flow";
import { publishSandboxFileArtifact } from "../sandbox-file-artifacts";
import {
  projectWorkspaceArtifactDetailProvenance,
  projectWorkspaceArtifactMutationProvenance,
  projectWorkspaceArtifactVersionProvenance,
  redactWorkspaceArtifactListProvenance,
} from "../workspace-artifact-provenance";
import {
  assertSocialConnectionProvider,
  socialMentionsLive,
  socialOwnPostsLive,
  socialPostReply,
  socialSearchLive,
  socialThreadLive,
} from "../integrations/social-api";
import {
  promoteVerifiedDefinitionEditChangeForApi,
  proposeRigChangeForApi,
  requireRigChangeForApi,
  requireRigForApi,
  assertAllowedVariableSetVariableName,
  MAX_ENVIRONMENTS_PER_WORKSPACE,
  MAX_VARIABLES_PER_ENVIRONMENT,
  recordVariableSetAuditEvent,
  requireVariableSetEncryption,
} from "@opengeni/core";
import {
  captureScheduledTaskRestoreState,
  createValidatedScheduledTask,
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskForGrant,
  scheduledTaskRunForGrant,
  scheduledTaskToolsProvided,
  scheduledTaskTriggerToken,
  ScheduledTaskSyncError,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validateScheduledTaskMachineTarget,
  validateScheduledTaskTarget,
  updateScheduledTaskForApi,
  triggerScheduledTaskForGrant,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import {
  acceptSessionUserMessageWithOutcome,
  controlAgentSessionWorkstream,
  controlHumanSessionWorkstreamWithOutcome,
  createSessionForRequestWithOutcome,
  SessionSpawnDeniedError,
  sessionSpawnDenialEnvelope,
  sendAgentSessionMessage,
  steerAgentSession,
  updateSessionTitle,
  setSessionModel,
  sessionWithEffectiveToolPolicy,
  workspaceSessionEffectiveToolsContext,
  workspaceSessionToolPolicyDefaultServerIds,
  workspaceSessionToolPolicyServerIds,
  type AgentSessionCommandContext,
} from "@opengeni/core";
import {
  buildFleetContextForSession,
  listFleet,
  provisionSandbox,
  runOnSandbox,
  swapActiveSandbox,
  type FleetContext,
  type FleetServices,
  type RunOnOp,
} from "@opengeni/core";
import {
  readSessionBackgroundCommandOutput,
  COMMAND_OUTPUT_MAX_BYTES,
} from "@opengeni/db/session-background-commands";
import {
  readCommandWithWait,
  COMMAND_READ_MAX_WAIT_SECONDS,
  COMMAND_WAIT_DEFAULT_SECONDS,
} from "./command-read";
import {
  boundSessionEventCompactResult,
  boundSessionEventMcpPage,
  boundSessionDetailMcp,
  boundSessionCompactDetailMcp,
  boundRigDetailMcp,
  SESSION_EVENT_MCP_MAX_BYTES,
} from "./session-view";
import { completeChildReadSequences } from "./child-read-evidence";
import {
  acknowledgeConsumedChildEvents,
  listOutstandingSessionSystemUpdatesForAttempt,
  recordConsumedChildAnswers,
} from "@opengeni/db";
import {
  SESSION_WAIT_COMPLETION_EVENT_TYPES,
  SESSION_WAIT_DEFAULT_SECONDS,
  SESSION_WAIT_EVENT_TYPES,
  SESSION_WAIT_EVENTS_PER_TARGET,
  SESSION_WAIT_MAX_SECONDS,
  SESSION_WAIT_MAX_TARGETS,
  sessionWaitChangeEventMatches,
  sessionWaitCompletionEventMatches,
  waitForSessionChanges,
  withOwnPendingUpdateKinds,
} from "./session-wait";
import {
  mcpMutationReceipt,
  sessionControlMutationReceipt,
  sessionCreateMutationReceipt,
} from "./receipts";
import {
  boundScheduledTaskDetailMcp,
  boundScheduledTaskMcpPage,
  scheduledTaskMcpSummary,
} from "./scheduled-task-view";
import { ensureSessionGroupReady as ensureViewerSessionGroupReady } from "../sandbox/viewer";
import {
  createOpenGeniSlackBotClient,
  prepareScheduledSlackBotPost,
  resolveSlackBotConnectionForTool,
  sendScheduledSlackBotPost,
  type OpenGeniSlackBotClient,
} from "../integrations/slack-bot";
import { uploadSlackTaskFile } from "../integrations/slack-task-file-upload";
import { createFikenClient, resolveFikenConnectionForTool } from "../integrations/fiken";
import {
  allowanceExhaustedMessage,
  parseAllowanceExhaustedRefusal,
} from "@opengeni/contracts/allowance-refusal";
import { registerEditableArtifactAgentTools } from "./editable-artifacts";
import { registerCompanyProfileAgentAdminTools } from "./company-profile-agent-admin";
import { mintSandboxCodemodeToken } from "@opengeni/runtime/sandbox";
import { deleteScheduledTaskWithDurableCleanup } from "../scheduled-task-deletion";
import { observeWorkDiscovery, summarizeWorkDiscoveryRows } from "../work-discovery-observability";
import { orchestrationFailureDiagnostic } from "./orchestration-failure-diagnostic";

export type McpServerOptions = {
  // Origin of the HTTP request that reached the MCP route. Browser-oriented
  // tools use it only when no configured public base URL is available.
  requestOrigin?: string | null;
  workspaceMemoryEnabled?: boolean | undefined;
  workspaceMemoryPromptMode?: WorkspaceMemoryPromptMode | undefined;
  /**
   * The bound session's typed Memory selector (migration 0427), resolved by
   * the route from the session row. `off` registers no Memory tools; `user`
   * and `session` read the workspace layer plus their own private layer and
   * save into that private layer. Omitted/null keeps the workspace layer.
   */
  sessionMemory?: MemoryAgentScope | null | undefined;
};

const ORCHESTRATION_FAILURE_CODE_MAX_LENGTH = 128;
const ORCHESTRATION_FAILURE_MESSAGE_MAX_UTF8_BYTES = 1_024;
// Keep pathological raw MCP payloads away from Unicode normalization while
// leaving the shared DB normalizer authoritative for the exact post-NFKC
// code-point limit. The multiplier admits supplementary-plane characters,
// decomposed forms, and ordinary whitespace folding without reopening the
// API-wide request-body ceiling for this 200-code-point field.
const MCP_DISCOVERY_QUERY_MAX_UTF16_CODE_UNITS = WORK_DISCOVERY_QUERY_MAX_CHARS * 8;

type OrchestrationToolName = "session_create" | "session_send_message" | "session_steer";

function boundedOrchestrationFailureMessage(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!normalized) return "OpenGeni could not complete the request.";
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.byteLength <= ORCHESTRATION_FAILURE_MESSAGE_MAX_UTF8_BYTES) return normalized;
  let end = ORCHESTRATION_FAILURE_MESSAGE_MAX_UTF8_BYTES;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.slice(0, end)).trim();
}

function orchestrationFailureCode(tool: OrchestrationToolName, error: HTTPException): string {
  const suffix =
    error.status === 401
      ? "unauthenticated"
      : error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : error.status === 429
              ? "limit_exceeded"
              : error.status >= 500
                ? "unavailable"
                : "rejected";
  return `${tool}_${suffix}`.slice(0, ORCHESTRATION_FAILURE_CODE_MAX_LENGTH);
}

function sessionCreateValidationFailureResult(error: z4.ZodError) {
  // Only call with issues from the raw request preflight, never downstream errors.
  // Paths may contain caller-controlled record keys, and custom issue messages
  // may contain values. Only publish canonical field names and fixed type labels.
  const details = error.issues.slice(0, 5).map((issue) => {
    const [field, goalField] = issue.path;
    let path =
      typeof field === "string" && Object.hasOwn(CreateSessionRequest.out.shape, field)
        ? field
        : "request";
    if (
      field === "goal" &&
      typeof goalField === "string" &&
      Object.hasOwn(GoalSpec.shape, goalField)
    ) {
      path += `.${goalField}`;
    }
    const expected =
      issue.code === "invalid_type" &&
      ["string", "number", "boolean", "object", "array", "int"].includes(issue.expected)
        ? `expected ${issue.expected === "int" ? "integer" : issue.expected}`
        : "failed schema validation";
    return `${path} ${expected}`;
  });
  const envelope = {
    error: {
      code: "session_create_invalid_request",
      message: boundedOrchestrationFailureMessage(
        `Invalid session create request: ${details.join("; ") || "request failed schema validation"}${error.issues.length > 5 ? "; additional fields failed validation" : ""}.`,
      ),
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: true as const,
  };
}

function orchestrationFailureEnvelope(tool: OrchestrationToolName, error: unknown) {
  if (
    tool === "session_create" &&
    error instanceof SessionCreateConnectionSelectionUnavailableError
  ) {
    return {
      error: {
        code: "session_create_connection_selection_unavailable",
        message: error.message,
        retryable: false,
      },
    };
  }
  const allowance =
    (error instanceof HTTPException ? parseAllowanceExhaustedRefusal(error.cause) : null) ??
    parseAllowanceExhaustedRefusal(error);
  if (allowance) {
    return {
      error: { ...allowance, message: allowanceExhaustedMessage(allowance), retryable: false },
    };
  }
  if (error instanceof SessionSpawnDeniedError) {
    const denial = sessionSpawnDenialEnvelope(error);
    return {
      error: {
        ...denial.error,
        message: boundedOrchestrationFailureMessage(denial.error.message),
      },
    };
  }
  if (error instanceof HTTPException) {
    return {
      error: {
        code: orchestrationFailureCode(tool, error),
        message:
          error.status >= 500
            ? "OpenGeni is temporarily unavailable — retry."
            : boundedOrchestrationFailureMessage(error.message),
      },
    };
  }
  if (error instanceof SessionAuthorizationDeniedError) {
    return {
      error: {
        code: `${tool}_not_found_or_denied`,
        message: "Session not found or access denied.",
      },
    };
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    return {
      error: {
        code: `${tool}_authorization_unavailable`,
        message: "Session authorization is temporarily unavailable — retry.",
      },
    };
  }
  const typedCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  const knownFailure =
    typedCode === "CALLER_STALE"
      ? ["caller_stale", "The calling session no longer owns this attempt."]
      : typedCode === "CALLER_INTERRUPTED"
        ? ["caller_interrupted", "The calling session was interrupted before delivery."]
        : typedCode === "TARGET_NOT_VERTICAL"
          ? ["target_not_vertical", "The calling agent cannot act on that session."]
          : typedCode === "CONTROL_CHANGED"
            ? ["conflict", "The target session control state changed; refresh and retry."]
            : typedCode === "IDEMPOTENCY_KEY_REUSED"
              ? ["idempotency_key_reused", "The idempotency key was reused with different input."]
              : typedCode === "WORKSPACE_CONTROL_BUSY"
                ? [
                    "workspace_busy",
                    "The workspace is busy applying other session commands; nothing was applied. Retry the same call shortly.",
                  ]
                : null;
  if (knownFailure) {
    return {
      error: {
        code: `${tool}_${knownFailure[0]}`,
        message: knownFailure[1],
      },
    };
  }
  return {
    error: {
      code: `${tool}_failed`,
      message: "OpenGeni could not complete the request.",
    },
  };
}

function orchestrationFailureResult(
  tool: OrchestrationToolName,
  error: unknown,
  deps: ApiRouteDeps,
  grant: AccessGrant,
) {
  const envelope = orchestrationFailureEnvelope(tool, error);
  let result: Record<string, unknown> = envelope;
  if (envelope.error.code === `${tool}_failed` || envelope.error.code === `${tool}_unavailable`) {
    try {
      result = {
        error: {
          ...envelope.error,
          ...orchestrationFailureDiagnostic(deps, tool, error, exactAgentAttemptClaims(grant)),
        },
      };
    } catch {
      // Diagnostic construction must never replace the original tool outcome.
    }
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: true as const,
  };
}

const FIRST_PARTY_MCP_TOOL_NAME_SET = new Set<string>(FIRST_PARTY_MCP_TOOL_NAMES);

class PolicyMcpServer extends McpServer {
  private registeredToolCount = 0;

  constructor(
    private readonly grant: AccessGrant,
    private readonly sessionId: string | null,
    private readonly selectedTools: ReadonlySet<FirstPartyMcpToolName> | null,
  ) {
    super({ name: "opengeni", version: "1.0.0" });
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const catalogued = FIRST_PARTY_MCP_TOOL_NAME_SET.has(name);
    let admitted = false;
    if (catalogued) {
      const toolName = name as FirstPartyMcpToolName;
      const policy: FirstPartyToolAuthorization = FIRST_PARTY_TOOL_AUTHORIZATION[toolName];
      const authorized =
        (!policy.sessionRequired || this.sessionId !== null) &&
        (policy.allOf?.every((permission) => hasPermission(this.grant.permissions, permission)) ??
          true) &&
        (policy.anyOf?.some((permission) => hasPermission(this.grant.permissions, permission)) ??
          true);
      const selected = this.selectedTools === null || this.selectedTools.has(toolName);
      admitted = authorized && selected;
    }
    if (!admitted) {
      return {
        ...(config.title ? { title: config.title } : {}),
        ...(config.description ? { description: config.description } : {}),
        ...(config.annotations ? { annotations: config.annotations } : {}),
        ...(config._meta ? { _meta: config._meta } : {}),
        handler: cb as RegisteredTool["handler"],
        enabled: false,
        enable() {},
        disable() {},
        update() {},
        remove() {},
      };
    }
    if (config.inputSchema) {
      const schema =
        normalizeObjectSchema(config.inputSchema) ??
        (Object.keys(config.inputSchema).length === 0 ? z4.object({}) : undefined);
      if (!schema) throw new Error(`${name}: MCP input must be an object schema`);
      assertDescribedToolInput(
        z4.toJSONSchema(schema as z4.ZodType, { io: "input", target: "draft-7" }),
        name,
      );
    }
    this.registeredToolCount += 1;
    return super.registerTool(name, config, cb);
  }

  ensureToolsListHandler(): void {
    if (this.registeredToolCount > 0) return;
    super
      .registerTool(
        "__opengeni_empty_first_party_surface__",
        {
          description: "Internal disabled placeholder for an empty first-party surface.",
          inputSchema: z4.object({}),
        },
        async () => ({
          content: [{ type: "text" as const, text: '{"unavailable":true}' }],
        }),
      )
      .disable();
  }
}

export function slackBotFileContentResult(
  result: Awaited<ReturnType<OpenGeniSlackBotClient["fileContent"]>>,
) {
  if (!("image" in result)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: {
        kind: "text" as const,
        fileId: result.file.id,
        contentType: result.contentType,
        content: result.content,
        sizeBytes: null,
        nextOffset: result.nextOffset,
      },
    };
  }
  return {
    structuredContent: {
      kind: "image" as const,
      fileId: result.file.id,
      contentType: result.image.contentType,
      content: null,
      sizeBytes: result.image.bytes.byteLength,
      nextOffset: null,
    },
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          channel: result.channel,
          file: result.file,
          contentType: result.image.contentType,
          sizeBytes: result.image.bytes.byteLength,
          receipt: result.receipt,
        }),
      },
      {
        type: "image" as const,
        mimeType: result.image.contentType,
        data: Buffer.from(result.image.bytes).toString("base64"),
      },
    ],
  };
}

export function buildOpenGeniMcpServer(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  options: McpServerOptions = {},
): McpServer {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const can = (permission: Permission) => hasPermission(grant.permissions, permission);
  let socialConnectionsPromise: ReturnType<typeof authorizedSocialConnectionsForGrant> | undefined;
  const authorizedSocialConnections = () =>
    (socialConnectionsPromise ??= authorizedSocialConnectionsForGrant({
      db: deps.db,
      grant,
      limit: 500,
    }));
  const requireAuthorizedSocialConnection = async (connectionId: string) => {
    const authority = (await authorizedSocialConnections()).find(
      ({ connection }) => connection.id === connectionId,
    );
    if (!authority) throw new Error(`Unknown or unavailable social connection: ${connectionId}`);
    return authority;
  };
  const requireAuthorizedSocialConnectionForProvider = async (
    provider: "x" | "reddit",
    connectionId: string,
  ) => {
    const authority = await requireAuthorizedSocialConnection(connectionId);
    assertSocialConnectionProvider(authority.connection, provider);
    return authority;
  };

  // Session-scoped tools key off the worker-asserted sessionId claim (signed
  // into the delegated token by the worker, never agent-controlled).
  const sessionId =
    typeof grant.metadata?.["sessionId"] === "string"
      ? (grant.metadata["sessionId"] as string)
      : null;
  // A session-scoped grant carries its model-visible selection as a signed
  // claim. When that claim is absent the grant was not minted for the ordinary
  // first-party MCP surface (today only the sandbox Codemode bearer has that
  // shape), so it resolves to no session tools rather than the deployment
  // default catalog: an omitted claim must never widen.
  const signedSelection = grant.metadata?.["firstPartyMcpTools"] as
    | FirstPartyMcpToolName[]
    | undefined;
  const selectedTools =
    sessionId !== null
      ? new Set(
          signedSelection === undefined
            ? []
            : allowedFirstPartyMcpToolsForSession(deps.settings, signedSelection),
        )
      : null;
  const nestedAgentDepth = grant.metadata?.["nestedAgentDepth"];
  const effectiveMaxNestedAgentDepth = grant.metadata?.["effectiveMaxNestedAgentDepth"];
  // Optional claims keep rolling deployments compatible. When both trusted
  // facts are present, an exhausted session does not receive an unusable spawn
  // tool; stale/legacy callers still meet the authoritative DB admission gate.
  const sessionCreateVisible =
    typeof nestedAgentDepth !== "number" ||
    typeof effectiveMaxNestedAgentDepth !== "number" ||
    nestedAgentDepth < effectiveMaxNestedAgentDepth;
  const server = new PolicyMcpServer(grant, sessionId, selectedTools);
  // set_session_title names the agent's OWN session — pure session metadata,
  // not a goal operation — so it is available on every session, gated only on
  // the signed sessionId (NOT goals:manage, and NOT on a goal existing).
  if (sessionId !== null) {
    server.registerTool(
      "set_session_title",
      {
        description:
          "Set this session's display title to a concise 3-7 word topic label. Use a stable noun phrase about the actual task or subject, never a quote/prefix of a prompt, greeting, request boilerplate, URL, identifier, credential, token, or other sensitive value. Call once on a new session, then only when the topic materially changes. Never call it as routine setup after a continuation, resume, or interruption, or merely to reassert the same title. A human-set title cannot be replaced.",
        inputSchema: { title: z4.string().min(1).max(200) },
      },
      async ({ title }) => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.title.write");
        const result = await updateSessionTitle(deps, grant, sessionId, title, "agent");
        return json({
          ok: true,
          updated: result.updated,
          title: result.title ?? title,
        });
      },
    );
  }
  // PolicyMcpServer applies each tool's own permission contract. Register this
  // mixed group for every session so session-level wait_for_input remains
  // available with sessions:control even when goals:manage is intentionally
  // absent.
  if (sessionId !== null) {
    registerGoalTools(server, deps, grant, sessionId, json);
  }
  // Agent learning controls authoring at the accepted-attempt write boundary.
  // Reading existing Knowledge and Skills remains available when authoring is Off.
  if (sessionId !== null) {
    registerKnowledgeEntryTools(server, deps, grant, sessionId);
  }
  server.registerTool(
    "artifacts_list",
    {
      description:
        "List the generic published artifacts in this workspace and their current versions.",
      inputSchema: {},
    },
    async () => {
      if (sessionId !== null && exactAgentAttemptClaims(grant) !== null) {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
      }
      return json(
        redactWorkspaceArtifactListProvenance(
          await listWorkspaceArtifacts(deps.db, grant.workspaceId),
        ),
      );
    },
  );
  if (sessionId !== null && exactAgentAttemptClaims(grant) !== null) {
    registerPreferenceRegistryTools(server, deps, grant, json);
    registerTaskNoteTools(server, deps, grant, sessionId, json);
    if (deps.settings.workClaimMutationsEnabled) {
      registerWorkClaimTools(server, deps, grant, sessionId, json);
    }
    const attempt = exactAgentAttemptClaims(grant)!;

    registerCompanyProfileAgentAdminTools({
      server,
      db: deps.db,
      attempt: {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        ...attempt,
        agentSubjectId: grant.subjectId,
      },
      authorize: async () => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
      },
      json,
    });
  }
  if (sessionId !== null && exactAgentAttemptClaims(grant) !== null) {
    registerWorkspaceArtifactTools(server, deps, grant, sessionId, json);
    registerSandboxFileArtifactTool(server, deps, grant, sessionId, json);
    registerEditableArtifactAgentTools({
      server,
      deps,
      grant,
      sessionId,
      authorize: async () => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
      },
    });
  }

  // Fleet tools (M7 bring-your-own-compute): list / attach / swap / run_on /
  // provision over the session's Modal box + the workspace's enrolled machines.
  // Session-scoped like goals (they steer THIS session's active-sandbox pointer),
  // so they register only when the grant carries the worker-signed sessionId claim
  // (never agent-controlled). Gated on the selfhosted feature flag: the active
  // pointer + swap are only meaningful when bring-your-own-compute is enabled.
  if (sessionId !== null && deps.settings.sandboxSelfhostedEnabled) {
    registerFleetTools(server, deps, grant, sessionId, json);
  }
  if (can("enrollments:manage") && deps.settings.sandboxSelfhostedEnabled) {
    registerConnectedMachineTools(server, deps, grant, sessionId, json);
  }
  registerRigTools(server, deps, grant, can, sessionId, json);
  registerSlackBotTools(server, deps, grant, sessionId, json);
  registerFikenTools(server, deps, grant, sessionId, json);

  // Orchestration, variableSet, and GitHub status tools are permission-gated
  // at registration: a grant without the permission does not see the tool.
  // Sandboxed workers reach this server with the first-party delegated
  // permission set (firstPartyMcpPermissions in @opengeni/runtime), which is
  // POWERFUL BY DEFAULT — it carries sessions:*, variable sets:*, and github:use,
  // so agents can spawn/read sessions, manage variable set variables, inspect
  // GitHub connection availability, and use already-bound repository resources
  // out of the box. GitHub installation credentials are refreshed host-side and
  // never returned through a model-visible MCP tool. A user DEMOTES a specific
  // session by setting a narrower session.firstPartyMcpPermissions (capped to
  // the creator's own grant); operators still cap what any session can be given.
  registerWorkspaceOrchestrationTools(
    server,
    deps,
    grant,
    can,
    sessionId,
    sessionCreateVisible,
    json,
  );
  registerProjectTools(server, deps, grant, can, json);
  registerVariableSetTools(server, deps, grant, can, sessionId, json);
  if (sessionId !== null && can("workspace:read")) {
    registerCapabilityDiscoveryTools(server, deps, grant, sessionId, json);
  }
  if (can("github:use")) {
    registerGitHubConnectTool(server, deps, grant, options, json);
  }

  if (can("github:use")) {
    server.registerTool(
      "github_repositories_list",
      {
        description:
          "List GitHub App repositories available as scheduled task repository resources. Use the returned resource object in scheduled task agentConfig.resources.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) => {
        try {
          const repositories = await listWorkspaceGitHubRepositories(deps, grant.workspaceId);
          const visible = typeof limit === "number" ? repositories.slice(0, limit) : repositories;
          return json({
            repositories: visible.map((repository) =>
              repositoryWithScheduledTaskResource(repository),
            ),
          });
        } catch (error) {
          if (error instanceof GitHubAppConfigurationError) {
            throw new Error(`GitHub App is not configured: ${error.missing.join(", ")}`, {
              cause: error,
            });
          }
          throw error;
        }
      },
    );
  }

  if (can("connections:read")) {
    server.registerTool(
      "social_connections_list",
      {
        description: "List connected social media accounts available for analysis.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) =>
        json({
          connections: (await authorizedSocialConnections())
            .slice(0, boundedMcpLimit(limit))
            .map(({ connection }) => connection),
        }),
    );

    server.registerTool(
      "social_posts_recent",
      {
        description: "List recent social media posts imported or synced into OpenGeni.",
        inputSchema: {
          connectionIds: z4.array(z4.string().uuid()).optional(),
          since: z4.string().optional(),
          windowHours: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionIds, since, windowHours, limit }) => {
        const authorized = await authorizedSocialConnections();
        const selected = connectionIds?.length
          ? connectionIds.map((id) => {
              const match = authorized.find(({ connection }) => connection.id === id);
              if (!match) throw new Error(`Unknown or unavailable social connection: ${id}`);
              return match;
            })
          : authorized;
        const personalSubjectId = selected.find(({ subjectId }) => subjectId)?.subjectId ?? null;
        const sinceDate = since
          ? parseMcpDate(since, "since")
          : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
        return json({
          since: sinceDate.toISOString(),
          posts: await listSocialPosts(deps.db, {
            workspaceId: grant.workspaceId,
            subjectId: personalSubjectId,
            connectionIds: selected.map(({ connection }) => connection.id),
            since: sinceDate,
            limit: boundedMcpLimit(limit),
          }),
        });
      },
    );

    server.registerTool(
      "social_daily_analysis_context",
      {
        description:
          "Collect social account and recent post context for a daily marketing analysis run.",
        inputSchema: {
          connectionIds: z4.array(z4.string().uuid()).optional(),
          documentBaseIds: z4.array(z4.string().uuid()).optional(),
          since: z4.string().optional(),
          windowHours: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionIds, documentBaseIds, since, windowHours, limit }) => {
        const authorized = await authorizedSocialConnections();
        const allConnections = authorized.map(({ connection }) => connection);
        const selectedIds =
          connectionIds && connectionIds.length > 0 ? new Set(connectionIds) : null;
        const connections = selectedIds
          ? allConnections.filter((connection) => selectedIds.has(connection.id))
          : allConnections.filter((connection) => connection.status === "connected");
        if (selectedIds) {
          const foundIds = new Set(connections.map((connection) => connection.id));
          const missing = [...selectedIds].filter((id) => !foundIds.has(id));
          if (missing.length > 0) {
            throw new Error(`Unknown social connection IDs: ${missing.join(", ")}`);
          }
        }
        const sinceDate = since
          ? parseMcpDate(since, "since")
          : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
        const posts =
          connections.length > 0
            ? await listSocialPosts(deps.db, {
                workspaceId: grant.workspaceId,
                subjectId:
                  authorized.find(
                    ({ connection, subjectId }) =>
                      subjectId && connections.some((selected) => selected.id === connection.id),
                  )?.subjectId ?? null,
                connectionIds: connections.map((connection) => connection.id),
                since: sinceDate,
                limit: boundedMcpLimit(limit),
              })
            : [];
        return json({
          generatedAt: new Date().toISOString(),
          window: {
            since: sinceDate.toISOString(),
            until: new Date().toISOString(),
          },
          documentBaseIds: documentBaseIds ?? [],
          connections,
          posts,
          instructions: [
            "Use docs MCP search tools for the supplied documentBaseIds when brand, campaign, or audience knowledge is needed.",
            "Report data gaps explicitly when posts or metrics are missing.",
            "Do not infer unpublished metrics or hidden platform data.",
          ],
        });
      },
    );

    // Live provider reads (X / Reddit). Tokens are resolved and used entirely
    // host-side; the agent only ever sees normalized post payloads.
    server.registerTool(
      "social_search_live",
      {
        description:
          "Search live conversations on a connected social account (X recent search or Reddit search). Use social_connections_list first to find the connectionId. For Reddit, pass subreddit to scope the search.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          query: z4.string().min(1).max(512),
          subreddit: z4.string().min(1).max(100).optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, query, subreddit, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialSearchLive(
          deps,
          {
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
          },
          { query, subreddit, limit },
        );
        return json({
          provider: result.connection.provider,
          posts: result.posts,
        });
      },
    );

    server.registerTool(
      "social_mentions_live",
      {
        description:
          "Fetch live mentions of the connected account (X mentions timeline, or the Reddit inbox with username mentions and comment replies).",
        inputSchema: {
          connectionId: z4.string().uuid(),
          sinceId: z4.string().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, sinceId, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialMentionsLive(
          deps,
          {
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
          },
          { sinceId, limit },
        );
        return json({
          provider: result.connection.provider,
          posts: result.posts,
        });
      },
    );

    server.registerTool(
      "social_thread_fetch",
      {
        description:
          "Fetch a live conversation thread: for X pass a tweet id (returns the conversation), for Reddit pass a post id or t3_ fullname (returns the post plus top comments).",
        inputSchema: {
          connectionId: z4.string().uuid(),
          id: z4.string().min(1).max(100),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, id, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialThreadLive(
          deps,
          {
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
          },
          { id, limit },
        );
        return json({
          provider: result.connection.provider,
          posts: result.posts,
        });
      },
    );

    // Provider-scoped aliases are the canonical tools advertised by the X and
    // Reddit Integration cards. The legacy social_* names remain available to

    // identity and reject a near-identical Connection from the other adapter.
    for (const provider of ["x", "reddit"] as const) {
      const providerName = provider === "x" ? "X" : "Reddit";
      server.registerTool(
        `${provider}_accounts_list`,
        {
          description: `List the exact visible ${providerName} accounts available to this work.`,
          inputSchema: { limit: z4.number().int().positive().optional() },
        },
        async ({ limit }) =>
          json({
            connections: (await authorizedSocialConnections())
              .filter(
                ({ connection }) =>
                  connection.provider === provider && connection.status !== "disabled",
              )
              .slice(0, boundedMcpLimit(limit))
              .map(({ connection }) => connection),
          }),
      );
      server.registerTool(
        `${provider}_search_live`,
        {
          description:
            provider === "x"
              ? "Search recent X conversations through one exact connected X account."
              : "Search Reddit through one exact connected Reddit account; optionally scope to a subreddit.",
          inputSchema: {
            connectionId: z4.string().uuid(),
            query: z4.string().min(1).max(512),
            subreddit: z4.string().min(1).max(100).optional(),
            limit: z4.number().int().positive().optional(),
          },
        },
        async ({ connectionId, query, subreddit, limit }) => {
          const authority = await requireAuthorizedSocialConnectionForProvider(
            provider,
            connectionId,
          );
          const result = await socialSearchLive(
            deps,
            {
              workspaceId: grant.workspaceId,
              connectionId,
              subjectId: authority.subjectId,
            },
            { query, subreddit, limit },
          );
          return json({
            provider: result.connection.provider,
            posts: result.posts,
          });
        },
      );
      server.registerTool(
        `${provider}_mentions_live`,
        {
          description: `Fetch live ${providerName} mentions and replies through one exact connected account.`,
          inputSchema: {
            connectionId: z4.string().uuid(),
            sinceId: z4.string().optional(),
            limit: z4.number().int().positive().optional(),
          },
        },
        async ({ connectionId, sinceId, limit }) => {
          const authority = await requireAuthorizedSocialConnectionForProvider(
            provider,
            connectionId,
          );
          const result = await socialMentionsLive(
            deps,
            {
              workspaceId: grant.workspaceId,
              connectionId,
              subjectId: authority.subjectId,
            },
            { sinceId, limit },
          );
          return json({
            provider: result.connection.provider,
            posts: result.posts,
          });
        },
      );
      server.registerTool(
        `${provider}_thread_fetch`,
        {
          description: `Fetch one live ${providerName} conversation thread through an exact connected account.`,
          inputSchema: {
            connectionId: z4.string().uuid(),
            id: z4.string().min(1).max(100),
            limit: z4.number().int().positive().optional(),
          },
        },
        async ({ connectionId, id, limit }) => {
          const authority = await requireAuthorizedSocialConnectionForProvider(
            provider,
            connectionId,
          );
          const result = await socialThreadLive(
            deps,
            {
              workspaceId: grant.workspaceId,
              connectionId,
              subjectId: authority.subjectId,
            },
            { id, limit },
          );
          return json({
            provider: result.connection.provider,
            posts: result.posts,
          });
        },
      );
    }
  }

  // Writes are gated on connections:write (never in the default first-party
  // agent permission set) so scheduled tasks must opt in, and deployments can
  // additionally wrap posting in a requireApproval policy.
  if (can("connections:write")) {
    server.registerTool(
      "social_posts_sync",
      {
        description:
          "Sync the connected account's own recent posts from the provider into OpenGeni's social_posts store (idempotent), so social_posts_recent and daily analysis see fresh data.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialOwnPostsLive(
          deps,
          {
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
          },
          { limit },
        );
        // A post without a provider timestamp is skipped rather than recorded
        // at sync time: publishedAt drives analysis windows, and the dedup
        // index would freeze a fabricated date forever.
        const datedPosts = result.posts.filter((post) => post.createdAt !== null);
        const synced = await recordSyncedSocialPosts(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          connectionId,
          subjectId: authority.subjectId,
          posts: datedPosts.map((post) => ({
            externalPostId: post.id,
            url: post.url,
            authorHandle: post.author,
            text: post.text,
            publishedAt: new Date(post.createdAt!),
            metrics: post.metrics,
          })),
        });
        return json({
          provider: result.connection.provider,
          fetched: result.posts.length,
          inserted: synced.inserted,
          skipped: synced.skipped,
          skippedMissingDate: result.posts.length - datedPosts.length,
        });
      },
    );

    server.registerTool(
      "social_post_reply",
      {
        description:
          "Publish a reply from the connected social account. X: inReplyToId is the tweet id to reply to. Reddit: inReplyToId is a fullname (t3_<post> or t1_<comment>). Draft and get approval before calling this — it posts publicly and immediately.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          inReplyToId: z4.string().min(1).max(100),
          text: z4.string().min(1).max(10000),
        },
      },
      async ({ connectionId, inReplyToId, text }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialPostReply(
          deps,
          {
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
          },
          { inReplyToId, text },
        );
        // Outbound publishes leave a durable, secret-free receipt (house
        // pattern: the Slack bot post audit), so who posted what where stays
        // answerable after the session is gone.
        await recordAuditEvent(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          action: "social.post_reply",
          targetType: "social_connection",
          targetId: connectionId,
          metadata: {
            provider: result.connection.provider,
            inReplyToId,
            postedId: result.postedId,
            url: result.url,
          },
        });
        return json({
          provider: result.connection.provider,
          postedId: result.postedId,
          url: result.url,
        });
      },
    );

    for (const provider of ["x", "reddit"] as const) {
      const providerName = provider === "x" ? "X" : "Reddit";
      server.registerTool(
        `${provider}_posts_sync`,
        {
          description: `Sync one exact connected ${providerName} account's recent posts into OpenGeni (idempotent).`,
          inputSchema: {
            connectionId: z4.string().uuid(),
            limit: z4.number().int().positive().optional(),
          },
        },
        async ({ connectionId, limit }) => {
          const authority = await requireAuthorizedSocialConnectionForProvider(
            provider,
            connectionId,
          );
          const result = await socialOwnPostsLive(
            deps,
            {
              workspaceId: grant.workspaceId,
              connectionId,
              subjectId: authority.subjectId,
            },
            { limit },
          );
          const datedPosts = result.posts.filter((post) => post.createdAt !== null);
          const synced = await recordSyncedSocialPosts(deps.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            connectionId,
            subjectId: authority.subjectId,
            posts: datedPosts.map((post) => ({
              externalPostId: post.id,
              url: post.url,
              authorHandle: post.author,
              text: post.text,
              publishedAt: new Date(post.createdAt!),
              metrics: post.metrics,
            })),
          });
          return json({
            provider: result.connection.provider,
            fetched: result.posts.length,
            inserted: synced.inserted,
            skipped: synced.skipped,
            skippedMissingDate: result.posts.length - datedPosts.length,
          });
        },
      );
      server.registerTool(
        `${provider}_post_reply`,
        {
          description: `Publish a reply from one exact connected ${providerName} account. This is a public write and should require approval.`,
          inputSchema: {
            connectionId: z4.string().uuid(),
            inReplyToId: z4.string().min(1).max(100),
            text: z4.string().min(1).max(10000),
          },
        },
        async ({ connectionId, inReplyToId, text }) => {
          const authority = await requireAuthorizedSocialConnectionForProvider(
            provider,
            connectionId,
          );
          const result = await socialPostReply(
            deps,
            {
              workspaceId: grant.workspaceId,
              connectionId,
              subjectId: authority.subjectId,
            },
            { inReplyToId, text },
          );
          await recordAuditEvent(deps.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            action: "social.post_reply",
            targetType: "social_connection",
            targetId: connectionId,
            metadata: {
              provider: result.connection.provider,
              adapterTool: `${provider}_post_reply`,
              inReplyToId,
              postedId: result.postedId,
              url: result.url,
            },
          });
          return json({
            provider: result.connection.provider,
            postedId: result.postedId,
            url: result.url,
          });
        },
      );
    }
  }

  if (can("scheduled_tasks:manage") || can("scheduled_tasks:run")) {
    server.registerTool(
      "scheduled_tasks_list",
      {
        description:
          "List compact scheduled-task summaries. Prompts, goal text, resource/tool bodies, and metadata values are represented by byte/count facts; page with offset and use scheduled_tasks_get for a bounded explicit detail projection.",
        inputSchema: {
          limit: z4.number().int().positive().max(50).optional(),
          offset: z4.number().int().nonnegative().max(10_000).optional(),
        },
      },
      async ({ limit: requestedLimit, offset: requestedOffset }) => {
        const limit = requestedLimit ?? 25;
        const offset = requestedOffset ?? 0;
        const rows = await listScheduledTasks(deps.db, grant.workspaceId, limit + 1, offset);
        return json(
          boundScheduledTaskMcpPage({
            tasks: rows.slice(0, limit).map((task) => scheduledTaskForGrant(task, grant)),
            limit,
            offset,
            sourceHasMore: rows.length > limit,
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_get",
      {
        description:
          "Get one scheduled task. The default is the same compact summary used by scheduled_tasks_list; pass includeEntity=true for a bounded projection with an 8 KiB prompt preview, bounded goal fields, resource/tool identity previews, and metadata keys without values.",
        inputSchema: {
          id: z4.string().uuid(),
          includeEntity: z4.boolean().optional(),
        },
      },
      async ({ id, includeEntity }) => {
        const task = scheduledTaskForGrant(
          await requireScheduledTask(deps.db, grant.workspaceId, id),
          grant,
        );
        return json(
          includeEntity ? boundScheduledTaskDetailMcp(task) : scheduledTaskMcpSummary(task),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_create",
      {
        description:
          "Create a scheduled task. Sessions generated for a task created from this session inherit this session's effective first-party tool selection and permission set; they never receive the deployment default catalog. To have runs post to Slack as the OpenGeni bot, a person must choose the channel in the schedule editor; you cannot set agentConfig.slackBotChannelId.",
        inputSchema: contractToolInput(
          z4
            .object({
              ...CreateScheduledTaskRequest.options[1].out.shape,
              agentConfig: z4
                .object(ScheduledTaskAgentConfigInput.shape)
                .omit({ slackBotChannelId: true })
                .strict(),
            })
            .omit({ agentLearning: true, connectionAuthorities: true })
            .strict(),
          CreateScheduledTaskRequest.options[1],
        ),
      },
      async (args) => {
        const payload = CreateScheduledTaskRequest.parse(args);
        requireAgentConfigAdmission(deps.settings, scheduledTaskAgentInput(payload));
        requireVariableSetsUseForMcpAttachment(grant, payload.variableSetId);
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          action: "schedule:create",
          quantity: 1,
        });
        const task = await createValidatedScheduledTask({
          settings: deps.settings,
          db: deps.db,
          objectStorage: deps.objectStorage,
          grant,
          payload,
          toolsProvided: scheduledTaskToolsProvided(args),
          sessionAuthorization: deps.sessionAuthorization,
          authorizationSurface: "first_party_mcp",
        });
        try {
          await syncCreatedScheduledTask({
            db: deps.db,
            workflowClient: deps.workflowClient,
            task,
          });
        } catch (error) {
          if (!(error instanceof ScheduledTaskSyncError) || error.persistenceRestored) {
            throw error;
          }
          return json(
            scheduledTaskReceipt("scheduled_tasks_create", task, "partial_failure", true, {
              partialFailure: { stage: "schedule_sync", retryable: true },
              warnings: [
                "The task database record committed, but Temporal schedule synchronization failed.",
              ],
            }),
          );
        }
        return json(scheduledTaskReceipt("scheduled_tasks_create", task, "created", true));
      },
    );

    server.registerTool(
      "scheduled_tasks_update",
      {
        description:
          "Update a scheduled task. For model/reasoning-only edits use agentConfigPatch: { model?, reasoningEffort? }; all omitted configuration is preserved. agentConfig is a complete replacement, and scheduled_tasks_get is a bounded projection, not replacement input. Task model settings apply to newly created sessions; existing-session targets and already-created reusable sessions keep their own model/reasoning.",
        inputSchema: contractToolInput(
          z4
            .object({
              ...UpdateScheduledTaskRequest.out.shape,
              id: z4.string().uuid(),
              action: CreateScheduledTaskRequest.options[1].out.shape.action.optional(),
              agentConfig: z4
                .object(ScheduledTaskAgentConfigInput.shape)
                .omit({ slackBotChannelId: true })
                .strict()
                .optional(),
            })
            .omit({ agentLearning: true, connectionAuthorities: true })
            .strict(),
          UpdateScheduledTaskRequest,
        ),
      },
      async ({ id, ...raw }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const payload = UpdateScheduledTaskRequest.parse(raw);
        requireAgentConfigAdmission(deps.settings, scheduledTaskAgentInput(payload));
        const patchWarnings = (task: ScheduledTask) =>
          payload.agentConfigPatch &&
          (task.runMode === "existing_session" || task.reusableSessionId)
            ? [
                "The task uses an existing session, whose model and reasoning are unchanged. Change that session separately if intended.",
              ]
            : [];
        requireVariableSetsUseForMcpAttachment(grant, payload.variableSetId);
        const update = await validatedScheduledTaskUpdate({
          settings: deps.settings,
          db: deps.db,
          objectStorage: deps.objectStorage,
          grant,
          existing,
          payload,
          toolsProvided: scheduledTaskToolsProvided(raw),
          sessionAuthorization: deps.sessionAuthorization,
          authorizationSurface: "first_party_mcp",
        });
        if (!scheduledTaskUpdateChangesState(existing, update)) {
          return json(
            scheduledTaskReceipt("scheduled_tasks_update", existing, "unchanged", false, {
              warnings: patchWarnings(existing),
            }),
          );
        }
        const task = await updateScheduledTaskForApi(deps.db, grant, id, update);
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(
          scheduledTaskReceipt("scheduled_tasks_update", task, "updated", true, {
            warnings: patchWarnings(task),
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_pause",
      {
        description: "Pause a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        if (existing.status === "paused") {
          return json(scheduledTaskReceipt("scheduled_tasks_pause", existing, "unchanged", false));
        }
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const task = await updateScheduledTaskForApi(deps.db, grant, id, {
          status: "paused",
        });
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(scheduledTaskReceipt("scheduled_tasks_pause", task, "updated", true));
      },
    );

    server.registerTool(
      "scheduled_tasks_resume",
      {
        description: "Resume a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        if (existing.status === "active") {
          return json(scheduledTaskReceipt("scheduled_tasks_resume", existing, "unchanged", false));
        }
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const update = await validatedScheduledTaskUpdate({
          settings: deps.settings,
          db: deps.db,
          objectStorage: deps.objectStorage,
          grant,
          existing,
          payload: { status: "active" },
          sessionAuthorization: deps.sessionAuthorization,
          authorizationSurface: "first_party_mcp",
        });
        const task = await updateScheduledTaskForApi(deps.db, grant, id, update);
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(scheduledTaskReceipt("scheduled_tasks_resume", task, "updated", true));
      },
    );

    server.registerTool(
      "scheduled_tasks_trigger",
      {
        description:
          "Trigger a scheduled task immediately. Pass a stable triggerId to make a retried trigger idempotent (one charge, one run).",
        inputSchema: {
          id: z4.string().uuid(),
          triggerId: z4.string().min(1).max(128).optional(),
        },
      },
      async ({ id, triggerId }) => {
        const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
        if (task.action.kind === "agent_turn") {
          const targetSession = await validateScheduledTaskTarget({
            db: deps.db,
            sessionAuthorization: deps.sessionAuthorization,
            authorizationSurface: "first_party_mcp",
            grant,
            targetSessionId: task.targetSessionId,
            runMode: task.runMode,
            variableSetId: task.variableSetId,
            rigId: task.rigId,
            agentConfig: task.agentConfig,
            missingTargetStatus: 404,
          });
          const catalogSourceSettings = deps.catalogSourceSettings ?? deps.settings;
          const catalogSettings = (
            await resolveWorkspaceCatalogSettings(deps.db, catalogSourceSettings, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              ...(targetSession ? { retainedProductModelId: targetSession.model } : {}),
            })
          ).settings;
          await validateScheduledTaskMachineTarget({
            settings: catalogSettings,
            db: deps.db,
            grant,
            runMode: task.runMode,
            agentConfig: task.agentConfig,
            requireOnline: true,
          });
          const taskAuthoritySubjectId = await getScheduledTaskRevisionAuthoritySubject(deps.db, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            taskAuthorityRevision: task.authorityRevision,
          });
          await requireLimit(
            { ...deps, settings: catalogSettings },
            {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              initiatingHumanSubjectId:
                taskAuthoritySubjectId === task.ownerSubjectId ? taskAuthoritySubjectId : null,
              action: "agent_run:create",
              quantity: 1,
              model: await resolveScheduledTaskPreflightModel(deps.db, catalogSettings, task),
            },
          );
        }
        const triggerToken = scheduledTaskTriggerToken(triggerId);
        const agentRunUsageIdempotencyKey =
          task.action.kind === "agent_turn"
            ? manualScheduledTaskTriggerUsageKey(grant.workspaceId, task.id, triggerToken)
            : `knowledge-source-sync:manual:${grant.workspaceId}:${task.id}:${triggerToken}`;
        const triggerWorkflowId = manualScheduledTaskTriggerWorkflowId(task.id, triggerToken);
        await triggerScheduledTaskForGrant(deps.db, grant, deps.workflowClient, {
          task,
          agentRunUsageIdempotencyKey,
          triggerWorkflowId,
          initiator: { kind: "subject", subjectId: grant.subjectId },
        });
        try {
          if (task.action.kind !== "agent_turn") {
            return json(
              scheduledTaskReceipt("scheduled_tasks_trigger", task, "triggered", true, {
                idempotencyStatus: triggerId ? "unknown" : "not_requested",
                facts: { triggerWorkflowId },
              }),
            );
          }
          await recordWorkspaceUsage(deps, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            eventType: "agent_run.created",
            quantity: 1,
            unit: "run",
            sourceResourceType: "scheduled_task",
            sourceResourceId: task.id,
            idempotencyKey: agentRunUsageIdempotencyKey,
          });
        } catch {
          return json(
            scheduledTaskReceipt("scheduled_tasks_trigger", task, "partial_failure", true, {
              partialFailure: { stage: "usage_recording", retryable: true },
              warnings: [
                "The Temporal run trigger completed, but usage recording failed; retry with the same triggerId.",
              ],
              idempotencyStatus: triggerId ? "unknown" : "not_requested",
              facts: { triggerWorkflowId },
            }),
          );
        }
        return json(
          scheduledTaskReceipt("scheduled_tasks_trigger", task, "triggered", true, {
            idempotencyStatus: triggerId ? "unknown" : "not_requested",
            facts: { triggerWorkflowId },
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_delete",
      {
        description: "Delete a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const { task, changed } = await deleteScheduledTaskWithDurableCleanup(deps, {
          grant,
          taskId: id,
        });
        return json(
          mcpMutationReceipt({
            operation: "scheduled_tasks_delete",
            committed: true,
            outcome: "deleted",
            changed,
            resource: { type: "scheduled_task", id: task.id, state: "deleted" },
            idempotency: { status: changed ? "applied" : "replayed" },
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_task_runs_list",
      {
        description: "List runs for a scheduled task.",
        inputSchema: {
          taskId: z4.string().uuid(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ taskId, limit }) =>
        json({
          runs: (await listScheduledTaskRuns(deps.db, grant.workspaceId, taskId, limit ?? 100)).map(
            (run) => scheduledTaskRunForGrant(run, grant),
          ),
        }),
    );
  }

  server.ensureToolsListHandler();

  return server;
}

function registerSandboxFileArtifactTool(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  server.registerTool(
    "sandbox_file_publish",
    {
      description:
        "Publish one exact file from this session's /workspace into durable workspace storage. Use this before presenting a video, ZIP, CSV, JSON, Markdown, HTML, PDF, Office file, or other sandbox output as downloadable. Present the returned artifact.artifactId as [Open file](artifact:<artifactId>), or ![Preview](artifact:<artifactId>) for inline image/video/audio/PDF previews. Replace <artifactId> with the exact returned ID and use a descriptive label. Never expose a sandbox: URL as the durable result.",
      inputSchema: {
        path: z4.string().min(1).max(4_096),
      },
    },
    async ({ path }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
      const session = await requireSession(deps.db, grant.workspaceId, sessionId);
      return json(
        await publishSandboxFileArtifact(deps, {
          grant,
          session,
          path,
        }),
      );
    },
  );
}

function registerSlackBotTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string | null,
  json: JsonResult,
): void {
  const clientFor = async (connectionId?: string) => {
    const resolved = await resolveSlackBotConnectionForTool({
      db: deps.db,
      grant,
      sessionId,
      ...(connectionId ? { requestedConnectionId: connectionId } : {}),
    });
    return createOpenGeniSlackBotClient(deps, resolved);
  };

  server.registerTool(
    "slack_bot_list_channels",
    {
      description:
        "List public and bot-visible private Slack channels through the workspace-shared OpenGeni bot. isMember identifies channels the bot may read/post in; the bot never joins channels automatically.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listChannels({
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  // Real-time Search requires an approved app and a trusted Slack interaction
  // action token. Generic agent calls cannot provide that interaction proof.

  server.registerTool(
    "slack_bot_channel_history",
    {
      description:
        "Read Slack channel history as the workspace-shared OpenGeni bot. Public and private channels both require bot membership; invite the bot to private channels first.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(100).optional(),
      },
    },
    async ({ connectionId, channelId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).channelHistory({
          channelId,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_thread_replies",
    {
      description:
        "Read a Slack thread as the workspace-shared OpenGeni bot. Pass the channel ID and the parent message timestamp returned by channel history. The result includes the parent followed by its replies.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        threadTimestamp: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(100).optional(),
      },
    },
    async ({ connectionId, channelId, threadTimestamp, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).threadReplies({
          channelId,
          threadTimestamp,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_list_users",
    {
      description: "List Slack workspace users through the workspace-shared OpenGeni bot.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listUsers({
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_list_files",
    {
      description:
        "List Slack files and canvases shared with a channel where the workspace-shared OpenGeni bot is already a member.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, channelId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listFiles({
          channelId,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_file_info",
    {
      description:
        "Read safe metadata for a Slack file or canvas shared with a channel where the workspace-shared OpenGeni bot is already a member. For an embedded huddle transcript, also pass the shared canvas file ID as parentFileId so OpenGeni can verify the indirect share.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        fileId: z4.string().min(1).max(64),
        parentFileId: z4.string().min(1).max(64).optional(),
      },
    },
    async ({ connectionId, channelId, fileId, parentFileId }) =>
      json(
        await (
          await clientFor(connectionId)
        ).fileInfo({
          channelId,
          fileId,
          ...(parentFileId ? { parentFileId } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_file_content",
    {
      description:
        "Read a bounded page of text or view a PNG, JPEG, or WebP image from a Slack file shared with a channel where the workspace-shared OpenGeni bot is already a member. Use the file ID from thread replies to view images in earlier thread messages. Images are returned as viewable content, only when directly shared to a non-shared channel, up to 640 KiB; offset must be 0. For an embedded huddle transcript, also pass the shared canvas file ID as parentFileId so OpenGeni can verify the channel-to-canvas-to-transcript chain. Slack may still restrict a huddle transcript body to participants; that returns huddle_transcript_requires_participant_access. Private Slack URLs and credentials are never returned. Continue with nextOffset for truncated text.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        fileId: z4.string().min(1).max(64),
        parentFileId: z4.string().min(1).max(64).optional(),
        offset: z4.number().int().min(0).max(4_000_000).optional(),
      },
      outputSchema: {
        kind: z4.enum(["text", "image"]),
        fileId: z4.string(),
        contentType: z4.string(),
        content: z4.string().nullable(),
        sizeBytes: z4.number().int().nullable(),
        nextOffset: z4.number().int().nullable(),
      },
    },
    async ({ connectionId, channelId, fileId, parentFileId, offset }) => {
      const result = await (
        await clientFor(connectionId)
      ).fileContent({
        channelId,
        fileId,
        ...(parentFileId ? { parentFileId } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
      return slackBotFileContentResult(result);
    },
  );

  server.registerTool(
    "slack_bot_upload_file",
    {
      description:
        "Upload one explicitly selected retained workspace file (including generated images) into this session's existing Slack task thread as the OpenGeni bot. Use the file/artifact UUID returned by sandbox_file_publish or image generation. No channel or URL is accepted. Generate one operationId UUID per intended delivery and reuse the same operationId on every retry, including unknown outcomes; never start a replacement delivery to retry. Requires the bot's optional files:write scope: a Slack administrator must apply the bot manifest and reinstall an older bot, not connect a personal Slack account. Nonempty files up to 25 MiB; personal files stay in private task threads. Does not automatically upload files merely because they appear in a message.",
      inputSchema: { fileId: z4.string().uuid(), operationId: z4.string().uuid() },
    },
    async ({ fileId, operationId }) => {
      if (!sessionId) throw new Error("File upload requires an existing Slack task session");
      return json(
        await uploadSlackTaskFile(deps, {
          grant,
          sessionId,
          fileId,
          operationId,
          authorize: async () => {
            await authorizeFirstPartySession(
              deps,
              grant,
              sessionId,
              "session.first_party_mcp.call",
            );
          },
        }),
      );
    },
  );

  // Scheduled runs post only to the channel a person chose on the task. The
  // tools take no channel: the destination is read from the task each time,
  // and the prepared message id is the durable Slack delivery identity.
  const authorizeScheduledPost = async () => {
    if (sessionId === null) {
      throw new Error("Posting to the task's Slack channel requires a scheduled task run");
    }
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };
  server.registerTool(
    "slack_bot_prepare_message",
    {
      description:
        "Prepare a message for this scheduled task's Slack channel, posted as the OpenGeni workspace bot. The channel was chosen by a person on the task; you cannot pick another one. This saves the exact text without sending it. Then call slack_bot_send_prepared_message with the returned messageId. Pass threadTimestamp (a timestamp returned by an earlier send) to reply in that thread of the same channel.",
      inputSchema: {
        text: z4.string().min(1).max(40_000),
        threadTimestamp: z4
          .string()
          .regex(/^\d{1,20}\.\d{1,12}$/)
          .optional(),
      },
    },
    async ({ text, threadTimestamp }) => {
      await authorizeScheduledPost();
      return json(
        await prepareScheduledSlackBotPost({
          db: deps.db,
          grant,
          sessionId,
          text,
          ...(threadTimestamp ? { threadTimestamp } : {}),
        }),
      );
    },
  );
  server.registerTool(
    "slack_bot_send_prepared_message",
    {
      description:
        "Send a message prepared by slack_bot_prepare_message in this chat, exactly as saved, to the task's Slack channel as the OpenGeni workspace bot. If a send is interrupted or its outcome is unclear, retry with the same messageId: OpenGeni checks Slack and never posts the same message twice. Do not prepare a new message just to retry.",
      inputSchema: { messageId: z4.string().uuid() },
    },
    async ({ messageId }) => {
      await authorizeScheduledPost();
      return json(
        await sendScheduledSlackBotPost({
          db: deps.db,
          settings: deps.settings,
          grant,
          sessionId,
          messageId,
          ...(deps.slackFetch ? { slackFetch: deps.slackFetch } : {}),
          authorizeProviderRequest: authorizeScheduledPost,
        }),
      );
    },
  );

  server.registerTool(
    "slack_bot_delete_message",
    {
      description:
        "Delete a message authored by the workspace-shared OpenGeni bot. Pass the channel ID and exact message timestamp returned by a prior post or channel/thread read. Generate one operationId UUID per intended deletion and reuse it on every retry, including after an unknown outcome. Slack refuses deletion of messages not authored by this bot.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        operationId: z4.string().uuid(),
        channelId: z4.string().min(1).max(64),
        timestamp: z4.string().min(1).max(64),
      },
    },
    async ({ connectionId, operationId, channelId, timestamp }) =>
      json(
        await (await clientFor(connectionId)).deleteMessage({ operationId, channelId, timestamp }),
      ),
  );
}

function registerFikenTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string | null,
  json: JsonResult,
): void {
  // One resolution per requested connection per MCP server instance: the
  // bound row cannot change mid-request, and re-resolving on every tool call
  // would pay an extra connections read each time.
  const clients = new Map<string, Promise<ReturnType<typeof createFikenClient>>>();
  const clientFor = (connectionId?: string) => {
    const cacheKey = connectionId ?? "";
    let client = clients.get(cacheKey);
    if (!client) {
      client = resolveFikenConnectionForTool({
        db: deps.db,
        grant,
        sessionId,
        ...(connectionId ? { requestedConnectionId: connectionId } : {}),
      }).then((resolved) => createFikenClient(deps, resolved));
      // A failed resolution must not be cached as a poisoned entry.
      client.catch(() => clients.delete(cacheKey));
      clients.set(cacheKey, client);
    }
    return client;
  };
  const companySlugInput = z4
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Fiken company slug. Optional when the connection has a default company or access to exactly one company.",
    );
  const pageInputs = {
    page: z4.number().int().min(0).optional(),
    pageSize: z4.number().int().min(1).max(100).optional(),
  };
  const isoDate = z4
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional();

  server.registerTool(
    "fiken_companies_list",
    {
      description:
        "List the Fiken companies this workspace's Fiken connection can act on. Use the returned slug as companySlug in other fiken tools.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        ...pageInputs,
      },
    },
    async ({ connectionId, page, pageSize }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listCompanies({
          ...(page !== undefined ? { page } : {}),
          ...(pageSize !== undefined ? { pageSize } : {}),
        }),
      ),
  );

  server.registerTool(
    "fiken_contacts_list",
    {
      description:
        "List or search contacts (customers and suppliers) in a Fiken company. Filters combine with AND. customerId used elsewhere equals a contact's contactId where customer is true.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        name: z4.string().min(1).max(256).optional(),
        email: z4.string().min(1).max(256).optional(),
        organizationNumber: z4.string().min(1).max(64).optional(),
        customer: z4.boolean().optional(),
        supplier: z4.boolean().optional(),
        inactive: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listContacts(input)),
  );

  server.registerTool(
    "fiken_contact_create",
    {
      description:
        "Create a contact in a Fiken company. Retrying after an unknown outcome may create a duplicate; search fiken_contacts_list first when unsure.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        name: z4.string().min(1).max(256),
        email: z4.string().min(1).max(256).optional(),
        organizationNumber: z4.string().min(1).max(64).optional(),
        phoneNumber: z4.string().min(1).max(64).optional(),
        customer: z4.boolean().optional(),
        supplier: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).createContact(input)),
  );

  server.registerTool(
    "fiken_products_list",
    {
      description: "List products in a Fiken company.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        name: z4.string().min(1).max(256).optional(),
        active: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listProducts(input)),
  );

  server.registerTool(
    "fiken_invoices_list",
    {
      description:
        "List invoices in a Fiken company. Dates are yyyy-mm-dd; monetary amounts in results are in cents/øre of the invoice currency.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        issueDateGe: isoDate,
        issueDateLe: isoDate,
        customerId: z4.number().int().positive().optional(),
        settled: z4.boolean().optional(),
        invoiceNumber: z4.string().min(1).max(64).optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listInvoices(input)),
  );

  server.registerTool(
    "fiken_invoice_get",
    {
      description: "Read a single Fiken invoice by its invoiceId.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        invoiceId: z4.number().int().positive(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).getInvoice(input)),
  );

  server.registerTool(
    "fiken_invoice_draft_create",
    {
      description:
        "Create an invoice DRAFT in Fiken. Drafts are not sent to the customer; a human finishes and sends them from Fiken. unitPriceCents is the net price per unit in cents/øre. Each line needs either productId or an incomeAccount + vatType. Generate one operationId UUID per intended draft and reuse that same UUID on every retry; a retry returns the existing draft instead of duplicating it.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        operationId: z4.string().uuid(),
        customerId: z4.number().int().positive(),
        daysUntilDueDate: z4.number().int().min(0).max(365),
        invoiceText: z4.string().max(500).optional(),
        yourReference: z4.string().max(128).optional(),
        ourReference: z4.string().max(128).optional(),
        currency: z4
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        bankAccountNumber: z4.string().min(1).max(64).optional(),
        lines: z4
          .array(
            z4.object({
              description: z4.string().max(200).optional(),
              productId: z4.number().int().positive().optional(),
              unitPriceCents: z4.number().int().optional(),
              vatType: z4.string().min(1).max(64).optional(),
              quantity: z4.number().positive(),
              discountPercent: z4.number().min(0).max(100).optional(),
              incomeAccount: z4.string().min(1).max(16).optional(),
              comment: z4.string().max(200).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).createInvoiceDraft(input)),
  );

  server.registerTool(
    "fiken_bank_accounts_list",
    {
      description:
        "List bank accounts in a Fiken company, including reconciled balances in cents/øre.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        inactive: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listBankAccounts(input)),
  );

  server.registerTool(
    "fiken_purchases_list",
    {
      description: "List purchases in a Fiken company. Dates are yyyy-mm-dd.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        dateGe: isoDate,
        dateLe: isoDate,
        paid: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listPurchases(input)),
  );

  server.registerTool(
    "fiken_sales_list",
    {
      description: "List sales in a Fiken company. Dates are yyyy-mm-dd.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        companySlug: companySlugInput,
        ...pageInputs,
        dateGe: isoDate,
        dateLe: isoDate,
        settled: z4.boolean().optional(),
      },
    },
    async ({ connectionId, ...input }) =>
      json(await (await clientFor(connectionId)).listSales(input)),
  );
}

/** Only a prompt explicitly supplied through the human/API channel may redirect a user-paused goal. */
export function isHumanDirectedTurn(turn: { source: string }): boolean {
  return turn.source === "user" || turn.source === "api";
}

/**
 * Sacred user pause: a goal a human paused (pausedReason 'user_pause') must
 * never be resurrected by a MACHINE turn. Child-completion notification turns
 * carry a "resume it now" nudge; without this guard the agent processing one of
 * them would call goal_set and re-arm the exact autonomous loop the user just
 * paused (the runaway that made Pause feel broken). A genuine user message
 * still redirects freely (it is not a child-notification turn), and the
 * human-driven API resume path (PATCH /goal) is unaffected.
 *
 * Classification is by CALLER IDENTITY — `callerTurnId` is the turn that minted
 * this MCP token (signed into it by the worker at turn setup). We deliberately
 * do NOT read the session's live `active_turn_id`: that pointer can flip to a
 * different turn between reads (a machine turn ends and a human turn becomes
 * active mid-check), which would misclassify the caller and, worst case, refuse
 * a legitimate human `goal_set` — inverting the guard against the very human
 * power it must preserve. A caller turn's source/metadata are immutable, so this
 * read is race-free. No caller identity ⇒ fail OPEN (only a positively
 * identified machine child-notification caller is refused).
 */
export async function assertGoalReactivationAllowed(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  callerTurnId: string | null,
): Promise<void> {
  if (!callerTurnId) {
    return;
  }
  const goal = await getSessionGoal(deps.db, workspaceId, sessionId);
  if (!goal || goal.status !== "paused" || goal.pausedReason !== "user_pause") {
    return;
  }
  const turn = await getSessionTurn(deps.db, workspaceId, callerTurnId);
  if (turn && !isHumanDirectedTurn(turn)) {
    throw new Error(
      "This session was paused by the user. An internal turn cannot resume or replace the goal — only a new human/API prompt can. Report your findings and do not call goal_set.",
    );
  }
}

function registerGoalTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> },
): void {
  const boundedGoalToolString = (maxBytes: number, field: string, purpose: string) =>
    z4
      .string()
      .min(1)
      .max(maxBytes)
      .describe(
        `${purpose} At most ${maxBytes} UTF-8 bytes (ASCII characters count as one byte). Use normal spaces and sentences; summarize if needed, never squeeze words together. This is a ledger field, not the final answer.`,
      )
      .refine((value) => sessionGoalUtf8Bytes(value) <= maxBytes, {
        message: `${field} exceeds ${maxBytes} UTF-8 bytes`,
      });
  const goalText = boundedGoalToolString(
    SESSION_GOAL_TEXT_MAX_BYTES,
    "goal text",
    "The human-readable standing objective, not a progress report.",
  );
  const successCriteriaSchema = boundedGoalToolString(
    SESSION_GOAL_SUCCESS_CRITERIA_MAX_BYTES,
    "goal success criteria",
    "Human-readable conditions that prove the full objective is achieved.",
  );
  const goalRationale = boundedGoalToolString(
    SESSION_GOAL_RATIONALE_MAX_BYTES,
    "goal rationale",
    "A short human-readable explanation of the goal change or blocker and what must happen next.",
  );
  const progressNoteSchema = boundedGoalToolString(
    SESSION_GOAL_PROGRESS_MAX_BYTES,
    "goal progress note",
    "A short human-readable status of concrete progress toward the unchanged goal. Keep only useful milestones; do not pack a deliverable, command transcript, or continuation instructions here.",
  );
  const inputWaitReasonSchema = boundedGoalToolString(
    2 * 1024,
    "session input wait reason",
    "One short human-readable sentence explaining the dependency being awaited.",
  ).refine((value) => value.trim().length > 0, {
    message: "session input wait reason must not be blank",
  });
  server.registerTool(
    "goal_set",
    {
      description:
        "Create a goal when this session has none, or replace a completed goal with a new one. text is the human-readable objective and successCriteria states its completion conditions; each allows 8192 UTF-8 bytes. Keep normal spaces; summarize, never compress words or put the deliverable in ledger text. Declare user-facing native document reports with reportRequirements before producing them. While active, idle moments synthesize continuation turns until goal_complete or goal_pause. To change an active or paused goal, use goal_update with its objective revision, a change kind, and rationale.",
      // `maxAutoContinuations` is deliberately not agent-facing: the ceiling is
      // API/scheduled-task pacing configuration, and an agent that set its own
      // cap used to silence its orchestration for hours. Continuation pacing is
      // the deployment's input-aware idle backoff instead.
      inputSchema: {
        text: goalText,
        successCriteria: successCriteriaSchema.optional(),
        reportRequirements: SessionGoalReportRequirements.optional(),
      },
    },
    async ({ text, successCriteria, reportRequirements }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (existing && existing.status !== "completed") {
        throw new Error(
          `this session's goal is ${existing.status} at objective revision ${existing.objectiveRevision}; use goal_update to revise it`,
        );
      }
      const callerTurnId =
        typeof grant.metadata?.["turnId"] === "string"
          ? (grant.metadata["turnId"] as string)
          : null;
      await assertGoalReactivationAllowed(deps, grant.workspaceId, sessionId, callerTurnId);
      const context = exactAgentCommandContext(grant, sessionId);
      const { goal, replaced, events } = await upsertSessionGoalWithEvent(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        text,
        successCriteria: successCriteria ?? null,
        ...(reportRequirements !== undefined ? { reportRequirements } : {}),
        maxAutoContinuations: null,
        createdBy: "agent",
        actor: "agent",
        commandActor: {
          type: "agent_attempt",
          sessionId: context.callerSessionId,
          turnId: context.callerTurnId,
          attemptId: context.callerAttemptId,
          executionGeneration: context.callerExecutionGeneration,
        },
      });
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json(
        mcpMutationReceipt({
          operation: "goal_set",
          committed: true,
          outcome: replaced ? "updated" : "created",
          changed: true,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          facts: { replaced },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
      );
    },
  );

  server.registerTool(
    "goal_update",
    {
      description:
        "Maintain your operational goal as user direction or meaningful new evidence clarifies the intended outcome. text and successCriteria each allow 8192 UTF-8 bytes; rationale allows 2048 UTF-8 bytes for a short human-readable explanation. Use normal spaces and summarize instead of squeezing words. Changes apply directly unless the user explicitly configured review_changes; refinement, adaptation, and replacement are audit classifications, not approval gates under the default policy. Use the exact expected objective revision. Updating a goal grants no additional authority and cannot change root constraints. Progress notes belong in goal_progress (8192 UTF-8 bytes), not a semantic goal rewrite; deliver the answer in your final reply.",
      inputSchema: {
        text: goalText.optional(),
        successCriteria: successCriteriaSchema.nullable().optional(),
        changeKind: z4.enum(["refinement", "adaptation", "replacement"]),
        rationale: goalRationale,
        expectedObjectiveRevision: z4.number().int().positive(),
        idempotencyKey: z4.string().uuid(),
      },
    },
    async ({
      text,
      successCriteria,
      changeKind,
      rationale,
      expectedObjectiveRevision,
      idempotencyKey,
    }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      if (text === undefined && successCriteria === undefined) {
        throw new Error("goal_update requires text or successCriteria");
      }
      const context = exactAgentCommandContext(grant, sessionId);
      const command = {
        accountId: grant.accountId,
        actor: {
          type: "agent_attempt" as const,
          attemptId: context.callerAttemptId,
          sessionId: context.callerSessionId,
          turnId: context.callerTurnId,
          executionGeneration: context.callerExecutionGeneration,
        },
        operationKey: idempotencyKey,
      };
      const semantic = await updateSessionGoalWithEvent(deps.db, grant.workspaceId, sessionId, {
        ...(text !== undefined ? { text } : {}),
        ...(successCriteria !== undefined ? { successCriteria } : {}),
        changeKind,
        rationale,
        expectedObjectiveRevision,
        actor: "agent",
        command,
      });
      await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, semantic.events);
      return json({
        ...semantic.goal,
        operationId: semantic.operationId,
        replay: semantic.replay,
        outcome: semantic.outcome,
        proposalId: semantic.proposalId,
      });
    },
  );

  server.registerTool(
    "goal_progress",
    {
      description:
        "Record concrete progress toward the unchanged active goal. progressNote is a short human-readable status with useful milestones, at most 8192 UTF-8 bytes. Use normal spaces and sentences; summarize instead of compressing words. It is not the deliverable, a raw command transcript, or instructions for the next turn; the final answer still belongs in chat. Optionally append reportRequirements for secondary user-facing reports discovered during other work; existing requirement IDs and titles cannot be changed or removed. This does not change goal text, success criteria, mutation policy, or objective revision. Do not use it merely to keep the continuation loop alive.",
      inputSchema: {
        progressNote: progressNoteSchema,
        idempotencyKey: z4.string().uuid(),
        reportRequirements: SessionGoalReportRequirements.optional(),
      },
    },
    async ({ progressNote, idempotencyKey, reportRequirements }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      const context = exactAgentCommandContext(grant, sessionId);
      const { goal, events, operationId, replay } = await recordSessionGoalProgressWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          progressNote,
          ...(reportRequirements !== undefined ? { reportRequirements } : {}),
          command: {
            accountId: grant.accountId,
            actor: {
              type: "agent_attempt",
              attemptId: context.callerAttemptId,
              sessionId: context.callerSessionId,
              turnId: context.callerTurnId,
              executionGeneration: context.callerExecutionGeneration,
            },
            operationKey: idempotencyKey,
          },
        },
      );
      await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, events);
      return json({ ...goal, operationId, replay });
    },
  );

  server.registerTool(
    "wait_for_input",
    {
      description:
        "End the current turn and wait out of turn for relevant session input. This is self-only and does not require a goal. After success, the production runtime ends the turn at the tool-batch boundary without another model step or final message. Use it for long or uncertain waits, including right after spawning a child that needs minutes, instead of sleeping or repeatedly calling session_wait, session_get, or command_wait. No preliminary short wait or status recheck is required. timeoutSeconds is a relative safety-wake duration, not a blocking execution wait; choose it for the dependency or a meaningful user/task/Skill monitoring cadence, potentially hours or days within the schema limits. Do not schedule wakeups merely for unchanged reassurance unless an explicit update cadence requires it. OpenGeni persists the first absolute deadline for the turn, and repeated calls do not extend it. After answering a question during a wait, preserve the existing deadline by passing the time remaining, not a fresh full timeout. If less than the schema minimum remains or the deadline has passed, a question-only human/API turn that consumed no immediate machine input may finish without replacing the retained wait; its deadline machinery remains authoritative. Do not send an invalid timeout or silently extend the deadline. Otherwise do not assume the old wait remains armed; register a valid wait if needed and make any unavoidable deadline adjustment explicit. Timeout never cancels a background command. A human/API prompt, agent message or Steer, child terminal result (it carries the child's final answer in payload.finalAnswer), scheduled input, terminal background-command result, or the deadline wakes the session. Use goal_pause instead when the active goal itself should stop pending a human decision. Pending Codemode calls require the same live attempt: observe them with command_wait/command_read rather than ending the turn.",
      inputSchema: {
        reason: inputWaitReasonSchema.describe(
          "Shown directly to the user; at most 2048 UTF-8 bytes. Write one short, natural sentence explaining what you are waiting for, with normal spacing. Exclude internal IDs, cursors, commit hashes, paths, and continuation instructions. Example: Waiting for the build and database checks to finish.",
        ),
        timeoutSeconds: z4
          .number()
          .int()
          .min(SESSION_INPUT_WAIT_MIN_SECONDS)
          .max(SESSION_INPUT_WAIT_MAX_SECONDS),
        idempotencyKey: z4.string().uuid().optional(),
      },
    },
    async ({ reason, timeoutSeconds, idempotencyKey }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.control");
      const context = exactAgentCommandContext(grant, sessionId);
      const operationKey =
        idempotencyKey ??
        `wait-for-input:${context.callerTurnId}:${createHash("sha256")
          .update(JSON.stringify({ reason, timeoutSeconds }))
          .digest("hex")
          .slice(0, 32)}`;
      const { events, operationId, replay, deadlineAt } = await waitForSessionInputWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          reason,
          timeoutSeconds,
          command: {
            accountId: grant.accountId,
            actor: {
              type: "agent_attempt",
              attemptId: context.callerAttemptId,
              sessionId: context.callerSessionId,
              turnId: context.callerTurnId,
              executionGeneration: context.callerExecutionGeneration,
            },
            operationKey,
          },
        },
      );
      await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, events);
      return json({
        status: "waiting_for_input",
        deadlineAt,
        operationId,
        replay,
        nextAction:
          "The runtime yields this turn after the tool batch settles. Relevant input or the timeout deadline will start a new turn; the timeout does not cancel commands.",
      });
    },
  );

  server.registerTool(
    "goal_complete",
    {
      description:
        "Mark the session goal as completed with a short concrete proof for the goal ledger (evidence: at most 8192 characters). Evidence is not the deliverable and is not shown as your final chat reply; do not squeeze a report into it or remove spaces to fit. After this tool succeeds, reply to the user with the requested deliverable, or its summary and retained artifact link. Completion stops automatic goal continuations, not the current turn or its final reply. Every persisted report requirement must have a matching reportDeliveries entry containing a native document artifactId and its server-issued inspectionReceiptId from a post-edit body inspection. Missing, stale, inaccessible or summary-only proof fails; inspect again after an edit. Omit reportDeliveries only when no reports were declared.",
      inputSchema: {
        evidence: z4
          .string()
          .min(1)
          .max(8192)
          .describe(
            "Short ledger proof, at most 8192 characters; not the final answer. Keep normal spaces. Deliver the answer in your final user-facing reply.",
          ),
        reportDeliveries: SessionGoalReportDeliveries.optional(),
      },
    },
    async ({ evidence, reportDeliveries }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const context = exactAgentCommandContext(grant, sessionId);
      const reportArtifactActor = editableArtifactActorForGrant(grant, "0000000000000001");
      if (reportArtifactActor.kind !== "agent")
        throw new Error("Goal completion requires exact agent authority");
      const { goal, events } = await setSessionGoalStatusWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          status: "completed",
          evidence,
          ...(reportDeliveries !== undefined ? { reportDeliveries } : {}),
          reportArtifactActor,
          commandActor: {
            type: "agent_attempt",
            sessionId: context.callerSessionId,
            turnId: context.callerTurnId,
            attemptId: context.callerAttemptId,
            executionGeneration: context.callerExecutionGeneration,
          },
          event: { type: "goal.completed", evidence },
        },
      );
      const changed = events.length > 0;
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json({
        ...mcpMutationReceipt({
          operation: "goal_complete",
          committed: true,
          outcome: changed ? "updated" : "unchanged",
          changed,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
        reportDeliveries: SessionGoalReportDeliveries.parse(
          goal.metadata.reportDeliveriesV1 ?? [],
        ).map((delivery) => ({
          ...delivery,
          artifactReference: `[Open report](/workspaces/${grant.workspaceId}/artifacts/editable/${delivery.artifactId})`,
        })),
        handoff:
          "Now reply to the user with the requested deliverable, or its summary and retained artifact link. The evidence is only ledger proof; this receipt does not deliver your final answer.",
      });
    },
  );

  server.registerTool(
    "goal_pause",
    {
      description:
        "Pause the session goal with an evidence-based rationale when no meaningful authorized progress remains. rationale is a short human-readable blocker explanation, at most 2048 UTF-8 bytes; keep normal spaces and summarize instead of compressing words. Investigate recoverable failures and try plausible safe alternatives that could materially help; no fixed turn or retry count is required, and a definitive missing permission or required human decision can justify pausing immediately. State the blocker and what must change to resume. Work already in flight or a meaningful timed recheck uses the available waiting mechanism instead. Tool approvals remain human-only. No further continuation turns are synthesized until the goal is resumed or replaced.",
      inputSchema: { rationale: goalRationale },
    },
    async ({ rationale }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, events } = await setSessionGoalStatusWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          status: "paused",
          rationale,
          pausedReason: "agent",
          event: {
            type: "goal.paused",
            actor: "agent",
            reason: "agent",
            rationale,
          },
        },
      );
      const changed = events.length > 0;
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json(
        mcpMutationReceipt({
          operation: "goal_pause",
          committed: true,
          outcome: changed ? "updated" : "unchanged",
          changed,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
      );
    },
  );
  server.registerTool(
    "goal_resume",
    {
      description:
        "Resume this session's paused goal when the user asks you to continue (whoever paused it), or when the blocker you paused for has cleared. A user's question alone is not a reason to resume: answer it and leave the goal paused. Already active is a successful no-op. Preserves the objective and resets continuation counters.",
      inputSchema: {},
    },
    async () => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, events, workflowWakeRevision } = await setSessionGoalStatusWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          status: "active",
          event: { type: "goal.resumed", actor: "agent" },
        },
      );
      const changed = events.length > 0;
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      if (workflowWakeRevision !== null) {
        await deps.workflowClient.wakeSessionWorkflow({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          workflowId: workflowIdForSession(sessionId),
          wakeRevision: workflowWakeRevision,
        });
      }
      return json(
        mcpMutationReceipt({
          operation: "goal_resume",
          committed: true,
          outcome: changed ? "updated" : "unchanged",
          changed,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
      );
    },
  );
}

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

async function authorizeFirstPartySession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: SessionAuthorizationOperation,
): Promise<ResolvedSessionAuthorization | null> {
  return await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation,
    surface: "first_party_mcp",
  });
}

function registerWorkspaceArtifactTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const attempt = () => {
    const claims = exactAgentAttemptClaims(grant);
    if (!claims) throw new Error("Exact signed artifact attempt authority is required.");
    return claims;
  };
  const authorize = async () => {
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };
  const canReadProvenanceSession = (sourceSessionId: string): Promise<boolean> =>
    authorizeFirstPartySession(deps, grant, sourceSessionId, "session.read")
      .then(() => true)
      .catch((error) => {
        if (error instanceof SessionAuthorizationDeniedError) return false;
        throw error;
      });
  const mutation = async (response: WorkspaceArtifactMutationResponse) =>
    await projectWorkspaceArtifactMutationProvenance(response, canReadProvenanceSession);
  const prepare = (
    html: string | undefined,
    source?: { entrypoint: string; files: Array<{ path: string; content: string }> },
    requestedTools?: Array<{ serverId: string; toolName: string }>,
    uploadId?: string,
  ) => {
    if (!deps.objectStorage) throw new Error("Object storage is not configured");
    return prepareWorkspaceArtifactPublication(deps, grant, {
      ...(html === undefined ? {} : { html }),
      ...(uploadId ? { uploadId } : {}),
      ...(source ? { source } : {}),
      ...(requestedTools ? { requestedTools } : {}),
    });
  };
  const provenance = (
    idempotencyKey: string,
    sourceToolName:
      | "artifacts_create"
      | "artifacts_publish"
      | "artifacts_rollback"
      | "artifacts_archive"
      | "artifacts_restore",
  ) => {
    const claims = attempt();
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationKey: `attempt:${createHash("sha256")
        .update(`${claims.sessionId}:${claims.turnId}:${idempotencyKey}`)
        .digest("hex")}`,
      actorSubjectId: grant.subjectId,
      sourceSessionId: claims.sessionId,
      sourceTurnId: claims.turnId,
      sourceAttemptId: claims.attemptId,
      sourceExecutionGeneration: claims.executionGeneration,
      sourceToolName,
    };
  };

  server.registerTool(
    "artifacts_prepare_upload",
    {
      description:
        "Get signed upload URLs for a Site's HTML and optional source JSON. Upload with curl or fetch, then pass uploadId to artifacts_create/artifacts_publish. No hashes or sizes needed. Source upload may be omitted for HTML-only Sites.",
      inputSchema: {},
    },
    async () => {
      await authorize();
      return json(await prepareWorkspaceArtifactUpload(deps, grant));
    },
  );

  server.registerTool(
    "artifacts_get_source",
    {
      description:
        "Get artifact metadata, version id, and signed download URLs for HTML and optional source JSON. Download with curl or Bun. If source is null, edit the HTML instead. Omit versionId for the current version.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        versionId: z4.string().uuid().optional(),
      },
    },
    async ({ artifactId, versionId }) => {
      await authorize();
      if (!deps.objectStorage) throw new Error("Object storage is not configured");
      const [rawDetail, ref] = await Promise.all([
        getWorkspaceArtifact(deps.db, grant.workspaceId, artifactId),
        getWorkspaceArtifactContentRef(deps.db, grant.workspaceId, artifactId, versionId),
      ]);
      const sourceAuthorizations = new Map<string, Promise<boolean>>();
      const canReadSourceSession = (sourceSessionId: string): Promise<boolean> => {
        const existing = sourceAuthorizations.get(sourceSessionId);
        if (existing) return existing;
        const decision = canReadProvenanceSession(sourceSessionId);
        sourceAuthorizations.set(sourceSessionId, decision);
        return decision;
      };
      const [detail, projectedVersion] = await Promise.all([
        projectWorkspaceArtifactDetailProvenance(rawDetail, canReadSourceSession),
        projectWorkspaceArtifactVersionProvenance(ref.version, canReadSourceSession),
      ]);
      const downloads = await workspaceArtifactDownloads(deps.objectStorage, ref, "sandbox");
      return json({
        detail,
        version: projectedVersion,
        downloads,
      });
    },
  );

  server.registerTool(
    "artifacts_create",
    {
      description:
        "Create and publish a generic workspace artifact from a complete HTML document. The exact HTML runs in an opaque-origin sandboxed iframe with JavaScript, external resources, forms, popups, and downloads enabled, but without parent-origin authority or top-level navigation.",
      inputSchema: {
        title: z4.string().min(1).max(120),
        description: z4.string().max(2000).nullable().optional(),
        slug: z4
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
          .max(96)
          .optional(),
        html: z4.string().min(1).max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES).optional(),
        uploadId: z4.string().uuid().optional(),
        source: z4
          .object({
            entrypoint: z4.string().min(1).max(256),
            files: z4
              .array(
                z4.object({
                  path: z4.string().min(1).max(256),
                  content: z4.string(),
                }),
              )
              .min(1)
              .max(WORKSPACE_ARTIFACT_SOURCE_MAX_FILES),
          })
          .optional(),
        requestedTools: z4
          .array(
            z4.object({
              serverId: z4.string().min(1).max(256),
              toolName: z4.string().min(1).max(512),
            }),
          )
          .max(WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX)
          .optional(),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({
      title,
      description,
      slug,
      html,
      source,
      requestedTools,
      idempotencyKey,
      uploadId,
    }) => {
      await authorize();
      const artifactId = crypto.randomUUID();
      const slugBase = slug ?? (normalizeWorkspaceArtifactSlug(title) || "artifact");
      const resolvedSlug = slug ?? `${slugBase.slice(0, 87)}-${artifactId.slice(0, 8)}`;
      return json(
        await mutation(
          await createWorkspaceArtifact(deps.db, {
            artifactId,
            slug: resolvedSlug,
            requestedSlug: slug ?? null,
            title,
            description: description ?? null,
            ...(await prepare(html, source, requestedTools, uploadId)),
            ...provenance(idempotencyKey, "artifacts_create"),
          }),
        ),
      );
    },
  );

  server.registerTool(
    "artifacts_publish",
    {
      description:
        "Publish a new immutable HTML version. The exact HTML runs in an opaque-origin sandboxed iframe. First read the current source and pass its version id for optimistic concurrency.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        title: z4.string().min(1).max(120).optional(),
        description: z4.string().max(2000).nullable().optional(),
        html: z4.string().min(1).max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES).optional(),
        uploadId: z4.string().uuid().optional(),
        source: z4
          .object({
            entrypoint: z4.string().min(1).max(256),
            files: z4
              .array(
                z4.object({
                  path: z4.string().min(1).max(256),
                  content: z4.string(),
                }),
              )
              .min(1)
              .max(WORKSPACE_ARTIFACT_SOURCE_MAX_FILES),
          })
          .optional(),
        requestedTools: z4
          .array(
            z4.object({
              serverId: z4.string().min(1).max(256),
              toolName: z4.string().min(1).max(512),
            }),
          )
          .max(WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX)
          .optional(),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({
      artifactId,
      expectedCurrentVersionId,
      title,
      description,
      html,
      uploadId,
      source,
      requestedTools,
      idempotencyKey,
    }) => {
      await authorize();
      return json(
        await mutation(
          await publishWorkspaceArtifactVersion(deps.db, {
            artifactId,
            expectedCurrentVersionId,
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(await prepare(html, source, requestedTools, uploadId)),
            ...provenance(idempotencyKey, "artifacts_publish"),
          }),
        ),
      );
    },
  );

  server.registerTool(
    "artifacts_rollback",
    {
      description:
        "Promote an existing immutable artifact version back to current without rewriting history.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        versionId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        reason: z4.string().min(1).max(4096),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ artifactId, versionId, expectedCurrentVersionId, reason, idempotencyKey }) => {
      await authorize();
      return json(
        await mutation(
          await rollbackWorkspaceArtifact(deps.db, {
            artifactId,
            versionId,
            expectedCurrentVersionId,
            reason,
            ...provenance(idempotencyKey, "artifacts_rollback"),
          }),
        ),
      );
    },
  );

  server.registerTool(
    "artifacts_archive",
    {
      description:
        "Unpublish an active workspace artifact without deleting its immutable versions or retained source.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        reason: z4.string().min(1).max(4096),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ artifactId, expectedCurrentVersionId, reason, idempotencyKey }) => {
      await authorize();
      return json(
        await mutation(
          await setWorkspaceArtifactStatus(deps.db, {
            artifactId,
            status: "archived",
            expectedCurrentVersionId,
            reason,
            ...provenance(idempotencyKey, "artifacts_archive"),
          }),
        ),
      );
    },
  );

  server.registerTool(
    "artifacts_restore",
    {
      description:
        "Republish an archived workspace artifact at its unchanged current immutable version.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        reason: z4.string().min(1).max(4096),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ artifactId, expectedCurrentVersionId, reason, idempotencyKey }) => {
      await authorize();
      return json(
        await mutation(
          await setWorkspaceArtifactStatus(deps.db, {
            artifactId,
            status: "active",
            expectedCurrentVersionId,
            reason,
            ...provenance(idempotencyKey, "artifacts_restore"),
          }),
        ),
      );
    },
  );
}

function exactAgentAttemptClaims(grant: AccessGrant): {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
} | null {
  if (grant.principalKind !== "agent_attempt") return null;
  const metadata = grant.metadata ?? {};
  if (
    typeof metadata["sessionId"] !== "string" ||
    typeof metadata["turnId"] !== "string" ||
    typeof metadata["attemptId"] !== "string" ||
    typeof metadata["executionGeneration"] !== "number" ||
    !Number.isSafeInteger(metadata["executionGeneration"]) ||
    metadata["executionGeneration"] < 1 ||
    metadata["executionGeneration"] > 2_147_483_647
  ) {
    return null;
  }
  return {
    sessionId: metadata["sessionId"],
    turnId: metadata["turnId"],
    attemptId: metadata["attemptId"],
    executionGeneration: metadata["executionGeneration"],
  };
}

function registerTaskNoteTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const attemptClaims = () => {
    const resolved = exactAgentAttemptClaims(grant);
    if (!resolved || resolved.sessionId !== sessionId) {
      throw new Error("Exact signed task-note attempt authority is required.");
    }
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...resolved,
    };
  };
  const authorize = async () => {
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };
  const boundedUtf8 = (maxBytes: number, label: string) =>
    z4
      .string()
      .min(1)
      .refine((value) => value === value.trim(), {
        message: `${label} must not have leading or trailing whitespace`,
      })
      .refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
        message: `${label} must be at most ${maxBytes} UTF-8 bytes`,
      });

  server.registerTool(
    "task_notes_list",
    {
      description:
        "Explicitly retrieve bounded, unexpired coordination notes shared by this session's root task tree. Notes are non-authoritative and are never injected into prompts automatically.",
      inputSchema: {
        includeArchived: z4.boolean().optional().default(false),
        limit: z4
          .number()
          .int()
          .min(1)
          .max(TASK_NOTE_LIST_MAX_LIMIT)
          .optional()
          .default(TASK_NOTE_LIST_DEFAULT_LIMIT),
      },
    },
    async ({ includeArchived, limit }) => {
      await authorize();
      return json(
        await listTaskNotes(deps.db, {
          ...attemptClaims(),
          includeArchived,
          limit,
        }),
      );
    },
  );

  server.registerTool(
    "task_note_save",
    {
      description:
        "Save one bounded, expiring, non-authoritative coordination note for agents in this root task tree. Use a fresh operationId; exact retries of the same attempt and input replay safely.",
      inputSchema: {
        operationId: z4.string().uuid(),
        kind: z4.enum(["finding", "decision", "blocker", "ownership", "artifact", "handoff"]),
        text: boundedUtf8(TASK_NOTE_TEXT_MAX_BYTES, "Task note text"),
        expiresInDays: z4.number().int().min(1).max(TASK_NOTE_MAX_LIFETIME_DAYS),
      },
    },
    async ({ operationId, kind, text, expiresInDays }) => {
      await authorize();
      return json(
        await createTaskNote(deps.db, {
          ...attemptClaims(),
          operationId,
          kind,
          text,
          expiresInDays,
        }),
      );
    },
  );

  server.registerTool(
    "task_note_archive",
    {
      description:
        "Archive a coordination note from this root task tree with optimistic version fencing. This preserves its immutable create receipt and records a separate archive receipt.",
      inputSchema: {
        operationId: z4.string().uuid(),
        noteId: z4.string().uuid(),
        expectedVersion: z4.number().int().min(1).max(1),
        reason: boundedUtf8(TASK_NOTE_REASON_MAX_BYTES, "Task note archive reason"),
      },
    },
    async ({ operationId, noteId, expectedVersion, reason }) => {
      await authorize();
      return json(
        await archiveTaskNote(deps.db, {
          ...attemptClaims(),
          operationId,
          noteId,
          expectedVersion,
          reason,
        }),
      );
    },
  );

  server.registerTool(
    "task_note_replace",
    {
      description:
        "Atomically correct one exact active coordination note: archive the old immutable note and create a fresh linked replacement. Exact retries replay safely; stale versions or changed input fail closed.",
      inputSchema: {
        operationId: z4.string().uuid(),
        replacedNoteId: z4.string().uuid(),
        expectedReplacedVersion: z4.number().int().min(1).max(1),
        replacementKind: z4.enum([
          "finding",
          "decision",
          "blocker",
          "ownership",
          "artifact",
          "handoff",
        ]),
        replacementText: boundedUtf8(TASK_NOTE_TEXT_MAX_BYTES, "Task note replacement text"),
        replacementExpiresInDays: z4.number().int().min(1).max(TASK_NOTE_MAX_LIFETIME_DAYS),
        reason: boundedUtf8(TASK_NOTE_REASON_MAX_BYTES, "Task note replacement reason"),
      },
    },
    async ({
      operationId,
      replacedNoteId,
      expectedReplacedVersion,
      replacementKind,
      replacementText,
      replacementExpiresInDays,
      reason,
    }) => {
      await authorize();
      return json(
        await replaceTaskNote(deps.db, {
          ...attemptClaims(),
          operationId,
          replacedNoteId,
          expectedReplacedVersion,
          replacementKind,
          replacementText,
          replacementExpiresInDays,
          reason,
        }),
      );
    },
  );
}

function registerWorkClaimTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const attemptClaims = () => {
    const resolved = exactAgentAttemptClaims(grant);
    if (!resolved || resolved.sessionId !== sessionId) {
      throw new Error("Exact signed work-claim attempt authority is required.");
    }
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...resolved,
    };
  };
  const authorize = async () => {
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };

  server.registerTool(
    "work_claim_upsert",
    {
      description:
        "Create or refresh one typed, non-exclusive claim describing this session's current external work. Claims are advisory evidence, never locks or authority. Use stable public identifiers only; never put credentials, tokens, or other secrets in claim fields. expectedRevision=0 creates a new active claim; refreshing an existing active claim requires its exact revision. Use a fresh operationId; an exact retry from a replacement attempt on the same logical turn replays safely.",
      inputSchema: {
        operationId: z4.string().uuid(),
        expectedRevision: z4.number().int().min(0),
        subjectNamespace: z4.string().min(1).max(WORK_CLAIM_NAMESPACE_MAX_BYTES),
        subjectType: z4.enum([
          "repository",
          "branch",
          "pull_request",
          "issue",
          "artifact",
          "release",
          "ci_run",
          "other",
        ]),
        canonicalKey: z4.string().min(1).max(WORK_CLAIM_CANONICAL_KEY_MAX_BYTES),
        displayLabel: z4.string().min(1).max(WORK_CLAIM_DISPLAY_LABEL_MAX_BYTES).optional(),
        role: z4.enum(["working", "reviewing", "monitoring", "delivering"]),
        versionKind: z4
          .enum([
            "git_commit",
            "branch_head",
            "pull_request_head",
            "artifact_version",
            "release_version",
            "ci_run",
            "other",
          ])
          .optional(),
        versionValue: z4.string().min(1).max(WORK_CLAIM_VERSION_VALUE_MAX_BYTES).optional(),
      },
    },
    async ({
      operationId,
      expectedRevision,
      subjectNamespace,
      subjectType,
      canonicalKey,
      displayLabel,
      role,
      versionKind,
      versionValue,
    }) => {
      await authorize();
      if ((versionKind === undefined) !== (versionValue === undefined)) {
        throw new Error("work_claim_upsert versionKind and versionValue must be supplied together");
      }
      return json(
        await upsertWorkClaim(deps.db, {
          ...attemptClaims(),
          operationId,
          expectedRevision,
          subjectNamespace,
          subjectType,
          canonicalKey,
          ...(displayLabel === undefined ? {} : { displayLabel }),
          role,
          ...(versionKind && versionValue
            ? { version: { kind: versionKind, value: versionValue } }
            : {}),
        }),
      );
    },
  );

  server.registerTool(
    "work_claim_release",
    {
      description:
        "Release one exact active claim owned by this session. This records an immutable receipt and does not affect other sessions claiming the same subject. Use a fresh operationId and the claim's exact revision.",
      inputSchema: {
        operationId: z4.string().uuid(),
        claimId: z4.string().uuid(),
        expectedRevision: z4.number().int().min(1),
        reason: z4.enum([
          "completed",
          "cancelled",
          "failed",
          "superseded",
          "no_longer_active",
          "corrected",
          "external_state_changed",
          "other",
        ]),
      },
    },
    async ({ operationId, claimId, expectedRevision, reason }) => {
      await authorize();
      return json(
        await releaseWorkClaim(deps.db, {
          ...attemptClaims(),
          operationId,
          claimId,
          expectedRevision,
          reason,
        }),
      );
    },
  );
}

function registerPreferenceRegistryTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  json: JsonResult,
): void {
  const attemptClaims = () => {
    const resolved = exactAgentAttemptClaims(grant);
    if (!resolved) throw new Error("Exact signed preference attempt authority is required.");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...resolved,
    };
  };

  server.registerTool(
    "preference_registry_summary",
    {
      description:
        "List bounded deterministic Skill descriptors for organization, workspace, and the immutable initiating human, frozen to this exact attempt. Full Skill instructions are omitted; retrieve only a relevant returned handle.",
      inputSchema: {},
    },
    async () => json(await getOrCreatePreferenceRegistrySnapshot(deps.db, attemptClaims())),
  );

  server.registerTool(
    "preference_registry_get",
    {
      description:
        "Retrieve the full instructions for one Skill in this exact attempt snapshot. Handles from another account, workspace, human, or attempt are rejected.",
      inputSchema: { retrievalHandle: z4.string().min(1).max(512) },
    },
    async ({ retrievalHandle }) =>
      json(await getPreferenceRegistryFullContent(deps.db, attemptClaims(), retrievalHandle)),
  );
}

function scheduledTaskReceipt(
  operation: string,
  task: ScheduledTask,
  outcome: "created" | "updated" | "unchanged" | "triggered" | "partial_failure",
  changed: boolean,
  options: {
    partialFailure?: { stage: string; retryable: boolean };
    warnings?: string[];
    idempotencyStatus?: "not_supported" | "not_requested" | "applied" | "replayed" | "unknown";
    facts?: Record<string, string | number | boolean | null>;
  } = {},
) {
  return mcpMutationReceipt({
    operation,
    committed: true,
    outcome,
    changed,
    resource: {
      type: "scheduled_task",
      id: task.id,
      version: task.updatedAt,
      state: task.status,
    },
    timestamp: task.updatedAt,
    idempotency: { status: options.idempotencyStatus ?? "not_supported" },
    ...(options.partialFailure ? { partialFailure: options.partialFailure } : {}),
    ...(options.warnings ? { warnings: options.warnings } : {}),
    ...(options.facts ? { facts: options.facts } : {}),
    nextAction: { tool: "scheduled_tasks_get", arguments: { id: task.id } },
  });
}

function scheduledTaskUpdateChangesState(
  task: ScheduledTask,
  update: Awaited<ReturnType<typeof validatedScheduledTaskUpdate>>,
): boolean {
  if (update.name !== undefined && update.name !== task.name) return true;
  if (update.status !== undefined && update.status !== task.status) return true;
  if (update.schedule !== undefined && stableJson(update.schedule) !== stableJson(task.schedule)) {
    return true;
  }
  if (update.runMode !== undefined && update.runMode !== task.runMode) return true;
  if (update.overlapPolicy !== undefined && update.overlapPolicy !== task.overlapPolicy)
    return true;
  if (
    update.agentConfig !== undefined &&
    stableJson(update.agentConfig) !== stableJson(task.agentConfig)
  ) {
    return true;
  }
  if (update.targetSessionId !== undefined && update.targetSessionId !== task.targetSessionId) {
    return true;
  }
  if (
    update.reusableSessionId !== undefined &&
    update.reusableSessionId !== task.reusableSessionId
  ) {
    return true;
  }
  if (update.variableSetId !== undefined && update.variableSetId !== task.variableSetId)
    return true;
  if (update.rigId !== undefined && update.rigId !== task.rigId) return true;
  if (update.metadata !== undefined && stableJson(update.metadata) !== stableJson(task.metadata)) {
    return true;
  }
  return false;
}

export function memorySlackPublicationActor(
  actor: Extract<SessionAuthorizationActor, { kind: "agent_attempt" }>,
  sessionId: string,
  fallbackOwnerLabel: string | null,
) {
  return {
    actor: {
      kind: actor.initiator.kind === "subject" ? ("human" as const) : ("service" as const),
      subjectId: actor.initiator.subjectId,
      initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
      sessionId,
      turnId: actor.turnId,
      attemptId: actor.attemptId,
    },
    ownerLabel: actor.initiator.label ?? fallbackOwnerLabel,
  };
}

function registerFleetTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const services: FleetServices = {
    db: deps.db,
    settings: deps.settings,
    bus: deps.bus,
    ensureSessionGroupReady: async (ctx) => {
      const session = await requireSession(deps.db, ctx.workspaceId, ctx.sessionId);
      return await ensureViewerSessionGroupReady(
        { db: deps.db, settings: deps.settings, bus: deps.bus },
        {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          session,
          subjectId: ctx.subjectId ?? null,
        },
      );
    },
  };

  // Resolve the session's group sandbox (the default/home fleet member) at
  // call-time via the shared helper (same context the user-authenticated swap
  // REST route builds). Throws when the session has no box (backend:none) — the
  // fleet is only meaningful for a session that runs in a sandbox.
  const fleetContext = async (): Promise<FleetContext> => {
    const claims = exactAgentAttemptClaims(grant);
    const actor = claims
      ? await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId)
      : null;
    return await buildFleetContextForSession(deps, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      ...(actor?.initiatingHumanSubjectId ? { subjectId: actor.initiatingHumanSubjectId } : {}),
      ...(actor?.initiatingHumanSubjectId && claims
        ? {
            attemptAuthority: {
              turnId: claims.turnId,
              attemptId: claims.attemptId,
              executionGeneration: claims.executionGeneration,
              initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
            },
          }
        : {}),
    });
  };

  const oneOffCodemodeEnvironment = async (
    op: RunOnOp,
  ): Promise<Readonly<Record<string, string>> | undefined> => {
    if (op.kind !== "exec") return undefined;
    const claims = exactAgentAttemptClaims(grant);
    if (!claims || claims.sessionId !== sessionId) return undefined;
    const material = await mintSandboxCodemodeToken(
      deps.settings,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      claims,
    );
    if (!material) return undefined;
    return {
      OPENGENI_CODEMODE_URL: codemodeWorkspaceUrl(deps.settings, grant.workspaceId),
      OPENGENI_CODEMODE_TOKEN: material.token,
      ...(deps.settings.ogtoolPackageSpec
        ? { OPENGENI_OGTOOL_PACKAGE_SPEC: deps.settings.ogtoolPackageSpec }
        : {}),
    };
  };

  server.registerTool(
    "sandboxes_list",
    {
      description:
        "List the sandboxes this session can run on: its own session sandbox plus enrolled selfhosted machines. `operationAvailability` is authoritative for ordinary shell/files use: `wakeable` means the next ordinary operation will wake or restore the idle managed home sandbox, even when `liveness=offline`, `leaseLiveness=cold|draining`, or `attachable=false`. `attachable` describes an already-live swap target, not ordinary operation availability. `recovering` requires a bounded retry/typed recovery result; `unavailable` is not usable. Provider, lease, route, archive, restore, workspace, lease epoch, and route epoch remain separate truth dimensions. Use an entry `id` as an attach/swap/run_on target.",
      inputSchema: {},
    },
    async () => json(await listFleet(services, await fleetContext())),
  );

  server.registerTool(
    "sandbox_attach",
    {
      description:
        'Attach this session to a sandbox for subsequent sandbox operations. The target must be owned and verified ready. A managed-home session currently running on a Connected Machine crosses a safe attempt boundary when attached back to home: OpenGeni checkpoints completed work and continues the same logical turn on home without another user message. A same-target attach is a repair request: it revalidates readiness and advances the route epoch rather than returning unchanged success. Recovery-in-progress/degraded/unrecoverable outcomes are typed. Use a sandboxes_list `id`, or "session"/"default" for home.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "sandbox_swap",
    {
      description:
        'Swap the active sandbox for this session mid-conversation. Validates ownership and verified readiness, then advances the route epoch. A managed-home session currently running on a Connected Machine crosses a safe attempt boundary when swapped back to home: OpenGeni checkpoints completed work and continues the same logical turn on home without another user message. Same-target swaps also revalidate and fence stale route caches. An operation that encountered provider disappearance is not replayed; retry only after a typed recovery-ready result. Use a sandboxes_list `id`, or "session"/"default" for home.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "run_on",
    {
      description:
        "Run a ONE-OFF op on a SPECIFIC enrolled selfhosted machine WITHOUT changing this session's active sandbox (a side-channel to another machine). Ops: exec (run a command), read (read a file), write (write a file). Exec returns exact exitCode plus typed timedOut and the effective deadlineMs; a deadline kill or missing exit proof is never ok:true, and an ambiguous transport loss is not replayed. `target` = a selfhosted sandboxes_list `id`. To make a machine the active sandbox instead, use sandbox_swap.",
      inputSchema: {
        target: z4.string().min(1),
        op: z4.discriminatedUnion("kind", [
          z4.object({
            kind: z4.literal("exec"),
            cmd: z4.string().min(1),
            workdir: z4.string().optional(),
          }),
          z4.object({ kind: z4.literal("read"), path: z4.string().min(1) }),
          z4.object({
            kind: z4.literal("write"),
            path: z4.string().min(1),
            content: z4.string(),
          }),
        ]),
      },
    },
    async ({ target, op }) => {
      const typedOp = op as RunOnOp;
      const transientExecEnvironment = await oneOffCodemodeEnvironment(typedOp);
      return json(
        await runOnSandbox(services, await fleetContext(), target, typedOp, {
          ...(transientExecEnvironment ? { transientExecEnvironment } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "sandbox_provision",
    {
      description:
        "Provision a new sandbox for the fleet. kind=selfhosted returns interactive device-flow instructions for a human to approve. For authorized headless enrollment, use connected_machine_enroll_token when available instead. kind=modal creates a named Modal sandbox record, but it is NOT yet attachable as a swap target: routing a session onto a second Modal box is not supported yet, so sandbox_swap to its id is rejected. Use the session's own box (the default) or attach a Connected Machine instead.",
      inputSchema: {
        kind: z4.enum(["selfhosted", "modal"]),
        name: z4.string().min(1).max(120).optional(),
      },
    },
    async ({ kind, name }) =>
      json(
        await provisionSandbox(services, await fleetContext(), {
          kind,
          ...(name ? { name } : {}),
        }),
      ),
  );
}

// Enrollment-management surface for creating tokens and removing machines. This is
// deliberately separate from the session-scoped fleet tools: a worker can list,
// attach, or run on a machine only with session authority, while removal requires
// the explicit enrollments:manage permission. Removal accepts enrollment ids,
// never sandbox ids; a Modal record cannot be removed through this operation.
function registerConnectedMachineTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string | null,
  json: JsonResult,
): void {
  server.registerTool(
    "connected_machine_enroll_token",
    {
      description:
        "Create a short-lived Connected Machine enrollment token for this workspace using existing enrollments:manage authority. Returns the token, expiry and Unix/PowerShell install commands. Run the appropriate command on the intended machine through an already-authorized execution path, then verify it with sandboxes_list. No separate device approval is required. Screen control is optional and defaults off. The token grants whole-machine access on enrollment; do not put it in public code or unrelated logs. Existing machine connections are preserved.",
      inputSchema: { allowScreenControl: z4.boolean().optional() },
    },
    async ({ allowScreenControl }) => {
      if (sessionId) {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
      }
      const minted = await mintEnrollToken(deps, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        allowScreenControl: allowScreenControl ?? false,
      });
      if (!minted) throw new Error("enrollment credential plane is not configured");
      const base = (deps.settings.publicBaseUrl ?? "https://app.opengeni.ai").replace(/\/+$/, "");
      const unixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const windowsQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      return json({
        ...minted,
        workspaceId: grant.workspaceId,
        allowScreenControl: allowScreenControl ?? false,
        installCommandUnix: `curl -fsSL ${unixQuote(`${base}/install.sh`)} | OPENGENI_API_URL=${unixQuote(base)} OPENGENI_ENROLL_TOKEN=${unixQuote(minted.token)} sh`,
        installCommandWindows: `$env:OPENGENI_API_URL=${windowsQuote(base)}; $env:OPENGENI_ENROLL_TOKEN=${windowsQuote(minted.token)}; irm ${windowsQuote(`${base}/install.ps1`)} | iex`,
      });
    },
  );
  server.registerTool(
    "connected_machine_remove",
    {
      description:
        "Remove one enrolled self-hosted machine while it is offline. Access is revoked, future heartbeat/reconnect credentials are rejected, and session, route, lease, archive, and audit history is retained. Idle dependent sessions are detached atomically; machine-home sessions become compute-less (backend none) until another sandbox is selected. Active turns, live leases, and recovery work remain fail-closed blockers whose typed outcome explains what must settle before retrying. Pass the enrollmentId from the Machines surface, never a Modal sandbox id. Reconnecting later requires fresh enrollment through device approval or an authorized enrollment token.",
      inputSchema: {
        enrollmentId: z4.string().uuid(),
        expectedUpdatedAt: z4.string().datetime({ offset: true }).optional(),
        idempotencyKey: z4.string().trim().min(1).max(200).optional(),
      },
    },
    async ({ enrollmentId, expectedUpdatedAt, idempotencyKey }) => {
      const resourceGrant =
        sessionId && exactAgentAttemptClaims(grant)
          ? {
              ...grant,
              subjectId:
                (await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId))
                  .initiatingHumanSubjectId ?? grant.subjectId,
            }
          : grant;
      const enrollment = (await listEnrollments(deps.db, resourceGrant, { status: "active" })).find(
        (candidate) => candidate.id === enrollmentId,
      );
      if (!enrollment) {
        throw new Error("machine enrollment not found in this access scope");
      }
      if (enrollment.scope === "organization" && !grant.permissions.includes("account:admin")) {
        throw new Error("missing permission: account:admin");
      }
      const result = await removeEnrollment(deps.db, {
        accountId: grant.accountId,
        workspaceId: enrollment.workspaceId,
        enrollmentId,
        operationKey: idempotencyKey?.trim() || randomUUID(),
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        subjectId: resourceGrant.subjectId,
      });
      if (!result) {
        throw new Error("machine enrollment not found in this workspace");
      }
      return json({ revoked: result.removed, ...result });
    },
  );
}

async function beginMcpRigVerificationAttempt(
  deps: ApiRouteDeps,
  workspaceId: string,
  changeId: string,
) {
  try {
    return await beginRigChangeVerificationAttempt(deps.db, workspaceId, changeId, {
      startedAt: new Date().toISOString(),
      allowAlreadyVerifying: true,
    });
  } catch (error) {
    if (error instanceof RigChangeTransitionError) {
      throw new Error(error.message, { cause: error });
    }
    throw error;
  }
}

function verificationAttempt(change: {
  verification?: Record<string, unknown> | null;
}): number | string {
  return typeof change.verification?.attempt === "number"
    ? change.verification.attempt
    : crypto.randomUUID();
}

function registerRigTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  sessionId: string | null,
  json: JsonResult,
): void {
  const resourceGrant = async (): Promise<AccessGrant> => {
    if (!sessionId || exactAgentAttemptClaims(grant) === null) return grant;
    const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return actor.initiatingHumanSubjectId
      ? { ...grant, subjectId: actor.initiatingHumanSubjectId }
      : grant;
  };
  const requireMutableRig = async (rigId: string) => {
    const rig = await requireRigForApi(deps.db, await resourceGrant(), rigId);
    if (rig.scope === "organization") {
      throw new Error(
        "Organization sandbox environment mutation requires account-admin authority through the authenticated REST surface.",
      );
    }
    return rig;
  };
  if (can("rigs:use")) {
    server.registerTool(
      "rig_list",
      {
        description: "List workspace sandbox environments and their active versions.",
        inputSchema: {},
      },
      async () => json({ rigs: await listRigs(deps.db, await resourceGrant()) }),
    );

    server.registerTool(
      "rig_get",
      {
        description:
          "Get one sandbox environment's bounded active definition plus compact historical version/change summaries. Historical setup scripts, checks, payloads, and verification logs are represented by counts/byte facts rather than copied into model context; use the access-controlled REST detail endpoints for exact retained definitions.",
        inputSchema: {
          rigId: z4.string().uuid(),
          versionLimit: z4.number().int().positive().optional(),
          changeLimit: z4.number().int().positive().optional(),
        },
      },
      async ({ rigId, versionLimit, changeLimit }) => {
        const rig = await requireRigForApi(deps.db, await resourceGrant(), rigId);
        const [versions, changes] = await Promise.all([
          listRigVersionMonitoringSummaries(
            deps.db,
            rig.workspaceId,
            rig.id,
            boundedRigHistoryLimit(versionLimit),
          ),
          listRigChangeMonitoringSummaries(
            deps.db,
            rig.workspaceId,
            rig.id,
            boundedRigHistoryLimit(changeLimit),
          ),
        ]);
        return json(boundRigDetailMcp(rig, versions, changes));
      },
    );

    server.registerTool(
      "rig_propose_change",
      {
        description:
          "Propose an additive sandbox environment setup command for clean verification. Use the exact command that already worked in this sandbox.",
        inputSchema: {
          rigId: z4.string().uuid(),
          command: z4.string().min(1).max(8192),
          note: z4.string().max(2000).optional(),
        },
      },
      async ({ rigId, command, note }) => {
        const rig = await requireMutableRig(rigId);
        const originGrant = { ...(await resourceGrant()), workspaceId: rig.workspaceId };
        const change = await proposeRigChangeForApi(
          { db: deps.db },
          originGrant,
          rig,
          {
            kind: "setup_append",
            payload: { command, ...(note ? { note } : {}) },
          },
          sessionId ? { proposedBy: `session:${sessionId}` } : {},
        );
        const verifying = await beginMcpRigVerificationAttempt(deps, rig.workspaceId, change.id);
        const attempt = verificationAttempt(verifying);
        try {
          await deps.workflowClient.startRigVerification({
            workspaceId: rig.workspaceId,
            changeId: change.id,
            workflowId: `rig-verification-change-${change.id}-attempt-${attempt}`,
          });
        } catch {
          return json(
            mcpMutationReceipt({
              operation: "rig_propose_change",
              committed: true,
              outcome: "partial_failure",
              changed: true,
              resource: {
                type: "rig_change",
                id: verifying.id,
                version: verifying.updatedAt,
                state: verifying.status,
              },
              relatedResources: [{ type: "rig", id: rig.id }],
              timestamp: verifying.updatedAt,
              idempotency: { status: "not_supported" },
              partialFailure: {
                stage: "verification_workflow_start",
                retryable: true,
              },
              warnings: [
                "The sandbox environment change and verifying transition committed, but verification workflow start failed.",
              ],
              facts: { verificationAttempt: attempt },
              nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
            }),
          );
        }
        return json(
          mcpMutationReceipt({
            operation: "rig_propose_change",
            committed: true,
            outcome: "created",
            changed: true,
            resource: {
              type: "rig_change",
              id: verifying.id,
              version: verifying.updatedAt,
              state: verifying.status,
            },
            relatedResources: [{ type: "rig", id: rig.id }],
            timestamp: verifying.updatedAt,
            idempotency: { status: "not_supported" },
            facts: { verificationStarted: true, verificationAttempt: attempt },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );

    server.registerTool(
      "rig_verify",
      {
        description:
          "Trigger sandbox environment verification. Pass changeId for a proposed change, or omit it to re-verify the active version's checks.",
        inputSchema: {
          rigId: z4.string().uuid(),
          changeId: z4.string().uuid().optional(),
        },
      },
      async ({ rigId, changeId }) => {
        const rig = await requireMutableRig(rigId);
        if (changeId) {
          const change = await requireRigChangeForApi(deps.db, rig.workspaceId, rig.id, changeId);
          const verifying = await beginMcpRigVerificationAttempt(deps, rig.workspaceId, change.id);
          const attempt = verificationAttempt(verifying);
          try {
            await deps.workflowClient.startRigVerification({
              workspaceId: rig.workspaceId,
              changeId: change.id,
              workflowId: `rig-verification-change-${change.id}-attempt-${attempt}`,
            });
          } catch {
            return json(
              mcpMutationReceipt({
                operation: "rig_verify",
                committed: true,
                outcome: "partial_failure",
                changed: true,
                resource: {
                  type: "rig_change",
                  id: verifying.id,
                  version: verifying.updatedAt,
                  state: verifying.status,
                },
                relatedResources: [{ type: "rig", id: rig.id }],
                timestamp: verifying.updatedAt,
                idempotency: { status: "not_supported" },
                partialFailure: {
                  stage: "verification_workflow_start",
                  retryable: true,
                },
                warnings: [
                  "The verifying transition committed, but verification workflow start failed.",
                ],
                facts: { verificationAttempt: attempt },
                nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
              }),
            );
          }
          return json(
            mcpMutationReceipt({
              operation: "rig_verify",
              committed: true,
              outcome: "accepted",
              changed: true,
              resource: {
                type: "rig_change",
                id: verifying.id,
                version: verifying.updatedAt,
                state: verifying.status,
              },
              relatedResources: [{ type: "rig", id: rig.id }],
              timestamp: verifying.updatedAt,
              idempotency: { status: "not_supported" },
              facts: {
                verificationStarted: true,
                verificationAttempt: attempt,
              },
              nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
            }),
          );
        }
        if (!rig.activeVersion) {
          throw new Error("sandbox environment has no active version");
        }
        await deps.workflowClient.startRigVerification({
          workspaceId: rig.workspaceId,
          versionId: rig.activeVersion.id,
          workflowId: `rig-verification-version-${rig.activeVersion.id}-${crypto.randomUUID()}`,
        });
        return json(
          mcpMutationReceipt({
            operation: "rig_verify",
            committed: true,
            outcome: "accepted",
            changed: true,
            resource: {
              type: "rig_version",
              id: rig.activeVersion.id,
              version: rig.activeVersion.version,
              state: "verification_started",
            },
            relatedResources: [{ type: "rig", id: rig.id }],
            idempotency: { status: "not_supported" },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );
  }

  if (can("rigs:manage")) {
    server.registerTool(
      "rig_promote",
      {
        description:
          "Promote a verified definition_edit sandbox environment change to a new active immutable version. Requires rigs:manage.",
        inputSchema: {
          rigId: z4.string().uuid(),
          changeId: z4.string().uuid(),
        },
      },
      async ({ rigId, changeId }) => {
        const rig = await requireMutableRig(rigId);
        const change = await requireRigChangeForApi(deps.db, rig.workspaceId, rig.id, changeId);
        const originGrant = { ...(await resourceGrant()), workspaceId: rig.workspaceId };
        const promoted = await promoteVerifiedDefinitionEditChangeForApi(
          { db: deps.db },
          originGrant,
          rig,
          change,
        );
        return json(
          mcpMutationReceipt({
            operation: "rig_promote",
            committed: true,
            outcome: "updated",
            changed: true,
            resource: {
              type: "rig_version",
              id: promoted.version.id,
              version: promoted.version.version,
              state: "active",
            },
            relatedResources: [
              {
                type: "rig_change",
                id: promoted.change.id,
                state: promoted.change.status,
              },
              { type: "rig", id: rig.id },
            ],
            timestamp: promoted.version.createdAt,
            idempotency: { status: "not_supported" },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );
  }
}

// Workspace orchestration for manager-style agents. Session-authenticated
// workers communicate through the typed internal-update plane; only a
// sessionless operator can append a visible prompt through this surface.
function exactAgentCommandContext(
  grant: AccessGrant,
  callerSessionId: string,
  authorizationSurface?: SessionAuthorizationSurface,
): AgentSessionCommandContext {
  const turnId = grant.metadata?.["turnId"];
  const attemptId = grant.metadata?.["attemptId"];
  const executionGeneration = grant.metadata?.["executionGeneration"];
  if (
    typeof turnId !== "string" ||
    typeof attemptId !== "string" ||
    typeof executionGeneration !== "number" ||
    !Number.isSafeInteger(executionGeneration) ||
    executionGeneration < 1
  ) {
    throw new Error("caller_attempt_claims_missing");
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    callerSessionId,
    callerTurnId: turnId,
    callerAttemptId: attemptId,
    callerExecutionGeneration: executionGeneration,
    ...(authorizationSurface ? { authorizationSurface } : {}),
  };
}

function registerWorkspaceOrchestrationTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  callerSessionId: string | null,
  sessionCreateVisible: boolean,
  json: JsonResult,
): void {
  const acknowledgeReads = async (children: { sessionId: string; sequences: number[] }[]) => {
    if (
      !callerSessionId ||
      !exactAgentAttemptClaims(grant) ||
      !children.some((child) => child.sequences.length > 0)
    )
      return;
    // Never use grant.subjectId, session creator, or the latest queue human.
    // Reauthorize after the bounded read, including after a blocking wait.
    const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
    if (!actor.initiatingHumanSubjectId) return;
    await acknowledgeConsumedChildEvents(deps.db, {
      workspaceId: grant.workspaceId,
      sessionId: callerSessionId,
      subjectId: actor.initiatingHumanSubjectId,
      children,
    });
  };
  // The caller's exact live attempt just returned a direct child's complete
  // answer to its model. Record it on the reading turn: when that attempt
  // completes its turn, a pending terminal result repeating only answers the
  // model already holds is superseded instead of starting another inference.
  // Only a direct model call counts: a Codemode script may keep the output to
  // itself. Best-effort: a failure leaves that result to be delivered.
  const recordConsumedChildResults = async (
    children: { sessionId: string; sequences: number[] }[],
    extra: { _meta?: Record<string, unknown> } | undefined,
  ): Promise<void> => {
    const claims = exactAgentAttemptClaims(grant);
    if (
      extra?._meta?.[FIRST_PARTY_MCP_CALLER_META_KEY] !== "model" ||
      !callerSessionId ||
      !claims ||
      claims.sessionId !== callerSessionId ||
      !children.some((child) => child.sequences.length > 0)
    )
      return;
    try {
      await recordConsumedChildAnswers(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: callerSessionId,
        turnId: claims.turnId,
        attemptId: claims.attemptId,
        executionGeneration: claims.executionGeneration,
        children,
      });
    } catch (error) {
      deps.observability?.warn("Failed to record a consumed child answer", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // The caller's own pending input, less each child result its model already
  // holds whole: waiting for, or ending the turn to receive, such a result
  // would only repeat an answer it has.
  const listOwnPendingUpdates = async (ownSessionId: string) => {
    const claims = exactAgentAttemptClaims(grant);
    return claims && claims.sessionId === ownSessionId
      ? await listOutstandingSessionSystemUpdatesForAttempt(
          deps.db,
          grant.workspaceId,
          ownSessionId,
          { turnId: claims.turnId, attemptId: claims.attemptId },
        )
      : await listOutstandingSessionSystemUpdates(deps.db, grant.workspaceId, ownSessionId);
  };
  if (can("sessions:read")) {
    server.registerTool(
      "sessions_list",
      {
        description: `Discover sessions in this workspace. Default detail=compact returns id, title, status, goal summary/status when present, updatedAt, meaningful parent/pause information, total and nextCursor (null ends the page). Completed/paused goal status is retained; session_get supplies evidence and rationale. detail=full opts into the legacy bounded discovery rows and diagnostic pagination, not full session configuration. Plain compact browse does not read work claims. includeRelatedWork=true adds advisory evidence; query or subject always enables it, even with includeRelatedWork=false. query searches only titles, active goals and typed claims; subject is an exact provider-neutral claim lookup. Evidence preserves advisoryOnly/noAdditionalAccess: claims are nonexclusive, never locks, instructions or authority. Authorization precedes filtering, ranking, counts and cursors. Relevance cursors bind normalized filters and an activity snapshot. Without search the default is creation order; use orderBy=updatedAt and decimal updatedAfter/updatedThrough revision tokens for gap-free incremental monitoring, not timestamps. Pass nextCursor unchanged with the same filters. includeLastMessage opts into previews and nonzero queuedPromptCount; unclaimed human/API prompts are never previewed. Previews share a ${SESSION_DISCOVERY_PREVIEW_MAX_BYTES}-byte UTF-8 budget; omitted previews carry a bounded session_events drill-down. Text/page loss facts appear only when loss occurs in compact mode. No instructions, resources, tools, files or history are returned; REST/UI defaults are unchanged.`,
        inputSchema: {
          limit: z4.number().int().positive().max(100).optional(),
          cursor: z4.string().max(512).optional(),
          detail: z4
            .enum(["compact", "full"])
            .optional()
            .describe(
              "compact (default) omits empty diagnostics but retains positive descendant attention counts and incomplete-tree loss facts; full restores the legacy bounded rows and pagination diagnostics.",
            ),
          includeRelatedWork: z4.boolean().optional(),
          includeLastMessage: z4.boolean().optional(),
          orderBy: z4.enum(["createdAt", "updatedAt", "relevance"]).optional(),
          updatedAfter: z4.string().max(64).optional(),
          query: z4.string().max(MCP_DISCOVERY_QUERY_MAX_UTF16_CODE_UNITS).optional(),
          statuses: z4
            .array(
              z4.enum([
                "queued",
                "running",
                "idle",
                "requires_action",
                "recovering",
                "waiting_capacity",
                "failed",
                "cancelled",
              ]),
            )
            .max(8)
            .optional(),
          activeOnly: z4.boolean().optional(),
          originSiteId: z4
            .string()
            .uuid()
            .optional()
            .describe(
              "Conversations created through this Site, regardless of their project. Keep unchanged when paging.",
            ),
          recentHours: z4.number().int().positive().max(WORK_DISCOVERY_RECENT_HOURS_MAX).optional(),
          projectId: z4
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe(
              "Filter by workspace project; null selects unfiled sessions. Keep unchanged when paging.",
            ),
          rootSessionId: z4.string().uuid().optional(),
          parentSessionId: z4.string().uuid().nullable().optional(),
          subject: z4
            .object({
              namespace: z4.string().min(1).max(WORK_CLAIM_NAMESPACE_MAX_BYTES),
              type: WorkClaimSubjectType,
              canonicalKey: z4.string().min(1).max(WORK_CLAIM_CANONICAL_KEY_MAX_BYTES),
            })
            .strict()
            .optional(),
          claimLimit: z4.number().int().positive().max(WORK_CLAIM_DISCOVERY_LIMIT).optional(),
        },
      },
      async ({
        limit,
        cursor,
        detail,
        includeRelatedWork,
        includeLastMessage,
        orderBy: requestedOrderBy,
        updatedAfter,
        query,
        statuses,
        activeOnly,
        originSiteId,
        recentHours,
        rootSessionId,
        projectId,
        parentSessionId,
        subject,
        claimLimit,
      }) => {
        const authorizationScope = await requireSessionAuthorizationListScope(
          deps,
          grant,
          "first_party_mcp",
        );
        const startedAtMs = performance.now();
        const mode = subject ? "subject" : query?.trim() ? "query" : "browse";
        const metricAuthorizationScope =
          authorizationScope?.kind === "scoped" ? "scoped" : "workspace";
        const decodedCursor = cursor ? decodeSessionDiscoveryCursor(cursor) : undefined;
        const relevanceRequested = Boolean(query?.trim() || subject);
        const relatedWorkRequested = sessionMcpIncludesRelatedWork({
          detail,
          includeRelatedWork,
          query,
          subject,
        });
        if (relevanceRequested && !deps.settings.workDiscoveryEnabled) {
          observeWorkDiscovery(deps.observability, {
            surface: "first_party_mcp",
            mode,
            outcome: "disabled",
            authorizationScope: metricAuthorizationScope,
            durationMs: performance.now() - startedAtMs,
            responseBytes: 0,
            resultCount: 0,
            overlapCount: 0,
            matchCounts: {},
          });
          throw new Error("sessions_list work discovery is disabled by the operator");
        }
        try {
          const orderBy: SessionDiscoveryOrderBy =
            requestedOrderBy ??
            decodedCursor?.orderBy ??
            (relevanceRequested ? "relevance" : "createdAt");
          if (decodedCursor && decodedCursor.orderBy !== orderBy) {
            throw new Error("sessions_list cursor order does not match orderBy");
          }
          const normalizedUpdatedAfter =
            updatedAfter !== undefined
              ? normalizeSessionDiscoveryRevision(updatedAfter, "updatedAfter")
              : (decodedCursor?.updatedAfter ?? undefined);
          if (normalizedUpdatedAfter !== undefined && orderBy !== "updatedAt") {
            throw new Error("sessions_list updatedAfter requires orderBy=updatedAt");
          }
          if (decodedCursor && decodedCursor.updatedAfter !== (normalizedUpdatedAfter ?? null)) {
            throw new Error("sessions_list cursor does not match updatedAfter");
          }
          const page = await listSessionDiscoverySummaries(deps.db, grant.workspaceId, {
            limit: boundedSessionDiscoveryLimit(limit),
            ...(decodedCursor ? { cursor: decodedCursor } : {}),
            includeLastMessage: includeLastMessage === true,
            orderBy,
            ...(normalizedUpdatedAfter ? { updatedAfter: normalizedUpdatedAfter } : {}),
            ...(query?.trim() ? { query } : {}),
            ...(statuses ? { statuses: statuses as SessionStatus[] } : {}),
            activeOnly: activeOnly === true,
            ...(originSiteId ? { originSiteId } : {}),
            ...(recentHours !== undefined ? { recentHours } : {}),
            ...(rootSessionId ? { rootSessionId } : {}),
            ...(projectId !== undefined ? { channelId: projectId } : {}),
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
            ...(subject ? { subject: subject as WorkClaimSubjectFilter } : {}),
            ...(claimLimit !== undefined ? { claimLimit } : {}),
            includeWorkDiscovery: deps.settings.workDiscoveryEnabled && relatedWorkRequested,
            subjectId: grant.subjectId,
            ...(authorizationScope ? { authorizationScope } : {}),
          });
          const result =
            detail === "full"
              ? capSessionDiscoveryPage(page, includeLastMessage === true)
              : capSessionDiscoveryCompactPage(page, {
                  includeLastMessage: includeLastMessage === true,
                  includeRelatedWork: relatedWorkRequested,
                });
          observeWorkDiscovery(deps.observability, {
            surface: "first_party_mcp",
            mode,
            outcome: result.sessions.length === 0 ? "empty" : "ok",
            authorizationScope: metricAuthorizationScope,
            durationMs: performance.now() - startedAtMs,
            responseBytes: Buffer.byteLength(JSON.stringify(result, null, 2), "utf8"),
            ...summarizeWorkDiscoveryRows(result.sessions),
          });
          return json(result);
        } catch (error) {
          observeWorkDiscovery(deps.observability, {
            surface: "first_party_mcp",
            mode,
            outcome: "error",
            authorizationScope: metricAuthorizationScope,
            durationMs: performance.now() - startedAtMs,
            responseBytes: 0,
            resultCount: 0,
            overlapCount: 0,
            matchCounts: {},
          });
          throw error;
        }
      },
    );

    server.registerTool(
      "session_get",
      {
        description:
          "Get an authorized session. Omit sessionId to read only the authenticated current agent session (a child reads itself, never its parent or root); sessionless/operator callers must provide an explicit ID. Both forms retain live-attempt and target authorization checks. Default detail=compact returns status, goal (including completion evidence or pause rationale), latest recorded goal progress, meaningful pause/wait state, queue counts, active turn and snapshot lastSequence. Queued status and updatedAt are not proof of execution; inspect the active turn and durable results. An unchanged snapshot is not new evidence of a child's progress: do not poll it between session_wait calls as a ritual. For a long or uncertain child wait, call wait_for_input instead; no preliminary snapshot or short wait is required. Its terminal result wakes you and carries its final answer (payload.finalAnswer). Meaningful user/task/Skill monitoring cadences remain supported. Goal completion is not a terminal child result: join with session_wait waitFor=completion from the last consumed event cursor (0 if none), not this snapshot lastSequence, which may already include an unread completion. For an already-settled child, retrieve its result-bearing completion with session_events or join from the last consumed cursor. Use detail=full for the legacy bounded configuration including resources, persisted tool refs, effectiveToolPolicy and variableSet ids (never variable values). Full mode is configuration, not a substitute for compact goal/progress facts. Self reads inspect session state, not conversation history, which is supplied directly. Text loss is explicit; REST/UI defaults are unchanged.",
        inputSchema: {
          sessionId: z4
            .string()
            .uuid()
            .optional()
            .describe(
              "Omit only to read the authenticated current agent session, never its parent or root. Sessionless callers must provide an explicit ID.",
            ),
          detail: z4.enum(["compact", "full"]).optional(),
        },
      },
      async ({ sessionId: requestedSessionId, detail }) => {
        const sessionId = requestedSessionId ?? exactAgentAttemptClaims(grant)?.sessionId;
        if (sessionId === undefined) {
          throw new Error(
            "session_get requires an explicit sessionId without authenticated current agent session context",
          );
        }
        const authorization = await authorizeFirstPartySession(
          deps,
          grant,
          sessionId,
          "session.read",
        );
        const session = await getSession(deps.db, grant.workspaceId, sessionId);
        if (!session) {
          throw new Error("session not found");
        }
        const queue = await getSessionQueueSnapshot(deps.db, grant.workspaceId, sessionId);
        const projected = projectSessionForRelatedAccess(
          {
            ...session,
            effectiveControl: queue?.effectiveControl ?? session.effectiveControl,
          },
          authorization?.relatedSessionAccess ?? "root",
        );
        if (detail !== "full") {
          return json(
            boundSessionCompactDetailMcp(
              projected,
              await getSessionMcpMonitoringSummary(deps.db, grant.workspaceId, sessionId),
              queue,
            ),
          );
        }
        return json(
          boundSessionDetailMcp(
            await withMcpEffectivePolicy(deps, grant.workspaceId, grant.subjectId, projected),
          ),
        );
      },
    );

    server.registerTool(
      "session_events",
      {
        description:
          "Read session history. Default view=conversation returns roughly ten complete user/assistant messages, including completed commentary, in a 16 KiB envelope; no token deltas or execution records. Prefer fewer complete messages; a single oversized message has fragment offsets and a lossless nextCursor continuation over retained source text, including large legacy rows. Fragment unit is codepoint for plain text or utf16 for codec text; pass the opaque v2 cursor unchanged (v1 cursors must restart). Pass cursor=nextCursor with sessionId, omitting other selectors; it binds the view, detail and direction. after/nextAfter and before/nextBefore only change position, never view or detail; use nextCursor when present to avoid skipping a message fragment. view=results returns final turn answers and actionable outcomes without duplicate message-completion text. view=tools returns compact call/result identities; includeArguments/includeOutput opt into one text or JSON-encoded value, and callId selects an exact call (sparse scans can return an empty advancing page). sourceExact=false and sourceOmitted identify oversized structured values that were omitted, never partial JSON presented as complete; scalar text remains resumable. Conversation/results/tools omit never-claimed human/API prompts and stale duplicate events. view=debug exposes the existing authorized audit query with explicit type/class filters, mode=monitoring|forensic and payloadMode=none|summary|full; raw deltas and never-claimed prompts require mode=forensic. Explicit legacy audit selectors remain supported without view. latest is an exclusive semantic-class lookup; resultMode=compact requires latest. No read observes commands or changes append-only history. REST behavior is unchanged.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          view: z4.enum(["conversation", "results", "tools", "debug"]).optional(),
          cursor: z4.string().max(4096).optional(),
          callId: z4.string().max(512).optional(),
          includeArguments: z4.boolean().optional(),
          includeOutput: z4.boolean().optional(),
          after: z4.number().int().nonnegative().optional(),
          before: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
          direction: z4.enum(SessionEventReadDirection.options).optional(),
          mode: z4.enum(SessionEventReadMode.options).optional(),
          payloadMode: z4.enum(SessionEventPayloadMode.options).optional(),
          resultMode: z4.enum(SessionEventResultMode.options).optional(),
          includeTypes: z4
            .array(
              z4
                .string()
                .refine(
                  (value) => SessionEventType.safeParse(value).success,
                  "Unknown session event type",
                ),
            )
            .max(100)
            .describe(
              "Debug audit event types, e.g. turn.completed, user.message, agent.message.completed, agent.toolCall.output. Validated against the canonical event-type registry.",
            )
            .optional(),
          excludeTypes: z4
            .array(
              z4
                .string()
                .refine(
                  (value) => SessionEventType.safeParse(value).success,
                  "Unknown session event type",
                ),
            )
            .max(100)
            .describe(
              "Debug audit event types to exclude; validated against the canonical event-type registry.",
            )
            .optional(),
          includeClasses: z4
            .array(z4.enum(SessionEventSemanticClass.options))
            .max(SessionEventSemanticClass.options.length)
            .optional(),
          excludeClasses: z4
            .array(z4.enum(SessionEventSemanticClass.options))
            .max(SessionEventSemanticClass.options.length)
            .optional(),
          latest: z4.enum(SessionEventLatestClass.options).optional(),
        },
      },
      async (
        {
          sessionId,
          view,
          cursor,
          callId,
          includeArguments,
          includeOutput,
          after,
          before,
          limit,
          direction: requestedDirection,
          mode: requestedMode,
          payloadMode: requestedPayloadMode,
          resultMode: requestedResultMode,
          includeTypes: requestedIncludeTypes,
          excludeTypes: requestedExcludeTypes,
          includeClasses,
          excludeClasses,
          latest,
        },
        extra,
      ) => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.events.read");
        // Keep the model schema compact without weakening either MCP validation
        // or direct adapter calls: the canonical registry owns accepted types.
        const includeTypes = requestedIncludeTypes?.map((type) => SessionEventType.parse(type));
        const excludeTypes = requestedExcludeTypes?.map((type) => SessionEventType.parse(type));
        const latestClass =
          latest === undefined ? undefined : sessionEventLatestClassToSemanticClass(latest);
        if (requestedResultMode === "compact" && latestClass === undefined) {
          throw new Error("resultMode=compact requires latest");
        }
        await requireSession(deps.db, grant.workspaceId, sessionId);
        const auditRequested = [
          requestedMode,
          requestedPayloadMode,
          requestedResultMode,
          includeTypes,
          excludeTypes,
          includeClasses,
          excludeClasses,
          latest,
        ].some((value) => value !== undefined);
        if (((view !== undefined && view !== "debug") || cursor !== undefined) && auditRequested) {
          throw new Error(
            "Audit selectors require view=debug and cannot change a conversation cursor",
          );
        }
        if (view !== "debug" && !auditRequested) {
          const { readSessionEventView } = await import("./session-event-view");
          const { listSessionEventSlices } = await import("@opengeni/db/session-event-slices");
          const page = await readSessionEventView(
            {
              sessionId,
              view,
              cursor,
              callId,
              includeArguments,
              includeOutput,
              after,
              before,
              direction: requestedDirection,
              limit,
            },
            (options) =>
              listSessionEventSlices(
                deps.db,
                grant.workspaceId,
                sessionId,
                options,
                (legacyOptions) =>
                  listSessionEventPage(deps.db, grant.workspaceId, sessionId, legacyOptions),
              ),
          );
          const consumed = [{ sessionId, sequences: completeChildReadSequences(page) }];
          await acknowledgeReads(consumed);
          await recordConsumedChildResults(consumed, extra);
          return json(page);
        }
        if (
          cursor !== undefined ||
          callId !== undefined ||
          includeArguments !== undefined ||
          includeOutput !== undefined
        ) {
          throw new Error("cursor/callId/includeArguments/includeOutput require a non-debug view");
        }
        if (
          latest &&
          [includeTypes, excludeTypes, includeClasses, excludeClasses].some(
            (filter) => filter !== undefined,
          )
        ) {
          throw new Error("latest cannot be combined with event filters");
        }
        const mode = requestedMode ?? "monitoring";
        const direction = latestClass
          ? "before"
          : (requestedDirection ??
            (before !== undefined ? "before" : after !== undefined ? "after" : "before"));
        const payloadMode =
          requestedResultMode === "compact"
            ? "full"
            : (requestedPayloadMode ?? (mode === "monitoring" ? "summary" : "full"));
        const dbPage = await listSessionEventPage(deps.db, grant.workspaceId, sessionId, {
          after: after ?? 0,
          ...(before !== undefined ? { before } : {}),
          direction,
          limit: latestClass ? 1 : boundedSessionEventMcpLimit(limit),
          payloadMode,
          includeTypes: includeTypes ?? [],
          excludeTypes: excludeTypes ?? [],
          includeClasses: latestClass ? [latestClass] : (includeClasses ?? []),
          excludeClasses: excludeClasses ?? [],
          ...(mode === "monitoring" ? { defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES } : {}),
          ...(mode === "monitoring" ? { excludeUnclaimedHumanPrompts: true } : {}),
          ...(latestClass ? { authoritativeLatest: true } : {}),
          maxBytes: SESSION_EVENT_MCP_MAX_BYTES * 4,
        });
        if (requestedResultMode === "compact") {
          const event = dbPage.events[0];
          const result = event
            ? boundSessionEventCompactResult(
                compactSessionEventResult(
                  event,
                  latestClass!,
                  dbPage.coveredSequence ?? {
                    first: event.sequence,
                    last: event.sequence,
                  },
                ),
              )
            : null;
          // The compact text of a turn that ended waiting for input is its
          // empty output, never the reply its human's message received, so
          // returning it is not proof of reading that reply.
          if (
            result &&
            event &&
            ["turn.completed", "agent.message.completed"].includes(result.type) &&
            turnCompletedReply(event.payload) === null &&
            !result.truncation.truncated &&
            dbPage.fullPayloadsExact
          ) {
            const consumed = [{ sessionId, sequences: [result.sequence] }];
            await acknowledgeReads(consumed);
            await recordConsumedChildResults(consumed, extra);
          }
          return json(result);
        }
        const page = boundSessionEventMcpPage({
          events: dbPage.events,
          mode,
          payloadMode,
          direction,
          sourceHasMore: dbPage.hasMore,
          sourceTruncatedBy: dbPage.truncatedBy,
          after: after ?? 0,
          before: before ?? null,
        });
        if (
          payloadMode === "full" &&
          dbPage.fullPayloadsExact &&
          !page.truncation?.reasons.includes("model_payload")
        ) {
          const consumed = [{ sessionId, sequences: page.events.map((event) => event.sequence) }];
          await acknowledgeReads(consumed);
          await recordConsumedChildResults(consumed, extra);
        }
        return json(page);
      },
    );

    server.registerTool(
      "session_wait",
      {
        description: `Wait once for durable session changes, your pending machine input, or maxWaitSeconds (default ${SESSION_WAIT_DEFAULT_SECONDS}, max ${SESSION_WAIT_MAX_SECONDS}). This is an optional in-turn execution wait, not a prerequisite for wait_for_input. Pass targets with sessionId and afterSequence: the last consumed cursor, or 0. Never substitute session_get.lastSequence, which may include an unread completion. waitFor=change returns on turn lifecycle, settled answers, terminal commands, blockers, goal facts, or session control. waitFor=completion joins a child result: only a result-bearing final turn or blocker qualifies, not commentary, goal.completed, background commands, maintenance turns, or continuation segments. Neither mode wakes on raw deltas, progress commentary, or tool receipts. Each target contains up to ${SESSION_WAIT_EVENTS_PER_TARGET} bounded summaries, latestSequence (the next afterSequence), and hasMore. For omitted rows use session_events view=results after=latestSequence for final outcomes, or view=debug with explicit filters for diagnostics; the default conversation view does not contain execution records. Byte limits can leave events=[] with hasMore=true. ownPendingUpdates > 0 means input will arrive when your next turn is claimed: finish this turn, or use includeOwnPendingUpdates=false to keep waiting. timedOut=true means no matching change; liveFanout=false means the deadline re-check supplied durable truth without the live bus. Do not immediately repeat a timeout without new evidence; an unchanged session_get snapshot between waits is not new evidence. For long or uncertain waits, including a child that needs minutes, call wait_for_input once and end the turn: the child's terminal result wakes you and carries its final answer (payload.finalAnswer). Use meaningful user/task/Skill monitoring cadences when needed; an out-of-turn wait may span hours or days within its own limits.`,
        inputSchema: {
          targets: z4
            .array(
              z4.object({
                sessionId: z4.string().uuid(),
                afterSequence: z4.number().int().nonnegative(),
              }),
            )
            .min(1)
            .max(SESSION_WAIT_MAX_TARGETS),
          includeOwnPendingUpdates: z4
            .boolean()
            .optional()
            .describe(
              "Also return when your own session has pending machine input (default true).",
            ),
          waitFor: z4
            .enum(["change", "completion"])
            .optional()
            .describe(
              "change (default) returns on relevant activity; completion ignores messages, goal/progress, maintenance, and continuation segments until a result-bearing final turn or blocker.",
            ),
          maxWaitSeconds: z4.number().int().min(1).max(SESSION_WAIT_MAX_SECONDS).optional(),
        },
      },
      async ({ targets, includeOwnPendingUpdates, waitFor, maxWaitSeconds }, extra) => {
        const distinct = new Set(targets.map((target) => target.sessionId));
        if (distinct.size !== targets.length) {
          throw new Error("session_wait targets must name distinct sessions");
        }
        // Authorize and resolve every target exactly as session_events does,
        // before any live-fanout subscription exists for it.
        for (const target of targets) {
          await authorizeFirstPartySession(deps, grant, target.sessionId, "session.events.read");
          await requireSession(deps.db, grant.workspaceId, target.sessionId);
        }
        const ownSessionId = includeOwnPendingUpdates === false ? null : callerSessionId;
        const targetEventTypes =
          waitFor === "completion" ? SESSION_WAIT_COMPLETION_EVENT_TYPES : SESSION_WAIT_EVENT_TYPES;
        // The API serves one transport per POST, so the worker's MCP cancel
        // notification never reaches this handler; the route binds the HTTP
        // request's abort to transport.close() (mcp/request-abort.ts), which
        // aborts `extra.signal` when the worker drops the call on Steer/Pause.
        // The deadline bounds the wait regardless. Direct handler invocation
        // (tests) may pass no extra at all.
        const signal: AbortSignal | undefined = extra?.signal;
        const workspaceId = grant.workspaceId;
        const incompleteWaitEvents = new Set<string>();
        // A NATS subscription is live fanout only; the durable session_events
        // read below is the authority. Bun.serve idleTimeout (255 s) and the
        // 60 s MCP client request timeout both exceed the 50 s cap.
        const result = await waitForSessionChanges({
          targets,
          ownSessionId,
          maxWaitMs: (maxWaitSeconds ?? SESSION_WAIT_DEFAULT_SECONDS) * 1_000,
          targetEventTypes,
          targetEventMatches:
            waitFor === "completion"
              ? sessionWaitCompletionEventMatches
              : sessionWaitChangeEventMatches,
          signal,
          source: {
            reauthorizeTargets: async (sessionIds) => {
              for (const targetSessionId of sessionIds) {
                await authorizeFirstPartySession(
                  deps,
                  grant,
                  targetSessionId,
                  "session.events.read",
                );
              }
            },
            readTargetEvents: async (target) => {
              const page = await listSessionEventPage(deps.db, workspaceId, target.sessionId, {
                after: target.afterSequence,
                direction: "after",
                limit: SESSION_WAIT_EVENTS_PER_TARGET,
                payloadMode: "full",
                includeTypes: targetEventTypes,
                // Progress notes must not fill the page ahead of the outcome.
                excludeStreamedAssistantMessages: waitFor !== "completion",
                maxBytes: SESSION_EVENT_MCP_MAX_BYTES * 4,
              });
              if (!page.fullPayloadsExact) {
                for (const event of page.events) incompleteWaitEvents.add(event.id);
              }
              return { events: page.events, hasMore: page.hasMore };
            },
            readOwnPendingUpdateKinds:
              ownSessionId === null
                ? null
                : async () =>
                    (await listOwnPendingUpdates(ownSessionId)).map((update) => update.kind),
            subscribe: (targetSessionId, onEvents) =>
              deps.bus.subscribe(workspaceId, targetSessionId, onEvents),
          },
        });
        if (!result.aborted && !result.truncated) {
          const consumed = result.changed.map((target) => ({
            sessionId: target.sessionId,
            sequences: target.events
              .filter((event) => event.contentComplete && !incompleteWaitEvents.has(event.id))
              .map((event) => event.sequence),
          }));
          await acknowledgeReads(consumed);
          await recordConsumedChildResults(consumed, extra);
          if (result.ownPendingUpdates > 0 && ownSessionId !== null) {
            // The returned answer may be the pending input this result
            // counted; report what is still pending so the caller is not told
            // to end its turn only to receive the answer it already has.
            const pending = await listOwnPendingUpdates(ownSessionId);
            if (pending.length !== result.ownPendingUpdates) {
              return json(
                withOwnPendingUpdateKinds(
                  result,
                  pending.map((update) => update.kind),
                ),
              );
            }
          }
        }
        return json(result);
      },
    );

    if (callerSessionId !== null) {
      for (const toolName of ["command_read", "command_wait"] as const) {
        server.registerTool(
          toolName,
          {
            description: `${toolName === "command_read" ? "Read retained output immediately, or briefly wait" : "Briefly wait using the same read operation as command_read"} for one command owned by the current session, across sandbox and Connected Machine providers. Returns bounded stdout/stderr chunks, durable state and exitCode, nextCursor and hasMore, plus explicit retention limitations. Pass nextCursor to continue; output remains readable after the process exits. A terminal read observes completion and suppresses only its still-pending inbox notification; running reads and already claimed history are unchanged. waitSeconds is at most 50; command_wait defaults to 45, command_read to 0. These execution-wait limits do not cap wait_for_input: use it for long out-of-turn waits, except pending Codemode calls require observation in the same live attempt. Neither tool sends stdin or cancels the command.`,
            inputSchema: {
              commandId: z4.string().uuid(),
              cursor: z4.string().max(128).optional(),
              waitSeconds: z4.number().int().min(0).max(COMMAND_READ_MAX_WAIT_SECONDS).optional(),
              maxOutputBytes: z4.number().int().min(4).max(COMMAND_OUTPUT_MAX_BYTES).optional(),
            },
          },
          async ({ commandId, cursor, waitSeconds, maxOutputBytes }, extra) => {
            await authorizeFirstPartySession(deps, grant, callerSessionId, "session.events.read");
            let initialRead = true;
            return json(
              await readCommandWithWait({
                commandId,
                waitSeconds:
                  waitSeconds ?? (toolName === "command_wait" ? COMMAND_WAIT_DEFAULT_SECONDS : 0),
                ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
                ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
                read: async () => {
                  if (!initialRead)
                    await authorizeFirstPartySession(
                      deps,
                      grant,
                      callerSessionId,
                      "session.events.read",
                    );
                  initialRead = false;
                  return await readSessionBackgroundCommandOutput(deps.db, {
                    accountId: grant.accountId,
                    workspaceId: grant.workspaceId,
                    sessionId: callerSessionId,
                    commandId,
                    ...(cursor === undefined ? {} : { cursor }),
                    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
                  });
                },
                subscribe: (onEvents) =>
                  deps.bus.subscribe(grant.workspaceId, callerSessionId, onEvents),
              }),
            );
          },
        );
      }
    }
  }

  if (can("sessions:create") && sessionCreateVisible) {
    const capabilityToggle = z4.boolean().optional();
    const sessionCreateAgentInput = z4
      .object({
        capabilities: z4
          .union([
            z4.enum(["all", "none"]),
            z4
              .object({
                from: z4.enum(["all", "none"]),
                webSearch: capabilityToggle,
                humanInput: capabilityToggle,
                skills: z4
                  .union([z4.literal("read"), z4.literal("manage"), z4.literal(false)])
                  .optional(),
                goals: capabilityToggle,
                subagents: capabilityToggle,
                knowledge: capabilityToggle,
                schedules: capabilityToggle,
                artifacts: capabilityToggle,
                browser: capabilityToggle,
                media: capabilityToggle,
                workspaceFiles: capabilityToggle,
                workspaceConnectors: capabilityToggle,
                workspaceAdmin: capabilityToggle,
              })
              .strict(),
          ])
          .optional(),
        identity: z4.string().min(1).max(AGENT_IDENTITY_MAX_CHARACTERS).nullable().optional(),
        instructions: z4.string().min(1).max(SESSION_INSTRUCTIONS_MAX_CHARACTERS).optional(),
        renderer: z4.enum(["opengeni", "markdown"]).optional(),
      })
      .strict()
      .optional()
      .describe(
        "Optional agent configuration for the child. Omit to inherit this session's. capabilities 'all' means everything this session has; 'none' keeps only essentials; an object starts from one and switches capabilities off (or back on within this session's own set). A child may only narrow: enabling a capability this session lacks is rejected.",
      );
    const sessionCreateInput = z4
      .object({
        initialMessage: z4.string().min(1),
        projectId: z4
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "Workspace project to file the new session into. Omit for existing default behavior; does not change runtime or visibility.",
          ),
        title: z4
          .string()
          .min(1)
          .max(SESSION_TITLE_MAX_CHARACTERS)
          .optional()
          .describe(
            "Concise semantic title for the child session. Omit only when the delegated goal or initial message already provides a suitable title; OpenGeni derives a sensitive-safe bounded fallback from that text.",
          ),
        instructions: z4.string().min(1).max(SESSION_INSTRUCTIONS_MAX_CHARACTERS).optional(),
        goal: GoalSpec.optional(),
        resources: z4
          .array(ResourceRef)
          .optional()
          .describe(
            "Omit to inherit parent repositories only. Files are never inherited automatically; explicitly include file resources to attach them. An empty array inherits no resources.",
          ),
        tools: z4.array(ToolRef).optional(),
        mcpServers: z4.array(SessionMcpServerInput).optional(),
        variableSetId: z4.string().uuid().optional(),
        variableSetIds: z4.array(z4.string().uuid()).max(MAX_SELECTED_VARIABLE_SETS).optional(),
        environmentId: z4.string().uuid().optional(),
        rigId: z4.string().uuid().optional(),
        model: z4
          .string()
          .min(1)
          .optional()
          .describe(
            "Model for the worker. Omit to inherit the exact calling turn's model, including its Codex subscription billing path.",
          ),
        reasoningEffort: CreateSessionRequest.out.shape.reasoningEffort.describe(
          "Omit to inherit the exact calling turn's reasoning effort.",
        ),
        latencyMode: z4
          .enum(["standard", "priority", "fast"])
          .optional()
          .describe(
            "Omit for standard latency, even when model and reasoning are inherited. Fast or priority must be selected explicitly and supported by the model.",
          ),
        sandboxBackend: CreateSessionRequest.out.shape.sandboxBackend,
        // Model-only structural coupling: workingDir cannot exist without a
        // targetSandboxId because both live inside one optional object. The
        // handler maps this back to the stable public REST/SDK request fields.
        machineTarget: z4
          .object({
            targetSandboxId: z4.string().uuid(),
            workingDir: z4.string().optional(),
          })
          .strict()
          .optional(),
        metadata: z4.record(z4.string(), z4.unknown()).optional(),
        idempotencyKey: z4.string().min(1).max(200).optional(),
        firstPartyMcpPermissions: z4
          .array(Permission)
          .optional()
          .describe(
            "Optional first-party capability set for the child. Omit to inherit this session's effective permissions. An explicit set may only narrow capabilities held by this session. A goal-bearing child requires goals:manage in the resulting set; creation fails rather than adding it implicitly.",
          ),
        firstPartyMcpTools: z4
          .array(z4.enum(FIRST_PARTY_MCP_TOOL_NAMES))
          .optional()
          .describe(
            "Exact model-visible first-party tool selection for the child. Omit to inherit this session's effective selection. An explicit selection may only narrow that selection: every listed tool must already be available to this session, and a wider list is rejected. To create a non-delegating leaf, provide a selection that omits session_create. This does not grant permissions.",
          ),
        // The child's agent-access scope and end-user label are never model
        // choices: it inherits this session's exactly. Only the Memory
        // selector may be narrowed here (workspace > user > off).
        memoryScope: z4
          .enum(["workspace", "user", "off"])
          .optional()
          .describe(
            "Optional Memory selector for the child. Omit to inherit this session's selector. An explicit value may only narrow it (workspace > user > off); off gives the child no Memory tools. Use task notes for task-local findings.",
          ),
        // Omission is the ordinary safe sharing path. Literal "shared" remains
        // available to advanced REST/SDK callers but is intentionally absent
        // from the model surface because it turns compatibility drift into a
        // deterministic failure instead of the omission path's safe own-box fallback.
        sandbox: z4
          .union([z4.literal("new"), z4.object({ groupId: z4.string().uuid() })])
          .optional(),
        // Registered only while agent configuration is admitted, so a
        // deployment with the switch off keeps a byte-identical tool schema.
        ...(agentConfigDeploymentPolicy(deps.settings).admissionEnabled
          ? { agent: sessionCreateAgentInput }
          : {}),
      })
      .superRefine((value, context) => {
        if (!value.variableSetIds) return;
        if (new Set(value.variableSetIds).size !== value.variableSetIds.length) {
          context.addIssue({
            code: z4.ZodIssueCode.custom,
            path: ["variableSetIds"],
            message: "variableSetIds must not contain duplicates",
          });
        }
        const singular = value.variableSetId ?? value.environmentId;
        if (singular === undefined) return;
        const expected = value.variableSetIds[value.variableSetIds.length - 1];
        if (singular !== expected) {
          context.addIssue({
            code: z4.ZodIssueCode.custom,
            path: ["variableSetId"],
            message: "variableSetId must match the last variableSetIds entry",
          });
        }
      })
      .strict();
    server.registerTool(
      "session_create",
      {
        description:
          "Spawn a new agent session (a worker) only for a concrete, bounded subtask that can run independently and has a defined integration point in your current work. Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps, and send a related follow-up to a worker you already spawned with session_send_message instead of spawning another. Explicit user requests and applicable Skill guidance for delegation, independent review, or fresh workers override that default within existing authority. After spawning work that needs minutes, once nothing else can advance, call wait_for_input and end the turn instead of alternating session_wait and session_get; no preliminary short wait or status recheck is required. The worker's terminal result wakes you and carries its final answer (payload.finalAnswer). Do not duplicate a child's implementation; independent review or comparison may intentionally examine the same subject with a distinct deliverable. Track the child and join its actual result before completing dependent work. Give the child a concise semantic title; if omitted, OpenGeni derives one from its delegated goal or initial message. The child inherits this session's visibility, agent-access scope and end-user label; a private session can only create a same-owner private child, and memoryScope may only narrow this session's selector. Give a goal-bearing child its delegated objective. Its goal.rootConstraints may be an exact applicable subset of this accepted turn's frozen root constraints; omit that field to inherit all of them. Omit sandbox for the safe default: compatible children share the creator's box, while a different Variable Set, Sandbox Environment, or machineTarget gets its own box. Use 'new' for deliberate isolation or {groupId} for a strict compatible sibling join. Put targetSandboxId and its optional workingDir together inside machineTarget; a machineTarget is always an own-box create even when the parent is backend none. To create a non-delegating leaf, pass a narrowed firstPartyMcpTools list that omits session_create; do not use a child-local depth override. Public REST/SDK callers retain advanced absolute depth and explicit shared-placement controls.",
        inputSchema: contractToolInput(sessionCreateInput),
      },
      async (args) => {
        try {
          requireVariableSetsUseForMcpAttachments(grant, {
            variableSetIds: args.variableSetIds,
            variableSetId: args.variableSetId,
            environmentId: args.environmentId,
          });
          if (callerSessionId !== null) {
            await authorizeFirstPartySession(deps, grant, callerSessionId, "session.child.create");
          }
          const { machineTarget, title, projectId, ...request } = args;
          const rawRequest = {
            ...request,
            ...(projectId !== undefined ? { channelId: projectId } : {}),
            ...(machineTarget
              ? {
                  targetSandboxId: machineTarget.targetSandboxId,
                  ...(machineTarget.workingDir !== undefined
                    ? { workingDir: machineTarget.workingDir }
                    : {}),
                }
              : {}),
          };
          // Keep authorization above validation and let core parse the original
          // request. Only this preflight's failures are attributable to input;
          // arbitrary downstream schema failures retain the private fallback.
          const validation = CreateSessionRequest.safeParse(rawRequest);
          if (!validation.success) return sessionCreateValidationFailureResult(validation.error);
          const result = await createSessionForRequestWithOutcome(
            deps,
            grant,
            grant.workspaceId,
            rawRequest,
            undefined,
            title === undefined ? {} : { automaticTitleCandidate: title },
          );
          return json(sessionCreateMutationReceipt(result, Boolean(request.idempotencyKey)));
        } catch (error) {
          return orchestrationFailureResult("session_create", error, deps, grant);
        }
      },
    );
  }

  if (can("sessions:control")) {
    server.registerTool(
      "session_send_message",
      {
        description:
          "To continue related work, by default message a worker you already spawned instead of spawning a new one; it keeps its context. Acceptance is not execution. Keep resource.id: for agent messages, match that ID in payload.updateIds from session_events view=debug, includeTypes=[system.update.delivered], payloadMode=full; retain the event turnId and read its relevant result. An unrelated in-flight turn completing does not prove delivery. Explicit user requests and applicable Skill guidance for independent review or fresh workers override that default within existing authority. Do not resend an unconsumed message; inspect blockers. Worker messages are coalescible machine input, added to history when claimed. Sessionless operator calls append a human/API prompt and resource.id is its turn ID. Use your last consumed event sequence. Report stalled delivery if it cannot safely progress.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          text: z4.string().min(1),
          idempotencyKey: z4.string().uuid(),
          // Header-value rotation only. URL/name/tool settings are immutable
          // after create; core enforces mcp_servers:attach on this field.
          mcpCredentialUpdates: z4.array(SessionMcpCredentialUpdateInput).optional(),
        },
      },
      async ({ sessionId: targetSessionId, text, idempotencyKey, mcpCredentialUpdates }) => {
        try {
          await authorizeFirstPartySession(deps, grant, targetSessionId, "session.append");
          if (callerSessionId !== null) {
            if ((mcpCredentialUpdates?.length ?? 0) > 0) {
              throw new HTTPException(422, {
                message: "internal session updates cannot change MCP credentials",
              });
            }
            const result = await sendAgentSessionMessage(
              deps,
              exactAgentCommandContext(grant, callerSessionId),
              { targetSessionId, text, idempotencyKey },
            );
            return json(
              mcpMutationReceipt({
                operation: "session_send_message",
                committed: true,
                outcome: result.replay ? "replayed" : "accepted",
                changed: !result.replay,
                resource: {
                  type: "session_system_update",
                  id: result.updateId,
                  state: result.effectiveState,
                },
                relatedResources: [{ type: "session", id: targetSessionId }],
                timestamp: result.receipt.createdAt.toISOString(),
                idempotency: { status: result.replay ? "replayed" : "applied" },
                facts: {
                  delivery: "coalesced_internal_update",
                  wakeRequested: result.wakeRevision !== null,
                  resumeRequired: result.effectiveState === "paused",
                },
                nextAction: {
                  tool: "session_get",
                  arguments: { sessionId: targetSessionId },
                },
              }),
            );
          }
          const { accepted, turn, replay } = await acceptSessionUserMessageWithOutcome(
            deps,
            grant,
            grant.workspaceId,
            targetSessionId,
            {
              text,
              delivery: "send",
              origin: "operator",
              clientEventId: idempotencyKey,
              mcpCredentialUpdates: (mcpCredentialUpdates ?? []).map((update) =>
                SessionMcpCredentialUpdateInput.parse(update),
              ),
            },
          );
          return json(
            mcpMutationReceipt({
              operation: "session_send_message",
              committed: true,
              outcome: replay ? "replayed" : "accepted",
              changed: !replay,
              resource: {
                type: "session_turn",
                id: turn.id,
                version: turn.version,
                state: turn.status,
              },
              relatedResources: [
                { type: "session", id: targetSessionId },
                {
                  type: "session_event",
                  id: accepted.id,
                  state: accepted.type,
                },
              ],
              timestamp: accepted.occurredAt,
              idempotency: { status: replay ? "replayed" : "applied" },
              nextAction: {
                tool: "session_get",
                arguments: { sessionId: targetSessionId },
              },
            }),
          );
        } catch (error) {
          return orchestrationFailureResult("session_send_message", error, deps, grant);
        }
      },
    );

    server.registerTool(
      "session_pause",
      {
        description:
          "Pause the selected session workstream, including descendants. From an agent, pausing an ancestor also stops this caller; it cannot then issue its own Resume. Do not use ancestor Pause merely to prevent concurrent edits. Waiting prompts stay saved and inert until Resume.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          idempotencyKey: z4.string().uuid(),
          reason: z4.string().min(1).max(500).optional(),
        },
      },
      async ({ sessionId, idempotencyKey, reason }) => {
        if (callerSessionId !== null) {
          const controlled = await controlAgentSessionWorkstream(
            deps,
            exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
            {
              targetSessionId: sessionId,
              action: "pause",
              idempotencyKey,
              reason: reason ?? "agent_mcp_pause",
            },
          );
          const effectiveControl = projectEffectiveControlForRelatedAccess(
            serializeEffectiveSessionControl(controlled.control),
            sessionId,
            controlled.authorization?.relatedSessionAccess ?? "root",
          );
          return json(
            sessionControlMutationReceipt({
              operation: "session_pause",
              sessionId,
              state: effectiveControl.state,
              receiptId: controlled.receipt.id,
              timestamp: controlled.receipt.createdAt.toISOString(),
              outcome: controlled.outcome,
              interruptionCount: controlled.interruptionCount,
            }),
          );
        }
        const controlled = await controlHumanSessionWorkstreamWithOutcome(
          deps,
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId,
            subjectId: grant.subjectId,
            authorizationSurface: "first_party_mcp",
          },
          {
            action: "pause",
            clientEventId: idempotencyKey,
            ...(reason ? { reason } : {}),
          },
        );
        return json(
          sessionControlMutationReceipt({
            operation: "session_pause",
            sessionId,
            state: controlled.response.effectiveControl.state,
            receiptId: controlled.response.receipt.id,
            timestamp: controlled.response.receipt.createdAt,
            outcome: controlled.outcome,
            interruptionCount: controlled.response.interruptionCount,
          }),
        );
      },
    );

    server.registerTool(
      "session_resume",
      {
        description:
          "Resume the selected session workstream through older parent/workspace pauses. This creates no message.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          idempotencyKey: z4.string().uuid(),
          reason: z4.string().min(1).max(500).optional(),
        },
      },
      async ({ sessionId, idempotencyKey, reason }) => {
        if (callerSessionId !== null) {
          const controlled = await controlAgentSessionWorkstream(
            deps,
            exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
            {
              targetSessionId: sessionId,
              action: "resume",
              idempotencyKey,
              reason: reason ?? "agent_mcp_resume",
            },
          );
          const effectiveControl = projectEffectiveControlForRelatedAccess(
            serializeEffectiveSessionControl(controlled.control),
            sessionId,
            controlled.authorization?.relatedSessionAccess ?? "root",
          );
          return json(
            sessionControlMutationReceipt({
              operation: "session_resume",
              sessionId,
              state: effectiveControl.state,
              receiptId: controlled.receipt.id,
              timestamp: controlled.receipt.createdAt.toISOString(),
              outcome: controlled.outcome,
              interruptionCount: controlled.interruptionCount,
            }),
          );
        }
        const controlled = await controlHumanSessionWorkstreamWithOutcome(
          deps,
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId,
            subjectId: grant.subjectId,
            authorizationSurface: "first_party_mcp",
          },
          {
            action: "resume",
            clientEventId: idempotencyKey,
            ...(reason ? { reason } : {}),
          },
        );
        return json(
          sessionControlMutationReceipt({
            operation: "session_resume",
            sessionId,
            state: controlled.response.effectiveControl.state,
            receiptId: controlled.response.receipt.id,
            timestamp: controlled.response.receipt.createdAt,
            outcome: controlled.outcome,
            interruptionCount: controlled.response.interruptionCount,
          }),
        );
      },
    );

    if (callerSessionId !== null) {
      server.registerTool(
        "session_steer",
        {
          description:
            "Atomically replace another session's current direction and resume it. The Agent Steer is a typed machine input shown in the target queue/timeline and durably retained in model history; it never impersonates a human prompt.",
          inputSchema: {
            sessionId: z4.string().uuid(),
            instruction: z4.string().min(1),
            idempotencyKey: z4.string().uuid(),
          },
        },
        async ({ sessionId, instruction, idempotencyKey }) => {
          try {
            const result = await steerAgentSession(
              deps,
              exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
              { targetSessionId: sessionId, instruction, idempotencyKey },
            );
            return json(
              mcpMutationReceipt({
                operation: "session_steer",
                committed: true,
                outcome: result.replay ? "replayed" : "updated",
                changed: !result.replay,
                resource: {
                  type: "session_system_update",
                  id: result.updateId,
                  state: result.effectiveState,
                },
                relatedResources: [{ type: "session", id: sessionId }],
                timestamp: result.receipt.createdAt.toISOString(),
                idempotency: { status: result.replay ? "replayed" : "applied" },
                facts: {
                  interruptionCount: result.interruptionCount,
                  stoppingPreviousAttempt: result.interruptionCount > 0,
                },
                updateId: result.updateId,
                nextAction: { tool: "session_get", arguments: { sessionId } },
              }),
            );
          } catch (error) {
            return orchestrationFailureResult("session_steer", error, deps, grant);
          }
        },
      );

      server.registerTool(
        "session_human_input_respond",
        {
          description:
            "Answer (or skip, when the request allows it) a structured human-input request that another session is blocked on, typically a worker you spawned after a `child_requires_action` update named its requestId. Use it only when you actually know the answer; otherwise report the exact blocker to the user. Tool approvals are decided by humans only and cannot be answered here. The response is recorded as an agent-attempt answer and resumes that session's blocked turn.",
          inputSchema: {
            sessionId: z4.string().uuid(),
            requestId: z4.string().uuid(),
            response: SubmitHumanInputResponseRequest,
            idempotencyKey: z4.string().uuid(),
          },
        },
        async ({ sessionId, requestId, response, idempotencyKey }) => {
          await authorizeFirstPartySession(deps, grant, sessionId, "session.human_input.write");
          const context = exactAgentCommandContext(grant, callerSessionId, "first_party_mcp");
          const parsedResponse = SubmitHumanInputResponseRequest.parse(response);
          let accepted: Awaited<ReturnType<typeof acceptSessionHumanInputResponse>>;
          try {
            accepted = await acceptSessionHumanInputResponse(deps.db, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId,
              requestId,
              response: parsedResponse,
              respondedBy: `agent_attempt:${context.callerAttemptId}`,
              respondedByKind: "agent_attempt",
              clientEventId: idempotencyKey,
            });
          } catch (error) {
            if (error instanceof HumanInputResponseValidationError) {
              throw new Error(`human-input response rejected: ${error.message}`, { cause: error });
            }
            throw error;
          }
          if (accepted.action === "not_found") {
            throw new Error("human-input request not found");
          }
          await publishDurableSessionEvents(
            deps.bus,
            grant.workspaceId,
            sessionId,
            accepted.events,
          );
          if (accepted.workflowWakeRevision !== null) {
            await deps.workflowClient.signalApprovalDecision({
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId,
              eventId: accepted.events[0]?.id ?? requestId,
              workflowId: `session-${sessionId}`,
              workflowWakeRevision: accepted.workflowWakeRevision,
            });
          }
          if (accepted.action === "conflict") {
            throw new Error("human-input request is not currently actionable");
          }
          return json(
            mcpMutationReceipt({
              operation: "session_human_input_respond",
              committed: true,
              outcome: accepted.action === "completed" ? "replayed" : "updated",
              changed: accepted.events.length > 0,
              resource: {
                type: "session_human_input_request",
                id: requestId,
                state: accepted.request.status,
              },
              relatedResources: [{ type: "session", id: sessionId }],
              timestamp: accepted.request.respondedAt ?? new Date().toISOString(),
              idempotency: {
                status: accepted.action === "completed" ? "replayed" : "applied",
              },
              facts: { outcome: accepted.request.response?.outcome ?? null },
              nextAction: { tool: "session_get", arguments: { sessionId } },
            }),
          );
        },
      );
    }

    server.registerTool(
      "set_other_session_title",
      {
        description:
          "Set another session's display title to a concise 3-7 word topic label. Use a stable noun phrase about the actual task or subject, never a quote/prefix of a prompt, greeting, request boilerplate, URL, identifier, credential, token, or other sensitive value. The target session must belong to this workspace. Replaces an existing automatic title unless a human has manually set it.",
        inputSchema: {
          session_id: z4.string().uuid(),
          title: z4.string().min(1).max(200),
        },
      },
      async ({ session_id, title }) => {
        await authorizeFirstPartySession(deps, grant, session_id, "session.title.write");
        await requireSession(deps.db, grant.workspaceId, session_id);
        const result = await updateSessionTitle(deps, grant, session_id, title, "agent");
        return json({
          ok: true,
          updated: result.updated,
          title: result.title ?? title,
        });
      },
    );

    server.registerTool(
      "session_set_model",
      {
        description:
          "Set an existing session's model and reasoning defaults for future turns. Use a model from list_models and specify the intended reasoning effort. Does not send a message, resume a paused session, wake an idle session, change latency mode, or rewrite already accepted turns/scheduled occurrences. Older queued turns keep their settings but cannot undo this choice when they start. Reuse the exact idempotencyKey for retries; session_get detail=full reads current effective defaults. Requires sessions:control and ordinary target-session authorization.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          model: z4.string().min(1).max(512),
          reasoningEffort: z4.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
          idempotencyKey: z4.string().uuid(),
        },
      },
      async ({ sessionId, ...request }) => {
        const result = await setSessionModel(deps, grant, sessionId, request, "first_party_mcp");
        return json(
          mcpMutationReceipt({
            operation: "session_set_model",
            committed: true,
            outcome: result.replay ? "replayed" : "updated",
            changed: !result.replay,
            resource: { type: "session", id: sessionId },
            relatedResources: [
              { type: "session_command_receipt", id: result.receiptId },
              { type: "session_event", id: result.eventId },
            ],
            timestamp: result.timestamp,
            idempotency: { status: result.replay ? "replayed" : "applied" },
            facts: {
              model: result.model,
              reasoningEffort: result.reasoningEffort,
              latencyMode: result.latencyMode,
              effectiveFrom: result.effectiveFrom,
            },
            nextAction: { tool: "session_get", arguments: { sessionId, detail: "full" } },
          }),
        );
      },
    );
  }
}

function registerProjectTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  json: JsonResult,
): void {
  const projectIdSchema = z4.string().uuid();
  const nameSchema = z4.string().trim().min(1).max(80);
  const descriptionSchema = z4.string().max(2000);
  if (can("sessions:read")) {
    server.registerTool(
      "project_list",
      {
        description:
          "List workspace-shared projects in sidebar order (pinned first). Projects group sessions in the user's sidebar; they do not change execution or access. Use before creating a project to reuse an existing group.",
        inputSchema: {},
      },
      async () => json({ projects: await listChannels(deps.db, grant.workspaceId) }),
    );
    server.registerTool(
      "project_get",
      {
        description:
          "Read one workspace project: name, description, pin state and order. Use sessions_list with projectId to find its visible sessions.",
        inputSchema: { projectId: projectIdSchema },
      },
      async ({ projectId }) => {
        const project = await getChannel(deps.db, grant.workspaceId, projectId);
        if (!project) throw new Error("Project not found");
        return json({ project });
      },
    );
  }
  if (can("sessions:create")) {
    server.registerTool(
      "project_create",
      {
        description:
          "Create a workspace-shared sidebar group for related sessions. A project is organizational metadata, not a repository, working directory, or inherited agent configuration.",
        inputSchema: { name: nameSchema, description: descriptionSchema.optional() },
      },
      async ({ name, description }) =>
        json({
          project: await createChannel(deps.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            name,
            description: description ?? null,
            createdBy: grant.subjectId,
          }),
        }),
    );
    server.registerTool(
      "project_update",
      {
        description:
          "Rename, describe or pin/unpin a workspace project. Pin state is shared by everyone in the workspace. Omitted fields stay unchanged; null clears the description.",
        inputSchema: {
          projectId: projectIdSchema,
          name: nameSchema.optional(),
          description: descriptionSchema.nullable().optional(),
          pinned: z4.boolean().optional(),
        },
      },
      async ({ projectId, ...update }) => {
        const project = await updateChannel(deps.db, grant.workspaceId, projectId, update);
        if (!project) throw new Error("Project not found");
        return json({ project });
      },
    );
    server.registerTool(
      "project_reorder",
      {
        description:
          "Replace the shared sidebar project order. Pass every current project ID exactly once, from project_list. Pinned projects still appear first. If projects changed, list again before retrying.",
        inputSchema: { projectIds: z4.array(projectIdSchema).min(1).max(200) },
      },
      async ({ projectIds }) => {
        const projects = await reorderChannels(deps.db, grant.workspaceId, projectIds);
        if (!projects)
          throw new Error("Projects changed or order is invalid; call project_list and retry");
        return json({ projects });
      },
    );
    server.registerTool(
      "project_delete",
      {
        description:
          "Delete a workspace-shared project. Its sessions are preserved and become unfiled; no running work is stopped.",
        inputSchema: { projectId: projectIdSchema },
      },
      async ({ projectId }) => {
        if (!(await deleteChannel(deps.db, grant.workspaceId, projectId)))
          throw new Error("Project not found");
        return json({ ok: true, projectId });
      },
    );
  }
  if (can("sessions:control")) {
    server.registerTool(
      "session_set_project",
      {
        description:
          "File a session into a workspace project, or pass projectId=null to unfile it. Projects group root sessions in the user's sidebar. Filing changes organization only, not visibility, instructions, runtime, or history.",
        inputSchema: { sessionId: z4.string().uuid(), projectId: projectIdSchema.nullable() },
      },
      async ({ sessionId, projectId }) => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.control");
        await requireSession(deps.db, grant.workspaceId, sessionId);
        if (
          !(await setSessionChannel(deps.db, {
            workspaceId: grant.workspaceId,
            sessionId,
            channelId: projectId,
          }))
        )
          throw new Error("Session not found");
        return json({ ok: true, sessionId, projectId });
      },
    );
  }
}

// Variable-set management for agents. Generic reads remain metadata-only.
// Plaintext has one dedicated tool that additionally requires literal
// secrets:read plus exact live attempt/session authorization.
function registerVariableSetTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  sessionId: string | null,
  json: JsonResult,
): void {
  const variableSetAccess = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  const registerListTool = (name: string, description: string): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {},
      },
      async () => {
        const variableSets = await listVariableSets(deps.db, variableSetAccess);
        return json({ variableSets, environments: variableSets });
      },
    );
  };
  const setVariableHandler =
    (operation: "variable_set_set_variable" | "environment_set_variable") =>
    async ({
      variableSetId,
      variableSetName,
      environmentId,
      environmentName,
      name,
      value,
    }: {
      variableSetId?: string | undefined;
      variableSetName?: string | undefined;
      environmentId?: string | undefined;
      environmentName?: string | undefined;
      name: string;
      value: string;
    }) => {
      const key = requireVariableSetEncryption(deps.settings);
      const parsedName = VariableSetVariableName.safeParse(name);
      if (!parsedName.success) {
        throw new Error("variable set/environment variable names must match ^[A-Z][A-Z0-9_]*$");
      }
      assertAllowedVariableSetVariableName(parsedName.data);
      const targetId = variableSetId ?? environmentId;
      const targetName = variableSetName ?? environmentName;
      if ((targetId === undefined) === (targetName === undefined)) {
        throw new Error(
          "provide exactly one of variableSetId or variableSetName; deprecated aliases must provide exactly one of environmentId or environmentName",
        );
      }
      const trimmedVariableSetName = targetName?.trim();
      if (targetName !== undefined && !trimmedVariableSetName) {
        throw new Error("variable set name is required");
      }
      let created = false;
      let variableSet =
        targetId !== undefined
          ? await getVariableSet(deps.db, variableSetAccess, targetId)
          : await getVariableSetByName(deps.db, variableSetAccess, trimmedVariableSetName!);
      if (!variableSet && targetId !== undefined) {
        throw new Error("variable set/environment not found");
      }
      if (!variableSet) {
        if (
          (await countVariableSets(deps.db, variableSetAccess)) >= MAX_ENVIRONMENTS_PER_WORKSPACE
        ) {
          throw new Error(
            `a workspace supports at most ${MAX_ENVIRONMENTS_PER_WORKSPACE} variable sets`,
          );
        }
        variableSet = await createVariableSet(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          scope: "workspace",
          subjectId: grant.subjectId,
          name: trimmedVariableSetName!,
        });
        created = true;
        await recordVariableSetAuditEvent(deps.db, {
          grant,
          action: "variable_set.created",
          variableSetId: variableSet.id,
        });
      }
      const exists = variableSet.variables.some((variable) => variable.name === parsedName.data);
      if (!exists && variableSet.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
        throw new Error(
          `a variable set supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables`,
        );
      }
      const metadata = await setVariableSetVariable(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        variableSetId: variableSet.id,
        name: parsedName.data,
        valueEncrypted: encryptVariableSetValue(key, value),
      });
      await recordVariableSetAuditEvent(deps.db, {
        grant,
        action: "variable_set.variable.set",
        variableSetId: variableSet.id,
        variableName: parsedName.data,
      });
      return json(
        mcpMutationReceipt({
          operation,
          committed: true,
          outcome: exists ? "updated" : "created",
          changed: true,
          resource: {
            type: "variable_set",
            id: variableSet.id,
            version: metadata.version,
            state: "variable_written",
          },
          timestamp: metadata.updatedAt,
          idempotency: { status: "not_supported" },
          facts: {
            variableCreated: !exists,
            variableSetCreated: created,
            deprecatedAlias: operation === "environment_set_variable",
          },
          nextAction: { tool: "variable_set_list", arguments: {} },
        }),
      );
    };
  const registerSetTool = (
    name: "variable_set_set_variable" | "environment_set_variable",
    description: string,
  ): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          variableSetId: z4.string().uuid().optional(),
          variableSetName: z4.string().min(1).optional(),
          environmentId: z4.string().uuid().optional(),
          environmentName: z4.string().min(1).optional(),
          name: z4.string().min(1),
          value: z4.string().min(1).max(32768),
        },
      },
      setVariableHandler(name),
    );
  };
  if (can("variable-sets:list") && can("secrets:list")) {
    registerListTool(
      "variable_set_list",
      "List variable sets with variable names and metadata (versions, timestamps). Plaintext values are never returned by list operations.",
    );
    registerListTool(
      "environment_list",
      "(deprecated alias of variable_set_list) List variable sets with variable names and metadata (versions, timestamps). Plaintext values are never returned by list operations.",
    );
  }

  if (
    sessionId !== null &&
    can("variable-sets:read") &&
    hasLiteralPermission(grant.permissions, "secrets:read")
  ) {
    server.registerTool(
      "variable_set_get_variable",
      {
        description:
          "Retrieve one exact plaintext variable value. This is a dedicated high-trust read: use it only when the current task requires the configured value. The access is audited against this exact live attempt.",
        inputSchema: {
          variableSetId: z4.string().uuid().optional(),
          variableSetName: z4.string().min(1).max(120).optional(),
          name: z4.string().min(1),
        },
      },
      async ({ variableSetId, variableSetName, name }) => {
        let target: { variableSetId: string } | { variableSetName: string };
        if (variableSetId !== undefined) {
          if (variableSetName !== undefined) {
            throw new Error("provide exactly one of variableSetId or variableSetName");
          }
          target = { variableSetId };
        } else {
          if (variableSetName === undefined) {
            throw new Error("provide exactly one of variableSetId or variableSetName");
          }
          target = { variableSetName };
        }
        if (
          ("variableSetId" in target && target.variableSetId.length === 0) ||
          ("variableSetName" in target && target.variableSetName.trim().length === 0)
        ) {
          throw new Error("provide exactly one of variableSetId or variableSetName");
        }
        const parsedName = VariableSetVariableName.safeParse(name);
        if (!parsedName.success) {
          throw new Error("variable set variable names must match ^[A-Z][A-Z0-9_]*$");
        }
        assertAllowedVariableSetVariableName(parsedName.data);
        const claims = exactAgentAttemptClaims(grant);
        if (!claims || claims.sessionId !== sessionId) {
          throw new Error("Exact signed secret-read attempt authority is required.");
        }
        await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
        await authorizeFirstPartySession(deps, grant, sessionId, "session.secret.read");
        const key = requireVariableSetEncryption(deps.settings);
        const secret = await readVariableSetSecretAtomically(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          ...target,
          name: parsedName.data,
          actor: {
            kind: "agent_attempt",
            sessionId: claims.sessionId,
            turnId: claims.turnId,
            attemptId: claims.attemptId,
            executionGeneration: claims.executionGeneration,
          },
          decrypt: (valueEncrypted) => decryptVariableSetValue(key, valueEncrypted),
        });
        if (!secret) throw new Error("variable set variable not found");
        return json(secret);
      },
    );
  }

  if (can("variable-sets:write") && can("secrets:write")) {
    registerSetTool(
      "variable_set_set_variable",
      "Set or rotate one variable in a variable set. Target by variableSetId, or by variableSetName (created if it does not exist). The value is encrypted at rest and injected into sandboxes of sessions the variable set is attached to. Reading it requires the dedicated permissioned secret-read operation.",
    );
    registerSetTool(
      "environment_set_variable",
      "(deprecated alias of variable_set_set_variable) Set or rotate one variable in a variable set. Target by variableSetId, or by variableSetName (created if it does not exist). The value is encrypted at rest and injected into sandboxes of sessions the variable set is attached to. Reading it requires the dedicated permissioned secret-read operation.",
    );
  }
}

type CapabilitySetupProjection =
  | { status: "ready"; action: null; detail: string }
  | {
      status: "authorization_required";
      action: "connect" | "add_credentials" | "enable";
      detail: string;
    }
  | { status: "unavailable"; action: null; detail: string };

function registerCapabilityDiscoveryTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const catalog = () =>
    buildCapabilityCatalog({
      db: deps.db,
      workspaceId: grant.workspaceId,
      settings: deps.settings,
      subjectId: grant.subjectId,
    });
  const authorize = async () => {
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };

  // Installation is workspace metadata; an enabled personal MCP is usable only
  // when its tools actually made it into this caller's immutable attempt catalog.
  // This is a readiness projection, never credential resolution or a new grant.
  const setupProjections = async (items: CapabilityCatalogItem[]) => {
    const availableServerIds = new Set<string>();
    const availableFirstPartyTools = new Set<string>();
    const acceptedServerIds = new Set<string>();
    let accountSelectionKnown = false;
    if (
      items.some(
        (item) => item.enabled && (item.connectionRef || item.surfaceType === "first_party_fiken"),
      )
    ) {
      const claims = exactAgentCommandContext(grant, sessionId);
      const attemptCatalog = await getAttemptToolCatalog(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        attemptId: claims.callerAttemptId,
      });
      if (
        attemptCatalog?.sessionId === sessionId &&
        attemptCatalog.turnId === claims.callerTurnId &&
        attemptCatalog.executionGeneration === claims.callerExecutionGeneration
      ) {
        for (const entry of attemptCatalog.entries) {
          availableServerIds.add(entry.identity.serverId);
          if (entry.identity.serverId === "opengeni")
            availableFirstPartyTools.add(entry.identity.toolName);
        }
        const bindings = await getSessionTurnMcpAccountBindings(
          deps.db,
          grant.workspaceId,
          sessionId,
          claims.callerTurnId,
        );
        accountSelectionKnown = bindings !== null;
        const readiness = capabilityAccountReadiness(availableServerIds, bindings);
        for (const id of readiness.available) availableServerIds.add(id);
        for (const id of readiness.accepted) acceptedServerIds.add(id);
      }
    }
    return await Promise.all(
      items.map((item) =>
        capabilitySetupProjection(
          deps,
          grant.workspaceId,
          item,
          availableServerIds,
          acceptedServerIds,
          accountSelectionKnown,
          availableFirstPartyTools,
          new Set((grant.metadata?.firstPartyMcpTools as string[] | undefined) ?? []),
        ),
      ),
    );
  };

  server.registerTool(
    "capability_catalog_search",
    {
      description:
        "Find integrations in OpenGeni's reviewed workspace catalog when the user asks to add one or needed access is missing. Search by integration name or task outcome. Results describe setup status and provide setup.nextAction when human setup can be requested. Use available tools directly for ready candidates. This reads metadata only and does not connect or authorize anything.",
      inputSchema: {
        query: z4.string().min(1).max(500),
        limit: z4.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, limit }) => {
      await authorize();
      const current = await catalog();
      const ranked = searchCapabilityCatalogItems(
        [...current.items, ...nativeConnectionCapabilityRecommendations()],
        query,
        limit ?? 8,
      );
      const setups = await setupProjections(ranked.map(({ item }) => item));
      const matches = ranked.map(({ item, matchedOn }, index) => ({
        capabilityId: item.id,
        name: item.name,
        description: item.description,
        kind: item.kind,
        source: item.source,
        category: item.category,
        tags: item.tags.slice(0, 16),
        providerDomain: item.providerDomain,
        authKind: item.authKind,
        tier: item.tier,
        matchedOn,
        setup: {
          ...setups[index]!,
          requiredVariables: capabilityRequiredVariables(item),
          nextAction:
            setups[index]!.status === "authorization_required"
              ? { toolName: "capability_authorization_request", capabilityId: item.id }
              : null,
        },
      }));
      return json({ query, matches });
    },
  );

  server.registerTool(
    "capability_authorization_request",
    {
      description:
        "Show a Connect card in this chat for a suitable capability returned by capability_catalog_search with setup.nextAction. Supply its capability ID and a brief rationale explaining how it helps the task; no separate confirmation is needed before showing the card. Requesting setup needs no integration-management permission and grants no access. The authenticated human completes setup through the card; never ask them to paste credentials into chat. Do not request another card for the same pending setup, or for a candidate reported ready or unavailable. GitHub App (api:github-app) is the exception: when it is already connected the card is still shown, listing repositories the person can use in this chat.",
      inputSchema: {
        capabilityId: z4.string().min(1).max(512),
        rationale: z4.string().min(1).max(2000),
      },
    },
    async ({ capabilityId, rationale }) => {
      await authorize();
      const current = await catalog();
      const item = [...current.items, ...nativeConnectionCapabilityRecommendations()].find(
        (candidate) => candidate.id === capabilityId,
      );
      if (!item || !capabilityCatalogItemIsTrustedForExposure(item)) {
        throw new Error("Unknown or untrusted capability; search the catalog again.");
      }
      const [setup] = await setupProjections([item]);
      if (!setup) throw new Error("Capability setup projection is unavailable.");
      // GitHub is the one capability whose card stays useful once connected:
      // it lists the shared repositories with a "Use" action that attaches one
      // to this chat, so a ready GitHub still gets its card.
      const githubCardWhenReady = setup.status === "ready" && item.id === "api:github-app";
      if (setup.status === "ready" && !githubCardWhenReady) {
        return json({
          capabilityId: item.id,
          status: "ready",
          message: setup.detail,
        });
      }
      if (setup.status === "unavailable") {
        return json({
          capabilityId: item.id,
          status: "unavailable",
          message: setup.detail,
        });
      }
      const claims = exactAgentCommandContext(grant, sessionId);
      const payload = ToolAuthNeededPayload.parse({
        serverId: item.runtime.mcpServerId ?? "opengeni",
        toolName: "capability_authorization_request",
        providerDomain: capabilityProviderDomain(item),
        reason: "missing_connection",
        capability: {
          id: item.id,
          name: item.name,
          kind: item.kind,
          source: item.source,
          action: setup.action ?? "connect",
          rationale,
          requiredVariables: capabilityRequiredVariables(item),
        },
      });
      const appended = await appendAndPublishTurnEventsFenced(
        deps.db,
        deps.bus,
        grant.workspaceId,
        sessionId,
        claims.callerTurnId,
        claims.callerExecutionGeneration,
        claims.callerAttemptId,
        [{ type: "tool.auth_needed", payload }],
      );
      if (!appended.accepted) {
        throw new Error(
          "The calling turn was replaced before the authorization request committed.",
        );
      }
      if (githubCardWhenReady) {
        return json({
          capabilityId: item.id,
          status: "ready",
          eventId: appended.events[0]?.id ?? null,
          message: `${setup.detail} The GitHub card is in this chat: the person picks a repository with its "Use" button, which attaches it to this chat.`,
        });
      }
      return json({
        capabilityId: item.id,
        status: "authorization_requested",
        action: setup.action,
        eventId: appended.events[0]?.id ?? null,
        message:
          "The recommendation was posted for human confirmation. No access has been granted yet.",
      });
    },
  );

  server.registerTool(
    "custom_mcp_setup_request",
    {
      description:
        "Show a review card for a remote HTTPS MCP server that is not in the workspace catalog. Use only an endpoint supplied by the user or established by reliable documentation; do not invent a URL. Never include query parameters or secrets in this URL; the human can edit it in the protected setup form. The agent cannot add, enable, or contact the server. Search the catalog first and do not propose an already available integration.",
      inputSchema: {
        name: z4.string().trim().min(1).max(256),
        endpointUrl: z4
          .string()
          .url()
          .max(2048)
          .refine((url) => {
            const parsed = new URL(url);
            return (
              parsed.protocol === "https:" &&
              !parsed.username &&
              !parsed.password &&
              !parsed.hash &&
              !parsed.search
            );
          }),
        rationale: z4.string().trim().min(1).max(2000),
      },
    },
    async ({ name, endpointUrl, rationale }) => {
      await authorize();
      const current = await catalog();
      const existing = current.items.find(
        (item) => item.kind === "mcp" && item.endpointUrl === endpointUrl && !item.stale,
      );
      if (existing) {
        return json({
          status: "already_in_catalog",
          capabilityId: existing.id,
          message: "Use the catalog authorization flow for this server instead.",
        });
      }
      const claims = exactAgentCommandContext(grant, sessionId);
      const payload = ToolAuthNeededPayload.parse({
        serverId: "opengeni",
        toolName: "custom_mcp_setup_request",
        providerDomain: new URL(endpointUrl).hostname,
        reason: "missing_connection",
        setupRequest: { kind: "mcp", name, endpointUrl, rationale },
      });
      const appended = await appendAndPublishTurnEventsFenced(
        deps.db,
        deps.bus,
        grant.workspaceId,
        sessionId,
        claims.callerTurnId,
        claims.callerExecutionGeneration,
        claims.callerAttemptId,
        [{ type: "tool.auth_needed", payload }],
      );
      if (!appended.accepted) {
        throw new Error("The calling turn was replaced before the setup request committed.");
      }
      return json({
        status: "setup_requested",
        eventId: appended.events[0]?.id ?? null,
        message: "The human review card was posted. No server was added or contacted.",
      });
    },
  );
}

async function capabilitySetupProjection(
  deps: ApiRouteDeps,
  workspaceId: string,
  item: CapabilityCatalogItem,
  availableServerIds: ReadonlySet<string>,
  acceptedServerIds: ReadonlySet<string>,
  accountSelectionKnown: boolean,
  availableFirstPartyTools: ReadonlySet<string>,
  selectedFirstPartyTools: ReadonlySet<string>,
): Promise<CapabilitySetupProjection> {
  if (item.surfaceType === "first_party_fiken") {
    if (!item.enabled || item.metadata.connectionStatus !== "active") {
      return {
        status: "authorization_required",
        action: "connect",
        detail:
          item.metadata.connectionStatus === "needs_reauth"
            ? "The workspace Fiken connection needs reconnection."
            : "Connect Fiken through the protected setup form.",
      };
    }
    const selected = FIRST_PARTY_MCP_TOOL_NAMES.filter(
      (name) => name.startsWith("fiken_") && selectedFirstPartyTools.has(name),
    );
    if (selected.length === 0) {
      return {
        status: "authorization_required",
        action: "enable",
        detail:
          "Fiken is connected, but its tools are not selected for this conversation. Ask the user to add its tools through the setup card, then send a new message.",
      };
    }
    if (selected.some((name) => availableFirstPartyTools.has(name))) {
      return {
        status: "ready",
        action: null,
        detail: "Fiken is connected and has tools available in this turn.",
      };
    }
    return {
      status: "unavailable",
      action: null,
      detail:
        "Fiken is connected, but its selected tools are unavailable in this execution. Check tool permissions and setup before retrying; reconnection is not required by this status.",
    };
  }
  if (item.id === "api:github-app" || item.surfaceType === "first_party_github") {
    const missing = githubAppMissingSettings(deps.settings);
    if (missing.length > 0) {
      return {
        status: "unavailable",
        action: null,
        detail:
          deps.settings.productAccessMode === "managed"
            ? "GitHub is not available on this deployment."
            : `The operator must configure the GitHub App first (${missing.join(", ")}).`,
      };
    }
    const installations = await listWorkspaceGitHubInstallationBindings(deps, workspaceId);
    if (githubBindingStatus(true, installations) === "bound") {
      return {
        status: "ready",
        action: null,
        detail: "GitHub is connected and ready.",
      };
    }
    return {
      status: "authorization_required",
      action: "connect",
      detail: "A GitHub owner must approve an installation and repository allowlist.",
    };
  }
  if (item.surfaceType === "codex_apps") {
    return item.enabled
      ? {
          status: "ready",
          action: null,
          detail: "Codex Apps is connected and ready.",
        }
      : {
          status: "authorization_required",
          action: "connect",
          detail: "A workspace admin must designate an authorized Codex Apps subscription.",
        };
  }
  if (item.enabled && item.connectionRef) {
    if (item.runtime.mcpServerId && availableServerIds.has(item.runtime.mcpServerId)) {
      return {
        status: "ready",
        action: null,
        detail: "This capability has tools available in this turn.",
      };
    }
    if (
      !accountSelectionKnown ||
      (item.runtime.mcpServerId && acceptedServerIds.has(item.runtime.mcpServerId))
    ) {
      return {
        status: "unavailable",
        action: null,
        detail:
          "This integration's tools are unavailable in this execution. Check its connection or setup failure before requesting reconnection; missing tools alone do not establish an authorization failure.",
      };
    }
    return {
      status: "authorization_required",
      action: "connect",
      detail:
        "This integration is enabled in the workspace, but no account was selected for this execution. Connect or select an account available to the sender, then send a new message.",
    };
  }
  if (item.enabled) {
    return {
      status: "ready",
      action: null,
      detail: "This capability is already enabled.",
    };
  }
  if (!item.runtime.available) {
    return {
      status: "unavailable",
      action: null,
      detail: item.runtime.notes ?? "This catalog entry has no executable runtime adapter.",
    };
  }
  if (item.authKind === "oauth2" || item.surfaceType === "first_party_social") {
    return {
      status: "authorization_required",
      action: "connect",
      detail: "The user must confirm the provider domain and complete sign-in.",
    };
  }
  if (item.authKind === "api_key" || item.authModel?.toLowerCase().includes("key")) {
    return {
      status: "authorization_required",
      action: "add_credentials",
      detail: "The user must provide the required credential through the protected setup form.",
    };
  }
  return {
    status: "authorization_required",
    action: "enable",
    detail: "A workspace admin must review and enable this capability.",
  };
}

function capabilityRequiredVariables(item: CapabilityCatalogItem): string[] {
  const variableSet = item.metadata.variableSet;
  if (!variableSet || typeof variableSet !== "object" || Array.isArray(variableSet)) return [];
  const required = (variableSet as Record<string, unknown>).requiredVariables;
  return Array.isArray(required)
    ? required.filter((name): name is string => typeof name === "string").slice(0, 64)
    : [];
}

function capabilityProviderDomain(item: CapabilityCatalogItem): string {
  if (item.providerDomain?.trim()) return item.providerDomain.trim();
  for (const candidate of [item.homepageUrl, item.endpointUrl, item.mcpUrl]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).hostname;
    } catch {
      // Continue to the local, non-provider fallback below.
    }
  }
  return "opengeni.local";
}

function registerGitHubConnectTool(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  options: McpServerOptions,
  json: JsonResult,
): void {
  server.registerTool(
    "github_connect_link",
    {
      description:
        "Report truthful GitHub App workspace binding status and, for a human grant with github:manage, return the fresh GitHub owner-consent link. Server App configuration alone is never reported as a usable binding.",
      inputSchema: {},
    },
    async () => {
      const { settings } = deps;
      const missing = githubAppMissingSettings(settings);
      const slug = settings.githubAppSlug?.trim() || null;
      const setupMode = settings.productAccessMode === "managed" ? "platform" : "operator";
      if (missing.length > 0 || !slug) {
        return json({
          configured: false,
          status: "disabled",
          setupMode,
          appSlug: setupMode === "operator" ? slug : null,
          installUrl: null,
          linkUrl: null,
          missing: setupMode === "operator" ? missing : [],
        });
      }
      const installations = await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId);
      const status = githubBindingStatus(true, installations);
      const baseUrl = githubBrowserBaseUrl(settings, options.requestOrigin);
      const state =
        baseUrl && hasPermission(grant.permissions, "github:manage")
          ? createSignedState(deps.githubStateSecret, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              intent: "installation_authority",
              ...githubBrowserGrantClaims(settings, grant),
            })
          : null;
      const connectUrl = state
        ? `${baseUrl}/v1/workspaces/${grant.workspaceId}/github/connect?state=${encodeURIComponent(state)}`
        : null;
      const installationViews = installations.map((installation) => ({
        ...installation,
        configureUrl:
          state && baseUrl
            ? `${baseUrl}/v1/workspaces/${grant.workspaceId}/github/installations/${installation.installationId}/configure?state=${encodeURIComponent(state)}`
            : null,
      }));
      return json({
        configured: true,
        status,
        setupMode,
        appSlug: setupMode === "operator" ? slug : null,
        installUrl: connectUrl,
        linkUrl: connectUrl,
        installations: installationViews,
        missing: [],
      });
    },
  );
}

// Defense-in-depth for invariant "agents cannot self-attach": the worker's
// first-party delegated token must carry both exact attachment and use
// permissions, so a token narrowed to only one cannot attach a variable set.
// agents calling these MCP tools cannot attach a variable set.
// Explicit detach (variableSetId: null) is also an attachment change and is
// blocked the same way.
function requireVariableSetsUseForMcpAttachment(
  grant: AccessGrant,
  variableSetId: string | null | undefined,
): void {
  if (variableSetId === undefined) return;
  if (!hasPermission(grant.permissions, "variable-sets:attach")) {
    throw new Error("missing permission: variable-sets:attach");
  }
  if (variableSetId !== null && !hasPermission(grant.permissions, "variable-sets:use")) {
    throw new Error("missing permission: variable-sets:use");
  }
}

function requireVariableSetsUseForMcpAttachments(
  grant: AccessGrant,
  selection: {
    variableSetIds?: string[] | undefined;
    variableSetId?: string | undefined;
    environmentId?: string | undefined;
  },
): void {
  const singular = selection.variableSetId ?? selection.environmentId;
  const variableSetIds = selection.variableSetIds ?? (singular ? [singular] : undefined);
  if (variableSetIds === undefined) return;
  if (!hasPermission(grant.permissions, "variable-sets:attach")) {
    throw new HTTPException(403, { message: "missing permission: variable-sets:attach" });
  }
  if (variableSetIds.length > 0 && !hasPermission(grant.permissions, "variable-sets:use")) {
    throw new HTTPException(403, { message: "missing permission: variable-sets:use" });
  }
}

/**
 * Project one allowlisted GitHub App repository into the resource an agent or
 * scheduled task attaches. Every listed repository is in the workspace
 * allowlist, public or private, so every resource carries the stable ids
 * that mint the scoped installation token; a bare URI would clone anonymously
 * and could never push.
 */
export function repositoryWithScheduledTaskResource(
  repository: GitHubRepository,
): GitHubRepository & { resource: ResourceRef } {
  return { ...repository, resource: githubRepositoryResourceRef(repository) };
}

function boundedMcpLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function boundedRigHistoryLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function boundedSessionEventMcpLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 40;
  return Math.min(250, Math.max(1, Math.floor(limit)));
}

const SESSION_DISCOVERY_DEFAULT_LIMIT = 20;
const SESSION_DISCOVERY_MAX_LIMIT = 100;
const SESSION_DISCOVERY_TEXT_CHARS = 600;
const SESSION_DISCOVERY_PREVIEW_MAX_BYTES = 16_384;
const SESSION_DISCOVERY_PREVIEW_OMISSION_REASON = "aggregatePreviewBudget" as const;
const SESSION_DISCOVERY_PAGE_MAX_BYTES = 128_000;
const SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL = "session_events" as const;
const SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT = {
  view: "debug",
  direction: "before",
  limit: 1,
  mode: "monitoring",
  payloadMode: "summary",
} as const;

function sessionDiscoveryPreviewDrillDownInput(sessionId: string, type: SessionEventType) {
  return {
    sessionId,
    includeTypes: [type],
    ...SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT,
  };
}

function boundedSessionDiscoveryLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return SESSION_DISCOVERY_DEFAULT_LIMIT;
  return Math.min(SESSION_DISCOVERY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function encodeSessionDiscoveryCursor(cursor: SessionDiscoveryCursor): string {
  const relevance = cursor.orderBy === "relevance";
  return Buffer.from(
    JSON.stringify({
      v: cursor.originSiteId ? 4 : relevance ? 3 : 2,
      ...(cursor.originSiteId ? { originSiteId: cursor.originSiteId } : {}),
      orderBy: cursor.orderBy,
      ...(relevance ? { sortRank: cursor.sortRank, filterHash: cursor.filterHash } : {}),
      sortRevision: cursor.sortRevision,
      sortAt: cursor.sortAt,
      id: cursor.id,
      snapshotAt: cursor.snapshotAt,
      snapshotRevision: cursor.snapshotRevision,
      updatedAfter: cursor.updatedAfter,
    }),
    "utf8",
  ).toString("base64url");
}

const SESSION_DISCOVERY_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SESSION_DISCOVERY_REVISION = /^(?:0|[1-9]\d*)$/;
const SESSION_DISCOVERY_REVISION_MAX = 9_223_372_036_854_775_807n;
const SESSION_DISCOVERY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSessionDiscoveryTimestamp(value: string, label: string): string {
  if (!SESSION_DISCOVERY_TIMESTAMP.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`sessions_list ${label} must be an ISO UTC date-time`);
  }
  // Preserve up to six fractional digits. Converting through JS Date would
  // discard PostgreSQL microseconds and can skip equal-millisecond rows.
  return value;
}

function normalizeSessionDiscoveryRevision(value: string, label: string): string {
  if (!SESSION_DISCOVERY_REVISION.test(value)) {
    throw new Error(`sessions_list ${label} must be a decimal activity revision`);
  }
  const revision = BigInt(value);
  if (revision > SESSION_DISCOVERY_REVISION_MAX) {
    throw new Error(`sessions_list ${label} exceeds the database activity revision range`);
  }
  return revision.toString();
}

export function decodeSessionDiscoveryCursor(value: string): SessionDiscoveryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      orderBy?: unknown;
      sortRevision?: unknown;
      sortAt?: unknown;
      createdAt?: unknown;
      id?: unknown;
      snapshotAt?: unknown;
      snapshotRevision?: unknown;
      updatedAfter?: unknown;
      sortRank?: unknown;
      filterHash?: unknown;
      originSiteId?: unknown;
    };
    if (
      parsed.v === undefined &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      const createdAt = normalizeSessionDiscoveryTimestamp(
        parsed.createdAt,
        "legacy cursor createdAt",
      );
      return {
        orderBy: "createdAt",
        sortRank: null,
        sortRevision: "0",
        sortAt: createdAt,
        id: parsed.id,
        snapshotAt: createdAt,
        snapshotRevision: "0",
        updatedAfter: null,
        filterHash: null,
      };
    }
    // The timestamp-fenced v1 format was never safe for updated-order
    // continuation. Preserve rolling compatibility only for creation cursors,
    // whose immutable ordering does not need an activity revision.
    if (
      parsed.v === 1 &&
      parsed.orderBy === "createdAt" &&
      typeof parsed.sortAt === "string" &&
      typeof parsed.snapshotAt === "string" &&
      parsed.updatedAfter === null &&
      typeof parsed.id === "string" &&
      SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      return {
        orderBy: "createdAt",
        sortRank: null,
        sortRevision: "0",
        sortAt: normalizeSessionDiscoveryTimestamp(parsed.sortAt, "cursor sortAt"),
        id: parsed.id,
        snapshotAt: normalizeSessionDiscoveryTimestamp(parsed.snapshotAt, "cursor snapshotAt"),
        snapshotRevision: "0",
        updatedAfter: null,
        filterHash: null,
      };
    }
    const isV2 = parsed.v === 2;
    const isV3 = parsed.v === 3;
    const isV4 = parsed.v === 4;
    const relevance = parsed.orderBy === "relevance";
    if (
      (!isV2 && !isV3 && !isV4) ||
      (isV4 &&
        (typeof parsed.originSiteId !== "string" ||
          !SESSION_DISCOVERY_UUID.test(parsed.originSiteId) ||
          !["createdAt", "updatedAt", "relevance"].includes(parsed.orderBy as string))) ||
      (isV2 && parsed.orderBy !== "createdAt" && parsed.orderBy !== "updatedAt") ||
      (isV3 && parsed.orderBy !== "relevance") ||
      typeof parsed.sortRevision !== "string" ||
      typeof parsed.sortAt !== "string" ||
      typeof parsed.snapshotAt !== "string" ||
      typeof parsed.snapshotRevision !== "string" ||
      (parsed.updatedAfter !== null && typeof parsed.updatedAfter !== "string") ||
      typeof parsed.id !== "string" ||
      !SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor fields");
    }
    if (
      relevance &&
      (!Number.isSafeInteger(parsed.sortRank) ||
        (parsed.sortRank as number) < 0 ||
        typeof parsed.filterHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.filterHash))
    ) {
      throw new Error("invalid relevance cursor fields");
    }
    if (!relevance && (parsed.sortRank !== undefined || parsed.filterHash !== undefined)) {
      throw new Error("chronological cursor cannot carry relevance fields");
    }
    const sortAt = normalizeSessionDiscoveryTimestamp(parsed.sortAt, "cursor sortAt");
    const snapshotAt = normalizeSessionDiscoveryTimestamp(parsed.snapshotAt, "cursor snapshotAt");
    const sortRevision = normalizeSessionDiscoveryRevision(
      parsed.sortRevision,
      "cursor sortRevision",
    );
    const snapshotRevision = normalizeSessionDiscoveryRevision(
      parsed.snapshotRevision,
      "cursor snapshotRevision",
    );
    const normalizedUpdatedAfter =
      parsed.updatedAfter === null
        ? null
        : normalizeSessionDiscoveryRevision(parsed.updatedAfter, "cursor updatedAfter");
    if (normalizedUpdatedAfter !== null && parsed.orderBy !== "updatedAt") {
      throw new Error("incremental cursor requires updatedAt order");
    }
    if (parsed.orderBy === "createdAt" && (sortRevision !== "0" || snapshotRevision !== "0")) {
      throw new Error("creation cursor cannot carry activity revisions");
    }
    const orderBy: SessionDiscoveryOrderBy = relevance
      ? "relevance"
      : (parsed.orderBy as "createdAt" | "updatedAt");
    return {
      orderBy,
      sortRank: relevance ? (parsed.sortRank as number) : null,
      sortRevision,
      sortAt,
      id: parsed.id,
      snapshotAt,
      snapshotRevision,
      updatedAfter: normalizedUpdatedAfter,
      filterHash: relevance ? (parsed.filterHash as string) : null,
      ...(isV4 ? { originSiteId: parsed.originSiteId as string } : {}),
    };
  } catch {
    throw new Error("sessions_list cursor is invalid");
  }
}

export function capSessionDiscoveryCompactPage(
  page: Awaited<ReturnType<typeof listSessionDiscoverySummaries>>,
  options: { includeLastMessage?: boolean; includeRelatedWork?: boolean } = {},
  maxBytes = SESSION_DISCOVERY_PAGE_MAX_BYTES,
) {
  let previewBytes = 0;
  const projected = page.sessions.map((session) => {
    const row = {
      ...compactSessionMcpListRow(session, options.includeRelatedWork),
      ...(options.includeLastMessage && session.queuedPromptCount > 0
        ? { queuedPromptCount: session.queuedPromptCount }
        : {}),
    };
    if (!options.includeLastMessage) return row;
    const preview = capSessionDiscoveryText(
      session.latestMessage?.preview ?? null,
      600,
      session.latestMessage?.previewOriginalChars,
    );
    if (!session.latestMessage) return row;
    const bytes = Buffer.byteLength(preview.text ?? "", "utf8");
    const omitted = previewBytes + bytes > SESSION_DISCOVERY_PREVIEW_MAX_BYTES;
    if (!omitted) previewBytes += bytes;
    return {
      ...row,
      latestMessage: {
        type: session.latestMessage.type,
        ...(omitted
          ? {
              previewOmitted: true,
              previewOmissionReason: SESSION_DISCOVERY_PREVIEW_OMISSION_REASON,
              previewDrillDownTool: SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL,
              previewDrillDownInput: sessionDiscoveryPreviewDrillDownInput(
                session.id,
                session.latestMessage.type,
              ),
            }
          : {
              preview: preview.text,
              ...(preview.truncated ? { previewTruncated: true } : {}),
            }),
      },
    };
  });
  let kept = projected;
  const build = () => {
    const dropped = kept.length < projected.length;
    const last = page.sessions[kept.length - 1];
    const cursor =
      dropped && last
        ? {
            orderBy: page.orderBy,
            sortRank: last.sortRank,
            sortRevision: last.sortRevision,
            sortAt: last.sortAt,
            id: last.id,
            snapshotAt: page.snapshotAt,
            snapshotRevision: page.snapshotRevision,
            updatedAfter: page.updatedAfter,
            filterHash: page.filterHash,
            ...(page.originSiteId ? { originSiteId: page.originSiteId } : {}),
          }
        : page.nextCursor;
    return {
      sessions: kept,
      total: page.total,
      nextCursor: cursor ? encodeSessionDiscoveryCursor(cursor) : null,
      ...(page.orderBy === "updatedAt" ? { updatedThrough: page.updatedThrough } : {}),
      ...(dropped
        ? {
            responseTruncated: true,
            truncationReason: `response exceeded ${maxBytes} bytes; continue with nextCursor`,
          }
        : {}),
    };
  };
  let result = build();
  while (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > maxBytes && kept.length > 1) {
    kept = kept.slice(0, -1);
    result = build();
  }
  if (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > maxBytes) {
    throw new RangeError(`sessions_list compact metadata exceeds its ${maxBytes}-byte envelope`);
  }
  return result;
}

export function capSessionDiscoveryPage(
  page: Awaited<ReturnType<typeof listSessionDiscoverySummaries>>,
  includeLastMessage: boolean,
) {
  const projected = page.sessions.map((session) => {
    const title = capSessionDiscoveryText(session.title, 200, session.titleOriginalChars);
    const goal = session.goal
      ? capSessionDiscoveryText(
          session.goal.text,
          SESSION_DISCOVERY_TEXT_CHARS,
          session.goal.textOriginalChars,
        )
      : null;
    const preview = includeLastMessage
      ? capSessionDiscoveryText(
          session.latestMessage?.preview ?? null,
          SESSION_DISCOVERY_TEXT_CHARS,
          session.latestMessage?.previewOriginalChars,
        )
      : null;
    const blocker = session.effectiveControl.primaryBlocker;
    const blockerDisplayName = blocker
      ? capSessionDiscoveryText(blocker.displayName, 200, blocker.displayNameOriginalChars)
      : null;
    return {
      id: session.id,
      ...(session.channelId ? { projectId: session.channelId } : {}),
      title: title.text,
      titleTruncated: title.truncated,
      parentSessionId: session.parentSessionId,
      isRoot: session.parentSessionId === null,
      status: session.status,
      pause: {
        state: session.effectiveControl.state,
        additionalBlockerCount: session.effectiveControl.additionalBlockerCount,
        source: blocker
          ? {
              kind: blocker.kind,
              ...(blocker.sessionId ? { sessionId: blocker.sessionId } : {}),
              displayName: blockerDisplayName!.text,
              displayNameTruncated: blockerDisplayName!.truncated,
            }
          : null,
      },
      goal: session.goal
        ? {
            status: session.goal.status,
            summary: goal!.text,
            summaryTruncated: goal!.truncated,
          }
        : null,
      queuedPromptCount: session.queuedPromptCount,
      children: session.treeStats,
      relatedWork: session.workDiscovery,
      ...(includeLastMessage
        ? {
            latestMessage: session.latestMessage
              ? {
                  type: session.latestMessage.type,
                  preview: preview!.text,
                  previewTruncated: preview!.truncated,
                }
              : null,
          }
        : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  });

  // The database order is already the useful discovery order. Spend the
  // separate preview budget in that order so the first page retains previews
  // for the most relevant rows and later rows remain discoverable by status.
  let budgetBytes = 0;
  const budgeted = includeLastMessage
    ? projected.map((session) => {
        const latestMessage = session.latestMessage;
        if (!latestMessage || latestMessage.preview === null) return session;
        const candidateBytes = Buffer.byteLength(latestMessage.preview, "utf8");
        if (budgetBytes + candidateBytes <= SESSION_DISCOVERY_PREVIEW_MAX_BYTES) {
          budgetBytes += candidateBytes;
          return session;
        }
        return {
          ...session,
          latestMessage: {
            ...latestMessage,
            preview: null,
            previewOmitted: true,
            previewOmissionReason: SESSION_DISCOVERY_PREVIEW_OMISSION_REASON,
            previewDrillDownTool: SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL,
            previewDrillDownInput: sessionDiscoveryPreviewDrillDownInput(
              session.id,
              latestMessage.type,
            ),
          },
        };
      })
    : projected;

  let kept = budgeted;
  const build = () => {
    const previewBytes = includeLastMessage
      ? kept.reduce(
          (total, session) =>
            total +
            (session.latestMessage?.preview === null || !session.latestMessage
              ? 0
              : Buffer.byteLength(session.latestMessage.preview, "utf8")),
          0,
        )
      : 0;
    const previewOmittedCount = includeLastMessage
      ? kept.filter((session) => {
          const latestMessage = session.latestMessage;
          return (
            latestMessage != null &&
            "previewOmitted" in latestMessage &&
            latestMessage.previewOmitted === true
          );
        }).length
      : 0;
    const lastKept = kept.at(-1);
    const droppedForByteCap = kept.length < projected.length;
    const sourceLast = lastKept
      ? page.sessions.find((session) => session.id === lastKept.id)
      : undefined;
    const nextCursor = droppedForByteCap
      ? sourceLast
        ? encodeSessionDiscoveryCursor({
            orderBy: page.orderBy,
            sortRank: sourceLast.sortRank,
            sortRevision: sourceLast.sortRevision,
            sortAt: sourceLast.sortAt,
            id: sourceLast.id,
            snapshotAt: page.snapshotAt,
            snapshotRevision: page.snapshotRevision,
            updatedAfter: page.updatedAfter,
            filterHash: page.filterHash,
            ...(page.originSiteId ? { originSiteId: page.originSiteId } : {}),
          })
        : null
      : page.nextCursor
        ? encodeSessionDiscoveryCursor(page.nextCursor)
        : null;
    const result = {
      sessions: kept,
      total: page.total,
      hasMore: page.hasMore || droppedForByteCap,
      nextCursor,
      orderBy: page.orderBy,
      snapshotAt: page.snapshotAt,
      snapshotRevision: page.snapshotRevision,
      updatedAfter: page.updatedAfter,
      updatedThrough: page.updatedThrough,
      ...(includeLastMessage
        ? {
            latestMessagePreviewBudget: {
              bytes: previewBytes,
              maxBytes: SESSION_DISCOVERY_PREVIEW_MAX_BYTES,
              omittedCount: previewOmittedCount,
              truncated: previewOmittedCount > 0,
              omissionReason:
                previewOmittedCount > 0 ? SESSION_DISCOVERY_PREVIEW_OMISSION_REASON : null,
              drillDownTool: SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL,
              drillDownInput: {
                includeTypes: ["user.message", "agent.message.completed"] as const,
                ...SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT,
              },
            },
          }
        : {}),
      responseTruncated: droppedForByteCap,
      ...(droppedForByteCap
        ? {
            truncationReason: `response exceeded ${SESSION_DISCOVERY_PAGE_MAX_BYTES} bytes; continue with nextCursor`,
          }
        : {}),
      bytes: 0,
      maxBytes: SESSION_DISCOVERY_PAGE_MAX_BYTES,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const measured = Buffer.byteLength(JSON.stringify(result, null, 2), "utf8");
      if (result.bytes === measured) break;
      result.bytes = measured;
    }
    return result;
  };

  let result = build();
  while (result.bytes > SESSION_DISCOVERY_PAGE_MAX_BYTES && kept.length > 1) {
    kept = kept.slice(0, -1);
    result = build();
  }
  if (result.bytes > SESSION_DISCOVERY_PAGE_MAX_BYTES) {
    throw new RangeError(
      `sessions_list metadata exceeds its ${SESSION_DISCOVERY_PAGE_MAX_BYTES}-byte envelope`,
    );
  }
  return result;
}

function parseMcpDate(raw: string, label: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return date;
}

async function withMcpEffectivePolicy(
  deps: ApiRouteDeps,
  workspaceId: string,
  subjectId: string,
  session: Session,
): Promise<Session> {
  const [workspaceServerIds, workspaceDefaultServerIds, effectiveToolsContext] = await Promise.all([
    workspaceSessionToolPolicyServerIds(deps.db, workspaceId, deps.settings, subjectId),
    workspaceSessionToolPolicyDefaultServerIds(deps.db, workspaceId, deps.settings, subjectId),
    workspaceSessionEffectiveToolsContext(deps, workspaceId, subjectId, [session]),
  ]);
  return sessionWithEffectiveToolPolicy(
    session,
    workspaceServerIds,
    workspaceDefaultServerIds,
    effectiveToolsContext,
  );
}
