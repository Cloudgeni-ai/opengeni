import {
  OPENGENI_BROWSER_EXTENSION_URL,
  CUA_DESKTOP_TOOLS,
  cuaDesktopToolVariants,
  AttemptToolResult,
  ComputerNativeReceipt,
} from "@opengeni/contracts";
import { boundComputerNativeReceipt } from "@opengeni/interaction";
import {
  AttachedBrowserDeviceListResponse,
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  BrowserAction,
  BrowserActionBatch,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDownload,
  BrowserDownloadListResponse,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  BrowserDomReadResponse,
  BrowserDomReadLocator,
  BrowserDomReadSelector,
  BrowserDomSafeAttribute,
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserObservation,
  BrowserActionResolvedTarget,
  BrowserDialog,
  InteractionDiagnosticSummary,
  InteractionError,
  InteractionOperationState,
  InteractionRect,
  RetainedArtifactReferenceSchema,
  InteractionSemanticNode,
  BrowserRevisionListResponse,
  BrowserSession,
  BrowserStorageMode,
  browserSessionStorageMode,
  BrowserSessionMutationResponse,
  BrowserTarget,
  BrowserTargetListResponse,
  ComputerAction,
  ComputerActionReceipt,
  ComputerClipboard,
  ComputerObservation,
  ComputerSession,
  ComputerSessionMutationResponse,
  ComputerTarget,
  ComputerTargetListResponse,
  ExternalAuthRunRequest,
  ExternalAuthRunResponse,
  InteractionIntervention,
  InteractionPlacement,
  PublishBrowserRevisionResponse,
  ReportAuthRunPayload,
  RequestHumanInteractionToolInput,
  RequestHumanInteractionToolOutput,
  SiteAuthConnection,
  SiteAuthConnectionListResponse,
  StartAuthRunRequest,
  VerifyAuthRunRequest,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_IN_PROCESS_TOOL_NAMES,
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type Permission,
  type AttemptToolJsonSchema,
  type AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";
import {
  firstPartyMcpInternalWorkspaceUrl,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import type {
  AttemptToolDefinition,
  AttemptToolExecutionContext,
  AttemptToolScope,
} from "@opengeni/codemode";
import {
  OpenGeniApiError,
  OpenGeniClient,
  interactionControlFailureFromError,
  type InteractionControlFailure,
  type InteractionTransport,
} from "@opengeni/sdk";
import { z } from "zod";
import {
  BrowserTargetResolutionError,
  CurrentBrowserTab,
  expandRefShorthand,
  type ResolvedBrowserSession,
  type ResolvedBrowserTarget,
} from "./browser-current-tab";
import {
  describeInvalidToolArguments,
  interactionToolInputJsonSchema,
  withRefShorthandLocators,
} from "./interaction-tool-json-schema";
import { guardedMcpFetch } from "./mcp-network";
import {
  browserActionText,
  browserObservationText,
  browserOpenText,
  browserReadText,
  browserTabsText,
} from "./browser-model-text";
import {
  computerActionText,
  computerObservationText,
  computerOpenText,
  computerTargetsText,
} from "./computer-model-text";

export const INTERACTION_ATTEMPT_TOOL_NAMES = FIRST_PARTY_IN_PROCESS_TOOL_NAMES;

export type InteractionAttemptToolName = (typeof INTERACTION_ATTEMPT_TOOL_NAMES)[number];

class InteractionExecutionResult<T> {
  constructor(
    readonly output: T,
    readonly additionalContent: AttemptToolResultValue["content"],
  ) {}
}

const BROWSER_AGENT_MAX_NODES = 60;
const BROWSER_AGENT_MAX_NODE_BYTES = 12_000;
const BROWSER_AGENT_MAX_FIELD_LENGTH = 180;
const BROWSER_READ_MAX_NODES = 80;
// A base64 image is journaled inside a 16 MiB Code Mode result. Leave room
// for JSON framing, metadata, and other content instead of failing after capture.
const BROWSER_TOOL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const BrowserAgentNode = z
  .object({
    ref: z.string().max(512),
    role: z.string().max(256),
    depth: z.number().int().nonnegative(),
    name: z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH).optional(),
    description: z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH).optional(),
    value: z
      .union([
        z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH),
        z.object({ redacted: z.literal(true), reason: z.string().max(32) }).strict(),
      ])
      .optional(),
    // Omitted when empty: most nodes have no states or actions, and repeating
    // empty arrays on every node only costs the model tokens.
    states: z.array(z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH)).min(1).max(6).optional(),
    actions: z.array(z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH)).min(1).max(6).optional(),
  })
  .strict();
/** The model-facing view keeps only what a next call can use: what is on the
 * page, the refs to act on, the fences an action may pass, and explicit budget
 * omissions. Zero counts and constant limits are left out. */
const BrowserAgentView = z
  .object({
    sourceKind: z.enum(["snapshot", "diff", "none"]),
    nodes: z.array(BrowserAgentNode).max(BROWSER_AGENT_MAX_NODES),
    omittedNodeCount: z.number().int().positive().optional(),
    removedRefCount: z.number().int().positive().optional(),
    clippedFieldCount: z.number().int().positive().optional(),
  })
  .strict();
/** A tab as the model needs it: identity, page, selection and the generations
 * an action or human request may pass as fences. Timestamps stay out. */
const AgentBrowserTarget = z
  .object({
    id: z.string().max(512),
    kind: z.enum(["page", "popup", "background_page", "worker"]),
    title: z.string().max(4_096),
    url: z.string().max(16_384),
    selected: z.boolean(),
    controllerGeneration: z.string().max(256),
    targetGeneration: z.string().max(256),
    documentGeneration: z.string().max(256).nullable(),
  })
  .strict();
const CompactBrowserObservation = z
  .object({
    target: AgentBrowserTarget,
    frameId: z.string().max(256).optional(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive().optional(),
        maxTouchPoints: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    focusedRef: z.string().max(512).optional(),
    changedRegions: z.array(InteractionRect).min(1).optional(),
    diagnostics: InteractionDiagnosticSummary.optional(),
    dialog: BrowserDialog.optional(),
    screenshot: RetainedArtifactReferenceSchema.optional(),
    agentView: BrowserAgentView,
  })
  .strict();
const BrowserAgentObservation = z.union([BrowserObservation, CompactBrowserObservation]);
const CompactBrowserActionReceipt = z
  .object({
    targetId: z.string().max(512),
    state: InteractionOperationState,
    error: InteractionError.optional(),
    targets: z.array(BrowserActionResolvedTarget).optional(),
    observation: CompactBrowserObservation.optional(),
  })
  .strict();
const BrowserAgentActionReceipt = z.union([BrowserActionReceipt, CompactBrowserActionReceipt]);
/** Browser tools default to the browser and tab the agent used last. */
const CurrentBrowserSessionId = z
  .string()
  .uuid()
  .optional()
  .describe("Omit to use the browser you used last.");
const CurrentBrowserTargetId = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe("Omit to use the tab you used last.");
const BrowserScreenshotInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    fullPage: z.boolean().optional(),
    quality: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const BrowserScreenshotOutput = z
  .object({
    kind: z.literal("browser_screenshot"),
    browserSessionId: z.string().uuid(),
    targetId: z.string(),
    frameId: z.string(),
    targetGeneration: z.string(),
    documentGeneration: z.string(),
    mediaType: z.enum(["image/jpeg", "image/png"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    scrollX: z.number(),
    scrollY: z.number(),
    capturedAt: z.string(),
    fullPage: z.boolean(),
  })
  .strict();
const BrowserReadInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    mode: z.enum(["matches", "count", "subtree", "dom"]).optional(),
    dom: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("element"),
            locator: BrowserDomReadLocator,
            attributes: z.array(BrowserDomSafeAttribute).max(6).optional(),
            maxChars: z.number().int().min(1).max(4_096).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("count"),
            selector: BrowserDomReadSelector,
          })
          .strict(),
      ])
      .optional(),
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedDocumentGeneration: z.string().min(1).max(256).nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    ref: z.string().min(1).max(512).optional(),
    scopeRef: z.string().min(1).max(512).optional(),
    role: z.string().min(1).max(256).optional(),
    nameContains: z.string().min(1).max(512).optional(),
    textContains: z.string().min(1).max(512).optional(),
    state: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(BROWSER_READ_MAX_NODES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "subtree" && !value.ref) {
      context.addIssue({ code: "custom", path: ["ref"], message: "subtree requires a ref" });
    }
    if ((value.mode === "dom") !== (value.dom !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["dom"],
        message: "dom query is required only with mode=dom",
      });
    }
    if (
      value.mode === "dom" &&
      [
        value.ref,
        value.scopeRef,
        value.role,
        value.nameContains,
        value.textContains,
        value.state,
        value.action,
        value.limit,
      ].some((field) => field !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "accessibility filters cannot be combined with a DOM query",
      });
    }
    if (
      value.mode !== "dom" &&
      [
        value.expectedTargetGeneration,
        value.expectedDocumentGeneration,
        value.expectedFrameId,
      ].some((field) => field !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "DOM generation fences require mode=dom",
      });
    }
  });
const BrowserReadOutput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string(),
    observationId: z.string(),
    targetGeneration: z.string(),
    documentGeneration: z.string().nullable(),
    frameId: z.string().nullable(),
    source: z.literal("accessibility"),
    mode: z.enum(["matches", "count", "subtree"]),
    scopeFound: z.boolean(),
    nodes: z.array(BrowserAgentNode).max(BROWSER_READ_MAX_NODES),
    totalMatches: z.number().int().nonnegative(),
    omittedMatches: z.number().int().nonnegative(),
    clippedFieldCount: z.number().int().nonnegative(),
    maxNodeBytes: z.number().int().positive(),
  })
  .strict();
const BrowserDomAgentReadOutput = BrowserDomReadResponse.safeExtend({
  source: z.literal("dom"),
});
const BrowserReadToolOutput = z.discriminatedUnion("source", [
  BrowserReadOutput,
  BrowserDomAgentReadOutput,
]);

type BrowserSemanticNodeValue = z.infer<typeof InteractionSemanticNode>;
type FlatBrowserNode = {
  node: BrowserSemanticNodeValue;
  depth: number;
  index: number;
  withinScope: boolean;
  parentName?: string;
};

const TOOL_PERMISSION = {
  interaction_discover: "sessions:read",
  browser_open: "sessions:control",
  browser_tabs: "sessions:control",
  browser_observe: "sessions:read",
  browser_read: "sessions:read",
  browser_screenshot: "sessions:read",
  browser_act: "sessions:control",
  browser_clipboard: "sessions:read",
  browser_debug: "sessions:read",
  browser_downloads: "sessions:read",
  browser_download_save: ["sessions:control", "files:upload"],
  browser_auth: "sessions:control",
  interaction_request_human: "sessions:control",
  browser_identity: "sessions:control",
  browser_publish: "sessions:control",
  browser_lifecycle: "sessions:control",
  computer_open: "sessions:control",
  computer_targets: "sessions:read",
  computer_observe: "sessions:read",
  computer_clipboard: "sessions:read",
  computer_act: "sessions:control",
  computer_lifecycle: "sessions:control",
} as const satisfies Record<InteractionAttemptToolName, Permission | readonly Permission[]>;

const DiscoveryInput = z
  .object({
    scope: z.enum(["current_session", "workspace", "attached_browsers"]).optional(),
    includeTerminal: z.boolean().optional(),
    includeArchivedIdentities: z.boolean().optional(),
    includeDisconnectedDevices: z.boolean().optional(),
  })
  .strict();
/** An attached Chrome profile as the model needs it to choose one: identity,
 * labels, state and any capability it lacks. Enrollment, generation and
 * timestamp bookkeeping stay out. */
const AgentAttachedBrowser = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(200),
    profileLabel: z.string().max(200).optional(),
    browserName: z.string().max(100),
    platform: z.enum(["linux", "macos", "windows"]),
    state: z.enum(["connected", "disconnected"]),
    tabCount: z.number().int().nonnegative(),
    unsupported: z.array(z.string().max(64)).min(1).optional(),
  })
  .strict();
/** An online machine that can host the extension but has no attached profile. */
const AgentAttachedBrowserBridge = z
  .object({
    enrollmentId: z.string().uuid(),
    connectedProfileCount: z.number().int().nonnegative(),
  })
  .strict();
const DiscoveryOutput = z
  .object({
    browserRevision: z.number().int().nonnegative(),
    computerRevision: z.number().int().nonnegative(),
    identityRevision: z.number().int().nonnegative(),
    attachedBrowserRevision: z.number().int().nonnegative(),
    browsers: z.array(BrowserSession),
    computers: z.array(ComputerSession),
    identities: z.array(BrowserIdentity),
    attachedBrowserBridges: z.array(AgentAttachedBrowserBridge),
    attachedBrowsers: z.array(AgentAttachedBrowser),
  })
  .strict();

