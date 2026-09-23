import {
  AttachedBrowserBridge,
  AttachedBrowserDevice,
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  BrowserAction,
  BrowserActionBatch,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDomReadResponse,
  BrowserDomSafeAttribute,
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserObservation,
  BrowserLocator,
  InteractionSemanticNode,
  BrowserRevisionListResponse,
  BrowserSession,
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
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
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
import { OpenGeniApiError, OpenGeniClient, type InteractionTransport } from "@opengeni/sdk";
import { z } from "zod";
import { browserActionInputJsonSchema } from "./browser-action-json-schema";
import { guardedMcpFetch } from "./mcp-network";

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
    states: z.array(z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH)).max(6),
    actions: z.array(z.string().max(BROWSER_AGENT_MAX_FIELD_LENGTH)).max(6),
  })
  .strict();
const BrowserAgentView = z
  .object({
    kind: z.literal("compact"),
    sourceKind: z.enum(["snapshot", "diff", "none"]),
    nodes: z.array(BrowserAgentNode).max(BROWSER_AGENT_MAX_NODES),
    sourceNodeCount: z.number().int().nonnegative(),
    omittedNodeCount: z.number().int().nonnegative(),
    removedRefCount: z.number().int().nonnegative(),
    clippedFieldCount: z.number().int().nonnegative(),
    maxNodes: z.number().int().positive(),
    maxNodeBytes: z.number().int().positive(),
  })
  .strict();
const CompactBrowserObservation = BrowserObservation.safeExtend({
  semantic: z.null(),
  agentView: BrowserAgentView,
});
const BrowserAgentObservation = z.union([BrowserObservation, CompactBrowserObservation]);
const BrowserAgentActionReceipt = BrowserActionReceipt.safeExtend({
  observation: BrowserAgentObservation.nullable(),
});
const BrowserScreenshotInput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
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
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    mode: z.enum(["matches", "count", "subtree", "dom"]).optional(),
    dom: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("element"),
            locator: BrowserLocator,
            attributes: z.array(BrowserDomSafeAttribute).max(6).optional(),
            maxChars: z.number().int().min(1).max(4_096).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("count"),
            selector: z.string().min(1).max(8_192),
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
} as const satisfies Record<InteractionAttemptToolName, Permission>;

const DiscoveryInput = z
  .object({
    scope: z.enum(["current_session", "workspace"]).optional(),
    includeTerminal: z.boolean().optional(),
    includeArchivedIdentities: z.boolean().optional(),
    includeDisconnectedDevices: z.boolean().optional(),
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
    attachedBrowserBridges: z.array(AttachedBrowserBridge),
    attachedBrowsers: z.array(AttachedBrowserDevice),
  })
  .strict();

const BrowserOpenInput = z
  .object({
    browserSessionId: z.string().uuid().optional(),
    mode: z.enum(["reuse_or_create", "new"]).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    initialUrl: z.string().url().max(16_384).optional(),
    headless: z.boolean().optional(),
    placement: InteractionPlacement.optional(),
    identityId: z.string().uuid().optional(),
    baseRevisionId: z.string().uuid().optional(),
    networkRouteId: z.string().uuid().optional(),
    linkedComputerSessionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
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
  .object({ session: BrowserSession, targets: z.array(BrowserTarget) })
  .strict();

const BrowserTabsInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), browserSessionId: z.string().uuid() }).strict(),
  z
    .object({
      operation: z.literal("open"),
      browserSessionId: z.string().uuid(),
      url: z.string().url().max(16_384).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("select"),
      browserSessionId: z.string().uuid(),
      targetId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      operation: z.literal("close"),
      browserSessionId: z.string().uuid(),
      targetId: z.string().min(1).max(512),
    })
    .strict(),
]);

const BrowserObserveInput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    view: z.enum(["compact", "full"]).optional(),
    includeScreenshot: z.boolean().optional(),
  })
  .strict();
