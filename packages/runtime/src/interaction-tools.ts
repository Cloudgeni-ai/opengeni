import { createHash } from "node:crypto";
import {
  OPENGENI_BROWSER_EXTENSION_URL,
  CUA_DESKTOP_TOOLS,
  cuaDesktopToolVariants,
  AttemptToolResult,
  ComputerNativeReceipt,
  type UserSetupBlocker,
  userSetupBlocker,
  userSetupCardShownMessage,
  userSetupCardUnpostedMessage,
  userSetupUnavailableMessage,
} from "@opengeni/contracts";
import { boundComputerNativeReceipt } from "@opengeni/interaction";
import {
  AttachedBrowserDeviceListResponse,
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  BrowserAction,
  BrowserLocator,
  INTERACTION_MAX_ACTIONS_PER_BATCH,
  INTERACTION_MAX_WORKSPACE_FILES_PER_COMMAND,
  BrowserActionBatch,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDownload,
  BrowserDownloadListResponse,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  BrowserRecordingSaveRequest,
  BrowserRecordingSaveResponse,
  BrowserRecordingSummary,
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
  BROWSER_LOCATOR_KIND_WORDS,
  BrowserTargetResolutionError,
  CurrentBrowserTab,
  expandRefShorthand,
  type ResolvedBrowserSession,
  type ResolvedBrowserTarget,
} from "./browser-current-tab";
import {
  ComputerTargetResolutionError,
  CurrentComputerWindow,
  type ResolvedComputerSession,
  type ResolvedComputerTarget,
} from "./computer-current-window";
import {
  describeInvalidToolArguments,
  interactionToolInputJsonSchema,
  browserActModelInputSchema,
  computerActModelInputSchema,
} from "./interaction-tool-json-schema";
import { guardedMcpFetch } from "./mcp-network";
import { compactComputerImage, compactComputerImageContent } from "./computer-image-encoding";
import {
  browserActionText,
  browserObservationDiff,
  browserObservationText,
  browserOpenText,
  browserReadText,
  browserTabsText,
  type BrowserTextObservation,
} from "./browser-model-text";
import {
  computerActionText,
  computerObservationDiff,
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
const BROWSER_AGENT_MAX_OMITTED_REGIONS = 4;
/** The focused or acted-on element is shown with its nearest enclosing group
 * (a toolbar, form section, row or card) up to this many elements. */
const BROWSER_AGENT_FOCUS_GROUP_MAX_NODES = 24;
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
    /** Where the left-out elements are, largest first, so the model knows
     * which part of the page a fuller read would add. */
    omittedRegions: z
      .array(
        z
          .object({
            role: z.string().max(256),
            name: z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH).optional(),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(BROWSER_AGENT_MAX_OMITTED_REGIONS)
      .optional(),
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
  browser_record: ["sessions:control", "files:upload"],
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
 * labels, the computer it is on (marked when it is the one this session runs
 * on), state and any capability it lacks. Enrollment, generation and timestamp
 * bookkeeping stay out. */
const AgentAttachedBrowser = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(200),
    profileLabel: z.string().max(200).optional(),
    machine: z.string().optional(),
    onThisMachine: z.literal(true).optional(),
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
    machine: z.string().optional(),
    onThisMachine: z.literal(true).optional(),
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
/** The Chrome profile browser_open chose when the request named none, with the
 * computer it is on (marked when it is the one this session runs on). */
const AgentAttachedProfile = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    profileLabel: z.string().optional(),
    machine: z.string().optional(),
    onThisMachine: z.literal(true).optional(),
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
    includeScreenshot: z.boolean().optional(),
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
    notice: z.string().optional(),
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
/**
 * An upload that names files in this session's workspace instead of workspace
 * File IDs. The tool publishes each path exactly as sandbox_file_publish does
 * and dispatches the ordinary upload with the resulting IDs, so a file the
 * agent just wrote needs no separate publish call.
 */
const BrowserUploadPathsAction = z
  .object({
    type: z.literal("upload"),
    locator: BrowserLocator,
    paths: z
      .array(z.string().min(1).max(4_096))
      .min(1)
      .max(INTERACTION_MAX_WORKSPACE_FILES_PER_COMMAND),
  })
  .strict();
/** navigate may name a load state to wait for; the tool dispatches it as the
 * navigation followed by an ordinary wait action. */
const AgentBrowserNavigateAction = z
  .object({
    type: z.literal("navigate"),
    url: z.string().min(1).max(8_192),
    waitUntil: z.enum(["load", "network_idle"]).optional(),
  })
  .strict();
/** viewport defaults to desktop layout without touch emulation. */
const AgentBrowserViewportAction = z
  .object({
    type: z.literal("viewport"),
    width: z.number().int().min(240).max(4_096),
    height: z.number().int().min(240).max(4_096),
    mobile: z.boolean().optional(),
    deviceScaleFactor: z.number().min(0.5).max(4).optional(),
  })
  .strict();
const AgentBrowserAction = z.union([
  AgentBrowserNavigateAction,
  AgentBrowserViewportAction,
  ...BrowserAction.options.filter(
    (option) => option.shape.type.value !== "navigate" && option.shape.type.value !== "viewport",
  ),
  BrowserUploadPathsAction,
]);
type AgentBrowserAction = z.infer<typeof AgentBrowserAction>;
const AgentBrowserActionBatch = z
  .object({
    type: z.literal("batch"),
    actions: z.array(AgentBrowserAction).min(1).max(INTERACTION_MAX_ACTIONS_PER_BATCH),
    fenceEachAction: z.literal(true).optional(),
  })
  .strict();
type AgentBrowserActionBatch = z.infer<typeof AgentBrowserActionBatch>;

/** Return the dispatched action: upload paths published once as File IDs, a
 * viewport's omitted `mobile` as desktop, and a navigate's `waitUntil` as the
 * navigation followed by a wait for that load state. */
async function toDispatchedBrowserAction(
  action: AgentBrowserAction | AgentBrowserActionBatch,
  publish: (path: string) => Promise<string>,
): Promise<BrowserAction | BrowserActionBatch> {
  const resolve = async (item: AgentBrowserAction): Promise<BrowserAction[]> => {
    if (item.type === "navigate") {
      const navigate = BrowserAction.parse({ type: "navigate", url: item.url });
      const waitUntil = "waitUntil" in item ? item.waitUntil : undefined;
      if (!waitUntil) return [navigate];
      return [navigate, { type: "wait", condition: waitUntil }];
    }
    if (item.type === "viewport") {
      return [BrowserAction.parse({ ...item, mobile: item.mobile ?? false })];
    }
    if (item.type !== "upload" || !("paths" in item)) return [item as BrowserAction];
    const workspaceFileIds: string[] = [];
    for (const path of item.paths) workspaceFileIds.push(await publish(path));
    return [{ type: "upload", locator: item.locator, workspaceFileIds }];
  };
  if (action.type !== "batch") {
    const resolved = await resolve(action);
    return resolved.length === 1
      ? resolved[0]!
      : BrowserActionBatch.parse({ type: "batch", actions: resolved });
  }
  const actions: BrowserAction[] = [];
  for (const item of action.actions) actions.push(...(await resolve(item)));
  if (actions.length > INTERACTION_MAX_ACTIONS_PER_BATCH) {
    throw new Error(
      `a batch runs at most ${INTERACTION_MAX_ACTIONS_PER_BATCH} actions, and each navigate with waitUntil counts as two; split the batch`,
    );
  }
  return BrowserActionBatch.parse({ ...action, actions });
}

const BrowserActInput = z
  .object({
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId,
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedDocumentGeneration: z.string().min(1).max(256).nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    view: z.enum(["compact", "full", "none"]).optional(),
    includeScreenshot: z.boolean().optional(),
    action: z.preprocess(
      (action) => expandRefShorthand(action, BROWSER_LOCATOR_KIND_WORDS),
      z.union([AgentBrowserAction, AgentBrowserActionBatch]),
    ),
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
const CurrentComputerSessionId = z
  .string()
  .uuid()
  .optional()
  .describe("Omit to use the computer you used last.");
const CurrentComputerTargetId = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe("Omit to use the window you used last.");
const ComputerTargetsInput = z.object({ computerSessionId: CurrentComputerSessionId }).strict();
const ComputerObserveInput = z
  .object({
    computerSessionId: CurrentComputerSessionId,
    targetId: CurrentComputerTargetId.describe(
      "Omit to use the window you used last, or at first the focused window (the screen when none is).",
    ),
  })
  .strict();
const ComputerObserveOutput = ComputerObservation.extend({
  capturedFrame: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict()
    .optional(),
}).strict();
const ComputerClipboardInput = z.object({ computerSessionId: CurrentComputerSessionId }).strict();
/** Action types a computer_act batch runs. Each acts on the state the one
 * before it left; a pointer action needs the pixels of one exact screenshot,
 * so it is not batched. */
const COMPUTER_BATCH_ACTION_TYPES: ReadonlySet<ComputerAction["type"]> = new Set([
  "semantic",
  "keyboard",
]);
const ComputerActionBatch = z
  .object({
    type: z.literal("batch"),
    actions: z
      .array(ComputerAction)
      .min(1)
      .max(INTERACTION_MAX_ACTIONS_PER_BATCH)
      .superRefine((actions, context) => {
        actions.forEach((action, index) => {
          if (!COMPUTER_BATCH_ACTION_TYPES.has(action.type)) {
            context.addIssue({
              code: "custom",
              path: [index, "type"],
              message: `a batch runs semantic and keyboard actions; run a ${action.type} action on its own`,
            });
          }
        });
      }),
  })
  .strict();
const ComputerActInput = z
  .object({
    computerSessionId: CurrentComputerSessionId,
    targetId: CurrentComputerTargetId,
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedObservationId: ComputerObservation.shape.observationId.nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    action: z.preprocess(
      (action) => withComputerActionTypes(expandRefShorthand(action)),
      z.union([ComputerAction, ComputerActionBatch]),
    ),
  })
  .strict();
/** A computer action may leave out its type where its fields say it: an
 * action with a locator is semantic, one with actions is a batch. */
function withComputerActionTypes(action: unknown): unknown {
  if (!action || typeof action !== "object" || Array.isArray(action)) return action;
  const record = action as Record<string, unknown>;
  const typed =
    record.type !== undefined
      ? record
      : "locator" in record
        ? { type: "semantic", ...record }
        : Array.isArray(record.actions)
          ? { type: "batch", ...record }
          : record;
  if (!Array.isArray(typed.actions)) return typed;
  return { ...typed, actions: typed.actions.map(withComputerActionTypes) };
}
/** computer_act input with the computer and window it resolved to. */
type ResolvedComputerActInput = Omit<
  z.output<typeof ComputerActInput>,
  "computerSessionId" | "targetId"
> & { computerSessionId: string; targetId: string };
/** What a computer_act batch did: each action's settled operation, in order,
 * up to the first one that did not complete, and the latest observation of
 * the target. */
const ComputerActionBatchReceipt = z
  .object({
    type: z.literal("batch"),
    targetId: z.string().min(1).max(512),
    actionCount: z.number().int().positive(),
    steps: z.array(
      z
        .object({
          operationId: z.string().uuid(),
          state: ComputerActionReceipt.shape.state,
          error: ComputerActionReceipt.shape.error,
        })
        .strict(),
    ),
    observation: ComputerObservation.nullable(),
    /** The observation was read before the action the batch stopped at, and
     * a fresh read after it failed. */
    observationPrecedesStop: z.boolean(),
    /** Actions that acted on an element of another role than the one named,
     * by their index in the batch. */
    roleStandIns: ComputerActionReceipt.shape.roleStandIns,
  })
  .strict();
const ComputerActOutput = z.union([ComputerActionReceipt, ComputerActionBatchReceipt]);
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
const BrowserRecordInput = z
  .object({
    operation: z.enum(["start", "stop"]),
    browserSessionId: CurrentBrowserSessionId,
    targetId: CurrentBrowserTargetId.describe(
      "start only: the tab to record first. Omit to use the tab you used last.",
    ),
    recordingId: z.string().uuid().optional().describe("stop only: the id start returned."),
    destinationPath: BrowserRecordingSaveRequest.shape.destinationPath.describe(
      "stop only: workspace-relative .mp4 path. Defaults to recordings/browser-<time>.mp4.",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === "stop") !== (value.recordingId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["recordingId"],
        message: "recordingId is required only for operation=stop",
      });
    }
    if (value.operation === "start" && value.destinationPath !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["destinationPath"],
        message: "destinationPath is set on operation=stop",
      });
    }
  });

export type CreateInteractionAttemptToolsInput = {
  /** The session's API client. Publishing is optional so narrower transports
   * still work; an upload by path then reports that it is unavailable. The
   * session read is optional too: without it, a placement-less open reuses a
   * live session on any non-personal placement. */
  transport: InteractionPlacementTransport &
    Partial<
      Pick<
        OpenGeniClient,
        "publishSandboxFileArtifact" | "startBrowserRecording" | "saveBrowserRecording"
      >
    >;
  workspaceId: string;
  sessionId: string;
  selectedTools?: readonly FirstPartyMcpToolName[];
  permissions?: readonly Permission[];
  interventionResume?: InteractionInterventionResume | null;
  /**
   * Put the setup card for a refusal the person can fix (USER_SETUP_BLOCKERS)
   * in this chat. Any tool here that hits one calls it, so the person sees the
   * fix on the first attempt. Resolves once the card is in the chat (including
   * one this turn already posted), with the chat link; null when none could be
   * posted.
   */
  postSetupCard?: UserSetupCardPoster | undefined;
  /**
   * The Chrome extension people add to connect their own Chrome, as agents
   * name and link it. Default: Opengeni Browser.
   */
  browserExtension?: { name: string; installUrl: string };
};

export function createInteractionAttemptToolDefinitions(
  input: CreateInteractionAttemptToolsInput,
): AttemptToolDefinition[] {
  const selected = new Set(input.selectedTools ?? DEFAULT_FIRST_PARTY_MCP_TOOLS);
  const permissions = input.permissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const extension = input.browserExtension ?? {
    name: "Opengeni Browser",
    installUrl: OPENGENI_BROWSER_EXTENSION_URL,
  };
  const definitions: AttemptToolDefinition[] = [];
  // A retried browser_act (same operation) must dispatch the same File IDs, so
  // each operation publishes a given path at most once.
  const publishedUploads = new Map<string, Promise<string>>();
  // The latest reading of each computer window and browser tab this attempt
  // showed the model (not a Code Mode program, whose results the model never
  // reads). An action's receipt shows only what changed since (refs stay with
  // their element), rendered once when the call returns, like every tool result.
  const computerSeen = new Map<string, Parameters<typeof computerObservationText>[0]>();
  const seenComputerKey = (observation: { computerSessionId: string; target: { id: string } }) =>
    `${observation.computerSessionId}\u0000${observation.target.id}`;
  const rememberComputerReading = (
    observation: Parameters<typeof computerObservationText>[0] & { computerSessionId: string },
  ) => {
    const key = seenComputerKey(observation);
    computerSeen.delete(key);
    computerSeen.set(key, observation);
    while (computerSeen.size > 32) computerSeen.delete(computerSeen.keys().next().value!);
  };
  const browserSeen = new Map<string, BrowserTextObservation>();
  const rememberBrowserReading = (
    context: AttemptToolExecutionContext,
    observation: BrowserTextObservation | undefined,
  ) => {
    if (context.caller.kind !== "model" || !observation) return;
    browserSeen.delete(observation.target.id);
    browserSeen.set(observation.target.id, observation);
    while (browserSeen.size > 32) browserSeen.delete(browserSeen.keys().next().value!);
  };
  const publishUploadPath = (operationId: string, path: string): Promise<string> => {
    const key = `${operationId}\u0000${path}`;
    let published = publishedUploads.get(key);
    if (!published) {
      const transport = input.transport;
      if (!transport.publishSandboxFileArtifact) {
        throw new Error(
          "upload by path is unavailable here; publish the file with sandbox_file_publish and pass its artifactId in workspaceFileIds",
        );
      }
      published = transport
        .publishSandboxFileArtifact(input.workspaceId, input.sessionId, { path })
        .then((receipt) => receipt.artifact.artifactId);
      published.catch(() => publishedUploads.delete(key));
      publishedUploads.set(key, published);
    }
    return published;
  };
  // Whether a ComputerSession runs a computer_act batch as one operation.
  // The computer fixes the answer for the session's life, across agent
  // updates, so every try of one batch, concurrent or retried, picks the same
  // way and cannot send its actions under both ways' operation IDs. A yes is
  // kept; a no is asked again, since a new session may say yes. An
  // unreadable or not yet reported answer sends nothing (see
  // actInComputerBatch).
  const actionBatchSupport = new Map<string, Promise<boolean>>();
  const supportsActionBatches = (computerSessionId: string): Promise<boolean> => {
    let known = actionBatchSupport.get(computerSessionId);
    if (!known) {
      known = Promise.resolve()
        .then(() => input.transport.getComputerSession(input.workspaceId, computerSessionId))
        .then(
          (session) => {
            if (!session.capabilities)
              throw new Error(
                "this computer session has not reported what it supports yet, so the batch was not sent; retry the call",
              );
            return session.capabilities.actionBatches === true;
          },
          (error: unknown) => {
            throw new Error(
              `whether this computer runs a batch as one operation could not be read, so the batch was not sent; retry the call: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                8_192,
              ),
            );
          },
        )
        .then((supported) => {
          if (!supported) actionBatchSupport.delete(computerSessionId);
          return supported;
        })
        .catch((error: unknown) => {
          actionBatchSupport.delete(computerSessionId);
          throw error;
        });
      actionBatchSupport.set(computerSessionId, known);
    }
    return known;
  };
  /** The sessions on the placement this chat runs on now. One left on a
   * machine the chat has since moved away from is used only when named, as
   * computer_open and browser_open reuse. The person's own Chrome and an
   * external provider's session are on neither machine. */
  const onCurrentPlacement = async <T extends { placement: z.infer<typeof InteractionPlacement> }>(
    listed: Promise<T[]>,
  ): Promise<T[]> => {
    const [sessions, current] = await Promise.all([
      listed,
      readCurrentInteractionPlacement(input.transport, input.workspaceId, input.sessionId),
    ]);
    return sessions.filter(
      (session) =>
        current === null ||
        (session.placement.kind !== "sandbox_group" &&
          session.placement.kind !== "connected_machine") ||
        placementFieldsMatch(session.placement, current),
    );
  };
  const currentTab = new CurrentBrowserTab({
    listLiveSessions: async () =>
      await onCurrentPlacement<
        Awaited<ReturnType<InteractionTransport["listBrowserSessions"]>>["sessions"][number]
      >(
        input.transport
          .listBrowserSessions(input.workspaceId, {
            associatedSessionId: input.sessionId,
            includeTerminal: false,
          })
          .then(({ sessions }) =>
            filterDiscoveredSessions(sessions, input.sessionId, "current_session", false),
          ),
      ),
    listTargets: async (browserSessionId) =>
      (await input.transport.listBrowserTargets(input.workspaceId, browserSessionId)).targets,
  });
  const currentComputer = new CurrentComputerWindow({
    latestLiveSession: async () =>
      newestRelevant(
        await onCurrentPlacement(
          input.transport
            .listComputerSessions(input.workspaceId, {
              associatedSessionId: input.sessionId,
              includeTerminal: false,
            })
            .then(({ sessions }) => sessions),
        ),
        input.sessionId,
      )?.id ?? null,
    currentTarget: async (computerSessionId, reading) => {
      try {
        const { targets } = await input.transport.listComputerTargets(
          input.workspaceId,
          computerSessionId,
        );
        const current = targets.find((target) => target.current);
        if (current || !reading) return current?.id ?? null;
        // A first read without a window starts where the person would look:
        // the focused window, or the only screen when no window is focused.
        const only = (found: typeof targets) => (found.length === 1 ? found[0]!.id : null);
        return (
          only(targets.filter((target) => target.kind === "window" && target.focused)) ??
          only(targets.filter((target) => target.kind === "screen"))
        );
      } catch (error) {
        // The computer itself is gone: resolve afresh next time.
        if (isGoneBrowserError(error)) currentComputer.forgetSession(computerSessionId);
        throw error;
      }
    },
  });
  /** Run one call on the requested or current computer and remember it on
   * success. */
  const onComputer = async <T>(
    computerSessionId: string | undefined,
    run: (computer: ResolvedComputerSession) => Promise<T>,
  ): Promise<T> => {
    const computer = await currentComputer.session(computerSessionId);
    try {
      const output = await run(computer);
      currentComputer.use(computer.computerSessionId);
      return output;
    } catch (error) {
      if (isGoneBrowserError(error)) currentComputer.failed(computer, goneComputerPart(error));
      throw error;
    }
  };
  /** Run one call on the requested or current window and remember, on
   * success, the window it leaves the agent in: the one it acted on, or the
   * one the action opened. A read may start in a window the agent has not
   * used yet. */
  const onComputerWindow = async <T>(
    value: { computerSessionId?: string | undefined; targetId?: string | undefined },
    run: (window: ResolvedComputerTarget) => Promise<T>,
    leftIn: (output: T) => string | null | undefined = () => null,
    reading = false,
  ): Promise<T> => {
    const window = await currentComputer.target(value, reading);
    try {
      const output = await run(window);
      currentComputer.use(window.computerSessionId, leftIn(output) ?? window.targetId);
      return output;
    } catch (error) {
      if (isGoneBrowserError(error)) currentComputer.failed(window, goneComputerPart(error));
      throw error;
    }
  };
  // Every call notes the event count when it starts. A browser resumed after
  // that, or whose resume no result had shown by then, has new tab IDs and
  // reloaded pages the call's caller had not seen when it chose the call.
  let browserEventCount = 0;
  const resumeFailures = new WeakSet<Error>();
  type ResumedTabs = z.infer<typeof BrowserTargetListResponse>;
  /** Resumes in flight, shared by concurrent calls on the same browser. */
  const resumesInFlight = new Map<string, Promise<ResumedTabs | null>>();
  /** Each browser's latest resume that may have reloaded its tabs, with the
   * restored tabs once they were read. */
  const lastResumes = new Map<
    string,
    { count: number; tabs: ResumedTabs | null; shownAt: number | null }
  >();
  /** This browser's resume that the caller of a call started at `startedAt`
   * has not seen, if any. */
  const unseenResume = (browserSessionId: string, startedAt: number) => {
    const resume = lastResumes.get(browserSessionId);
    return resume &&
      (resume.count > startedAt || resume.shownAt === null || resume.shownAt > startedAt)
      ? resume
      : null;
  };
  /** The tabs a resume restored, read again if the resume could not. */
  const restoredTabs = async (
    browserSessionId: string,
    resume: { tabs: ResumedTabs | null },
  ): Promise<ResumedTabs> =>
    resume.tabs ?? (await input.transport.listBrowserTargets(input.workspaceId, browserSessionId));
  /** A result about the browser's current tabs reached the caller. */
  const markResumeShown = (browserSessionId: string) => {
    const resume = lastResumes.get(browserSessionId);
    if (resume && resume.shownAt === null) resume.shownAt = ++browserEventCount;
  };
  /** Resume a browser the API refused to use because it is not running. A
   * browser suspended while idle (to make room for another one on its
   * machine) or lost to a restarted controller resumes from its saved working
   * copy, the way browser_open resumes it. Concurrent calls share one resume.
   * Returns the resumed browser's tabs, or null when the browser was not
   * paused, so the original error stands. */
  const resumePausedBrowser = async (
    browserSessionId: string,
    operationId: string,
    startedAt: number,
  ): Promise<ResumedTabs | null> => {
    const inFlight = resumesInFlight.get(browserSessionId);
    if (inFlight) return await inFlight;
    // The browser was resumed while this call ran, so its refusal came from
    // before that resume.
    const completed = lastResumes.get(browserSessionId);
    if (completed && completed.count > startedAt) {
      return await restoredTabs(browserSessionId, completed);
    }
    const count = ++browserEventCount;
    const resume = resumeBrowser(browserSessionId, operationId, count).catch((error: unknown) => {
      // A failed resume is the answer for every call waiting on it; none of
      // them retries it.
      if (error instanceof Error) resumeFailures.add(error);
      throw error;
    });
    resumesInFlight.set(browserSessionId, resume);
    try {
      return await resume;
    } finally {
      resumesInFlight.delete(browserSessionId);
    }
  };
  const resumeBrowser = async (
    browserSessionId: string,
    operationId: string,
    count: number,
  ): Promise<z.infer<typeof BrowserTargetListResponse> | null> => {
    let before: z.infer<typeof BrowserSession>;
    try {
      before = await input.transport.getBrowserSession(input.workspaceId, browserSessionId);
    } catch {
      // When even the browser's state can't be read, the original refusal stands.
      return null;
    }
    if (!isResumablePausedBrowser(before)) return null;
    const response = await input.transport.resumeBrowserSession(
      input.workspaceId,
      browserSessionId,
      { operationId: derivedOperationId("browser-tool-resume", operationId, browserSessionId) },
    );
    const resumed = { count, tabs: null as ResumedTabs | null, shownAt: null as number | null };
    if (response.operation.state !== "failed") {
      // From here the browser may have reloaded its tabs, even if what
      // follows fails. Earlier tab IDs are gone.
      lastResumes.set(browserSessionId, resumed);
      currentTab.use(browserSessionId, null);
    }
    const failure = response.operation.error;
    if (response.operation.state === "outcome_unknown") {
      throw new OpenGeniApiError(
        409,
        `BrowserSession ${browserSessionId} had stopped, and whether it resumed is unknown: ${failure?.message ?? "no answer"}. Check it with browser_open before retrying.`,
        { code: failure?.code ?? "outcome_unknown", retryable: false, outcomeUnknown: true },
      );
    }
    if (response.operation.state === "failed") {
      throw new OpenGeniApiError(
        409,
        `BrowserSession ${browserSessionId} had stopped and could not be resumed: ${failure?.message ?? response.operation.state}`,
        {
          code: failure?.code ?? "browser_resume_failed",
          retryable: failure?.retryable ?? false,
        },
      );
    }
    if (response.session.lifecycle !== "active") {
      throw new OpenGeniApiError(
        409,
        `BrowserSession ${browserSessionId} had stopped and is still resuming from its saved state; try again shortly.`,
        { code: "browser_resuming", retryable: true },
      );
    }
    resumed.tabs = await input.transport.listBrowserTargets(input.workspaceId, browserSessionId);
    // Later calls on the current tab use the restored selected tab, whether
    // or not this call goes on to succeed.
    currentTab.use(
      browserSessionId,
      resumed.tabs.targets.find((target) => target.selected)?.id ?? null,
    );
    return resumed.tabs;
  };
  /** After a resume, tab IDs are new and unsaved page state may be gone, so a
   * call aimed at an earlier tab does not run. Report the restored tabs and
   * the selected tab's outline, so the next call can act on them directly.
   * `completed` names a tab operation that had already run before the
   * browser stopped, so the caller does not repeat it. */
  const resumedBrowserError = async (
    tabs: z.infer<typeof BrowserTargetListResponse>,
    completed?: string,
  ): Promise<BrowserTargetResolutionError> => {
    const selectedTab = tabs.targets.find((target) => target.selected);
    const observation = selectedTab
      ? await input.transport
          .observeBrowserTarget(input.workspaceId, tabs.browserSessionId, selectedTab.id)
          .then((observed) => projectBrowserObservation(observed, "compact"))
          .catch(() => undefined)
      : undefined;
    markResumeShown(tabs.browserSessionId);
    return new BrowserTargetResolutionError(
      "browser_resumed",
      [
        completed
          ? `The tab ${completed} completed, then this browser stopped (it was idle while its machine needed room, or its controller restarted) and has been resumed from its saved state.`
          : "This browser had stopped (it was idle while its machine needed room, or its controller restarted) and has been resumed from its saved state.",
        completed
          ? "Its tabs reloaded with new targetIds and unsaved page input may be gone. Check the tabs below for the result before repeating it."
          : "Its tabs reloaded with new targetIds and unsaved page input may be gone, so this call did not run. Continue from the tabs below.",
        browserTabsText({
          ...agentTargetList(tabs),
          ...(observation ? { mutationObservation: observation } : {}),
        }),
      ].join("\n"),
    );
  };
  /** Run one call on the requested or current tab and remember it on success.
   * When the browser had stopped, it resumes. A read on the current tab then
   * runs again on the resumed browser's selected tab ("replay"); other calls
   * report the restored tabs instead ("report"), since they name a tab that no
   * longer exists or would act on a page the agent has not seen. A "report"
   * call never runs on a browser resumed after it started, or whose resume no
   * result had shown before it started. */
  const onTab = async <T>(
    value: { browserSessionId?: string | undefined; targetId?: string | undefined },
    context: { operationId: string },
    afterResume: "replay" | "report",
    run: (tab: ResolvedBrowserTarget) => Promise<T>,
  ): Promise<T> => {
    const startedAt = browserEventCount;
    let tab: ResolvedBrowserTarget | undefined;
    try {
      // Finding the current tab lists the browser's tabs, which also fails
      // while it is stopped.
      tab = await currentTab.target(value);
      if (afterResume === "report") {
        // A resume still in flight, or one no result had shown before this
        // call started, means the page it would act on reloaded unseen. A
        // failed resume fails this call too.
        await resumesInFlight.get(tab.browserSessionId);
        const unseen = unseenResume(tab.browserSessionId, startedAt);
        if (unseen) {
          throw await resumedBrowserError(await restoredTabs(tab.browserSessionId, unseen));
        }
      }
      const output = await run(tab);
      currentTab.use(tab.browserSessionId, tab.targetId);
      markResumeShown(tab.browserSessionId);
      return output;
    } catch (error) {
      if (tab && isGoneBrowserError(error)) currentTab.failed(tab);
      if (!isBrowserNotRunningError(error) || resumeFailures.has(error as Error)) throw error;
      const browser = tab ?? (await currentTab.session(value.browserSessionId));
      const resumed = await resumePausedBrowser(
        browser.browserSessionId,
        context.operationId,
        startedAt,
      );
      if (!resumed) throw error;
      const selectedTab = resumed.targets.find((target) => target.selected);
      if (afterResume === "report" || value.targetId !== undefined || !selectedTab) {
        throw await resumedBrowserError(resumed);
      }
      const replayed = { ...browser, targetId: selectedTab.id, implicitTarget: true };
      const output = await run(replayed);
      currentTab.use(replayed.browserSessionId, replayed.targetId);
      markResumeShown(replayed.browserSessionId);
      return output;
    }
  };
  /** Run one tab operation on the requested or current browser and remember
   * it on success, resuming a browser that had stopped as onTab does. Listing
   * a tab, or opening one the browser refused to open, then runs again; select
   * and close name a tab from before the resume, whose ID no longer exists. */
  const onBrowser = async <T>(
    value: { browserSessionId?: string | undefined; operation: string },
    context: { operationId: string },
    run: (browser: ResolvedBrowserSession, progress: { changed: boolean }) => Promise<T>,
  ): Promise<T> => {
    const startedAt = browserEventCount;
    const browser = await currentTab.session(value.browserSessionId);
    // Set once the operation has changed the browser, so it never runs twice.
    const progress = { changed: false };
    try {
      const output = await run(browser, progress);
      currentTab.use(browser.browserSessionId);
      markResumeShown(browser.browserSessionId);
      return output;
    } catch (error) {
      if (isGoneBrowserError(error)) currentTab.failed(browser);
      if (!isBrowserNotRunningError(error)) throw error;
      const resumed = await resumePausedBrowser(
        browser.browserSessionId,
        context.operationId,
        startedAt,
      );
      if (!resumed) throw error;
      if (progress.changed) throw await resumedBrowserError(resumed, value.operation);
      if (value.operation !== "list" && value.operation !== "open") {
        throw await resumedBrowserError(resumed);
      }
      const output = await run(browser, progress);
      currentTab.use(browser.browserSessionId);
      markResumeShown(browser.browserSessionId);
      return output;
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
     * stays in structuredContent; without this the text is that value as JSON.
     * `context.caller` says whether the model or a Code Mode program reads it. */
    modelText?: (output: z.output<TOutput>, context: AttemptToolExecutionContext) => string;
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
          async (value, executionContext) => {
            try {
              return await options.execute(value, executionContext);
            } catch (error) {
              throw await withUserSetupCard(error, options.name, input.postSetupCard);
            }
          },
          options.readOnly,
          options.modelText,
        ),
    });
  };

  add({
    name: "interaction_discover",
    codemodePath: ["interaction", "discover"],
    title: "Discover browsers and computers",
    description: `Discover browsers and computers. To use the user's existing/current/personal Chrome, call browser_open with placement={kind:'attached_device'} directly; use scope=attached_browsers only to pick a specific Chrome profile. If none is connected, browser_open shows the person the setup card. That scope reads only Chrome profiles and extension bridges, avoiding unrelated sessions and saved identities. The default current_session scope lists this agent session's BrowserSessions and ComputerSessions. Use scope=workspace only for reusable identities or peer/child resources; that inventory can be large. An attachedBrowserBridge only means the machine is ready for the extension; only attachedBrowsers are real user Chrome profiles/tabs. Leave includeTerminal=false unless ended history is specifically required.`,
    input: DiscoveryInput,
    output: DiscoveryOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      const scope = value.scope ?? "current_session";
      if (scope === "attached_browsers") {
        const [attached, thisMachine] = await Promise.all([
          input.transport.listAttachedBrowsers(input.workspaceId, {
            includeDisconnected: value.includeDisconnectedDevices ?? false,
          }),
          readCurrentMachineSandboxId(input.transport, input.workspaceId, input.sessionId),
        ]);
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
          ...agentAttachedInventory(attached, thisMachine),
        };
      }
      // Narrow in SQL: a workspace can retain thousands of ended sessions, and
      // current_session discovery only ever returns this session's own.
      const listFilter = {
        ...(scope === "current_session" ? { associatedSessionId: input.sessionId } : {}),
        ...((value.includeTerminal ?? false) ? {} : { includeTerminal: false }),
      };
      const [browsers, computers, identities, attached, thisMachine] = await Promise.all([
        input.transport.listBrowserSessions(input.workspaceId, listFilter),
        input.transport.listComputerSessions(input.workspaceId, listFilter),
        input.transport.listBrowserIdentities(input.workspaceId, {
          includeArchived: value.includeArchivedIdentities ?? false,
        }),
        input.transport.listAttachedBrowsers(input.workspaceId, {
          includeDisconnected: value.includeDisconnectedDevices ?? false,
        }),
        scope === "workspace"
          ? readCurrentMachineSandboxId(input.transport, input.workspaceId, input.sessionId)
          : null,
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
          ? agentAttachedInventory(attached, thisMachine)
          : { attachedBrowserBridges: [], attachedBrowsers: [] }),
      };
    },
  });

  add({
    name: "browser_open",
    codemodePath: ["interaction", "browser", "open"],
    title: "Open or reuse browser",
    description: `Open a managed BrowserSession on the current agent placement, reuse a relevant compatible live session by default, attach to an explicit workspace BrowserSession, or open the user's own Chrome with placement={kind:'attached_device'}. Use that directly for requests about 'my browser', 'my tabs', or current Chrome: it opens the only Chrome profile connected through the ${extension.name} extension, or else the most recently active one (reported as attachedProfile, the rest as otherAttachedProfiles). Add deviceId (from interaction_discover scope=attached_browsers or otherAttachedProfiles) only when the user wants a different profile. Omitting placement never uses the user's Chrome. If no profile is connected, do not fall back to a blank managed browser. BrowserSessions persist across tool calls; shell-launched browser daemons do not survive remote-command cleanup. Never switch to the user's attached Chrome as a fallback for a failed managed browser unless the user requested that profile. A new attached session opens a dedicated tab. Managed Chromium defaults to headed so OAuth and later human interaction use a supported browser; request headless=true only for agent-only work that will not require sign-in or human control. Operator-enabled disposable sandbox verification may explicitly request storageMode=ephemeral_context with headless=true: no saved identity, route, Computer, checkpoint or resume; process loss ends the session. Default private_profile storage is unchanged. Returns the session, its tabs and an outline of the opened (or selected) tab when one is available, in the browser_observe format. With initialUrl, only the opened tab is listed and the others are counted (browser_tabs list shows them). Act on the outline's elements directly instead of observing again. Set includeScreenshot=true to also get a still image of the opened tab in the same call when its visual state matters. Call it first for any browser task; browser_observe, browser_act, browser_screenshot and browser_tabs then work on the session it returns. For repetitive or bulk work, such as screenshots of many pages or widths, script these same browsers with Code Mode instead of installing another browser automation library: openGeni.browsers.open({initialUrl}), tab.navigate(url, {waitUntil:'network_idle'}), tab.act({type:'viewport',width,height}) and tab.screenshot({saveTo}), or from the shell client, call interaction.browser.screenshot with --save-image <path>. Solve CAPTCHAs and other verification challenges yourself, retrying and trying alternatives as needed; never hand them to the user.`,
    input: BrowserOpenInput,
    output: BrowserOpenOutput,
    readOnly: false,
    idempotent: true,
    modelText: (output, context) => {
      rememberBrowserReading(context, output.observation);
      return browserOpenText(output);
    },
    execute: async (value, context) => {
      const opened = await openBrowser(
        input.transport,
        input.workspaceId,
        input.sessionId,
        value,
        context,
        extension.installUrl,
      );
      const openedTargetId =
        opened.observation?.target.id ??
        opened.targets.find((target) => target.selected)?.id ??
        null;
      currentTab.use(opened.session.id, openedTargetId);
      if (!value.includeScreenshot) return opened;
      // The browser is already open. A failed capture must not turn its result
      // into an error the model could answer by opening another browser.
      if (!openedTargetId)
        return new InteractionExecutionResult(opened, [
          {
            type: "text" as const,
            text: "The browser opened, but it has no tab to capture a screenshot of.",
          },
        ]);
      try {
        const frame = await input.transport.captureBrowserTarget(
          input.workspaceId,
          opened.session.id,
          openedTargetId,
        );
        return new InteractionExecutionResult(opened, [
          browserToolImageContent(frame.data, frame.mediaType),
        ]);
      } catch (error) {
        return new InteractionExecutionResult(opened, [
          {
            type: "text" as const,
            text: `The browser opened, but its screenshot could not be captured: ${screenshotFailureReason(error)}`,
          },
        ]);
      }
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
    modelText: (output, context) => {
      rememberBrowserReading(context, output.mutationObservation);
      return browserTabsText(output);
    },
    execute: async (value, context) =>
      await onBrowser(value, context, async ({ browserSessionId }, progress) => {
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
        if (mutationObservation) progress.changed = true;
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
    modelText: (output, context) => {
      if ("agentView" in output) rememberBrowserReading(context, output);
      // A complete view lists more than the model's last outline holds.
      else if (context.caller.kind === "model") browserSeen.delete(output.target.id);
      return agentObservationText(output);
    },
    execute: async (value, context) =>
      await onTab(value, context, "replay", async ({ browserSessionId, targetId }) => {
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
        // A tab cannot be captured while a JavaScript dialog is open; the
        // observation names the dialog.
        if (captured.status === "rejected" && observed.value.dialog)
          return new InteractionExecutionResult(
            projectBrowserObservation(observed.value, value.view ?? "compact"),
            [{ type: "text" as const, text: BROWSER_DIALOG_NO_SCREENSHOT }],
          );
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
      "Search, count, or read a subtree from one tab's accessibility snapshot; filter by ref, role, name, accessibility text, state, or action, and scopeRef. AX mode refreshes the full tree internally and cannot return DOM attributes. Use mode=dom with a ref, CSS, test-id, or placeholder locator for bounded element text, a long field value, or allowlisted attributes, or a CSS selector for count. Content-matching role/label/text locators and CSS attribute/pseudo selectors are rejected for DOM reads to prevent secret-value probing. DOM reads use exact causal fences and only fixed, read-only browser-side projection; callers cannot supply JavaScript. Ref DOM locators refresh accessibility; CSS/test-id/placeholder locators avoid that scan.",
    input: BrowserReadInput,
    output: BrowserReadToolOutput,
    readOnly: true,
    idempotent: true,
    modelText: (output) =>
      output.source === "accessibility" ? browserReadText(output) : JSON.stringify(output),
    execute: async (value, context) =>
      await onTab(value, context, "replay", async ({ browserSessionId, targetId }) => {
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
      "Capture a current browser tab screenshot without reading its accessibility tree. The image is returned as tool image content, with small structured frame metadata. Set fullPage=true to capture the whole scrollable page when supported; large pages may take longer or exceed capture bounds. Set quality lower to reduce JPEG bytes if a large capture exceeds the Code Mode image limit. In Code Mode, tab.screenshot({saveTo}) or the shell client's --save-image <path> writes the image to a file, and Code Mode output names image files instead of carrying their pixels.",
    input: BrowserScreenshotInput,
    output: BrowserScreenshotOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value, context) =>
      await onTab(value, context, "replay", async ({ browserSessionId, targetId }) => {
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
      "Perform one semantic-first browser action or bounded batch. Prefer action={type:'batch',actions:[...],fenceEachAction:true} for predictable edits in the same observed document, such as filling known form fields before one authorized submit. Pause for new page state, a dialog, or a decision instead of batching steps that depend on an unseen result. Role, label, text, placeholder, test id and CSS locators wait up to 10 s for their element to appear, and input actions wait while it is disabled, so a known sequence across page changes (open a record, open its edit form, fill it, save) can run as one batch without fenceEachAction; use those locators there, because a ref only names an element you have already seen. When a procedure repeats for many records, do the first step by step, then run each remaining record as one such batch, or loop over them in Code Mode. Reuse a page observation, when present, from browser_open, tab open/select or a prior action; observe only when none is present or it lacks needed content. Observe again after page changes or when needed content was omitted. If an action reports outcome_unknown, inspect the outcome and do not replay the batch. Use navigate with waitUntil ('load' or 'network_idle') to wait for the page before acting or capturing it. Use viewport to set page width and height (mobile:true adds mobile layout and touch emulation), then check the measured viewport in the returned observation; emulation does not prove physical mobile-browser behavior. Use history back/forward for tab navigation; keypress shortcuts are page input and may not navigate browser history. A press key is one character or a key name (Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, F1-F24), optionally prefixed by Ctrl+, Alt+, Shift+, Meta+ or Mod+. The explicit activate action foregrounds the target in the user's desktop browser; use only when that is intended. Permission actions set a managed browser's web permission for this tab's exact current top-level origin. The default receipt includes the page outline after the action, in the browser_observe format; after your first reading of a page it lists only the elements that changed since your last reading of it, and the refs you hold stay valid. Set view=full for every element, or view=none when no post-action outline is needed; browser_observe always returns the whole outline. Set includeScreenshot=true to also get a still image of the tab after the action, in the same call, when the page's visual state matters. An upload action takes paths of files in this session's workspace, or workspace File IDs such as a sandbox_file_publish artifactId. Text in fill, type and clipboard write may contain {{secret:…}} references; the value (or the current TOTP code for /otp) is typed at dispatch and never shown to you. Use type with mode:'keys' for split one-time-code boxes or inputs that ignore pasted text.",
    input: BrowserActInput,
    modelInputSchema: browserActModelInputSchema,
    output: BrowserAgentActionReceipt,
    readOnly: false,
    idempotent: true,
    modelText: (receipt, context) => {
      if (context.caller.kind !== "model") return agentActionText(receipt);
      if ("protocolVersion" in receipt) {
        browserSeen.delete(receipt.targetId);
        return agentActionText(receipt);
      }
      const observation = receipt.observation;
      if (!observation) return agentActionText(receipt);
      const base = browserSeen.get(observation.target.id);
      rememberBrowserReading(context, observation);
      const shown = base ? browserObservationDiff(base, observation) : null;
      return browserActionText(shown ? { ...receipt, observation: shown } : receipt);
    },
    // An action never runs on a page that reloaded since the agent saw it.
    execute: async (value, context) =>
      await onTab(value, context, "report", async ({ browserSessionId, targetId }) => {
        const action = await toDispatchedBrowserAction(value.action, (path) =>
          publishUploadPath(context.operationId, path),
        );
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
          action,
        });
        const projected = value.view === "full" ? receipt : compactActionReceipt(receipt);
        if (!value.includeScreenshot) return projected;
        // A tab cannot be captured while a JavaScript dialog is open; the
        // receipt already names the dialog.
        if (receipt.observation?.dialog)
          return new InteractionExecutionResult(projected, [
            { type: "text" as const, text: BROWSER_DIALOG_NO_SCREENSHOT },
          ]);
        // The action has already run. A failed capture must not turn its
        // receipt into an error the model could answer by replaying the action.
        try {
          const frame = await input.transport.captureBrowserTarget(
            input.workspaceId,
            browserSessionId,
            targetId,
          );
          return new InteractionExecutionResult(projected, [
            browserToolImageContent(frame.data, frame.mediaType),
          ]);
        } catch (error) {
          return new InteractionExecutionResult(projected, [
            {
              type: "text" as const,
              text: `The action ran, but its screenshot could not be captured: ${screenshotFailureReason(error)}`,
            },
          ]);
        }
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
    // Diagnostics belong to the tab from before a resume, which is gone.
    execute: async (value, context) =>
      await onTab(
        value,
        context,
        "report",
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
      "List browser-produced files or get one exact download by id. Metadata identifies completed bytes and their SHA-256; diagnostics alone do not expose a download id or file bytes. Use browser_download_save to materialize a completed download in its source session's workspace. In attached Chrome the person's own file also stays in their downloads folder. Lightpanda has no downloads.",
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
      // Downloads kept from before a suspension keep the controller generation
      // that fetched them, so only the browser binding must match.
      if (
        response.browserSessionId !== value.browserSessionId ||
        response.downloads.some((download) => download.browserSessionId !== value.browserSessionId)
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
      "Save one exact completed browser download to a portable relative path in the browser's source session workspace. Missing folders on that path are created. Requires sessions:control and files:upload. Returns the materialized destinationPath, fileId and integrity metadata; read the saved bytes with ordinary workspace file tools. Existing files are protected unless overwrite=true. The attempt operation id fences retries; uncertain outcomes must reconcile that same operation.",
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
    name: "browser_record",
    codemodePath: ["interaction", "browser", "record"],
    title: "Record browser video",
    description:
      "Record a browser flow as a video, for proof of work or a demo. operation=start records the tab and follows the tabs you act on, open or select; frames are captured only when the page changes, so waiting costs nothing. Work normally, then operation=stop with the returned recordingId. Stop saves an MP4 in the workspace (default recordings/browser-<time>.mp4) with a .actions.json log beside it giving the time of each action, and returns the video's artifactId: show it with ![what it shows](artifact:<artifactId>). For edits such as cutting idle parts, speeding up, captions or narration, use ffmpeg (or install another tool), take timings from the action log, then publish the result with sandbox_file_publish. One recording per browser at a time, up to 30 minutes. Requires sessions:control and files:upload.",
    input: BrowserRecordInput,
    output: z.union([BrowserRecordingSummary, BrowserRecordingSaveResponse]),
    readOnly: false,
    idempotent: false,
    execute: async (value, context) => {
      const { startBrowserRecording, saveBrowserRecording } = input.transport;
      if (!startBrowserRecording || !saveBrowserRecording) {
        throw new Error("browser recording is unavailable here");
      }
      if (value.operation === "start") {
        return await onTab(
          value,
          context,
          "report",
          async ({ browserSessionId, targetId }) =>
            await startBrowserRecording.call(
              input.transport,
              input.workspaceId,
              browserSessionId,
              targetId,
            ),
        );
      }
      const browser = await currentTab.session(value.browserSessionId);
      const response = await saveBrowserRecording.call(
        input.transport,
        input.workspaceId,
        browser.browserSessionId,
        value.recordingId!,
        {
          operationId: context.operationId,
          ...(value.destinationPath ? { destinationPath: value.destinationPath } : {}),
        },
      );
      if (response.recording.recordingId !== value.recordingId) {
        throw new Error("Browser recording save returned another recording");
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
      "Open a ComputerSession on the current agent placement, reuse a relevant live session by default, or attach to an explicit workspace ComputerSession. To use another machine's screen, sandbox_swap to it first. Returns exact apps/windows/screens. Call it first for any computer task; computer_observe and computer_act then work on the session it returns. Read and operate other apps through them rather than scripting them with osascript, which makes macOS ask the person for permission and hangs the command. Solve CAPTCHAs and other verification challenges yourself, retrying and trying alternatives as needed; never hand them to the user.",
    input: ComputerOpenInput,
    output: ComputerOpenOutput,
    readOnly: false,
    idempotent: true,
    modelText: computerOpenText,
    execute: async (value, context) => {
      const opened = await openComputer(
        input.transport,
        input.workspaceId,
        input.sessionId,
        value,
        context,
      );
      currentComputer.use(opened.session.id);
      return opened;
    },
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
      await onComputer(
        value.computerSessionId,
        async ({ computerSessionId }) =>
          await input.transport.listComputerTargets(input.workspaceId, computerSessionId),
      ),
  });

  add({
    name: "computer_observe",
    codemodePath: ["interaction", "computer", "observe"],
    title: "Observe app or window",
    description:
      "Read one ComputerSession app/window/screen target, causal generation, semantic accessibility tree, focus, frame identity, and a bounded current screenshot without taking control. capturedFrame gives the screenshot's exact pixel dimensions; use those pixels for pointer coordinates, not the target's native bounds or an image-preview size. An app target may return only its accessibility tree; observe one of its windows or the screen for pixels.",
    input: ComputerObserveInput,
    output: ComputerObserveOutput,
    readOnly: true,
    idempotent: true,
    modelText: (output, context) => {
      if (context.caller.kind === "model") rememberComputerReading(output);
      return output.capturedFrame
        ? computerObservationText(output)
        : `${computerObservationText(output)}\nNo screenshot of an app target; observe one of its windows or the screen for pixels.`;
    },
    execute: async (requested) =>
      await onComputerWindow(
        requested,
        async (value) => {
          // The tree and the pixels are independent reads of the same target;
          // a generation mismatch below re-reads the tree once. An app target
          // spans several windows, so most adapters cannot photograph it; its
          // tree is then the whole observation instead of a failed read.
          const capture = input.transport
            .captureComputerTarget(input.workspaceId, value.computerSessionId, value.targetId)
            .then(
              (frame) => ({ frame, error: null as unknown }),
              (error: unknown) => ({ frame: null, error }),
            );
          let observation = await input.transport.observeComputerTarget(
            input.workspaceId,
            value.computerSessionId,
            value.targetId,
          );
          const { frame, error } = await capture;
          if (frame === null) {
            if (observation.target.kind === "app") return observation;
            throw error;
          }
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
          const image = await compactComputerImage(frame.data, frame.mediaType);
          return new InteractionExecutionResult(
            {
              ...observation,
              frameId: frame.frameId,
              capturedFrame: { width: frame.width, height: frame.height },
            },
            [
              {
                type: "image",
                data: Buffer.from(image.data).toString("base64"),
                mimeType: image.mimeType,
              },
            ],
          );
        },
        () => null,
        true,
      ),
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
      await onComputer(
        value.computerSessionId,
        async ({ computerSessionId }) =>
          await input.transport.readComputerClipboard(input.workspaceId, computerSessionId),
      ),
  });

  add({
    name: "computer_act",
    codemodePath: ["interaction", "computer", "act"],
    title: "Act in app or window",
    description:
      "Perform one action in an exact ComputerSession target. Prefer semantic actions from computer_observe: on macOS they can invoke controls and set values without foregrounding the app. Pointer, keyboard, target focus, screen actions, and clipboard paste use the physical graphical seat and may change the user's foreground app; use them only when foreground control is explicitly intended. For pointer actions, set action.frameId from the observed frame and use coordinates in the returned screenshot's pixels; do not scale them to target.bounds. A pixel frame fence applies only to pointer actions; semantic actions use the observation fence even if a frame ID is supplied. Supplying the target generation and relevant action fence preserves the exact observation without refreshing it. Omit fences to use a fresh observation automatically. Keyboard type, set_value and clipboard write text may contain {{secret:…}} references, typed at dispatch and never shown to you. When you already know several steps in the same target, such as pressing a run of buttons or filling known fields, send them in one call with action={type:'batch',actions:[...]} (semantic and keyboard actions): they run in order, stop at the first failure, and return the target's state after the last one. A later action may name, by role and name instead of ref (\"button:Save\"), an element that an earlier one brings up, such as the next page or a form that is still loading; on macOS and in Linux sandboxes it waits up to 10 seconds for it to appear and enable. set_value true or false on a checkbox or switch leaves it in that state and presses it only when needed, so a batch can set one without reading it first. So when you repeat a procedure for many records, do each record in one batch; once one record has worked, you can instead loop over the rest in one Code Mode program that sends the same batches with interaction.computer.act and stops at the first one that does not complete. Pause for new state only when the next step depends on what you will see. Returns the durable causal receipt.",
    input: ComputerActInput,
    output: ComputerActOutput,
    readOnly: false,
    idempotent: true,
    modelInputSchema: computerActModelInputSchema,
    modelText: (receipt, context) => {
      const observation = receipt.observation;
      if (!observation || context.caller.kind !== "model") return computerActionText(receipt);
      const base = computerSeen.get(seenComputerKey(observation));
      rememberComputerReading(observation);
      const shown = base ? computerObservationDiff(base, observation) : null;
      return computerActionText(shown ? { ...receipt, observation: shown } : receipt);
    },
    execute: async (requested, context) =>
      await onComputerWindow(
        requested,
        async (window) => {
          const value: ResolvedComputerActInput = {
            ...requested,
            computerSessionId: window.computerSessionId,
            targetId: window.targetId,
          };
          const action = value.action;
          if (action.type === "batch") {
            return await actInComputerBatch(
              input.transport,
              input.workspaceId,
              value,
              action.actions,
              context.operationId,
              () => supportsActionBatches(value.computerSessionId),
            );
          }
          // A launch acts on no window's contents, and an action that names the
          // observation it was read from has its content fence already: both need
          // only the target's generation, which the target list gives without
          // reading the window again (a fresh read would retire the refs the
          // caller holds). A target missing from the list is read below, which
          // explains why.
          const listedGeneration =
            action.type !== "launch" &&
            (action.type === "pointer" || value.expectedObservationId == null)
              ? undefined
              : (value.expectedTargetGeneration ??
                (
                  await input.transport.listComputerTargets(
                    input.workspaceId,
                    value.computerSessionId,
                  )
                ).targets.find((target) => target.id === value.targetId)?.targetGeneration);
          if (listedGeneration !== undefined) {
            return await input.transport.actInComputer(input.workspaceId, value.computerSessionId, {
              operationId: context.operationId,
              targetId: value.targetId,
              expectedTargetGeneration: listedGeneration,
              expectedObservationId: value.expectedObservationId ?? null,
              expectedFrameId: null,
              action,
            });
          }
          const current =
            value.expectedTargetGeneration !== undefined &&
            (action.type === "pointer"
              ? (value.expectedFrameId ?? action.frameId) != null
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
              action.type === "pointer"
                ? value.expectedFrameId === undefined
                  ? action.frameId
                  : value.expectedFrameId
                : null,
            action,
          });
        },
        // The window an action opened, when the receipt says so: a batch
        // says it only when its last action completed.
        (receipt) =>
          "steps" in receipt && receipt.steps.at(-1)?.state !== "completed"
            ? null
            : receipt.observation?.target.id,
      ),
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
    execute: async (value, context) => {
      const ended = await input.transport.endComputerSession(
        input.workspaceId,
        value.computerSessionId,
        { operationId: context.operationId },
      );
      currentComputer.forgetSession(value.computerSessionId);
      return ended;
    },
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
            description:
              "CUA ComputerSession from computer_open. Omit to use the computer you used last.",
          };
          return {
            ...variantInputSchema,
            properties,
            required: ((variantInputSchema.required as string[] | undefined) ?? []).filter(
              (name) => name !== "session",
            ),
          };
        }),
      );
      const outputSchema = variants.every((variant) => variant.outputSchema)
        ? nativeCuaSchema(variants.map((variant) => variant.outputSchema!))
        : undefined;
      definitions.push({
        identity: { serverId: "interaction", toolName: "cua_" + tool.name },
        modelName: "interaction__cua_" + tool.name,
        codemodePath: ["interaction", "cua", tool.name],
        title: tool.name,
        description:
          "Native CUA computer tool; requires a CUA-backed computer_open session. Other CUA tools it names are interaction__cua_<name> (in Code Mode interaction.cua.<name>); steps inside run_steps keep the plain name. " +
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
          let computer: ResolvedComputerSession;
          try {
            computer = await currentComputer.session(
              z.string().uuid().optional().parse(computerSessionId),
            );
          } catch (error) {
            if (error instanceof ComputerTargetResolutionError) {
              return interactionErrorResult(error.code, error.message);
            }
            throw error;
          }
          const id = computer.computerSessionId;
          let response: unknown;
          try {
            response = await input.transport.callNativeComputerTool!(input.workspaceId, id, {
              operationId: context.operationId,
              tool: tool.name,
              arguments: args,
            });
            currentComputer.use(id);
          } catch (error) {
            if (isGoneBrowserError(error))
              currentComputer.failed(computer, goneComputerPart(error));
            // The API refused the call before dispatching it (a retired or
            // ended ComputerSession, a missing permission, invalid
            // arguments): a definite failure the model can act on, not an
            // operation of unknown outcome or a failure worth retrying.
            const refused = refusedNativeCallResult(error);
            if (refused) return refused;
            throw error;
          }
          const receipt = boundComputerNativeReceipt(ComputerNativeReceipt.parse(response));
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
          result.content = await compactComputerImageContent(result.content);
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
 * level, unless they differ only in their nested properties (a step field one
 * platform lacks), which merge the same way. Only properties every platform
 * requires stay required. The session's CUA worker still validates arguments
 * against its own exact platform schema.
 */
export function nativeCuaSchema(variants: Record<string, unknown>[]): AttemptToolJsonSchema {
  const unique = [...new Map(variants.map((schema) => [JSON.stringify(schema), schema])).values()];
  if (unique.length === 1) return unique[0] as AttemptToolJsonSchema;
  const { properties, required } = mergedProperties(unique);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(unique.every((schema) => schema.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  } as AttemptToolJsonSchema;
}

/** The union of the schemas' properties; required only where all require it. */
function mergedProperties(schemas: Record<string, unknown>[]): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const names = [...new Set(schemas.flatMap((schema) => Object.keys(objectProperties(schema))))];
  for (const name of names)
    properties[name] = mergedProperty(
      schemas
        .map((schema) => objectProperties(schema)[name])
        .filter((value): value is Record<string, unknown> => isJsonObject(value)),
    );
  const required = names.filter((name) =>
    schemas.every((schema) =>
      Array.isArray(schema.required) ? schema.required.includes(name) : false,
    ),
  );
  return { properties, required };
}

function mergedProperty(alternatives: Record<string, unknown>[]): Record<string, unknown> {
  // The first platform's wording wins for constraint-identical schemas.
  const distinct = new Map<string, Record<string, unknown>>();
  for (const schema of alternatives) {
    const key = JSON.stringify(withoutWording(schema));
    if (!distinct.has(key)) distinct.set(key, schema);
  }
  const options = [...distinct.values()];
  if (options.length === 1) return options[0]!;
  return mergedShape(options) ?? { anyOf: options };
}

const NESTED_KEYS = new Set(["properties", "required", "items"]);

/**
 * One schema for alternatives that agree on everything but their nested
 * properties or items, or undefined when they differ anywhere else.
 */
function mergedShape(options: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const shell = (schema: Record<string, unknown>) =>
    JSON.stringify(
      withoutWording(
        Object.fromEntries(Object.entries(schema).filter(([key]) => !NESTED_KEYS.has(key))),
      ),
    );
  const first = options[0]!;
  if (options.some((schema) => shell(schema) !== shell(first))) return undefined;
  const merged: Record<string, unknown> = { ...first };
  if (options.some((schema) => "items" in schema)) {
    const items = options.map((schema) => schema.items);
    if (!items.every(isJsonObject)) return undefined;
    merged.items = mergedProperty(items);
  }
  if (options.some((schema) => "properties" in schema || "required" in schema)) {
    if (!options.every((schema) => isJsonObject(schema.properties))) return undefined;
    const { properties, required } = mergedProperties(options);
    merged.properties = properties;
    if (required.length > 0) merged.required = required;
    else delete merged.required;
  }
  return merged;
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
    browserExtension: {
      name: input.settings.browserExtensionName,
      installUrl: input.settings.browserExtensionInstallUrl ?? OPENGENI_BROWSER_EXTENSION_URL,
    },
    selectedTools,
    permissions,
    ...(input.interventionResume ? { interventionResume: input.interventionResume } : {}),
    ...(input.postSetupCard ? { postSetupCard: input.postSetupCard } : {}),
  });
}

/** Failures the browser resume route can continue from the browser's own
 * working copy (an expired resume, or a suspension that found its controller
 * restarted). Every other lost browser stays as it is. */
const RESUMABLE_LOST_BROWSER_FAILURES: ReadonlySet<string> = new Set([
  "controller_resource_missing",
  "controller_transition_expired",
]);

/** A browser that is not running but continues from its saved working copy
 * when resumed: suspended, or lost to a restarted controller. */
function isResumablePausedBrowser(session: z.infer<typeof BrowserSession>): boolean {
  return (
    session.lifecycle === "suspended" ||
    // A browser lost to a restarted controller continues from its preserved
    // working copy. The resume refuses, and says why, when it cannot.
    (session.lifecycle === "lost" && RESUMABLE_LOST_BROWSER_FAILURES.has(session.failureCode ?? ""))
  );
}

/** A stable operation ID for a step a tool call takes on its own behalf, so a
 * retried call repeats the same step instead of starting another. */
function derivedOperationId(purpose: string, operationId: string, subject: string): string {
  const bytes = createHash("sha256")
    .update(`opengeni:${purpose}:v1\n${operationId}\n${subject}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Run a computer_act batch. A computer that supports it runs the batch as one
 * operation (see actInComputerNativeBatch). Otherwise each action is its own
 * durable operation, fenced by the observation the action before it
 * returned, so it acts on the state that action left, and the batch stops at
 * the first action that does not complete. A retried call derives the same
 * operation IDs; an action that already ran under its ID returns its
 * recorded receipt, whatever fence it ran with. One action at a time, a
 * step's recorded receipt is read before a fresh fence, so a retry reuses
 * what already ran even when the window is gone.
 */
async function actInComputerBatch(
  transport: InteractionTransport,
  workspaceId: string,
  value: ResolvedComputerActInput,
  actions: ComputerAction[],
  operationId: string,
  /** Whether the computer runs the whole batch as one operation. */
  runsNatively: () => Promise<boolean> = async () => false,
): Promise<z.output<typeof ComputerActionBatchReceipt>> {
  type Observation = z.output<typeof ComputerObservation>;
  type Receipt = z.output<typeof ComputerActionReceipt>;
  const observe = async (): Promise<Observation> =>
    await transport.observeComputerTarget(workspaceId, value.computerSessionId, value.targetId);
  // A recorded receipt, "absent" when nothing ran under the ID, or "unknown"
  // when the lookup itself failed.
  const recorded = async (stepOperationId: string): Promise<Receipt | "absent" | "unknown"> => {
    try {
      return await transport.getComputerActionReceipt(
        workspaceId,
        value.computerSessionId,
        stepOperationId,
      );
    } catch (error) {
      return error instanceof OpenGeniApiError && error.status === 404 ? "absent" : "unknown";
    }
  };
  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // The two ways derive different operation IDs. The computer fixes its
  // answer for the session's life, so every try of one batch picks the same
  // way and cannot send its actions under both ways' IDs. Run as one
  // operation, a retry sends the same ID and the computer's journal answers
  // it, so nothing is read first.
  if (await runsNatively())
    return await actInComputerNativeBatch(transport, workspaceId, value, actions, {
      operationId: derivedOperationId("computer-batch", operationId, "all"),
      observe,
      recorded,
    });
  const firstStepPrior = await recorded(derivedOperationId("computer-batch", operationId, "0"));
  let generation = value.expectedTargetGeneration;
  let observationId = value.expectedObservationId;
  let observation: Observation | null = null;
  let observedAfterLastAction = true;
  const steps: z.output<typeof ComputerActionBatchReceipt>["steps"] = [];
  const roleStandIns: NonNullable<z.output<typeof ComputerActionBatchReceipt>["roleStandIns"]> = [];
  for (const [index, action] of actions.entries()) {
    const stepOperationId = derivedOperationId("computer-batch", operationId, String(index));
    let receipt: Receipt | null = null;
    if (index === 0 && typeof firstStepPrior === "object") {
      receipt = firstStepPrior;
    } else if (generation === undefined || observationId == null) {
      // Read the recorded receipt first: a fresh read replaces the latest
      // observation, which would make a recovered receipt's fence stale.
      const prior = index === 0 ? firstStepPrior : await recorded(stepOperationId);
      if (typeof prior === "object") {
        receipt = prior;
      } else {
        let current: Observation;
        try {
          current = await observe();
        } catch (error) {
          // The first action failing is the call failing. Later, the actions
          // before this one did run and must still be reported.
          if (index === 0) throw error;
          steps.push(
            prior === "absent"
              ? {
                  operationId: stepOperationId,
                  state: "failed",
                  error: {
                    code: "resource_unavailable",
                    message:
                      `the window could not be read before this action, so it was not sent: ${reasonOf(error)}`.slice(
                        0,
                        8_192,
                      ),
                    retryable: true,
                  },
                }
              : {
                  operationId: stepOperationId,
                  state: "outcome_unknown",
                  error: {
                    code: "outcome_unknown",
                    message:
                      `this call did not send this action because the window could not be read, and whether an earlier try of this batch sent it could not be read either: ${reasonOf(error)}`.slice(
                        0,
                        8_192,
                      ),
                    retryable: false,
                  },
                },
          );
          observedAfterLastAction = false;
          break;
        }
        generation ??= current.target.targetGeneration;
        observationId ??= current.observationId;
        observation = current;
      }
    }
    if (!receipt) {
      try {
        // Without a recorded receipt, the fences were read above.
        receipt = await transport.actInComputer(workspaceId, value.computerSessionId, {
          operationId: stepOperationId,
          targetId: value.targetId,
          expectedTargetGeneration: generation!,
          expectedObservationId: observationId!,
          expectedFrameId: null,
          action,
        });
      } catch (error) {
        // A retried batch reaches an action that already ran with the fence
        // of its first run, or the reply to this request was lost: the
        // recorded receipt says what happened.
        const prior = await recorded(stepOperationId);
        if (typeof prior !== "object") {
          if (index === 0) throw error;
          steps.push({
            operationId: stepOperationId,
            state: "outcome_unknown",
            error: {
              code: "outcome_unknown",
              message: `the request for this action failed: ${reasonOf(error)}`.slice(0, 8_192),
              retryable: false,
            },
          });
          observedAfterLastAction = false;
          break;
        }
        receipt = prior;
      }
    }
    steps.push({ operationId: receipt.operationId, state: receipt.state, error: receipt.error });
    for (const standIn of receipt.roleStandIns ?? [])
      roleStandIns.push({ ...standIn, actionIndex: index });
    if (receipt.observation) observation = receipt.observation;
    if (receipt.state !== "completed") {
      observedAfterLastAction = receipt.observation !== null;
      break;
    }
    // The action opened a window: the actions after it were meant for this
    // target, or for a window not yet seen, so the batch stops at the window.
    if (receipt.observation && receipt.observation.target.id !== value.targetId) break;
    generation = receipt.observation?.target.targetGeneration;
    observationId = receipt.observation?.observationId ?? null;
  }
  if (!observedAfterLastAction) {
    // Show the state the stopped action left, not the state before it.
    try {
      observation = await observe();
      observedAfterLastAction = true;
    } catch {
      // Keep the earlier state; the text says it predates the stopped action.
    }
  }
  return {
    type: "batch",
    targetId: value.targetId,
    actionCount: actions.length,
    steps,
    observation,
    observationPrecedesStop: !observedAfterLastAction && observation !== null,
    ...(roleStandIns.length ? { roleStandIns } : {}),
  };
}

/**
 * Run a computer_act batch as one operation on a computer that supports it:
 * the computer checks every action against the one observation the batch
 * names, runs them in order and observes the target once. A batch it stopped
 * part way says in its error details how many actions completed, so each
 * action is still reported as it would be one at a time.
 */
async function actInComputerNativeBatch(
  transport: InteractionTransport,
  workspaceId: string,
  value: ResolvedComputerActInput,
  actions: ComputerAction[],
  batch: {
    operationId: string;
    observe: () => Promise<z.output<typeof ComputerObservation>>;
    /** The batch's recorded receipt, read only when this call cannot tell
     * from its own requests whether an earlier try ran it. */
    recorded: (
      operationId: string,
    ) => Promise<z.output<typeof ComputerActionReceipt> | "absent" | "unknown">;
  },
): Promise<z.output<typeof ComputerActionBatchReceipt>> {
  const entries = actions.map((action) => {
    if (action.type !== "semantic" && action.type !== "keyboard")
      throw new Error(`a batch runs semantic and keyboard actions, not ${action.type}`);
    return action;
  });
  let receipt: z.output<typeof ComputerActionReceipt> | null = null;
  let generation = value.expectedTargetGeneration;
  let observationId = value.expectedObservationId ?? null;
  if (generation === undefined || observationId === null) {
    try {
      if (observationId !== null) {
        // The batch names its observation: the target list gives the
        // generation without reading the window again, which would retire
        // the refs the caller holds.
        generation = (
          await transport.listComputerTargets(workspaceId, value.computerSessionId)
        ).targets.find((target) => target.id === value.targetId)?.targetGeneration;
      }
      if (generation === undefined || observationId === null) {
        const current = await batch.observe();
        generation ??= current.target.targetGeneration;
        observationId ??= current.observationId;
      }
    } catch (error) {
      // An earlier try may have run the batch, closing the window: its
      // recorded receipt says what ran.
      const prior = await batch.recorded(batch.operationId);
      if (typeof prior !== "object") throw error;
      receipt = prior;
    }
  }
  if (!receipt) {
    try {
      receipt = await transport.actInComputer(workspaceId, value.computerSessionId, {
        operationId: batch.operationId,
        targetId: value.targetId,
        expectedTargetGeneration: generation!,
        expectedObservationId: observationId,
        expectedFrameId: null,
        action: { type: "batch", actions: entries },
      });
    } catch (error) {
      // A retried call, or a lost reply: the recorded receipt says what ran.
      const prior = await batch.recorded(batch.operationId);
      if (typeof prior !== "object") throw error;
      receipt = prior;
    }
  }
  const { operationId, state, error } = receipt;
  const steps: z.output<typeof ComputerActionBatchReceipt>["steps"] = [];
  if (state === "completed") {
    for (let index = 0; index < actions.length; index++)
      steps.push({ operationId, state, error: null });
  } else {
    const { batchActionsCompleted, batchStoppedActionState, ...details } = error?.details ?? {};
    const completed =
      typeof batchActionsCompleted === "number" && Number.isInteger(batchActionsCompleted)
        ? Math.min(Math.max(batchActionsCompleted, 0), actions.length - 1)
        : 0;
    for (let index = 0; index < completed; index++)
      steps.push({ operationId, state: "completed", error: null });
    steps.push({
      operationId,
      state: batchStoppedActionState === "failed" ? "failed" : state,
      error: error && {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(Object.keys(details).length ? { details } : {}),
      },
    });
  }
  let observation = receipt.observation;
  if (observation === null && state !== "completed") {
    // Show the state the stopped batch left.
    try {
      observation = await batch.observe();
    } catch {
      // The receipt shows no state; the caller observes when it needs one.
    }
  }
  return {
    type: "batch",
    targetId: value.targetId,
    actionCount: actions.length,
    steps,
    observation,
    observationPrecedesStop: false,
    ...(receipt.roleStandIns?.length ? { roleStandIns: receipt.roleStandIns } : {}),
  };
}

async function openBrowser(
  transport: InteractionPlacementTransport,
  workspaceId: string,
  sourceSessionId: string,
  value: z.output<typeof BrowserOpenInput>,
  context: AttemptToolExecutionContext,
  extensionUrl: string,
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
    // resolution adds no sequential round trip. The chat's current machine is
    // read too: a profile on the computer this session runs on comes first.
    const resolveProfile =
      value.placement?.kind === "attached_device" && !("deviceId" in value.placement);
    const [listed, attachedInventory, currentPlacement] = await Promise.all([
      value.mode === "new"
        ? { sessions: [] }
        : transport.listBrowserSessions(workspaceId, {
            associatedSessionId: sourceSessionId,
            includeTerminal: false,
          }),
      resolveProfile
        ? transport.listAttachedBrowsers(workspaceId, { includeDisconnected: false })
        : null,
      resolveProfile || (value.mode !== "new" && namesMachinePlacement(value.placement))
        ? // Only a preference here: a failed read must not fail the open.
          readCurrentInteractionPlacement(transport, workspaceId, sourceSessionId).catch(() => null)
        : value.mode === "new" || value.placement
          ? null
          : readCurrentInteractionPlacement(transport, workspaceId, sourceSessionId),
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
                compatibleInteractionPlacement(
                  candidate.placement,
                  value.placement,
                  currentPlacement,
                ) &&
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
      if (attachedInventory) {
        profileChoice = chooseAttachedProfile(
          attachedInventory,
          currentPlacement?.kind === "connected_machine" ? currentPlacement.sandboxId : null,
          extensionUrl,
        );
      }
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
      // A browser that failed to start is not a result to act on: report why,
      // so the caller fixes the cause instead of retrying an opaque failure.
      const launchError = createdResponse.operation?.error;
      if (launchError && session.lifecycle === "failed") {
        throw new OpenGeniApiError(
          launchError.code === "unsupported" ? 422 : 502,
          `BrowserSession ${session.id} did not start: ${launchError.message}`,
          { code: launchError.code, retryable: launchError.retryable },
        );
      }
    }
  }
  if (isResumablePausedBrowser(session)) {
    session = (
      await transport.resumeBrowserSession(workspaceId, session.id, {
        operationId: context.operationId,
      })
    ).session;
  }
  const chosenProfile = profileChoice
    ? {
        attachedProfile: agentAttachedProfile(profileChoice.chosen, profileChoice.machines),
        ...(profileChoice.others.length > 0
          ? {
              otherAttachedProfiles: profileChoice.others.map((device) =>
                agentAttachedProfile(device, profileChoice!.machines),
              ),
            }
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
  const primary = openedBrowserTarget(
    targets,
    value.initialUrl,
    initialView?.observation.target.id,
  );
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
    ...(initialView?.notice ? { notice: initialView.notice } : {}),
  };
}

type AttachedProfileChoice = {
  chosen: z.infer<typeof AttachedBrowserDeviceListResponse>["devices"][number];
  others: z.infer<typeof AttachedBrowserDeviceListResponse>["devices"];
  machines: AttachedProfileMachines;
};

/** Where each attached profile is: its computer's plain name, and whether that
 * is the Connected Machine this session runs on now. */
type AttachedProfileMachines = {
  readonly thisMachine: string | null;
  machineOf(device: { enrollmentId: string }): { sandboxId: string | null; name: string | null };
};

function attachedProfileMachines(
  inventory: z.infer<typeof AttachedBrowserDeviceListResponse>,
  thisMachine: string | null,
): AttachedProfileMachines {
  const bridges = new Map(inventory.bridges.map((bridge) => [bridge.enrollmentId, bridge]));
  return {
    thisMachine,
    machineOf: (device) => {
      const bridge = bridges.get(device.enrollmentId);
      // An older API omits these fields; treat them as unknown.
      return { sandboxId: bridge?.sandboxId ?? null, name: bridge?.machineName ?? null };
    },
  };
}

/** The machine fields the model sees for one profile or bridge. */
function agentMachineFields(
  machines: AttachedProfileMachines,
  device: { enrollmentId: string },
): { machine?: string; onThisMachine?: true } {
  const machine = machines.machineOf(device);
  return {
    ...(machine.name ? { machine: machine.name } : {}),
    ...(machines.thisMachine !== null && machine.sandboxId === machines.thisMachine
      ? { onThisMachine: true as const }
      : {}),
  };
}

/** The person's own Chrome when browser_open names no profile: the only
 * connected profile, else the one whose tabs changed most recently (a device's
 * updatedAt moves with its tab inventory, not with heartbeats), preferring
 * profiles on the Connected Machine this session runs on (`thisMachine`, its
 * sandbox ID; null on a managed sandbox, which never hosts the person's
 * Chrome). */
function chooseAttachedProfile(
  inventory: z.infer<typeof AttachedBrowserDeviceListResponse>,
  thisMachine: string | null,
  extensionUrl: string,
): AttachedProfileChoice {
  const machines = attachedProfileMachines(inventory, thisMachine);
  const usable = inventory.devices
    .filter((device) => device.state === "connected" && device.capabilities.debuggerAttachment)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const chosen =
    (thisMachine !== null
      ? usable.find((device) => machines.machineOf(device).sandboxId === thisMachine)
      : undefined) ?? usable[0];
  if (!chosen) {
    throw new OpenGeniApiError(
      409,
      `No Chrome profile is connected through the browser extension. The person needs a Connected Machine, then the extension: ${extensionUrl}`,
      { code: "attached_browser_unavailable", retryable: false },
    );
  }
  return { chosen, others: usable.filter((device) => device !== chosen), machines };
}

/**
 * Posts a blocker's setup card. Resolves the chat link once it is posted,
 * "unavailable" when the card's capability is off on this deployment, or null
 * when it could not be posted.
 */
export type UserSetupCardPoster = (
  blocker: UserSetupBlocker,
  toolName: string,
) => Promise<{ chatUrl: string | null } | "unavailable" | null>;

/**
 * A tool was refused for something the person can fix themselves (a missing
 * machine, extension or permission; see USER_SETUP_BLOCKERS). Put its setup
 * card in the chat right away, so the person sees the fix on the first attempt
 * instead of having to ask, and tell the model the card is there so it neither
 * repeats its steps nor posts another. Without a card (no poster, or posting
 * failed), tell the model to offer the fix itself; when the deployment can't
 * offer the fix, say so. Every other error is
 * returned unchanged.
 */
async function withUserSetupCard(
  error: unknown,
  toolName: string,
  post: UserSetupCardPoster | undefined,
): Promise<unknown> {
  if (!(error instanceof OpenGeniApiError)) return error;
  const blocker = userSetupBlocker(error.code);
  if (!blocker) return error;
  let posted: Awaited<ReturnType<UserSetupCardPoster>> = null;
  if (post) {
    try {
      posted = await post(blocker, toolName);
    } catch {
      posted = null;
    }
  }
  return new OpenGeniApiError(
    error.status,
    posted === "unavailable"
      ? userSetupUnavailableMessage(blocker)
      : posted
        ? userSetupCardShownMessage(blocker, posted.chatUrl)
        : userSetupCardUnpostedMessage(blocker),
    // Not retryable: finishing the card continues the chat, so a retry only
    // repeats the refusal. The reference ID stays for support.
    { code: blocker.code, retryable: false, correlationId: error.correlationId },
  );
}

function agentAttachedProfile(
  device: AttachedProfileChoice["chosen"],
  machines: AttachedProfileMachines,
): z.infer<typeof AgentAttachedProfile> {
  return {
    id: device.id,
    name: device.name,
    ...(device.profileLabel && device.profileLabel !== device.name
      ? { profileLabel: device.profileLabel }
      : {}),
    ...agentMachineFields(machines, device),
  };
}

/**
 * The tab the agent most likely acts on next: the tab this open launched, else
 * the session's own (selected) tab showing the requested URL, else any tab
 * showing it, else the selected page. An attached Chrome profile lists the
 * person's tabs and other sessions' tabs too, so an older tab on the same URL
 * must not win over the one this session opened.
 */
function openedBrowserTarget(
  targets: z.infer<typeof BrowserTarget>[],
  initialUrl: string | undefined,
  launchedTargetId: string | undefined,
): z.infer<typeof BrowserTarget> | undefined {
  const pages = targets.filter((target) => target.kind === "page");
  const launched = launchedTargetId
    ? pages.find((target) => target.id === launchedTargetId)
    : undefined;
  if (launched) return launched;
  const showingUrl = initialUrl
    ? pages.filter((target) => sameBrowserUrl(target.url, initialUrl))
    : [];
  return (
    showingUrl.find((target) => target.selected) ??
    showingUrl[0] ??
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
  transport: InteractionPlacementTransport,
  workspaceId: string,
  sourceSessionId: string,
  value: z.output<typeof ComputerOpenInput>,
  context: AttemptToolExecutionContext,
): Promise<z.input<typeof ComputerOpenOutput>> {
  let session: z.infer<typeof ComputerSession>;
  if (value.computerSessionId) {
    session = await transport.getComputerSession(workspaceId, value.computerSessionId);
  } else {
    const [listed, currentPlacement] = await Promise.all([
      value.mode === "new"
        ? { sessions: [] }
        : transport.listComputerSessions(workspaceId, {
            associatedSessionId: sourceSessionId,
            includeTerminal: false,
          }),
      value.mode === "new"
        ? null
        : namesMachinePlacement(value.placement)
          ? // Only a preference here: a failed read must not fail the open.
            readCurrentInteractionPlacement(transport, workspaceId, sourceSessionId).catch(
              () => null,
            )
          : value.placement
            ? null
            : readCurrentInteractionPlacement(transport, workspaceId, sourceSessionId),
    ]);
    const reusable = newestRelevant(
      listed.sessions.filter((candidate) =>
        compatibleInteractionPlacement(candidate.placement, value.placement, currentPlacement),
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

type InteractionPlacementTransport = InteractionTransport &
  Partial<Pick<OpenGeniClient, "getSession">>;

/** Where a placement-less open creates its session: the machine the chat is
 * routed to now. No active sandbox means the session's own group sandbox; a
 * swapped chat uses the machine it swapped to. Read at call time, since
 * sandbox_swap can move the chat mid-turn. Null when the transport cannot
 * read the session. */
async function readCurrentInteractionPlacement(
  transport: InteractionPlacementTransport,
  workspaceId: string,
  sessionId: string,
): Promise<z.infer<typeof InteractionPlacement> | null> {
  if (!transport.getSession) return null;
  const session = await transport.getSession(workspaceId, sessionId, { fresh: true });
  return session.activeSandboxId === null
    ? { kind: "sandbox_group", sandboxGroupId: session.sandboxGroupId }
    : { kind: "connected_machine", sandboxId: session.activeSandboxId };
}

function compatibleInteractionPlacement(
  candidate: z.infer<typeof InteractionPlacement>,
  requested: z.infer<typeof BrowserOpenPlacement> | undefined,
  current: z.infer<typeof InteractionPlacement> | null = null,
): boolean {
  if (!requested) {
    if (candidate.kind === "attached_device") return false;
    // Without a placement only a session on the chat's current machine is
    // reused, never one left on a machine the chat has since swapped away from.
    return current === null || placementFieldsMatch(candidate, current);
  }
  // A session on a named machine the chat is not routed to cannot be used
  // from here: the server retires it on contact. Opening a new one instead
  // returns the error that says how to move the chat to that machine.
  if (namesMachinePlacement(requested) && current !== null) {
    if (!placementFieldsMatch(current, requested)) return false;
  }
  return placementFieldsMatch(candidate, requested);
}

/** A placement that names one machine (the chat's own sandbox group or a
 * Connected Machine), as opposed to the person's Chrome or a provider. */
function namesMachinePlacement(
  placement: z.infer<typeof BrowserOpenPlacement> | undefined,
): boolean {
  return placement?.kind === "connected_machine" || placement?.kind === "sandbox_group";
}

/** The Connected Machine this session runs on now (its sandbox ID), or null on
 * a managed sandbox or when the transport cannot read the session. */
async function readCurrentMachineSandboxId(
  transport: InteractionPlacementTransport,
  workspaceId: string,
  sessionId: string,
): Promise<string | null> {
  // Only a preference: a failed read means no machine is preferred.
  const placement = await readCurrentInteractionPlacement(transport, workspaceId, sessionId).catch(
    () => null,
  );
  return placement?.kind === "connected_machine" ? placement.sandboxId : null;
}

function placementFieldsMatch(
  candidate: z.infer<typeof InteractionPlacement>,
  wanted: z.infer<typeof BrowserOpenPlacement> | z.infer<typeof InteractionPlacement>,
): boolean {
  return Object.entries(wanted).every(
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
  rank: ((flat: FlatBrowserNode) => readonly number[]) | null = browserNodeRank,
): { nodes: z.infer<typeof BrowserAgentNode>[]; clippedFieldCount: number } {
  const candidates = rank
    ? flattened
        .map((flat) => ({ flat, key: [...rank(flat), flat.index] }))
        .sort((a, b) => compareRank(a.key, b.key))
        .map((entry) => entry.flat)
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

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Without page context: controls first, then orientation, then content. */
function browserNodeRank(flat: FlatBrowserNode): readonly number[] {
  const { node } = flat;
  if (node.actions.length > 0) return [0];
  if (["heading", "dialog", "alert", "status", "navigation", "main"].includes(node.role))
    return [1];
  if (["text", "paragraph", "listitem"].includes(node.role) && node.name) return [2];
  if (node.name || node.value || node.description) return [3];
  return [4];
}

/** Open popups and modal surfaces: where a person's attention is after they
 * open a menu, dialog, listbox or tooltip. */
const BROWSER_ATTENTION_SURFACE_ROLES = new Set([
  "dialog",
  "alertdialog",
  "menu",
  "listbox",
  "tooltip",
]);
/** Live regions announce results such as toasts, errors and status text. */
const BROWSER_LIVE_REGION_ROLES = new Set(["alert", "status", "log", "marquee", "timer"]);
/** Site-wide chrome that rarely holds what a task is about. */
const BROWSER_PAGE_CHROME_ROLES = new Set(["navigation", "banner", "contentinfo"]);
/** A focus group never grows past a landmark or the document. */
const BROWSER_FOCUS_GROUP_STOP_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "document",
  "RootWebArea",
  "WebArea",
]);
/** Regions named in the omitted-element summary. */
const BROWSER_SUMMARY_REGION_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "complementary",
  "contentinfo",
  "region",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "menu",
]);

type RankedBrowserView = {
  /** Non-redundant nodes in document order. */
  visible: FlatBrowserNode[];
  rank: (flat: FlatBrowserNode) => readonly number[];
  regionOf: (flat: FlatBrowserNode) => { role: string; name?: string } | null;
};

/**
 * A dense application page has far more elements than one compact view can
 * hold. Document order puts site navigation and the top of a long grid first,
 * while the menu, dialog or popover a click just opened is usually rendered at
 * the end of the document, and result text (a total, a toast, an error) is not
 * a control at all. Rank by where attention is instead: open surfaces and live
 * messages, then the focused or acted-on element with its small enclosing
 * group, then the page's own content, and site chrome last.
 */
function rankBrowserView(
  flattened: readonly FlatBrowserNode[],
  anchorRefs: readonly string[],
): RankedBrowserView {
  const count = flattened.length;
  const parent = new Int32Array(count).fill(-1);
  const end = new Int32Array(count);
  const ancestors: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const depth = flattened[index]!.depth;
    while (ancestors.length > 0 && flattened[ancestors.at(-1)!]!.depth >= depth) {
      end[ancestors.pop()!] = index;
    }
    parent[index] = ancestors.at(-1) ?? -1;
    ancestors.push(index);
  }
  for (const index of ancestors) end[index] = count;

  const redundant = flattened.map(redundantAgentNode);
  const keptBefore = new Int32Array(count + 1);
  for (let index = 0; index < count; index += 1)
    keptBefore[index + 1] = keptBefore[index]! + (redundant[index] ? 0 : 1);
  const keptDescendants = (index: number): number =>
    keptBefore[end[index]!]! - keptBefore[index + 1]!;
  // An empty live region is page plumbing, not a message.
  for (let index = 0; index < count; index += 1) {
    const { node } = flattened[index]!;
    if (
      BROWSER_LIVE_REGION_ROLES.has(node.role) &&
      !node.name &&
      (node.value === undefined || node.value === null || node.value === "") &&
      keptDescendants(index) === 0
    )
      redundant[index] = true;
  }
  const subtreeSize = (index: number): number =>
    (redundant[index] ? 0 : 1) + keptDescendants(index);

  const attention = new Uint8Array(count);
  const markSubtree = (index: number) => attention.fill(1, index, end[index]!);
  for (let index = 0; index < count; index += 1) {
    const { node } = flattened[index]!;
    if (
      BROWSER_ATTENTION_SURFACE_ROLES.has(node.role) ||
      node.states.includes("modal") ||
      (BROWSER_LIVE_REGION_ROLES.has(node.role) && !redundant[index])
    )
      markSubtree(index);
  }
  const indexByRef = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const ref = flattened[index]!.node.ref;
    if (ref && !indexByRef.has(ref)) indexByRef.set(ref, index);
  }
  for (const ref of anchorRefs) {
    const anchor = indexByRef.get(ref);
    if (anchor === undefined) continue;
    if (subtreeSize(anchor) > BROWSER_AGENT_FOCUS_GROUP_MAX_NODES) {
      attention[anchor] = 1;
      continue;
    }
    let group = anchor;
    for (
      let next = parent[group]!;
      next >= 0 &&
      !BROWSER_FOCUS_GROUP_STOP_ROLES.has(flattened[next]!.node.role) &&
      subtreeSize(next) <= BROWSER_AGENT_FOCUS_GROUP_MAX_NODES;
      next = parent[next]!
    )
      group = next;
    markSubtree(group);
  }

  const chrome = new Uint8Array(count);
  const region = new Int32Array(count).fill(-1);
  for (let index = 0; index < count; index += 1) {
    const { node } = flattened[index]!;
    const up = parent[index]!;
    chrome[index] =
      BROWSER_PAGE_CHROME_ROLES.has(node.role) || (up >= 0 && chrome[up] === 1) ? 1 : 0;
    region[index] =
      BROWSER_SUMMARY_REGION_ROLES.has(node.role) && (node.role !== "region" || node.name)
        ? index
        : up >= 0
          ? region[up]!
          : -1;
  }

  return {
    visible: flattened.filter((_, index) => !redundant[index]),
    rank: (flat) => {
      if (attention[flat.index] === 1) return [0];
      return [chrome[flat.index] === 1 ? 2 : 1, ...browserNodeRank(flat)];
    },
    regionOf: (flat) => {
      const owner = region[flat.index]!;
      if (owner < 0) return null;
      const { node } = flattened[owner]!;
      return {
        role: node.role,
        ...(node.name ? { name: boundedAgentField(node.name, () => {}) } : {}),
      };
    },
  };
}

function omittedBrowserRegions(
  ranked: RankedBrowserView,
  shownRefs: ReadonlySet<string>,
): Array<{ role: string; name?: string; count: number }> {
  const regions = new Map<string, { role: string; name?: string; count: number }>();
  for (const flat of ranked.visible) {
    if (shownRefs.has(flat.node.ref)) continue;
    const owner = ranked.regionOf(flat) ?? { role: "page" };
    const key = `${owner.role}\0${owner.name ?? ""}`;
    const entry = regions.get(key) ?? { ...owner, count: 0 };
    entry.count += 1;
    regions.set(key, entry);
  }
  return [...regions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, BROWSER_AGENT_MAX_OMITTED_REGIONS);
}

function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact",
  anchorRefs?: readonly string[],
): z.infer<typeof CompactBrowserObservation>;
function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact" | "full",
  anchorRefs?: readonly string[],
): z.infer<typeof BrowserAgentObservation>;
function projectBrowserObservation(
  observation: z.infer<typeof BrowserObservation>,
  view: "compact" | "full",
  anchorRefs: readonly string[] = [],
): z.infer<typeof BrowserAgentObservation> {
  if (view === "full") return observation;
  const semantic = observation.semantic;
  const roots =
    semantic?.kind === "snapshot"
      ? semantic.roots
      : semantic?.kind === "diff"
        ? semantic.changed
        : [];
  const ranked = rankBrowserView(flattenBrowserNodes(roots), [
    ...(observation.focusedRef ? [observation.focusedRef] : []),
    ...anchorRefs,
  ]);
  const projected = selectAgentNodes(
    ranked.visible,
    BROWSER_AGENT_MAX_NODES,
    BROWSER_AGENT_MAX_NODE_BYTES,
    ranked.rank,
  );
  const omittedNodeCount = ranked.visible.length - projected.nodes.length;
  const omittedRegions =
    omittedNodeCount > 0
      ? omittedBrowserRegions(ranked, new Set(projected.nodes.map((node) => node.ref)))
      : [];
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
      ...(omittedRegions.length > 0 ? { omittedRegions } : {}),
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
 * none is available, so they are listed (online only) when no profile is.
 * Both name their computer; `thisMachine` is the sandbox ID of the Connected
 * Machine this session runs on, if any. */
function agentAttachedInventory(
  inventory: z.infer<typeof AttachedBrowserDeviceListResponse>,
  thisMachine: string | null,
): {
  attachedBrowserBridges: z.infer<typeof AgentAttachedBrowserBridge>[];
  attachedBrowsers: z.infer<typeof AgentAttachedBrowser>[];
} {
  const machines = attachedProfileMachines(inventory, thisMachine);
  const attachedBrowsers = inventory.devices.map((device) => {
    const unsupported = Object.entries(device.capabilities)
      .filter(([, supported]) => !supported)
      .map(([capability]) => capability);
    return {
      id: device.id,
      name: device.name,
      ...(device.profileLabel ? { profileLabel: device.profileLabel } : {}),
      ...agentMachineFields(machines, device),
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
          ...agentMachineFields(machines, bridge),
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
      ? {
          observation: projectBrowserObservation(
            receipt.observation,
            "compact",
            (receipt.targets ?? []).flatMap((target) => (target.ref ? [target.ref] : [])),
          ),
        }
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
      : selectAgentNodes(matches, input.limit ?? 40, BROWSER_AGENT_MAX_NODE_BYTES, null);
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
function resultModelText<T>(
  output: T,
  modelText: ((output: T, context: AttemptToolExecutionContext) => string) | undefined,
  context: AttemptToolExecutionContext,
): string {
  if (modelText) {
    try {
      return modelText(output, context);
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
  modelText?: (output: z.output<TOutput>, context: AttemptToolExecutionContext) => string,
): Promise<AttemptToolResultValue> {
  try {
    const value = inputSchema.parse(raw);
    const executed = await execute(value, context);
    const structuredContent = outputSchema.parse(
      executed instanceof InteractionExecutionResult ? executed.output : executed,
    );
    const result = {
      content: [
        { type: "text" as const, text: resultModelText(structuredContent, modelText, context) },
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
    if (
      error instanceof BrowserTargetResolutionError ||
      error instanceof ComputerTargetResolutionError
    ) {
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

function screenshotFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 300) || "unknown error";
}

const BROWSER_DIALOG_NO_SCREENSHOT =
  "No screenshot: a JavaScript dialog is open in this tab. Handle it first with browser_act action {type:'handle_dialog'}.";

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

/** What a computer call's 404 or 410 found gone: the computer itself (a 410,
 * or a 404 saying its session was not found or is not active) or else the
 * window it named, which the controller reports in many words ("computer
 * target … does not exist", "CUA window is no longer present"). */
function goneComputerPart(error: unknown): "window" | "computer" {
  return error instanceof OpenGeniApiError &&
    error.status === 404 &&
    !/session (?:operation )?(?:not found|is not active)/iu.test(error.message)
    ? "window"
    : "computer";
}

/** The API refused the call before running it, possibly because its browser
 * is not running. */
function isBrowserNotRunningError(error: unknown): boolean {
  return error instanceof OpenGeniApiError && error.status === 409 && !error.outcomeUnknown;
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

/** A native computer call the API rejected with a definite client error. */
function refusedNativeCallResult(error: unknown): AttemptToolResultValue | null {
  const secretReferenceFailure = secretReferenceToolResult(error);
  if (secretReferenceFailure) return secretReferenceFailure;
  if (!(error instanceof OpenGeniApiError) || error.outcomeUnknown || error.status >= 500) {
    return null;
  }
  return (
    interactionToolErrorOutput(error) ??
    interactionErrorResult(
      error.code ?? `http_${error.status}`,
      boundedErrorMessage(error.message),
      error.retryable,
      error.correlationId,
    )
  );
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
    throw new Error("First-party MCP URL cannot be projected to the API base URL");
  }
  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function boundedErrorMessage(message: string): string {
  return message.length <= 1_024 ? message : `${message.slice(0, 1_021)}...`;
}