/** browser_open may name the person's connected Chrome without a profile id;
 * the tool then resolves it (see chooseAttachedProfile). */
const BrowserOpenPlacement = z.union([
  InteractionPlacement,
  z.object({ kind: z.literal("attached_device") }).strict(),
]);
/** The Chrome profile browser_open chose when the request named none. */
const AgentAttachedProfile = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    profileLabel: z.string().optional(),
  })
  .strict();

const BrowserOpenInput = z
  .object({
    browserSessionId: z.string().uuid().optional(),
    mode: z.enum(["reuse_or_create", "new"]).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    initialUrl: z.string().url().max(16_384).optional(),
    headless: z.boolean().optional(),
    storageMode: BrowserStorageMode.optional(),
    placement: BrowserOpenPlacement.optional(),
    identityId: z.string().uuid().optional(),
    baseRevisionId: z.string().uuid().optional(),
    networkRouteId: z.string().uuid().optional(),
    linkedComputerSessionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.browserSessionId &&
      value.storageMode === "ephemeral_context" &&
      (value.headless !== true ||
        value.identityId ||
        value.baseRevisionId ||
        value.networkRouteId ||
        value.linkedComputerSessionId ||
        (value.placement && value.placement.kind !== "sandbox_group"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["storageMode"],
        message:
          "ephemeral_context requires headless sandbox Chromium without identity, revision, route or Computer",
      });
    }
    if (value.browserSessionId && value.mode === "new") {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "mode=new cannot target an existing BrowserSession",
      });
    }
    if (
      value.browserSessionId &&
      (value.identityId || value.baseRevisionId || value.networkRouteId || value.placement)
    ) {
      context.addIssue({
        code: "custom",
        path: ["browserSessionId"],
        message: "an existing BrowserSession already has fixed identity and placement",
      });
    }
  });
const BrowserOpenOutput = z
  .object({
    session: BrowserSession,
    targets: z.array(AgentBrowserTarget),
    otherTabCount: z.number().int().nonnegative().optional(),
    observation: CompactBrowserObservation.optional(),
    attachedProfile: AgentAttachedProfile.optional(),
    otherAttachedProfiles: z.array(AgentAttachedProfile).optional(),
  })
  .strict();

const BrowserTabsInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), browserSessionId: CurrentBrowserSessionId }).strict(),
  z
    .object({
      operation: z.literal("open"),
      browserSessionId: CurrentBrowserSessionId,
      url: z.string().url().max(16_384).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("select"),
      browserSessionId: CurrentBrowserSessionId,
      targetId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      operation: z.literal("close"),
      browserSessionId: CurrentBrowserSessionId,
      targetId: z.string().min(1).max(512),
    })
    .strict(),
]);
const BrowserTabsOutput = z
  .object({
    browserSessionId: z.string().uuid(),
    targets: z.array(AgentBrowserTarget),
    mutationObservation: CompactBrowserObservation.optional(),
  })
  .strict();

const BrowserObserveInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    view: z.enum(["compact", "full"]).optional(),
    includeScreenshot: z.boolean().optional(),
  })
  .strict();
const BrowserActInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedDocumentGeneration: z.string().min(1).max(256).nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    view: z.enum(["compact", "full", "none"]).optional(),
    action: z.preprocess(expandRefShorthand, z.union([BrowserAction, BrowserActionBatch])),
  })
  .strict();
const BrowserClipboardInput = z.object({ browserSessionId: z.string().uuid() }).strict();
const BrowserDebugInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    kinds: z
      .array(z.enum(["console", "page_error", "failed_request", "download"]))
      .max(4)
      .optional(),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const BrowserAuthInput = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list_connections"),
      includeArchived: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("get_connection"),
      siteAuthConnectionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("list_runs"),
      browserSessionId: z.string().uuid().optional(),
      siteAuthConnectionId: z.string().uuid().optional(),
      includeSettled: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal("get_run"), authRunId: z.string().uuid() }).strict(),
  z
    .object({ operation: z.literal("start"), browserSessionId: z.string().uuid() })
    .extend(StartAuthRunRequest.omit({ operationId: true }).shape)
    .strict(),
  ReportAuthRunPayload.safeExtend({
    operation: z.literal("report"),
    browserSessionId: z.string().uuid(),
    authRunId: z.string().uuid(),
  }),
  z
    .object({
      operation: z.literal("advance_external"),
      browserSessionId: z.string().uuid(),
      authRunId: z.string().uuid(),
    })
    .extend(ExternalAuthRunRequest.omit({ operationId: true }).shape)
    .strict(),
  z
    .object({
      operation: z.literal("verify"),
      browserSessionId: z.string().uuid(),
      authRunId: z.string().uuid(),
    })
    .extend(VerifyAuthRunRequest.omit({ operationId: true }).shape)
    .strict(),
]);

const BrowserAuthOutput = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list_connections"),
      result: SiteAuthConnectionListResponse,
    })
    .strict(),
  z
    .object({
      operation: z.literal("get_connection"),
      result: SiteAuthConnection,
    })
    .strict(),
  z.object({ operation: z.literal("list_runs"), result: AuthRunListResponse }).strict(),
  z.object({ operation: z.literal("get_run"), result: AuthRun }).strict(),
  z.object({ operation: z.literal("start"), result: AuthRunMutationResponse }).strict(),
  z.object({ operation: z.literal("report"), result: AuthRunMutationResponse }).strict(),
  z.object({ operation: z.literal("advance_external"), result: ExternalAuthRunResponse }).strict(),
  z.object({ operation: z.literal("verify"), result: AuthRunMutationResponse }).strict(),
]);

export type InteractionInterventionResume = {
  toolCallId: string;
  intervention: z.infer<typeof InteractionIntervention>;
};
const BrowserPublishInput = z
  .object({
    browserSessionId: z.string().uuid(),
    identityId: z.string().uuid(),
    expectedHeadGeneration: z.number().int().nonnegative(),
    advanceDefault: z.boolean().optional(),
  })
  .strict();
const BrowserIdentityInput = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("list"), includeArchived: z.boolean().optional() }).strict(),
    z.object({ operation: z.literal("get"), identityId: z.string().uuid() }).strict(),
    z.object({ operation: z.literal("create"), name: z.string().trim().min(1).max(200) }).strict(),
    z
      .object({
        operation: z.literal("update"),
        identityId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        name: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["active", "archived"]).optional(),
        defaultRevisionId: z.string().uuid().optional(),
      })
      .strict(),
    z.object({ operation: z.literal("revisions"), identityId: z.string().uuid() }).strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.operation === "update" &&
      value.name === undefined &&
      value.status === undefined &&
      value.defaultRevisionId === undefined
    ) {
      context.addIssue({ code: "custom", message: "browser identity update is empty" });
    }
  });
const BrowserIdentityOutput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), result: BrowserIdentityListResponse }).strict(),
  z.object({ operation: z.literal("get"), result: BrowserIdentity }).strict(),
  z.object({ operation: z.literal("create"), result: BrowserIdentityMutationResponse }).strict(),
  z.object({ operation: z.literal("update"), result: BrowserIdentityMutationResponse }).strict(),
  z.object({ operation: z.literal("revisions"), result: BrowserRevisionListResponse }).strict(),
]);
const BrowserLifecycleInput = z
  .object({
    browserSessionId: z.string().uuid(),
    action: z.enum(["suspend", "resume", "end"]),
  })
  .strict();

const ComputerOpenInput = z
  .object({
    computerSessionId: z.string().uuid().optional(),
    mode: z.enum(["reuse_or_create", "new"]).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    placement: InteractionPlacement.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.computerSessionId && value.mode === "new") {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "mode=new cannot target an existing ComputerSession",
      });
    }
    if (value.computerSessionId && value.placement) {
      context.addIssue({
        code: "custom",
        path: ["computerSessionId"],
        message: "an existing ComputerSession already has fixed placement",
      });
    }
  });
const ComputerOpenOutput = z
  .object({ session: ComputerSession, targets: z.array(ComputerTarget) })
  .strict();
const ComputerTargetsInput = z.object({ computerSessionId: z.string().uuid() }).strict();
const ComputerObserveInput = z
  .object({
    computerSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
  })
  .strict();
const ComputerObserveOutput = ComputerObservation.extend({
  capturedFrame: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict(),
}).strict();
const ComputerClipboardInput = z.object({ computerSessionId: z.string().uuid() }).strict();
const ComputerActInput = z
  .object({
    computerSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedObservationId: ComputerObservation.shape.observationId.nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    action: ComputerAction,
  })
  .strict();
const ComputerLifecycleInput = z
  .object({
    computerSessionId: z.string().uuid(),
    action: z.literal("end"),
  })
  .strict();

const TERMINAL_LIFECYCLES = new Set(["ended", "failed"]);

const BrowserDownloadsInput = z
  .object({
    browserSessionId: z.string().uuid(),
    operation: z.enum(["list", "get"]).default("list"),
    downloadId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === "get") !== (value.downloadId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["downloadId"],
        message: "downloadId is required only for operation=get",
      });
    }
  });
const BrowserDownloadSaveInput = BrowserDownloadSaveRequest.omit({ operationId: true })
  .extend({ browserSessionId: z.string().uuid(), downloadId: z.string().uuid() })
  .strict();

export type CreateInteractionAttemptToolsInput = {
  transport: InteractionTransport;
  workspaceId: string;
  sessionId: string;
  selectedTools?: readonly FirstPartyMcpToolName[];
  permissions?: readonly Permission[];
  interventionResume?: InteractionInterventionResume | null;
};