const BrowserActInput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedDocumentGeneration: z.string().min(1).max(256).nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
    view: z.enum(["compact", "full", "none"]).optional(),
    action: z.union([BrowserAction, BrowserActionBatch]),
  })
  .strict();
const BrowserClipboardInput = z.object({ browserSessionId: z.string().uuid() }).strict();
const BrowserDebugInput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
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
      operation: z.literal("protected_fill"),
      browserSessionId: z.string().uuid(),
      authRunId: z.string().uuid(),
    })
    .extend(ProtectedAuthFillRequest.omit({ operationId: true }).shape)
    .strict(),
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
  z.object({ operation: z.literal("protected_fill"), result: ProtectedAuthFillResponse }).strict(),
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
const ComputerClipboardInput = z.object({ computerSessionId: z.string().uuid() }).strict();
const ComputerActInput = z
  .object({
    computerSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedObservationId: z.string().uuid().nullable().optional(),
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
  const add = <TInput extends z.ZodType, TOutput extends z.ZodType>(options: {
    name: InteractionAttemptToolName;
    codemodePath: readonly string[];
    title: string;
    description: string;
    input: TInput;
    output: TOutput;
    readOnly: boolean;
    idempotent: boolean;
    approval?: "none" | "human" | "policy";
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
      inputSchema:
        options.name === "browser_act"
          ? browserActionInputJsonSchema(options.input)
          : jsonSchema(options.input),
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
        ),
    });
  };

  add({
    name: "interaction_discover",
    codemodePath: ["interaction", "discover"],
    title: "Discover browsers and computers",
    description:
      "List BrowserSessions and ComputerSessions associated with this agent session. The default current_session scope is deliberately small and omits workspace-wide identities, attached-browser bridges, and Chrome profiles. For requests about the user's existing/current/personal Chrome, reusable identities, or peer/child resources, call this with scope=workspace before browser_open and select an actual attachedBrowsers device; that inventory can be large. An attachedBrowserBridge only means the machine is ready for the extension; only attachedBrowsers are real user Chrome profiles/tabs. Leave includeTerminal=false unless ended history is specifically required.",
    input: DiscoveryInput,
    output: DiscoveryOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      const scope = value.scope ?? "current_session";
      const [browsers, computers, identities, attached] = await Promise.all([
        input.transport.listBrowserSessions(input.workspaceId),
        input.transport.listComputerSessions(input.workspaceId),
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
        attachedBrowserBridges: scope === "workspace" ? attached.bridges : [],
        attachedBrowsers: scope === "workspace" ? attached.devices : [],
      };
    },
  });

  add({
    name: "browser_open",
    codemodePath: ["interaction", "browser", "open"],
    title: "Open or reuse browser",
    description:
      "Open a managed BrowserSession on the current agent placement, reuse a relevant compatible live session by default, attach to an explicit workspace BrowserSession, or open an attached Chrome profile by passing placement={kind:'attached_device',deviceId}. This does not infer or attach the user's existing Chrome: for requests about 'my browser', 'my tabs', or current Chrome, call interaction_discover first and select an actual attachedBrowsers device; if none exists, explain that the Chrome extension must be connected instead of silently creating a blank managed browser. BrowserSessions persist across tool calls; shell-launched browser daemons do not survive remote-command cleanup. Never switch to the user's attached Chrome as a fallback for a failed managed browser unless the user requested that profile. A new attached session opens a dedicated tab. Managed Chromium defaults to headed so OAuth and later human interaction use a supported browser; request headless=true only for agent-only work that will not require sign-in or human control. Returns exact session and tab state.",
    input: BrowserOpenInput,
    output: BrowserOpenOutput,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) =>
      await openBrowser(input.transport, input.workspaceId, input.sessionId, value, context),
  });

  add({
    name: "browser_tabs",
    codemodePath: ["interaction", "browser", "tabs"],
    title: "Manage browser tabs",
    description:
      "List, open, logically select, or close tabs in one exact BrowserSession. Selection changes the BrowserSession's default target, not the visible desktop tab. New attached-Chrome tabs open in the background. Use browser_act activate only when foregrounding the owned tab is explicitly intended. Returns the authoritative complete tab list after the operation.",
    input: BrowserTabsInput,
    output: BrowserTargetListResponse,
    readOnly: false,
    idempotent: false,
    execute: async (value) => {
      if (value.operation === "open") {
        await input.transport.openBrowserTarget(input.workspaceId, value.browserSessionId, {
          ...(value.url ? { url: value.url } : {}),
        });
      } else if (value.operation === "select") {
        await input.transport.selectBrowserTarget(
          input.workspaceId,
          value.browserSessionId,
          value.targetId,
        );
      } else if (value.operation === "close") {
        return await input.transport.closeBrowserTarget(
          input.workspaceId,
          value.browserSessionId,
          value.targetId,
        );
      }
      return await input.transport.listBrowserTargets(input.workspaceId, value.browserSessionId);
    },
  });

  add({
    name: "browser_observe",
    codemodePath: ["interaction", "browser", "observe"],
    title: "Observe browser tab",
    description:
      "Read one tab's URL, title, viewport, causal generations, and a bounded accessibility view. Compact view is the default: agentView lists selected refs and reports omitted nodes and clipped fields; it is not a complete page tree. Set view=full for the complete accessibility snapshot. Set includeScreenshot=true to add a current still image as tool image content; browser_screenshot is faster when only pixels are needed.",
    input: BrowserObserveInput,
    output: BrowserAgentObservation,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      let observation = await input.transport.observeBrowserTarget(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
      );
      if (!value.includeScreenshot)
        return projectBrowserObservation(observation, value.view ?? "compact");
      const frame = await input.transport.captureBrowserTarget(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
      );
      if (
        observation.target.targetGeneration !== frame.targetGeneration ||
        observation.target.documentGeneration !== frame.documentGeneration
      ) {
        observation = await input.transport.observeBrowserTarget(
          input.workspaceId,
          value.browserSessionId,
          value.targetId,
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
    },
  });

  add({
    name: "browser_read",
    codemodePath: ["interaction", "browser", "read"],
    title: "Read focused browser content",
    description:
      "Search, count, or read a subtree from one tab's accessibility snapshot; filter by ref, role, name, accessibility text, state, or action, and scopeRef. AX mode refreshes the full tree internally and cannot return DOM attributes or editable input values. Use mode=dom with a locator for bounded element text, editable value, or allowlisted attributes, or a CSS selector for count. DOM CSS reads accept simple tag, class, id, descendant, and child selectors; attribute and pseudo selectors are rejected to prevent secret-value probing. DOM reads use exact causal fences and only fixed, read-only browser-side projection; callers cannot supply JavaScript. Role/ref DOM locators can still refresh accessibility; CSS/test-id/placeholder locators avoid that scan.",
    input: BrowserReadInput,
    output: BrowserReadToolOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      if (value.mode === "dom") {
        const state =
          value.expectedTargetGeneration !== undefined &&
          value.expectedDocumentGeneration !== undefined &&
          value.expectedFrameId !== undefined
            ? null
            : await input.transport.getBrowserTargetState(
                input.workspaceId,
                value.browserSessionId,
                value.targetId,
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
            value.browserSessionId,
            value.targetId,
            request,
          )),
          source: "dom" as const,
        };
      }
      return readBrowserObservation(
        await input.transport.observeBrowserTarget(
          input.workspaceId,
          value.browserSessionId,
          value.targetId,
        ),
        value,
      );
    },
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
    execute: async (value) => {
      const frame = await input.transport.captureBrowserTarget(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
        {},
        { fullPage: value.fullPage ?? false, ...(value.quality ? { quality: value.quality } : {}) },
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
    },
  });

  add({
    name: "browser_act",
    codemodePath: ["interaction", "browser", "act"],
    title: "Act in browser tab",
    description:
      "Perform one semantic-first browser action or bounded batch. Use viewport to set page width, height, desktop/mobile layout and touch emulation, then check the measured viewport in the returned observation; emulation does not prove physical mobile-browser behavior. Use history back/forward for tab navigation; keypress shortcuts are page input and may not navigate browser history. The explicit activate action foregrounds the target in the user's desktop browser; use only when that is intended. Permission actions set a managed browser's web permission for this tab's exact current top-level origin. Omit generation fences to fetch fresh generation metadata without scanning accessibility; supplying all three fences skips that state read while preserving controller validation. The default receipt includes a compact accessibility view with explicit omissions; set view=full for the complete observation, or view=none when no post-action tree is needed.",
    input: BrowserActInput,
    output: BrowserAgentActionReceipt,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      const current =
        value.expectedTargetGeneration !== undefined &&
        value.expectedDocumentGeneration !== undefined &&
        value.expectedFrameId !== undefined
          ? null
          : await input.transport.getBrowserTargetState(
              input.workspaceId,
              value.browserSessionId,
              value.targetId,
            );
      const receipt = await input.transport.actInBrowser(
        input.workspaceId,
        value.browserSessionId,
        {
          operationId: context.operationId,
          targetId: value.targetId,
          expectedTargetGeneration: value.expectedTargetGeneration ?? current!.targetGeneration,
          expectedDocumentGeneration:
            value.expectedDocumentGeneration === undefined
              ? current!.documentGeneration
              : value.expectedDocumentGeneration,
          expectedFrameId:
            value.expectedFrameId === undefined ? current!.frameId : value.expectedFrameId,
          ...(value.view === "none" ? { observationMode: "none" as const } : {}),
          action: value.action,
        },
      );
      return receipt.observation && (value.view ?? "compact") === "compact"
        ? { ...receipt, observation: projectBrowserObservation(receipt.observation, "compact") }
        : receipt;
    },
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
      await input.transport.listBrowserDiagnostics(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
        {
          ...(value.kinds ? { kinds: value.kinds } : {}),
          ...(value.after !== undefined ? { after: value.after } : {}),
          ...(value.limit !== undefined ? { limit: value.limit } : {}),
        },
      ),
  });

  add({
    name: "browser_auth",
    codemodePath: ["interaction", "browser", "auth"],
    title: "Authenticate browser session",
    description:
      "List configured site-auth connections and durable auth runs, or start, report, provider-advance, protected-fill, and verify one exact BrowserSession authentication run. Use advance_external for an external_provider authority. Provider secrets and hosted-login URLs never enter model tool arguments or results. If an operation returns needs_human, call interaction_request_human with the returned intervention id.",
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
      if (value.operation === "protected_fill") {
        const { operation: _operation, browserSessionId, authRunId, ...request } = value;
        return {
          operation: value.operation,
          result: await input.transport.protectedBrowserAuthFill(
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
      "Pause the current agent turn for a person to act in one exact browser tab or computer target. Browser login/MFA handoffs must target a headed BrowserSession (headless=false); never hand a headless automation browser to a person because identity providers may reject it. Use operation=wait for an intervention already returned by browser_auth; otherwise provide the exact observed resource generations and a concise reason. The same tool call resumes with the settled intervention and a fresh observation.",
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
      "Explicitly quiesce and save the live BrowserSession as an immutable child revision of a reusable BrowserIdentity. Nothing is written back automatically.",
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
      "Suspend, resume, or end one BrowserSession through its durable exactly-once lifecycle journal. Suspending preserves a private working checkpoint; it does not publish a reusable identity version.",
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
      "Open a ComputerSession on the current agent placement, reuse a relevant live session by default, or attach to an explicit workspace ComputerSession. Returns exact apps/windows/screens.",
    input: ComputerOpenInput,
    output: ComputerOpenOutput,
    readOnly: false,
    idempotent: true,
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
    execute: async (value) =>
      await input.transport.listComputerTargets(input.workspaceId, value.computerSessionId),
  });

  add({
    name: "computer_observe",
    codemodePath: ["interaction", "computer", "observe"],
    title: "Observe app or window",
    description:
      "Read one ComputerSession app/window/screen target, causal generation, semantic accessibility tree, focus, frame identity, and a bounded current screenshot without taking control.",
    input: ComputerObserveInput,
    output: ComputerObservation,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
      let observation = await input.transport.observeComputerTarget(
        input.workspaceId,
        value.computerSessionId,
        value.targetId,
      );
      const frame = await input.transport.captureComputerTarget(
        input.workspaceId,
        value.computerSessionId,
        value.targetId,
      );
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
      return new InteractionExecutionResult({ ...observation, frameId: frame.frameId }, [
        {
          type: "image",
          data: Buffer.from(frame.data).toString("base64"),
          mimeType: frame.mediaType,
        },
      ]);
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
      "Perform one action in an exact ComputerSession target. Prefer semantic actions from computer_observe: on macOS they can invoke controls and set values without foregrounding the app. Pointer, keyboard, target focus, screen actions, and clipboard paste use the physical graphical seat and may change the user's foreground app; use them only when foreground control is explicitly intended. Omit fences to use a fresh observation automatically. Returns the durable causal receipt.",
    input: ComputerActInput,
    output: ComputerActionReceipt,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      const current = await input.transport.observeComputerTarget(
        input.workspaceId,
        value.computerSessionId,
        value.targetId,
      );
      return await input.transport.actInComputer(input.workspaceId, value.computerSessionId, {
        operationId: context.operationId,
        targetId: value.targetId,
        expectedTargetGeneration: value.expectedTargetGeneration ?? current.target.targetGeneration,
        expectedObservationId:
          value.expectedObservationId === undefined
            ? current.observationId
            : value.expectedObservationId,
        expectedFrameId:
          value.expectedFrameId === undefined
            ? value.action.type === "pointer"
              ? value.action.frameId
              : null
            : value.expectedFrameId,
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

  return definitions;
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
  fetch?: typeof globalThis.fetch;
};

/**
 * Construct the canonical Browser/Computer attempt definitions against the
 * ordinary OpenGeni control plane. MCP/Codemode never receive controller keys,
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
  if (value.browserSessionId) {
    session = await transport.getBrowserSession(workspaceId, value.browserSessionId);
  } else {
    const listed =
      value.mode === "new" ? { sessions: [] } : await transport.listBrowserSessions(workspaceId);
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
      session = (
        await transport.createBrowserSession(workspaceId, {
          operationId: context.operationId,
          sessionId: sourceSessionId,
          ...(value.name ? { name: value.name } : {}),
          ...(value.initialUrl ? { initialUrl: value.initialUrl } : {}),
          headless: requestedHeadless,
          ...(value.placement ? { placement: value.placement } : {}),
          ...(value.identityId ? { identityId: value.identityId } : {}),
          ...(value.baseRevisionId ? { baseRevisionId: value.baseRevisionId } : {}),
          ...(value.networkRouteId ? { networkRouteId: value.networkRouteId } : {}),
          ...(value.linkedComputerSessionId
            ? { linkedComputerSessionId: value.linkedComputerSessionId }
            : {}),
        })
      ).session;
    }
  }
  if (session.lifecycle === "suspended") {
    session = (
      await transport.resumeBrowserSession(workspaceId, session.id, {
        operationId: context.operationId,
      })
    ).session;
  }
  if (session.lifecycle !== "active") return { session, targets: [] };
  let targets = (await transport.listBrowserTargets(workspaceId, session.id)).targets;
  if (
    value.initialUrl &&
    !created &&
    !targets.some((target) => sameBrowserUrl(target.url, value.initialUrl!))
  ) {
    await transport.openBrowserTarget(workspaceId, session.id, { url: value.initialUrl });
    targets = (await transport.listBrowserTargets(workspaceId, session.id)).targets;
  }
  return { session, targets };
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
      value.mode === "new" ? { sessions: [] } : await transport.listComputerSessions(workspaceId);
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
  requested: z.infer<typeof InteractionPlacement> | undefined,
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
  const stack = [...roots].reverse().map((node) => ({ node, depth: 0, withinScope: !scopeRef }));
  while (stack.length > 0) {
    const next = stack.pop()!;
    const withinScope = next.withinScope || next.node.ref === scopeRef;
    flattened.push({
      node: next.node,
      depth: next.depth,
      index: flattened.length,
      withinScope,
    });
    for (const child of [...(next.node.children ?? [])].reverse()) {
      stack.push({ node: child, depth: next.depth + 1, withinScope });
    }
  }
  return flattened;
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
    states: source.states.slice(0, 6).map((state) => boundedAgentField(state, clip)),
    actions: source.actions.slice(0, 6).map((action) => boundedAgentField(action, clip)),
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
  const flattened = flattenBrowserNodes(roots);
  const projected = selectAgentNodes(
    flattened,
    BROWSER_AGENT_MAX_NODES,
    BROWSER_AGENT_MAX_NODE_BYTES,
  );
  return {
    ...observation,
    semantic: null,
    agentView: {
      kind: "compact",
      sourceKind: semantic?.kind ?? "none",
      nodes: projected.nodes,
      sourceNodeCount: flattened.length,
      omittedNodeCount: flattened.length - projected.nodes.length,
      removedRefCount: semantic?.kind === "diff" ? semantic.removedRefs.length : 0,
      clippedFieldCount: projected.clippedFieldCount,
      maxNodes: BROWSER_AGENT_MAX_NODES,
      maxNodeBytes: BROWSER_AGENT_MAX_NODE_BYTES,
    },
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

async function safeInteractionExecution<TInput extends z.ZodType, TOutput extends z.ZodType>(
  inputSchema: TInput,
  outputSchema: TOutput,
  raw: Record<string, unknown>,
  context: AttemptToolExecutionContext,
  execute: (
    value: z.output<TInput>,
    context: AttemptToolExecutionContext,
  ) => Promise<z.input<TOutput> | InteractionExecutionResult<z.input<TOutput>>>,
): Promise<AttemptToolResultValue> {
  try {
    const value = inputSchema.parse(raw);
    const executed = await execute(value, context);
    const structuredContent = outputSchema.parse(
      executed instanceof InteractionExecutionResult ? executed.output : executed,
    );
    const result = {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
        ...(executed instanceof InteractionExecutionResult ? executed.additionalContent : []),
      ],
      structuredContent: structuredContent as NonNullable<
        AttemptToolResultValue["structuredContent"]
      >,
    };
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return interactionErrorResult("invalid_arguments", "Interaction tool arguments are invalid.");
    }
    if (error instanceof OpenGeniApiError && !error.outcomeUnknown && error.status < 500) {
      return interactionErrorResult(
        error.code ?? `http_${error.status}`,
        boundedErrorMessage(error.message),
        error.retryable,
      );
    }
    throw error;
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

function interactionErrorResult(
  code: string,
  message: string,
  retryable = false,
): AttemptToolResultValue {
  const error = { code, message, retryable };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}

function jsonSchema(schema: z.ZodType): AttemptToolJsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as AttemptToolJsonSchema;
}

function hasToolPermission(permissions: readonly Permission[], required: Permission): boolean {
  return permissions.includes(required) || permissions.includes("workspace:admin");
}

function firstPartyApiBaseUrl(settings: Settings, workspaceId: string): string {
  const url = new URL(firstPartyMcpInternalWorkspaceUrl(settings, workspaceId));
  const suffix = `/v1/workspaces/${workspaceId}/mcp`;
  if (!url.pathname.endsWith(suffix)) {
    throw new Error("First-party MCP URL cannot be projected to the OpenGeni API base URL");
  }
  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function boundedErrorMessage(message: string): string {
  return message.length <= 1_024 ? message : `${message.slice(0, 1_021)}...`;
}