export function createInteractionAttemptToolDefinitions(
  input: CreateInteractionAttemptToolsInput,
): AttemptToolDefinition[] {
  const selected = new Set(input.selectedTools ?? DEFAULT_FIRST_PARTY_MCP_TOOLS);
  const permissions = input.permissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const definitions: AttemptToolDefinition[] = [];
  const currentTab = new CurrentBrowserTab({
    listLiveSessions: async () =>
      filterDiscoveredSessions(
        (
          await input.transport.listBrowserSessions(input.workspaceId, {
            associatedSessionId: input.sessionId,
            includeTerminal: false,
          })
        ).sessions,
        input.sessionId,
        "current_session",
        false,
      ),
    listTargets: async (browserSessionId) =>
      (await input.transport.listBrowserTargets(input.workspaceId, browserSessionId)).targets,
  });
  /** Run one call on the requested or current tab and remember it on success. */
  const onTab = async <T>(
    value: { browserSessionId?: string | undefined; targetId?: string | undefined },
    run: (tab: ResolvedBrowserTarget) => Promise<T>,
  ): Promise<T> => {
    const tab = await currentTab.target(value);
    try {
      const output = await run(tab);
      currentTab.use(tab.browserSessionId, tab.targetId);
      return output;
    } catch (error) {
      if (isGoneBrowserError(error)) currentTab.failed(tab);
      throw error;
    }
  };
  /** Run one call on the requested or current browser and remember it on success. */
  const onBrowser = async <T>(
    browserSessionId: string | undefined,
    run: (browser: ResolvedBrowserSession) => Promise<T>,
  ): Promise<T> => {
    const browser = await currentTab.session(browserSessionId);
    try {
      const output = await run(browser);
      currentTab.use(browser.browserSessionId);
      return output;
    } catch (error) {
      if (isGoneBrowserError(error)) currentTab.failed(browser);
      throw error;
    }
  };
  const add = <TInput extends z.ZodType, TOutput extends z.ZodType>(options: {
    name: InteractionAttemptToolName;
    codemodePath: readonly string[];
    title: string;
    description: string;
    input: TInput;
    /** Adjusts the model's view of the input schema; validation is unchanged. */
    modelInputSchema?: (schema: AttemptToolJsonSchema) => AttemptToolJsonSchema;
    output: TOutput;
    readOnly: boolean;
    idempotent: boolean;
    approval?: "none" | "human" | "policy";
    /** The model's text view of a successful result. The complete typed value
     * stays in structuredContent; without this the text is that value as JSON. */
    modelText?: (output: z.output<TOutput>) => string;
    execute: (
      value: z.output<TInput>,
      context: AttemptToolExecutionContext,
    ) => Promise<z.input<TOutput> | InteractionExecutionResult<z.input<TOutput>>>;
  }) => {
    if (
      !selected.has(options.name) ||
      !hasToolPermission(permissions, TOOL_PERMISSION[options.name])
    ) {
      return;
    }
    definitions.push({
      identity: { serverId: "interaction", toolName: options.name },
      modelName: `interaction__${options.name}`,
      codemodePath: options.codemodePath,
      title: options.title,
      description: options.description,
      inputSchema: (options.modelInputSchema ?? ((schema) => schema))(
        interactionToolInputJsonSchema(options.input),
      ),
      outputSchema: jsonSchema(options.output),
      annotations: {
        title: options.title,
        readOnlyHint: options.readOnly,
        destructiveHint: !options.readOnly && options.name.endsWith("lifecycle"),
        idempotentHint: options.idempotent,
        openWorldHint: true,
      },
      source: "interaction",
      approval: options.approval ?? "none",
      execute: async (raw, context) =>
        await safeInteractionExecution(
          options.input,
          options.output,
          raw,
          context,
          options.execute,
          options.readOnly,
          options.modelText,
        ),
    });
  };

  add({
    name: "interaction_discover",
    codemodePath: ["interaction", "discover"],
    title: "Discover browsers and computers",
    description: `Discover browsers and computers. To use the user's existing/current/personal Chrome, call browser_open with placement={kind:'attached_device'} directly; use scope=attached_browsers only to pick a specific Chrome profile or to see why none is connected. That scope reads only Chrome profiles and extension bridges, avoiding unrelated sessions and saved identities. The default current_session scope lists this agent session's BrowserSessions and ComputerSessions. Use scope=workspace only for reusable identities or peer/child resources; that inventory can be large. An attachedBrowserBridge only means the machine is ready for the extension; only attachedBrowsers are real user Chrome profiles/tabs. If none exist, the person needs a Connected Machine first (post the Connected Machine card with capability_authorization_request api:connected-machine) and then the Opengeni Browser Chrome extension: ${OPENGENI_BROWSER_EXTENSION_URL}. Leave includeTerminal=false unless ended history is specifically required.`,
    input: DiscoveryInput,
    output: DiscoveryOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      const scope = value.scope ?? "current_session";
      if (scope === "attached_browsers") {
        const attached = await input.transport.listAttachedBrowsers(input.workspaceId, {
          includeDisconnected: value.includeDisconnectedDevices ?? false,
        });
        // Each inventory uses the same workspace interaction revision. Empty arrays
        // here are outside this scope, not evidence that the workspace has no sessions.
        return {
          browserRevision: attached.revision,
          computerRevision: attached.revision,
          identityRevision: attached.revision,
          attachedBrowserRevision: attached.revision,
          browsers: [],
          computers: [],
          identities: [],
          ...agentAttachedInventory(attached),
        };
      }
      // Narrow in SQL: a workspace can retain thousands of ended sessions, and
      // current_session discovery only ever returns this session's own.
      const listFilter = {
        ...(scope === "current_session" ? { associatedSessionId: input.sessionId } : {}),
        ...((value.includeTerminal ?? false) ? {} : { includeTerminal: false }),
      };
      const [browsers, computers, identities, attached] = await Promise.all([
        input.transport.listBrowserSessions(input.workspaceId, listFilter),
        input.transport.listComputerSessions(input.workspaceId, listFilter),
        input.transport.listBrowserIdentities(input.workspaceId, {
          includeArchived: value.includeArchivedIdentities ?? false,
        }),
        input.transport.listAttachedBrowsers(input.workspaceId, {
          includeDisconnected: value.includeDisconnectedDevices ?? false,
        }),
      ]);
      return {
        browserRevision: browsers.revision,
        computerRevision: computers.revision,
        identityRevision: identities.revision,
        attachedBrowserRevision: attached.revision,
        browsers: filterDiscoveredSessions(
          browsers.sessions,
          input.sessionId,
          scope,
          value.includeTerminal ?? false,
        ),
        computers: filterDiscoveredSessions(
          computers.sessions,
          input.sessionId,
          scope,
          value.includeTerminal ?? false,
        ),
        identities: scope === "workspace" ? identities.identities : [],
        ...(scope === "workspace"
          ? agentAttachedInventory(attached)
          : { attachedBrowserBridges: [], attachedBrowsers: [] }),
      };
    },
  });

  add({
    name: "browser_open",
    codemodePath: ["interaction", "browser", "open"],
    title: "Open or reuse browser",
    description: `Open a managed BrowserSession on the current agent placement, reuse a relevant compatible live session by default, attach to an explicit workspace BrowserSession, or open the user's own Chrome with placement={kind:'attached_device'}. Use that directly for requests about 'my browser', 'my tabs', or current Chrome: it opens the only Chrome profile connected through the Opengeni Browser extension, or else the most recently active one (reported as attachedProfile, the rest as otherAttachedProfiles). Add deviceId (from interaction_discover scope=attached_browsers or otherAttachedProfiles) only when the user wants a different profile. Omitting placement never uses the user's Chrome. If no profile is connected, explain that the Chrome extension must be connected instead of silently creating a blank managed browser (it needs a Connected Machine, then the Opengeni Browser extension: ${OPENGENI_BROWSER_EXTENSION_URL}). BrowserSessions persist across tool calls; shell-launched browser daemons do not survive remote-command cleanup. Never switch to the user's attached Chrome as a fallback for a failed managed browser unless the user requested that profile. A new attached session opens a dedicated tab. Managed Chromium defaults to headed so OAuth and later human interaction use a supported browser; request headless=true only for agent-only work that will not require sign-in or human control. Operator-enabled disposable sandbox verification may explicitly request storageMode=ephemeral_context with headless=true: no saved identity, route, Computer, checkpoint or resume; process loss ends the session. Default private_profile storage is unchanged. Returns the session, its tabs and an outline of the opened (or selected) tab when one is available, in the browser_observe format. With initialUrl, only the opened tab is listed and the others are counted (browser_tabs list shows them). Act on the outline's elements directly instead of observing again. Call it first for any browser task; browser_observe, browser_act, browser_screenshot and browser_tabs then work on the session it returns.`,
    input: BrowserOpenInput,
    output: BrowserOpenOutput,
    readOnly: false,
    idempotent: true,
    modelText: browserOpenText,
    execute: async (value, context) => {
      const opened = await openBrowser(
        input.transport,
        input.workspaceId,
        input.sessionId,
        value,
        context,
      );
      currentTab.use(
        opened.session.id,
        opened.observation?.target.id ??
          opened.targets.find((target) => target.selected)?.id ??
          null,
      );
      return opened;
    },
  });

  add({
    name: "browser_tabs",
    codemodePath: ["interaction", "browser", "tabs"],
    title: "Manage browser tabs",
    description:
      "List, open, logically select, or close tabs in one exact BrowserSession. Selection changes the BrowserSession's default target, not the visible desktop tab. New attached-Chrome tabs open in the background. Use browser_act activate only when foregrounding the owned tab is explicitly intended. Closing a tab does not release the browser process; use browser_lifecycle for session cleanup. Returns the authoritative complete tab list after the operation. Open/select also return the page outline. Act on its elements directly; observe again after later page changes.",
    input: BrowserTabsInput,
    output: BrowserTabsOutput,
    readOnly: false,
    idempotent: false,
    modelText: browserTabsText,
    execute: async (value) =>
      await onBrowser(value.browserSessionId, async ({ browserSessionId }) => {
        let mutationObservation: z.infer<typeof BrowserObservation> | undefined;
        if (value.operation === "open") {
          mutationObservation = await input.transport.openBrowserTarget(
            input.workspaceId,
            browserSessionId,
            { ...(value.url ? { url: value.url } : {}) },
          );
        } else if (value.operation === "select") {
          mutationObservation = await input.transport.selectBrowserTarget(
            input.workspaceId,
            browserSessionId,
            value.targetId,
          );
        } else if (value.operation === "close") {
          const closed = await input.transport.closeBrowserTarget(
            input.workspaceId,
            browserSessionId,
            value.targetId,
          );
          currentTab.forgetTarget(browserSessionId, value.targetId);
          return agentTargetList(closed);
        }
        const tabs = await input.transport.listBrowserTargets(input.workspaceId, browserSessionId);
        if (mutationObservation) {
          currentTab.use(browserSessionId, mutationObservation.target.id);
          return {
            ...agentTargetList(tabs),
            mutationObservation: projectBrowserObservation(mutationObservation, "compact"),
          };
        }
        return agentTargetList(tabs);
      }),
  });

  add({
    name: "browser_observe",
    codemodePath: ["interaction", "browser", "observe"],
    title: "Observe browser tab",
    description:
      "Read one tab's URL, title, viewport and accessibility outline: one line per element, role \"name\" [ref] value and states, indented by nesting. Locate an element by role and name, or by ref ({kind:'ref',ref}); refs are listed on controls and other actionable elements, not on text and layout lines. The default view is selective and says how many elements it left out; it is not a complete page tree. Set view=full for every element with its ref. Set includeScreenshot=true to add a current still image as tool image content; browser_screenshot is faster when only pixels are needed.",
    input: BrowserObserveInput,
    output: BrowserAgentObservation,
    readOnly: true,
    idempotent: true,
    modelText: agentObservationText,
    execute: async (value) =>
      await onTab(value, async ({ browserSessionId, targetId }) => {
        const observationRequest = input.transport.observeBrowserTarget(
          input.workspaceId,
          browserSessionId,
          targetId,
        );
        if (!value.includeScreenshot)
          return projectBrowserObservation(await observationRequest, value.view ?? "compact");
        // These are independent reads. Settle both before returning an error so
        // the tool never leaves an outstanding capture behind after a failed read.
        const [observed, captured] = await Promise.allSettled([
          observationRequest,
          Promise.resolve().then(() =>
            input.transport.captureBrowserTarget(input.workspaceId, browserSessionId, targetId),
          ),
        ]);
        if (observed.status === "rejected") throw observed.reason;
        if (captured.status === "rejected") throw captured.reason;
        let observation = observed.value;
        const frame = captured.value;
        if (
          observation.target.targetGeneration !== frame.targetGeneration ||
          observation.target.documentGeneration !== frame.documentGeneration
        ) {
          observation = await input.transport.observeBrowserTarget(
            input.workspaceId,
            browserSessionId,
            targetId,
          );
        }
        if (
          observation.target.targetGeneration !== frame.targetGeneration ||
          observation.target.documentGeneration !== frame.documentGeneration
        ) {
          throw new Error("browser target changed while its visual observation was captured");
        }
        return new InteractionExecutionResult(
          projectBrowserObservation(observation, value.view ?? "compact"),
          [browserToolImageContent(frame.data, frame.mediaType)],
        );
      }),
  });

  add({
    name: "browser_read",
    codemodePath: ["interaction", "browser", "read"],
    title: "Read focused browser content",
    description:
      "Search, count, or read a subtree from one tab's accessibility snapshot; filter by ref, role, name, accessibility text, state, or action, and scopeRef. AX mode refreshes the full tree internally and cannot return DOM attributes or editable input values. Use mode=dom with a ref, CSS, test-id, or placeholder locator for bounded element text, editable value, or allowlisted attributes, or a CSS selector for count. Content-matching role/label/text locators and CSS attribute/pseudo selectors are rejected for DOM reads to prevent secret-value probing. DOM reads use exact causal fences and only fixed, read-only browser-side projection; callers cannot supply JavaScript. Ref DOM locators refresh accessibility; CSS/test-id/placeholder locators avoid that scan.",
    input: BrowserReadInput,
    output: BrowserReadToolOutput,
    readOnly: true,
    idempotent: true,
    modelText: (output) =>
      output.source === "accessibility" ? browserReadText(output) : JSON.stringify(output),
    execute: async (value) =>
      await onTab(value, async ({ browserSessionId, targetId }) => {
        if (value.mode === "dom") {
          const state =
            value.expectedTargetGeneration !== undefined &&
            value.expectedDocumentGeneration !== undefined &&
            value.expectedFrameId !== undefined
              ? null
              : await input.transport.getBrowserTargetState(
                  input.workspaceId,
                  browserSessionId,
                  targetId,
                );
          const fences = {
            expectedTargetGeneration: value.expectedTargetGeneration ?? state!.targetGeneration,
            expectedDocumentGeneration:
              value.expectedDocumentGeneration === undefined
                ? state!.documentGeneration
                : value.expectedDocumentGeneration,
            expectedFrameId:
              value.expectedFrameId === undefined ? state!.frameId : value.expectedFrameId,
          };
          const documentGeneration = fences.expectedDocumentGeneration;
          const frameId = fences.expectedFrameId;
          if (documentGeneration === null || frameId === null) {
            throw new OpenGeniApiError(409, "browser target has no inspectable document", {
              code: "document_unavailable",
              retryable: true,
            });
          }
          const inspectedFences = {
            expectedTargetGeneration: fences.expectedTargetGeneration,
            expectedDocumentGeneration: documentGeneration,
            expectedFrameId: frameId,
          };
          const dom = value.dom!;
          const request =
            dom.kind === "element"
              ? {
                  ...inspectedFences,
                  kind: "element" as const,
                  locator: dom.locator,
                  ...(dom.attributes ? { attributes: dom.attributes } : {}),
                  maxChars: dom.maxChars ?? 4_096,
                }
              : { ...inspectedFences, kind: "count" as const, selector: dom.selector };
          return {
            ...(await input.transport.readBrowserDom(
              input.workspaceId,
              browserSessionId,
              targetId,
              request,
            )),
            source: "dom" as const,
          };
        }
        return readBrowserObservation(
          await input.transport.observeBrowserTarget(input.workspaceId, browserSessionId, targetId),
          value,
        );
      }),
  });

  add({
    name: "browser_screenshot",
    codemodePath: ["interaction", "browser", "screenshot"],
    title: "Capture browser screenshot",
    description:
      "Capture a current browser tab screenshot without reading its accessibility tree. The image is returned as tool image content, with small structured frame metadata. Set fullPage=true to capture the whole scrollable page when supported; large pages may take longer or exceed capture bounds. Set quality lower to reduce JPEG bytes if a large capture exceeds the Code Mode image limit.",
    input: BrowserScreenshotInput,
    output: BrowserScreenshotOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await onTab(value, async ({ browserSessionId, targetId }) => {
        const frame = await input.transport.captureBrowserTarget(
          input.workspaceId,
          browserSessionId,
          targetId,
          {},
          {
            fullPage: value.fullPage ?? false,
            ...(value.quality ? { quality: value.quality } : {}),
          },
        );
        return new InteractionExecutionResult(
          {
            kind: "browser_screenshot" as const,
            browserSessionId: frame.browserSessionId,
            targetId: frame.targetId,
            frameId: frame.frameId,
            targetGeneration: frame.targetGeneration,
            documentGeneration: frame.documentGeneration,
            mediaType: frame.mediaType,
            width: frame.width,
            height: frame.height,
            deviceScaleFactor: frame.deviceScaleFactor,
            scrollX: frame.scrollX,
            scrollY: frame.scrollY,
            capturedAt: frame.capturedAt,
            fullPage: value.fullPage ?? false,
          },
          [browserToolImageContent(frame.data, frame.mediaType)],
        );
      }),
  });

  add({
    name: "browser_act",
    codemodePath: ["interaction", "browser", "act"],
    title: "Act in browser tab",
    description:
      "Perform one semantic-first browser action or bounded batch. Prefer action={type:'batch',actions:[...],fenceEachAction:true} for predictable edits in the same observed document, such as filling known form fields before one authorized submit. Pause for new page state, a dialog, or a decision instead of batching steps that depend on an unseen result. Reuse a page observation, when present, from browser_open, tab open/select or a prior action; observe only when none is present or it lacks needed content. Observe again after page changes or when needed content was omitted. If an action reports outcome_unknown, inspect the outcome and do not replay the batch. Use viewport to set page width, height, desktop/mobile layout and touch emulation, then check the measured viewport in the returned observation; emulation does not prove physical mobile-browser behavior. Use history back/forward for tab navigation; keypress shortcuts are page input and may not navigate browser history. A press key is one character or a key name (Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, F1-F24), optionally prefixed by Ctrl+, Alt+, Shift+, Meta+ or Mod+. The explicit activate action foregrounds the target in the user's desktop browser; use only when that is intended. Permission actions set a managed browser's web permission for this tab's exact current top-level origin. The default receipt includes the page outline after the action, in the browser_observe format; set view=full for every element, or view=none when no post-action outline is needed. An upload action takes workspace File IDs; the artifact.artifactId returned by sandbox_file_publish is one. Text in fill, type and clipboard write may contain {{secret:…}} references; the value (or the current TOTP code for /otp) is typed at dispatch and never shown to you. Use type with mode:'keys' for split one-time-code boxes or inputs that ignore pasted text.",
    input: BrowserActInput,
    modelInputSchema: withRefShorthandLocators,
    output: BrowserAgentActionReceipt,
    readOnly: false,
    idempotent: true,
    modelText: agentActionText,
    execute: async (value, context) =>
      await onTab(value, async ({ browserSessionId, targetId }) => {
        // Omitted fences are resolved by the API from the live target in the same
        // request, so acting on the current document costs one round trip.
        const receipt = await input.transport.actInBrowser(input.workspaceId, browserSessionId, {
          operationId: context.operationId,
          targetId,
          ...(value.expectedTargetGeneration === undefined
            ? {}
            : { expectedTargetGeneration: value.expectedTargetGeneration }),
          ...(value.expectedDocumentGeneration === undefined
            ? {}
            : { expectedDocumentGeneration: value.expectedDocumentGeneration }),
          ...(value.expectedFrameId === undefined
            ? {}
            : { expectedFrameId: value.expectedFrameId }),
          ...(value.view === "none" ? { observationMode: "none" as const } : {}),
          action: value.action,
        });
        return value.view === "full" ? receipt : compactActionReceipt(receipt);
      }),
  });

  add({
    name: "browser_clipboard",
    codemodePath: ["interaction", "browser", "clipboard"],
    title: "Read browser clipboard",
    description:
      "Read the bounded private clipboard of one exact BrowserSession. This never reads the connected machine or host OS clipboard. Use browser_act with a clipboard action to write, clear, copy, or paste.",
    input: BrowserClipboardInput,
    output: BrowserClipboard,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await input.transport.readBrowserClipboard(input.workspaceId, value.browserSessionId),
  });

  add({
    name: "browser_debug",
    codemodePath: ["interaction", "browser", "debug"],
    title: "Inspect browser diagnostics",
    description:
      "Read bounded console errors, page errors, failed requests, and downloads for one exact browser tab.",
    input: BrowserDebugInput,
    output: BrowserDiagnosticBatch,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await onTab(
        value,
        async ({ browserSessionId, targetId }) =>
          await input.transport.listBrowserDiagnostics(
            input.workspaceId,
            browserSessionId,
            targetId,
            {
              ...(value.kinds ? { kinds: value.kinds } : {}),
              ...(value.after !== undefined ? { after: value.after } : {}),
              ...(value.limit !== undefined ? { limit: value.limit } : {}),
            },
          ),
      ),
  });

  add({
    name: "browser_downloads",
    codemodePath: ["interaction", "browser", "downloads"],
    title: "Inspect browser downloads",
    description:
      "List browser-produced files or get one exact download by id. Metadata identifies completed bytes and their SHA-256; diagnostics alone do not expose a download id or file bytes. Use browser_download_save to materialize a completed download in its source session's workspace. Attached browsers and Lightpanda do not expose managed downloads.",
    input: BrowserDownloadsInput,
    output: z.union([BrowserDownloadListResponse, BrowserDownload]),
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      if (value.operation === "get") {
        const download = await input.transport.getBrowserDownload(
          input.workspaceId,
          value.browserSessionId,
          value.downloadId!,
        );
        if (
          download.browserSessionId !== value.browserSessionId ||
          download.id !== value.downloadId
        ) {
          throw new Error("Browser download belongs to another resource");
        }
        return download;
      }
      const response = await input.transport.listBrowserDownloads(
        input.workspaceId,
        value.browserSessionId,
      );
      if (
        response.browserSessionId !== value.browserSessionId ||
        response.downloads.some(
          (download) =>
            download.browserSessionId !== value.browserSessionId ||
            download.controllerGeneration !== response.controllerGeneration,
        )
      ) {
        throw new Error("Browser downloads belong to another session binding");
      }
      return response;
    },
  });

  add({
    name: "browser_download_save",
    codemodePath: ["interaction", "browser", "downloadSave"],
    title: "Save browser download to workspace",
    description:
      "Save one exact completed managed browser download to a portable relative path in the browser's source session workspace. Missing folders on that path are created. Requires sessions:control and files:upload. Returns the materialized destinationPath, fileId and integrity metadata; read the saved bytes with ordinary workspace file tools. Existing files are protected unless overwrite=true. The attempt operation id fences retries; uncertain outcomes must reconcile that same operation. Attached browsers and Lightpanda cannot publish managed downloads.",
    input: BrowserDownloadSaveInput,
    output: BrowserDownloadSaveResponse,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      const response = await input.transport.saveBrowserDownload(
        input.workspaceId,
        value.browserSessionId,
        value.downloadId,
        {
          operationId: context.operationId,
          destinationPath: value.destinationPath,
          overwrite: value.overwrite,
        },
      );
      if (
        response.download.browserSessionId !== value.browserSessionId ||
        response.download.id !== value.downloadId ||
        response.operationId !== context.operationId ||
        response.destinationPath !== value.destinationPath
      ) {
        throw new Error("Browser download save returned another operation binding");
      }
      return response;
    },
  });

  add({
    name: "browser_auth",
    codemodePath: ["interaction", "browser", "auth"],
    title: "Authenticate browser session",
    description:
      "Reuse a saved sign-in, the first rung of the login ladder: list provider-managed (external_provider) site-auth connections and durable auth runs, or start, report, provider-advance with advance_external, and verify one exact BrowserSession authentication run. Provider credentials and hosted-login URLs stay with the provider. When no saved sign-in applies or a run returns needs_human, sign in yourself with browser_act fill or type: type saved credentials as secret references (such as {{secret:Item/password}} and {{secret:Item/otp}}), read email or SMS codes through connected tools, and solve CAPTCHAs yourself. Pass the returned intervention id to interaction_request_human only when a person must physically act, such as a push approval or a hardware key.",
    input: BrowserAuthInput,
    output: BrowserAuthOutput,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      if (value.operation === "list_connections") {
        return {
          operation: value.operation,
          result: await input.transport.listSiteAuthConnections(input.workspaceId, {
            includeArchived: value.includeArchived ?? false,
          }),
        };
      }
      if (value.operation === "get_connection") {
        return {
          operation: value.operation,
          result: await input.transport.getSiteAuthConnection(
            input.workspaceId,
            value.siteAuthConnectionId,
          ),
        };
      }
      if (value.operation === "list_runs") {
        return {
          operation: value.operation,
          result: await input.transport.listAuthRuns(input.workspaceId, {
            ...(value.browserSessionId ? { browserSessionId: value.browserSessionId } : {}),
            ...(value.siteAuthConnectionId
              ? { siteAuthConnectionId: value.siteAuthConnectionId }
              : {}),
            includeSettled: value.includeSettled ?? false,
          }),
        };
      }
      if (value.operation === "get_run") {
        return {
          operation: value.operation,
          result: await input.transport.getAuthRun(input.workspaceId, value.authRunId),
        };
      }
      if (value.operation === "start") {
        const { operation: _operation, browserSessionId, ...request } = value;
        return {
          operation: value.operation,
          result: await input.transport.startBrowserAuthRun(input.workspaceId, browserSessionId, {
            operationId: context.operationId,
            ...request,
          }),
        };
      }
      if (value.operation === "report") {
        const { operation: _operation, browserSessionId, authRunId, ...request } = value;
        return {
          operation: value.operation,
          result: await input.transport.reportBrowserAuthRun(
            input.workspaceId,
            browserSessionId,
            authRunId,
            { operationId: context.operationId, ...request },
          ),
        };
      }
      if (value.operation === "advance_external") {
        const { operation: _operation, browserSessionId, authRunId, ...request } = value;
        return {
          operation: value.operation,
          result: await input.transport.advanceExternalBrowserAuthRun(
            input.workspaceId,
            browserSessionId,
            authRunId,
            { operationId: context.operationId, ...request },
          ),
        };
      }
      const { operation: _operation, browserSessionId, authRunId, ...request } = value;
      return {
        operation: value.operation,
        result: await input.transport.verifyBrowserAuthRun(
          input.workspaceId,
          browserSessionId,
          authRunId,
          { operationId: context.operationId, ...request },
        ),
      };
    },
  });

  add({
    name: "interaction_request_human",
    codemodePath: ["interaction", "requestHuman"],
    title: "Request human interaction",
    description:
      "Pause the current agent turn for a person to physically act in one exact browser tab or computer target: a push approval on their phone, a hardware security key, or another step only a person present can do. Log in yourself first (secret references and TOTP codes such as {{secret:Item/otp}} when secrets are available, email or SMS codes from connected tools) and solve CAPTCHAs yourself; never hand over a CAPTCHA or a step you can do. Handoffs must target a headed BrowserSession (headless=false); never hand a headless automation browser to a person because identity providers may reject it. Use operation=wait for an intervention already returned by browser_auth; otherwise provide the exact observed resource generations and a concise reason. The same tool call resumes with the settled intervention and a fresh observation.",
    input: RequestHumanInteractionToolInput,
    output: RequestHumanInteractionToolOutput,
    readOnly: false,
    idempotent: true,
    approval: "human",
    execute: async (value) => {
      const resumed = input.interventionResume;
      if (!resumed) {
        throw new Error("Interaction intervention resumed without a durable response");
      }
      assertInterventionResumeMatches(value, resumed.intervention);
      try {
        const observation =
          resumed.intervention.resourceKind === "browser_session"
            ? await input.transport.observeBrowserTarget(
                input.workspaceId,
                resumed.intervention.resourceId,
                resumed.intervention.targetId,
              )
            : await input.transport.observeComputerTarget(
                input.workspaceId,
                resumed.intervention.resourceId,
                resumed.intervention.targetId,
              );
        return {
          intervention: resumed.intervention,
          observation,
          observationErrorCode: null,
        };
      } catch (error) {
        return {
          intervention: resumed.intervention,
          observation: null,
          observationErrorCode:
            error instanceof OpenGeniApiError
              ? (error.code ?? `http_${error.status}`)
              : "observation_unavailable",
        };
      }
    },
  });

  add({
    name: "browser_identity",
    codemodePath: ["interaction", "browser", "identity"],
    title: "Manage reusable browser identities",
    description:
      "List, inspect, create, update, or list immutable revisions of reusable BrowserIdentities. Update can rename, archive/restore, or select the default revision for browsers opened later; it never changes a live browser. Live browser state changes only through explicit browser_publish.",
    input: BrowserIdentityInput,
    output: BrowserIdentityOutput,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      if (value.operation === "list") {
        return {
          operation: value.operation,
          result: await input.transport.listBrowserIdentities(input.workspaceId, {
            includeArchived: value.includeArchived ?? false,
          }),
        };
      }
      if (value.operation === "get") {
        return {
          operation: value.operation,
          result: await input.transport.getBrowserIdentity(input.workspaceId, value.identityId),
        };
      }
      if (value.operation === "revisions") {
        return {
          operation: value.operation,
          result: await input.transport.listBrowserRevisions(input.workspaceId, value.identityId),
        };
      }
      if (value.operation === "update") {
        return {
          operation: value.operation,
          result: await input.transport.updateBrowserIdentity(input.workspaceId, value.identityId, {
            operationId: context.operationId,
            expectedVersion: value.expectedVersion,
            ...(value.name !== undefined ? { name: value.name } : {}),
            ...(value.status !== undefined ? { status: value.status } : {}),
            ...(value.defaultRevisionId !== undefined
              ? { defaultRevisionId: value.defaultRevisionId }
              : {}),
          }),
        };
      }
      return {
        operation: value.operation,
        result: await input.transport.createBrowserIdentity(input.workspaceId, {
          operationId: context.operationId,
          name: value.name,
        }),
      };
    },
  });

  add({
    name: "browser_publish",
    codemodePath: ["interaction", "browser", "publish"],
    title: "Save browser identity version",
    description:
      "Explicitly quiesce and save the live BrowserSession as an immutable child revision of a reusable BrowserIdentity. Nothing is written back automatically. After you log in with workspace or task credentials, publish so later browsers reuse the signed-in session instead of logging in again; do not publish after logging in with an Only me secret, because browser identities are shared with the whole workspace.",
    input: BrowserPublishInput,
    output: PublishBrowserRevisionResponse,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) =>
      await input.transport.publishBrowserRevision(input.workspaceId, value.browserSessionId, {
        operationId: context.operationId,
        identityId: value.identityId,
        expectedHeadGeneration: value.expectedHeadGeneration,
        ...(value.advanceDefault !== undefined ? { advanceDefault: value.advanceDefault } : {}),
      }),
  });

  add({
    name: "browser_lifecycle",
    codemodePath: ["interaction", "browser", "lifecycle"],
    title: "Change browser lifecycle",
    description:
      "Suspend, resume, or end one BrowserSession through its durable exactly-once lifecycle journal. End a disposable managed session you created when its task is finished and no continuation or human handoff needs it; this releases the browser process and removes its private profile. Suspend instead when supported if later work needs the private working checkpoint; suspension does not publish a reusable identity version. Do not end another actor's, shared, or attached user browser merely because your turn is finished or it appears idle.",
    input: BrowserLifecycleInput,
    output: BrowserSessionMutationResponse,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      const request = { operationId: context.operationId };
      if (value.action === "suspend") {
        return await input.transport.suspendBrowserSession(
          input.workspaceId,
          value.browserSessionId,
          request,
        );
      }
      if (value.action === "resume") {
        return await input.transport.resumeBrowserSession(
          input.workspaceId,
          value.browserSessionId,
          request,
        );
      }
      currentTab.forgetSession(value.browserSessionId);
      return await input.transport.endBrowserSession(
        input.workspaceId,
        value.browserSessionId,
        request,
      );
    },
  });

  add({
    name: "computer_open",
    codemodePath: ["interaction", "computer", "open"],
    title: "Open or reuse computer",
    description:
      "Open a ComputerSession on the current agent placement, reuse a relevant live session by default, or attach to an explicit workspace ComputerSession. Returns exact apps/windows/screens. Call it first for any computer task; computer_observe and computer_act then work on the session it returns.",
    input: ComputerOpenInput,
    output: ComputerOpenOutput,
    readOnly: false,
    idempotent: true,
    modelText: computerOpenText,
    execute: async (value, context) =>
      await openComputer(input.transport, input.workspaceId, input.sessionId, value, context),
  });

  add({
    name: "computer_targets",
    codemodePath: ["interaction", "computer", "targets"],
    title: "List computer apps and windows",
    description:
      "List the current app, window, and screen targets for one exact ComputerSession without changing focus.",
    input: ComputerTargetsInput,
    output: ComputerTargetListResponse,
    readOnly: true,
    idempotent: true,
    modelText: (output) => computerTargetsText(output.targets),
    execute: async (value) =>
      await input.transport.listComputerTargets(input.workspaceId, value.computerSessionId),
  });

  add({
    name: "computer_observe",
    codemodePath: ["interaction", "computer", "observe"],
    title: "Observe app or window",
    description:
      "Read one ComputerSession app/window/screen target, causal generation, semantic accessibility tree, focus, frame identity, and a bounded current screenshot without taking control. capturedFrame gives the screenshot's exact pixel dimensions; use those pixels for pointer coordinates, not the target's native bounds or an image-preview size.",
    input: ComputerObserveInput,
    output: ComputerObserveOutput,
    readOnly: true,
    idempotent: true,
    modelText: computerObservationText,
    execute: async (value) => {
      // The tree and the pixels are independent reads of the same target;
      // a generation mismatch below re-reads the tree once.
      let [observation, frame] = await Promise.all([
        input.transport.observeComputerTarget(
          input.workspaceId,
          value.computerSessionId,
          value.targetId,
        ),
        input.transport.captureComputerTarget(
          input.workspaceId,
          value.computerSessionId,
          value.targetId,
        ),
      ]);
      if (observation.target.targetGeneration !== frame.targetGeneration) {
        observation = await input.transport.observeComputerTarget(
          input.workspaceId,
          value.computerSessionId,
          value.targetId,
        );
      }
      if (observation.target.targetGeneration !== frame.targetGeneration) {
        throw new Error("computer target changed while its visual observation was captured");
      }
      return new InteractionExecutionResult(
        {
          ...observation,
          frameId: frame.frameId,
          capturedFrame: { width: frame.width, height: frame.height },
        },
        [
          {
            type: "image",
            data: Buffer.from(frame.data).toString("base64"),
            mimeType: frame.mediaType,
          },
        ],
      );
    },
  });

  add({
    name: "computer_clipboard",
    codemodePath: ["interaction", "computer", "clipboard"],
    title: "Read computer clipboard",
    description:
      "Read the bounded native OS clipboard for one exact ComputerSession graphical seat. This may be shared by ComputerSessions on the same physical login seat and is never the BrowserSession private clipboard. Use computer_act clipboard actions to write, clear, copy, or paste.",
    input: ComputerClipboardInput,
    output: ComputerClipboard,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await input.transport.readComputerClipboard(input.workspaceId, value.computerSessionId),
  });

  add({
    name: "computer_act",
    codemodePath: ["interaction", "computer", "act"],
    title: "Act in app or window",
    description:
      "Perform one action in an exact ComputerSession target. Prefer semantic actions from computer_observe: on macOS they can invoke controls and set values without foregrounding the app. Pointer, keyboard, target focus, screen actions, and clipboard paste use the physical graphical seat and may change the user's foreground app; use them only when foreground control is explicitly intended. For pointer actions, set action.frameId from the observed frame and use coordinates in the returned screenshot's pixels; do not scale them to target.bounds. A pixel frame fence applies only to pointer actions; semantic actions use the observation fence even if a frame ID is supplied. Supplying the target generation and relevant action fence preserves the exact observation without refreshing it. Omit fences to use a fresh observation automatically. Keyboard type, set_value and clipboard write text may contain {{secret:…}} references, typed at dispatch and never shown to you. Returns the durable causal receipt.",
    input: ComputerActInput,
    output: ComputerActionReceipt,
    readOnly: false,
    idempotent: true,
    modelText: computerActionText,
    execute: async (value, context) => {
      const current =
        value.expectedTargetGeneration !== undefined &&
        (value.action.type === "pointer"
          ? (value.expectedFrameId ?? value.action.frameId) != null
          : value.expectedObservationId != null)
          ? null
          : await input.transport.observeComputerTarget(
              input.workspaceId,
              value.computerSessionId,
              value.targetId,
            );
      return await input.transport.actInComputer(input.workspaceId, value.computerSessionId, {
        operationId: context.operationId,
        targetId: value.targetId,
        expectedTargetGeneration:
          value.expectedTargetGeneration ?? current!.target.targetGeneration,
        expectedObservationId:
          value.expectedObservationId === undefined
            ? (current?.observationId ?? null)
            : value.expectedObservationId,
        expectedFrameId:
          value.action.type === "pointer"
            ? value.expectedFrameId === undefined
              ? value.action.frameId
              : value.expectedFrameId
            : null,
        action: value.action,
      });
    },
  });

  add({
    name: "computer_lifecycle",
    codemodePath: ["interaction", "computer", "lifecycle"],
    title: "End computer",
    description:
      "End one ComputerSession through its durable exactly-once lifecycle journal. A ComputerSession hosting a live linked browser cannot be ended first.",
    input: ComputerLifecycleInput,
    output: ComputerSessionMutationResponse,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) =>
      await input.transport.endComputerSession(input.workspaceId, value.computerSessionId, {
        operationId: context.operationId,
      }),
  });

  if (
    selected.has("computer_act") &&
    selected.has("computer_open") &&
    hasToolPermission(permissions, "sessions:control") &&
    input.transport.callNativeComputerTool
  ) {
    for (const tool of CUA_DESKTOP_TOOLS) {
      const variants = cuaDesktopToolVariants(tool.name);
      const inputSchema = nativeCuaSchema(
        variants.map(({ inputSchema: variantInputSchema }) => {
          const properties = { ...(variantInputSchema.properties as Record<string, unknown>) };
          delete properties.session;
          properties.computerSessionId = {
            type: "string",
            format: "uuid",
            description: "CUA ComputerSession from computer_open",
          };
          return {
            ...variantInputSchema,
            properties,
            required: [
              ...((variantInputSchema.required as string[] | undefined) ?? []).filter(
                (name) => name !== "session",
              ),
              "computerSessionId",
            ],
          };
        }),
      );
      const outputSchema = variants.every((variant) => variant.outputSchema)
        ? nativeCuaSchema(variants.map((variant) => variant.outputSchema!))
        : undefined;
      definitions.push({
        identity: { serverId: "interaction", toolName: "cua_" + tool.name },
        modelName: "interaction__cua_" + tool.name,
        codemodePath: ["computer", tool.name],
        title: tool.name,
        description:
          "Native CUA computer tool; requires a CUA-backed computer_open session. " +
          tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        // Read-like tools can write screenshots to files; all native calls use
        // the existing computer control authority, including ordered batches.
        annotations: { ...tool.annotations, readOnlyHint: false, idempotentHint: false },
        source: "interaction",
        approval: "none",
        execute: async (raw, context) => {
          const { computerSessionId, ...args } = raw;
          const id = z.string().uuid().parse(computerSessionId);
          const receipt = boundComputerNativeReceipt(
            ComputerNativeReceipt.parse(
              await input.transport.callNativeComputerTool!(input.workspaceId, id, {
                operationId: context.operationId,
                tool: tool.name,
                arguments: args,
              }),
            ),
          );
          const evidence = {
            operationId: receipt.operationId,
            state: receipt.state,
            error: receipt.error,
          };
          const result = receipt.observation
            ? AttemptToolResult.parse(receipt.observation.result)
            : interactionErrorResult(
                receipt.error?.code ?? "driver_failed",
                receipt.error?.message ?? "Native CUA result is unavailable",
              );
          if (receipt.state !== "completed") {
            result.isError = true;
            result.content.push({
              type: "text",
              text: JSON.stringify({
                opengeniOperation: evidence,
                guidance:
                  receipt.state === "outcome_unknown"
                    ? "Do not replay this operation. Observe current state before deciding the next action."
                    : "Operation failed. Inspect the retained CUA result before deciding the next action.",
              }),
            });
          }
          return AttemptToolResult.parse({
            ...result,
            _meta: { ...result._meta, opengeniOperation: evidence },
          });
        },
      });
    }
  }
  return definitions;
}

/**
 * One top-level object schema for every platform variant of a native CUA tool.
 * Model providers require a plain object at the top level of a function schema
 * (a top-level anyOf is rejected or ignored, so the model loses every argument
 * type). Properties are the union across platforms; a property whose platform
 * schemas differ in more than wording keeps those alternatives at property
 * level. Only properties every platform requires stay required. The session's
 * CUA worker still validates arguments against its own exact platform schema.
 */
export function nativeCuaSchema(variants: Record<string, unknown>[]): AttemptToolJsonSchema {
  const unique = [...new Map(variants.map((schema) => [JSON.stringify(schema), schema])).values()];
  if (unique.length === 1) return unique[0] as AttemptToolJsonSchema;
  const properties: Record<string, unknown> = {};
  const names = [...new Set(unique.flatMap((schema) => Object.keys(objectProperties(schema))))];
  for (const name of names) {
    const alternatives = unique
      .map((schema) => objectProperties(schema)[name])
      .filter((value): value is Record<string, unknown> => isJsonObject(value));
    // The first platform's wording wins for constraint-identical schemas.
    const distinct = new Map<string, Record<string, unknown>>();
    for (const schema of alternatives) {
      const key = JSON.stringify(withoutWording(schema));
      if (!distinct.has(key)) distinct.set(key, schema);
    }
    const options = [...distinct.values()];
    properties[name] = options.length === 1 ? options[0] : { anyOf: options };
  }
  const required = names.filter((name) =>
    unique.every((schema) =>
      Array.isArray(schema.required) ? schema.required.includes(name) : false,
    ),
  );
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(unique.every((schema) => schema.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  } as AttemptToolJsonSchema;
}

function objectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isJsonObject(schema.properties) ? schema.properties : {};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare platform property schemas by constraint, not by explanatory text. */
function withoutWording(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWording);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description" && key !== "title" && key !== "default")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, withoutWording(entry)]),
  );
}

function filterDiscoveredSessions<
  T extends {
    lifecycle: string;
    associations: Array<{ sessionId: string }>;
  },
>(
  sessions: T[],
  sessionId: string,
  scope: "current_session" | "workspace",
  includeTerminal: boolean,
) {
  return sessions.filter(
    (session) =>
      (includeTerminal || !TERMINAL_LIFECYCLES.has(session.lifecycle)) &&
      (scope === "workspace" ||
        session.associations.some((association) => association.sessionId === sessionId)),
  );
}

export type CreateFirstPartyInteractionAttemptToolsInput = Omit<
  CreateInteractionAttemptToolsInput,
  "transport" | "workspaceId" | "sessionId"
> & {
  settings: Settings;
  scope: AttemptToolScope;
  subjectId?: string;
  subjectLabel?: string;
  credentialRestriction?: "developer_setup";
  fetch?: typeof globalThis.fetch;
};

/**
 * Construct the canonical Browser/Computer attempt definitions against the
 * ordinary Opengeni control plane. MCP/Codemode never receive controller keys,
 * raw CDP, or provider credentials; every call re-signs exact attempt authority.
 */
export function createFirstPartyInteractionAttemptToolDefinitions(
  input: CreateFirstPartyInteractionAttemptToolsInput,
): AttemptToolDefinition[] {
  const secret = resolveFirstPartyDelegationSecret(input.settings);
  if (!secret) return [];
  const selectedTools = input.selectedTools ?? DEFAULT_FIRST_PARTY_MCP_TOOLS;
  const permissions = input.permissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const baseUrl = firstPartyApiBaseUrl(input.settings, input.scope.workspaceId);
  const rawFetch = input.fetch ?? globalThis.fetch.bind(globalThis);
  const guarded = guardedMcpFetch(
    { ...input.settings, integrationsAllowPrivateNetworkTargets: true },
    rawFetch,
    {
      requireHttpsOutsideLocalTest: false,
      ...(process.versions.bun ? { pinResolvedDestination: false } : {}),
    },
  );
  const client = new OpenGeniClient({
    baseUrl,
    fetch: async (request, init) => {
      const bearer = await signDelegatedAccessToken(secret, {
        accountId: input.scope.accountId,
        workspaceId: input.scope.workspaceId,
        subjectId: input.subjectId ?? "worker:interaction-tools",
        ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        permissions: [...permissions],
        principalKind: "agent_attempt",
        firstPartyMcpTools: [...selectedTools],
        sessionId: input.scope.sessionId,
        turnId: input.scope.turnId,
        attemptId: input.scope.attemptId,
        executionGeneration: input.scope.executionGeneration,
        ...(input.credentialRestriction
          ? { credentialRestriction: input.credentialRestriction }
          : {}),
        exp: Math.floor(Date.now() / 1_000) + 60 * 60,
      });
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return await guarded(request, { ...init, headers });
    },
  });
  return createInteractionAttemptToolDefinitions({
    transport: client,
    workspaceId: input.scope.workspaceId,
    sessionId: input.scope.sessionId,
    selectedTools,
    permissions,
    ...(input.interventionResume ? { interventionResume: input.interventionResume } : {}),
  });
}

async function openBrowser(
  transport: InteractionTransport,
  workspaceId: string,
  sourceSessionId: string,
  value: z.output<typeof BrowserOpenInput>,
  context: AttemptToolExecutionContext,
): Promise<z.input<typeof BrowserOpenOutput>> {
  let session: z.infer<typeof BrowserSession>;
  let created = false;
  // A create that launched the browser in this call returns its tabs and the
  // opened tab's observation, which replaces the two reads below.
  let initialView: Awaited<ReturnType<InteractionTransport["createBrowserSession"]>>["initialView"];
  let profileChoice: AttachedProfileChoice | undefined;
  if (value.browserSessionId) {
    session = await transport.getBrowserSession(workspaceId, value.browserSessionId);
    if (value.storageMode && browserSessionStorageMode(session) !== value.storageMode)
      throw new Error("existing BrowserSession storage mode does not match request");
  } else {
    // placement={kind:'attached_device'} without a deviceId means "the person's
    // own Chrome". Read the profile inventory alongside the reuse lookup so the
    // resolution adds no sequential round trip.
    const resolveProfile =
      value.placement?.kind === "attached_device" && !("deviceId" in value.placement);
    const [listed, attachedInventory] = await Promise.all([
      value.mode === "new"
        ? { sessions: [] }
        : transport.listBrowserSessions(workspaceId, {
            associatedSessionId: sourceSessionId,
            includeTerminal: false,
          }),
      resolveProfile
        ? transport.listAttachedBrowsers(workspaceId, { includeDisconnected: false })
        : null,
    ]);
    // The agent-facing browser is human-capable by default. A headless session
    // is a deliberately narrower execution mode and must never be silently
    // reused for an omitted/default headed request: OAuth providers such as
    // Google reject that automation-shaped login surface.
    const requestedHeadless = value.headless ?? false;
    const reusable =
      value.mode === "new"
        ? null
        : newestRelevant(
            listed.sessions.filter(
              (candidate) =>
                candidate.headless === requestedHeadless &&
                browserSessionStorageMode(candidate) === (value.storageMode ?? "private_profile") &&
                compatibleInteractionPlacement(candidate.placement, value.placement) &&
                (value.identityId === undefined || candidate.identityId === value.identityId) &&
                (value.baseRevisionId === undefined ||
                  candidate.baseRevisionId === value.baseRevisionId) &&
                (value.networkRouteId === undefined ||
                  candidate.networkRouteId === value.networkRouteId) &&
                (value.linkedComputerSessionId === undefined ||
                  candidate.linkedComputerSessionId === value.linkedComputerSessionId),
            ),
            sourceSessionId,
          );
    if (reusable) {
      session = reusable;
    } else {
      created = true;
      if (attachedInventory) profileChoice = chooseAttachedProfile(attachedInventory);
      // Without a deviceId, chooseAttachedProfile has resolved one (or thrown).
      const placement = profileChoice
        ? { kind: "attached_device" as const, deviceId: profileChoice.chosen.id }
        : (value.placement as z.infer<typeof InteractionPlacement> | undefined);
      const createdResponse = await transport.createBrowserSession(workspaceId, {
        operationId: context.operationId,
        sessionId: sourceSessionId,
        ...(value.name ? { name: value.name } : {}),
        ...(value.initialUrl ? { initialUrl: value.initialUrl } : {}),
        headless: requestedHeadless,
        ...(value.storageMode ? { storageMode: value.storageMode } : {}),
        ...(placement ? { placement } : {}),
        ...(value.identityId ? { identityId: value.identityId } : {}),
        ...(value.baseRevisionId ? { baseRevisionId: value.baseRevisionId } : {}),
        ...(value.networkRouteId ? { networkRouteId: value.networkRouteId } : {}),
        ...(value.linkedComputerSessionId
          ? { linkedComputerSessionId: value.linkedComputerSessionId }
          : {}),
      });
      session = createdResponse.session;
      initialView = createdResponse.initialView;
    }
  }
  if (session.lifecycle === "suspended") {
    session = (
      await transport.resumeBrowserSession(workspaceId, session.id, {
        operationId: context.operationId,
      })
    ).session;
  }
  const chosenProfile = profileChoice
    ? {
        attachedProfile: agentAttachedProfile(profileChoice.chosen),
        ...(profileChoice.others.length > 0
          ? { otherAttachedProfiles: profileChoice.others.map(agentAttachedProfile) }
          : {}),
      }
    : {};
  if (session.lifecycle !== "active") return { session, targets: [], ...chosenProfile };
  let targets =
    initialView?.targets ?? (await transport.listBrowserTargets(workspaceId, session.id)).targets;
  if (
    value.initialUrl &&
    !created &&
    !targets.some((target) => sameBrowserUrl(target.url, value.initialUrl!))
  ) {
    if (!transport.openBrowserTargetWithInventory) {
      throw new Error("browser transport does not support metadata-only tab opening");
    }
    const inventory = BrowserTargetListResponse.parse(
      await transport.openBrowserTargetWithInventory(workspaceId, session.id, {
        url: value.initialUrl,
      }),
    );
    const controllerGeneration = session.controller?.controllerGeneration;
    if (
      inventory.browserSessionId !== session.id ||
      inventory.controllerGeneration !== controllerGeneration ||
      inventory.targets.some(
        (target) =>
          target.browserSessionId !== session.id ||
          target.controllerGeneration !== controllerGeneration,
      )
    ) {
      throw new Error("browser transport returned inventory for another session binding");
    }
    targets = inventory.targets;
  }
  const primary = openedBrowserTarget(targets, value.initialUrl);
  const observation = !primary
    ? undefined
    : initialView?.observation.target.id === primary.id
      ? projectBrowserObservation(initialView.observation, "compact")
      : await observeOpenedBrowserTarget(transport, workspaceId, session.id, primary);
  // A browser opened on a URL is about that tab. A person's own Chrome profile
  // can hold dozens of unrelated tabs; listing them all costs context on every
  // later step, so only the opened tab is returned with a count of the rest
  // (browser_tabs list shows them).
  const opened =
    value.initialUrl && primary && sameBrowserUrl(primary.url, value.initialUrl)
      ? primary
      : undefined;
  const shown = opened && targets.length > 1 ? [opened] : targets;
  return {
    session,
    targets: shown.map(agentBrowserTarget),
    ...(shown.length < targets.length ? { otherTabCount: targets.length - shown.length } : {}),
    ...(observation ? { observation } : {}),
    ...chosenProfile,
  };
}

type AttachedProfileChoice = {
  chosen: z.infer<typeof AttachedBrowserDeviceListResponse>["devices"][number];
  others: z.infer<typeof AttachedBrowserDeviceListResponse>["devices"];
};

/** The person's own Chrome when browser_open names no profile: the only
 * connected profile, else the one whose tabs changed most recently (a device's
 * updatedAt moves with its tab inventory, not with heartbeats). */
function chooseAttachedProfile(
  inventory: z.infer<typeof AttachedBrowserDeviceListResponse>,
): AttachedProfileChoice {
  const usable = inventory.devices
    .filter((device) => device.state === "connected" && device.capabilities.debuggerAttachment)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const [chosen, ...others] = usable;
  if (!chosen) {
    throw new OpenGeniApiError(
      409,
      `No Chrome profile is connected through the Opengeni Browser extension. The person needs a Connected Machine, then the extension: ${OPENGENI_BROWSER_EXTENSION_URL}`,
      { code: "attached_browser_unavailable", retryable: false },
    );
  }
  return { chosen, others };
}

function agentAttachedProfile(
  device: AttachedProfileChoice["chosen"],
): z.infer<typeof AgentAttachedProfile> {
  return {
    id: device.id,
    name: device.name,
    ...(device.profileLabel && device.profileLabel !== device.name
      ? { profileLabel: device.profileLabel }
      : {}),
  };
}

/**
 * The tab the agent most likely acts on next: the tab showing the requested
 * URL, else the selected page.
 */
function openedBrowserTarget(
  targets: z.infer<typeof BrowserTarget>[],
  initialUrl: string | undefined,
): z.infer<typeof BrowserTarget> | undefined {
  const pages = targets.filter((target) => target.kind === "page");
  return (
    (initialUrl ? pages.find((target) => sameBrowserUrl(target.url, initialUrl)) : undefined) ??
    pages.find((target) => target.selected) ??
    (pages.length === 1 ? pages[0] : undefined)
  );
}

/**
 * A compact observation of the opened tab. Opening a browser is almost always
 * followed by reading it, so this saves that model round trip. It is a
 * read-only convenience: if it fails, the open still succeeds and the agent can
 * observe explicitly.
 */
async function observeOpenedBrowserTarget(
  transport: InteractionTransport,
  workspaceId: string,
  browserSessionId: string,
  primary: z.infer<typeof BrowserTarget>,
): Promise<z.infer<typeof CompactBrowserObservation> | undefined> {
  try {
    return projectBrowserObservation(
      await transport.observeBrowserTarget(workspaceId, browserSessionId, primary.id),
      "compact",
    );
  } catch {
    return undefined;
  }
}

function sameBrowserUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

async function openComputer(
  transport: InteractionTransport,
  workspaceId: string,
  sourceSessionId: string,
  value: z.output<typeof ComputerOpenInput>,
  context: AttemptToolExecutionContext,
): Promise<z.input<typeof ComputerOpenOutput>> {
  let session: z.infer<typeof ComputerSession>;
  if (value.computerSessionId) {
    session = await transport.getComputerSession(workspaceId, value.computerSessionId);
  } else {
    const listed =
      value.mode === "new"
        ? { sessions: [] }
        : await transport.listComputerSessions(workspaceId, {
            associatedSessionId: sourceSessionId,
            includeTerminal: false,
          });
    const reusable = newestRelevant(
      listed.sessions.filter((candidate) =>
        compatibleInteractionPlacement(candidate.placement, value.placement),
      ),
      sourceSessionId,
    );
    session = reusable
      ? reusable
      : (
          await transport.createComputerSession(workspaceId, {
            operationId: context.operationId,
            sessionId: sourceSessionId,
            ...(value.name ? { name: value.name } : {}),
            ...(value.placement ? { placement: value.placement } : {}),
          })
        ).session;
  }
  return {
    session,
    targets:
      session.lifecycle === "active"
        ? (await transport.listComputerTargets(workspaceId, session.id)).targets
        : [],
  };
}

function compatibleInteractionPlacement(
  candidate: z.infer<typeof InteractionPlacement>,
  requested: z.infer<typeof BrowserOpenPlacement> | undefined,
): boolean {
  if (!requested) return candidate.kind !== "attached_device";
  return Object.entries(requested).every(
    ([key, value]) => (candidate as Record<string, unknown>)[key] === value,
  );
}

function newestRelevant<
  T extends {
    lifecycle: string;
    associations: Array<{ sessionId: string; lastUsedAt: string }>;
    lastUsedAt: string;
  },
>(sessions: readonly T[], sourceSessionId: string): T | null {
  return (
    sessions
      .filter(
        (session) =>
          !["ending", "ended", "failed", "lost", "repair_required"].includes(session.lifecycle) &&
          session.associations.some((association) => association.sessionId === sourceSessionId),
      )
      .sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt))[0] ?? null
  );
}

function assertInterventionResumeMatches(
  request: z.output<typeof RequestHumanInteractionToolInput>,
  intervention: z.infer<typeof InteractionIntervention>,
): void {
  if (request.operation === "wait") {
    if (request.interventionId !== intervention.id) {
      throw new Error("Interaction response does not belong to the resumed intervention");
    }
    return;
  }
  if (
    request.resourceKind !== intervention.resourceKind ||
    request.resourceId !== intervention.resourceId ||
    request.targetId !== intervention.targetId ||
    request.expectedControllerGeneration !== intervention.controllerGeneration ||
    request.expectedTargetGeneration !== intervention.targetGeneration ||
    request.expectedDocumentGeneration !== intervention.documentGeneration ||
    request.kind !== intervention.kind ||
    request.reason !== intervention.reason ||
    (request.authRunId ?? null) !== intervention.authRunId
  ) {
    throw new Error("Interaction response does not match the resumed tool request");
  }
}

function flattenBrowserNodes(
  roots: readonly BrowserSemanticNodeValue[],
  scopeRef?: string,
): FlatBrowserNode[] {
  const flattened: FlatBrowserNode[] = [];
  const stack: Array<{
    node: BrowserSemanticNodeValue;
    depth: number;
    withinScope: boolean;
    parentName?: string;
  }> = [...roots].reverse().map((node) => ({ node, depth: 0, withinScope: !scopeRef }));
  while (stack.length > 0) {
    const next = stack.pop()!;
    const withinScope = next.withinScope || next.node.ref === scopeRef;
    flattened.push({
      node: next.node,
      depth: next.depth,
      index: flattened.length,
      withinScope,
      ...(next.parentName !== undefined ? { parentName: next.parentName } : {}),
    });
    for (const child of [...(next.node.children ?? [])].reverse()) {
      stack.push({
        node: child,
        depth: next.depth + 1,
        withinScope,
        ...(next.node.name !== undefined ? { parentName: next.node.name } : {}),
      });
    }
  }
  return flattened;
}

/** Container roles that help the model orient even without a name. */
const BROWSER_AGENT_STRUCTURAL_ROLES = new Set([
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "navigation",
  "main",
  "form",
  "table",
  "grid",
  "list",
  "listbox",
  "menu",
  "menubar",
  "tablist",
  "radiogroup",
]);

/** Nodes that add nothing to the compact view: static text repeating its
 * parent's accessible name, and unnamed, stateless, non-actionable containers.
 * Their children keep their own depth, so the outline stays readable. */
function redundantAgentNode(flat: FlatBrowserNode): boolean {
  const { node } = flat;
  if (node.actions.length > 0 || node.states.length > 0) return false;
  const hasValue = node.value !== undefined && node.value !== null && node.value !== "";
  if (node.role === "text" || node.role === "StaticText") {
    return !hasValue && !node.description && (!node.name || node.name === flat.parentName);
  }
  if (BROWSER_AGENT_STRUCTURAL_ROLES.has(node.role)) return false;
  return !node.name && !node.description && !hasValue;
}

function boundedAgentField(value: string, onClip: () => void): string {
  if (value.length <= BROWSER_AGENT_MAX_FIELD_LENGTH) return value;
  onClip();
  return `${value.slice(0, BROWSER_AGENT_MAX_FIELD_LENGTH - 1)}…`;
}

function projectAgentNode(flat: FlatBrowserNode): {
  node: z.infer<typeof BrowserAgentNode>;
  clippedFieldCount: number;
} {
  let clippedFieldCount = 0;
  const clip = () => {
    clippedFieldCount += 1;
  };
  const source = flat.node;
  const nodes = {
    ref: source.ref,
    role: source.role,
    depth: flat.depth,
    ...(source.name !== undefined ? { name: boundedAgentField(source.name, clip) } : {}),
    ...(source.description !== undefined
      ? { description: boundedAgentField(source.description, clip) }
      : {}),
    ...(source.value !== undefined
      ? {
          value:
            typeof source.value === "string" ? boundedAgentField(source.value, clip) : source.value,
        }
      : {}),
    ...(source.states.length > 0
      ? { states: source.states.slice(0, 6).map((state) => boundedAgentField(state, clip)) }
      : {}),
    ...(source.actions.length > 0
      ? { actions: source.actions.slice(0, 6).map((action) => boundedAgentField(action, clip)) }
      : {}),
  };
  if (source.states.length > 6) clippedFieldCount += source.states.length - 6;
  if (source.actions.length > 6) clippedFieldCount += source.actions.length - 6;
  return { node: nodes, clippedFieldCount };
}

function selectAgentNodes(
  flattened: readonly FlatBrowserNode[],
  maxNodes: number,
  maxBytes: number,
  prioritize = true,
): { nodes: z.infer<typeof BrowserAgentNode>[]; clippedFieldCount: number } {
  const priority = (flat: FlatBrowserNode): number => {
    const { node } = flat;
    if (node.actions.length > 0) return 0;
    if (["heading", "dialog", "alert", "status", "navigation", "main"].includes(node.role))
      return 1;
    if (["text", "paragraph", "listitem"].includes(node.role) && node.name) return 2;
    if (node.name || node.value || node.description) return 3;
    return 4;
  };
  const candidates = prioritize
    ? [...flattened].sort((a, b) => priority(a) - priority(b) || a.index - b.index)
    : flattened;
  const selected: Array<{ index: number; node: z.infer<typeof BrowserAgentNode> }> = [];
  let usedBytes = 0;
  let clippedFieldCount = 0;
  for (const flat of candidates) {
    if (selected.length >= maxNodes) break;
    const projected = projectAgentNode(flat);
    const bytes = Buffer.byteLength(JSON.stringify(projected.node), "utf8");
    if (usedBytes + bytes > maxBytes) continue;
    selected.push({ index: flat.index, node: projected.node });
    usedBytes += bytes;
    clippedFieldCount += projected.clippedFieldCount;
  }
  return {
    nodes: selected.sort((a, b) => a.index - b.index).map((entry) => entry.node),
    clippedFieldCount,
  };
}

function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact",
): z.infer<typeof CompactBrowserObservation>;
function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact" | "full",
): z.infer<typeof BrowserAgentObservation>;
function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact" | "full",
): z.infer<typeof BrowserAgentObservation> {
  if (view === "full") return observation;
  const semantic = observation.semantic;
  const roots =
    semantic?.kind === "snapshot"
      ? semantic.roots
      : semantic?.kind === "diff"
        ? semantic.changed
        : [];
  const flattened = flattenBrowserNodes(roots).filter((flat) => !redundantAgentNode(flat));
  const projected = selectAgentNodes(
    flattened,
    BROWSER_AGENT_MAX_NODES,
    BROWSER_AGENT_MAX_NODE_BYTES,
  );
  const omittedNodeCount = flattened.length - projected.nodes.length;
  const removedRefCount = semantic?.kind === "diff" ? semantic.removedRefs.length : 0;
  const viewport = observation.viewport;
  const diagnostics = observation.diagnostics;
  const hasDiagnostics =
    diagnostics.consoleErrorCount > 0 ||
    diagnostics.failedRequestCount > 0 ||
    diagnostics.downloadCount > 0 ||
    diagnostics.pageErrorCount > 0;
  return {
    target: agentBrowserTarget(observation.target),
    ...(observation.frameId ? { frameId: observation.frameId } : {}),
    ...(viewport
      ? {
          viewport: {
            width: viewport.width,
            height: viewport.height,
            ...(viewport.deviceScaleFactor !== 1
              ? { deviceScaleFactor: viewport.deviceScaleFactor }
              : {}),
            ...(viewport.maxTouchPoints > 0 ? { maxTouchPoints: viewport.maxTouchPoints } : {}),
          },
        }
      : {}),
    ...(observation.focusedRef ? { focusedRef: observation.focusedRef } : {}),
    ...(observation.changedRegions.length > 0
      ? { changedRegions: observation.changedRegions }
      : {}),
    ...(hasDiagnostics ? { diagnostics } : {}),
    ...(observation.dialog ? { dialog: observation.dialog } : {}),
    ...(observation.screenshot ? { screenshot: observation.screenshot } : {}),
    agentView: {
      sourceKind: semantic?.kind ?? "none",
      nodes: projected.nodes,
      ...(omittedNodeCount > 0 ? { omittedNodeCount } : {}),
      ...(removedRefCount > 0 ? { removedRefCount } : {}),
      ...(projected.clippedFieldCount > 0
        ? { clippedFieldCount: projected.clippedFieldCount }
        : {}),
    },
  };
}

function agentBrowserTarget(
  target: z.infer<typeof BrowserTarget>,
): z.infer<typeof AgentBrowserTarget> {
  return {
    id: target.id,
    kind: target.kind,
    title: target.title,
    url: target.url,
    selected: target.selected,
    controllerGeneration: target.controllerGeneration,
    targetGeneration: target.targetGeneration,
    documentGeneration: target.documentGeneration,
  };
}

/** Attached profiles are what the model selects. Bridges only explain why
 * none is available, so they are listed (online only) when no profile is. */
function agentAttachedInventory(inventory: z.infer<typeof AttachedBrowserDeviceListResponse>): {
  attachedBrowserBridges: z.infer<typeof AgentAttachedBrowserBridge>[];
  attachedBrowsers: z.infer<typeof AgentAttachedBrowser>[];
} {
  const attachedBrowsers = inventory.devices.map((device) => {
    const unsupported = Object.entries(device.capabilities)
      .filter(([, supported]) => !supported)
      .map(([capability]) => capability);
    return {
      id: device.id,
      name: device.name,
      ...(device.profileLabel ? { profileLabel: device.profileLabel } : {}),
      browserName: device.browserName,
      platform: device.platform,
      state: device.state,
      tabCount: device.tabCount,
      ...(unsupported.length > 0 ? { unsupported } : {}),
    };
  });
  const anyConnected = inventory.devices.some((device) => device.state === "connected");
  const attachedBrowserBridges = anyConnected
    ? []
    : inventory.bridges
        .filter((bridge) => bridge.state === "online")
        .map((bridge) => ({
          enrollmentId: bridge.enrollmentId,
          connectedProfileCount: bridge.connectedProfileCount,
        }));
  return { attachedBrowserBridges, attachedBrowsers };
}

function agentTargetList(
  list: z.infer<typeof BrowserTargetListResponse>,
): z.infer<typeof BrowserTabsOutput> {
  return {
    browserSessionId: list.browserSessionId,
    targets: list.targets.map(agentBrowserTarget),
  };
}

function compactActionReceipt(
  receipt: z.infer<typeof BrowserActionReceipt>,
): z.infer<typeof CompactBrowserActionReceipt> {
  return {
    targetId: receipt.targetId,
    state: receipt.state,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(receipt.targets && receipt.targets.length > 0 ? { targets: receipt.targets } : {}),
    ...(receipt.observation
      ? { observation: projectBrowserObservation(receipt.observation, "compact") }
      : {}),
  };
}

function readBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  input: z.output<typeof BrowserReadInput>,
): z.infer<typeof BrowserReadOutput> {
  if (observation.semantic?.kind !== "snapshot") {
    throw new Error("browser focused read requires a complete accessibility snapshot");
  }
  const mode = input.mode && input.mode !== "dom" ? input.mode : "matches";
  const scopeRef = mode === "subtree" ? input.ref : input.scopeRef;
  const flattened = flattenBrowserNodes(observation.semantic.roots, scopeRef);
  const scopeFound = !scopeRef || flattened.some((entry) => entry.node.ref === scopeRef);
  const includes = (source: string | undefined, needle: string | undefined): boolean =>
    needle === undefined || (source ?? "").toLowerCase().includes(needle.toLowerCase());
  const matches = flattened.filter(({ node, withinScope }) => {
    if (!withinScope) return false;
    if (mode !== "subtree" && input.ref && node.ref !== input.ref) return false;
    if (input.role && node.role.toLowerCase() !== input.role.toLowerCase()) return false;
    if (!includes(node.name, input.nameContains)) return false;
    if (
      input.textContains &&
      ![node.name, node.description, typeof node.value === "string" ? node.value : undefined].some(
        (candidate) => includes(candidate, input.textContains),
      )
    )
      return false;
    if (
      input.state &&
      !node.states.some((state) => state.toLowerCase() === input.state!.toLowerCase())
    )
      return false;
    if (
      input.action &&
      !node.actions.some((action) => action.toLowerCase() === input.action!.toLowerCase())
    )
      return false;
    return true;
  });
  const projected =
    mode === "count"
      ? { nodes: [] as z.infer<typeof BrowserAgentNode>[], clippedFieldCount: 0 }
      : selectAgentNodes(matches, input.limit ?? 40, BROWSER_AGENT_MAX_NODE_BYTES, false);
  return {
    browserSessionId: observation.browserSessionId,
    targetId: observation.target.id,
    observationId: observation.observationId,
    targetGeneration: observation.target.targetGeneration,
    documentGeneration: observation.target.documentGeneration,
    frameId: observation.frameId,
    source: "accessibility",
    mode,
    scopeFound,
    nodes: projected.nodes,
    totalMatches: matches.length,
    omittedMatches: matches.length - projected.nodes.length,
    clippedFieldCount: projected.clippedFieldCount,
    maxNodeBytes: BROWSER_AGENT_MAX_NODE_BYTES,
  };
}

/** A tool's model text, or its JSON when it has none. Rendering is a pure view
 * of a value that already passed its output schema; should it ever fail, the
 * model still gets the complete value rather than an error for a call that
 * succeeded. */
function resultModelText<T>(output: T, modelText: ((output: T) => string) | undefined): string {
  if (modelText) {
    try {
      return modelText(output);
    } catch {
      // Fall through to the complete value.
    }
  }
  return JSON.stringify(output);
}

/** The text view of a complete observation (view=full): every node, every ref. */
function fullObservationText(observation: z.infer<typeof BrowserObservation>): string {
  const semantic = observation.semantic;
  const roots =
    semantic?.kind === "snapshot"
      ? semantic.roots
      : semantic?.kind === "diff"
        ? semantic.changed
        : [];
  return browserObservationText(
    {
      target: observation.target,
      viewport: observation.viewport,
      focusedRef: observation.focusedRef,
      changedRegions: observation.changedRegions,
      diagnostics: observation.diagnostics,
      dialog: observation.dialog,
      screenshot: observation.screenshot ?? undefined,
      agentView: {
        sourceKind: semantic?.kind ?? "none",
        nodes: flattenBrowserNodes(roots).map(({ node, depth }) => ({
          ref: node.ref,
          role: node.role,
          depth,
          ...(node.name !== undefined ? { name: node.name } : {}),
          ...(node.description !== undefined ? { description: node.description } : {}),
          ...(node.value !== undefined ? { value: node.value } : {}),
          states: node.states,
          actions: node.actions,
        })),
        ...(semantic?.kind === "diff" && semantic.removedRefs.length > 0
          ? { removedRefCount: semantic.removedRefs.length }
          : {}),
      },
    },
    { allRefs: true },
  );
}

function agentObservationText(observation: z.infer<typeof BrowserAgentObservation>): string {
  return "agentView" in observation
    ? browserObservationText(observation)
    : fullObservationText(observation);
}

function agentActionText(receipt: z.infer<typeof BrowserAgentActionReceipt>): string {
  if ("protocolVersion" in receipt) {
    const text = browserActionText({
      targetId: receipt.targetId,
      state: receipt.state,
      error: receipt.error,
      ...(receipt.targets ? { targets: receipt.targets } : {}),
    });
    return receipt.observation ? `${text}\n${fullObservationText(receipt.observation)}` : text;
  }
  return browserActionText(receipt);
}

async function safeInteractionExecution<TInput extends z.ZodType, TOutput extends z.ZodType>(
  inputSchema: TInput,
  outputSchema: TOutput,
  raw: Record<string, unknown>,
  context: AttemptToolExecutionContext,
  execute: (
    value: z.output<TInput>,
    context: AttemptToolExecutionContext,
  ) => Promise<z.input<TOutput> | InteractionExecutionResult<z.input<TOutput>>>,
  readOnly: boolean,
  modelText?: (output: z.output<TOutput>) => string,
): Promise<AttemptToolResultValue> {
  try {
    const value = inputSchema.parse(raw);
    const executed = await execute(value, context);
    const structuredContent = outputSchema.parse(
      executed instanceof InteractionExecutionResult ? executed.output : executed,
    );
    const result = {
      content: [
        { type: "text" as const, text: resultModelText(structuredContent, modelText) },
        ...(executed instanceof InteractionExecutionResult ? executed.additionalContent : []),
      ],
      structuredContent: structuredContent as NonNullable<
        AttemptToolResultValue["structuredContent"]
      >,
    };
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return interactionErrorResult("invalid_arguments", describeInvalidToolArguments(error));
    }
    if (error instanceof BrowserTargetResolutionError) {
      return interactionErrorResult(error.code, error.message);
    }
    // A failed read is still a useful tool result. Preserve the API's public
    // explanation; mutations and uncertain outcomes retain their failure path.
    const secretReferenceFailure = secretReferenceToolResult(error);
    if (secretReferenceFailure) return secretReferenceFailure;
    if (
      error instanceof OpenGeniApiError &&
      !error.outcomeUnknown &&
      (error.status < 500 || readOnly)
    ) {
      const controlFailure = interactionToolErrorOutput(error);
      if (controlFailure) return controlFailure;
      return interactionErrorResult(
        error.code ?? `http_${error.status}`,
        boundedErrorMessage(error.message),
        error.retryable,
        error.correlationId,
      );
    }
    throw error;
  }
}

export type InteractionToolErrorResult = {
  isError: true;
  content: [{ type: "text"; text: string }];
  structuredContent: {
    error: {
      code: string;
      message: string;
      retryable: boolean;
      outcomeUnknown: boolean;
      requestId?: string;
      details?: {
        interactionLayer: "connected_machine";
        interactionSurface: "browser" | "computer";
        controlFailureCode: InteractionControlFailure["code"];
        controlRequestId?: string;
      };
      guidance: string;
    };
  };
};

/** Preserve the API's closed control-failure projection at the model seam.
 * Uncertain execution still throws from the tool executor; rendering its error
 * must not replace that uncertainty with a generic instruction to retry. */
export function interactionToolErrorOutput(error: unknown): InteractionToolErrorResult | null {
  try {
    if (!(error instanceof OpenGeniApiError)) return null;
    const failure = interactionControlFailureFromError(error);
    if (!failure && !error.outcomeUnknown) return null;
    const opaque = (value: unknown): string | undefined =>
      typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value)
        ? value
        : undefined;
    const requestId = opaque(error.correlationId);
    const details = failure
      ? {
          interactionLayer: failure.layer,
          interactionSurface: failure.surface,
          controlFailureCode: failure.code,
          ...(failure.controlRequestId ? { controlRequestId: failure.controlRequestId } : {}),
        }
      : undefined;
    const projected = {
      code:
        typeof error.code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(error.code)
          ? error.code
          : "interaction_request_failed",
      message: boundedErrorMessage(error.message),
      retryable: error.retryable,
      outcomeUnknown: error.outcomeUnknown,
      ...(requestId ? { requestId } : {}),
      ...(details ? { details } : {}),
      guidance: error.outcomeUnknown
        ? "The request may have completed. Do not repeat actions automatically; inspect the existing session before continuing."
        : error.retryable
          ? "Check the existing session before retrying. Keep its identity and do not recreate it to bypass the failure."
          : "Resolve the reported issue before calling again; this failure is not marked retryable.",
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: projected }) }],
      structuredContent: { error: projected },
    };
  } catch {
    return null;
  }
}

function browserToolImageContent(
  data: Uint8Array,
  mimeType: string,
): AttemptToolResultValue["content"][number] {
  if (data.byteLength > BROWSER_TOOL_IMAGE_MAX_BYTES) {
    throw new OpenGeniApiError(
      413,
      "Browser screenshot exceeds the Code Mode image limit; capture the viewport or lower JPEG quality.",
      { code: "browser_screenshot_too_large", retryable: false },
    );
  }
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
}

/** The remembered browser or tab no longer exists. */
function isGoneBrowserError(error: unknown): boolean {
  return error instanceof OpenGeniApiError && (error.status === 404 || error.status === 410);
}

function interactionErrorResult(
  code: string,
  message: string,
  retryable = false,
  requestId?: string,
): AttemptToolResultValue {
  const error = { code, message, retryable, ...(requestId ? { requestId } : {}) };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}

/** The API refused a Browser or Computer action before dispatch because a
 * `{{secret:…}}` reference failed. Render it exactly like the in-process
 * adapters (`SecretReferenceError.toModelOutput()`), including the ready-made
 * ask card for missing secrets. The body never contains values. */
export function secretReferenceToolResult(error: unknown): AttemptToolResultValue | null {
  if (!(error instanceof OpenGeniApiError) || error.status !== 422 || !error.body) return null;
  try {
    const parsed = JSON.parse(error.body) as {
      error?: { details?: { reason?: unknown; secretReference?: unknown } };
    };
    const details = parsed.error?.details;
    const output = details?.secretReference;
    if (
      details?.reason !== "secret_reference_error" ||
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output)
    ) {
      return null;
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output as NonNullable<AttemptToolResultValue["structuredContent"]>,
    };
  } catch {
    return null;
  }
}

function jsonSchema(schema: z.ZodType): AttemptToolJsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as AttemptToolJsonSchema;
}

function hasToolPermission(
  permissions: readonly Permission[],
  required: Permission | readonly Permission[],
): boolean {
  return (
    permissions.includes("workspace:admin") ||
    (typeof required === "string" ? [required] : required).every((permission) =>
      permissions.includes(permission),
    )
  );
}

function firstPartyApiBaseUrl(settings: Settings, workspaceId: string): string {
  const url = new URL(firstPartyMcpInternalWorkspaceUrl(settings, workspaceId));
  const suffix = `/v1/workspaces/${workspaceId}/mcp`;
  if (!url.pathname.endsWith(suffix)) {
    throw new Error("First-party MCP URL cannot be projected to the Opengeni API base URL");
  }
  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function boundedErrorMessage(message: string): string {
  return message.length <= 1_024 ? message : `${message.slice(0, 1_021)}...`;
}
