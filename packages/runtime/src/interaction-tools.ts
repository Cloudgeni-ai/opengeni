import {
  AttachedBrowserDevice,
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  BrowserAction,
  BrowserActionBatch,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserObservation,
  BrowserRevisionListResponse,
  BrowserSession,
  BrowserSessionMutationResponse,
  BrowserTarget,
  BrowserTargetListResponse,
  ComputerAction,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerSession,
  ComputerSessionMutationResponse,
  ComputerTarget,
  ComputerTargetListResponse,
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
  firstPartyMcpWorkspaceUrl,
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
import {
  MCP_MAX_TOOL_RESULT_BYTES,
  McpPayloadTooLargeError,
  assertMcpPayloadWithinBytes,
  guardedMcpFetch,
} from "./mcp-network";

export const INTERACTION_ATTEMPT_TOOL_NAMES = FIRST_PARTY_IN_PROCESS_TOOL_NAMES;

export type InteractionAttemptToolName = (typeof INTERACTION_ATTEMPT_TOOL_NAMES)[number];

const TOOL_PERMISSION = {
  interaction_discover: "sessions:read",
  browser_open: "sessions:control",
  browser_tabs: "sessions:control",
  browser_observe: "sessions:read",
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
  computer_act: "sessions:control",
  computer_lifecycle: "sessions:control",
} as const satisfies Record<InteractionAttemptToolName, Permission>;

const DiscoveryInput = z
  .object({
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
    if (value.browserSessionId && (value.identityId || value.baseRevisionId || value.placement)) {
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
  })
  .strict();
const BrowserActInput = z
  .object({
    browserSessionId: z.string().uuid(),
    targetId: z.string().min(1).max(512),
    expectedTargetGeneration: z.string().min(1).max(256).optional(),
    expectedDocumentGeneration: z.string().min(1).max(256).nullable().optional(),
    expectedFrameId: z.string().min(1).max(256).nullable().optional(),
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
const BrowserIdentityInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), includeArchived: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("get"), identityId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("create"), name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ operation: z.literal("revisions"), identityId: z.string().uuid() }).strict(),
]);
const BrowserIdentityOutput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), result: BrowserIdentityListResponse }).strict(),
  z.object({ operation: z.literal("get"), result: BrowserIdentity }).strict(),
  z.object({ operation: z.literal("create"), result: BrowserIdentityMutationResponse }).strict(),
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
    ) => Promise<z.input<TOutput>>;
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
      inputSchema: jsonSchema(options.input),
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
      "List live workspace BrowserSessions, ComputerSessions, reusable browser identities, and attached Chrome devices. Resources are workspace-visible: inspect and reuse relevant peer/child sessions instead of creating duplicates.",
    input: DiscoveryInput,
    output: DiscoveryOutput,
    readOnly: true,
    idempotent: true,
    execute: async (value) => {
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
        browsers: value.includeTerminal
          ? browsers.sessions
          : browsers.sessions.filter((session) => !TERMINAL_LIFECYCLES.has(session.lifecycle)),
        computers: value.includeTerminal
          ? computers.sessions
          : computers.sessions.filter((session) => !TERMINAL_LIFECYCLES.has(session.lifecycle)),
        identities: identities.identities,
        attachedBrowsers: attached.devices,
      };
    },
  });

  add({
    name: "browser_open",
    codemodePath: ["interaction", "browser", "open"],
    title: "Open or reuse browser",
    description:
      "Open a managed BrowserSession on the current agent placement, reuse a relevant live session by default, or attach to an explicit workspace BrowserSession. Returns exact session and tab state.",
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
      "List, open, select, or close tabs in one exact BrowserSession. Returns the authoritative complete tab list after the operation.",
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
      "Read one tab's current URL/title, causal generations, compact semantic accessibility tree, dialog, and diagnostic counts without taking control.",
    input: BrowserObserveInput,
    output: BrowserObservation,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await input.transport.observeBrowserTarget(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
      ),
  });

  add({
    name: "browser_act",
    codemodePath: ["interaction", "browser", "act"],
    title: "Act in browser tab",
    description:
      "Perform one semantic-first browser action or bounded batch. Omit generation fences to use a fresh observation automatically; provide them to require exact previously observed state. Returns the durable receipt and changed observation.",
    input: BrowserActInput,
    output: BrowserActionReceipt,
    readOnly: false,
    idempotent: true,
    execute: async (value, context) => {
      const current = await input.transport.observeBrowserTarget(
        input.workspaceId,
        value.browserSessionId,
        value.targetId,
      );
      return await input.transport.actInBrowser(input.workspaceId, value.browserSessionId, {
        operationId: context.operationId,
        targetId: value.targetId,
        expectedTargetGeneration: value.expectedTargetGeneration ?? current.target.targetGeneration,
        expectedDocumentGeneration:
          value.expectedDocumentGeneration === undefined
            ? current.target.documentGeneration
            : value.expectedDocumentGeneration,
        expectedFrameId:
          value.expectedFrameId === undefined ? current.frameId : value.expectedFrameId,
        action: value.action,
      });
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
      "List configured site-auth connections and durable auth runs, or start, advance, protected-fill, and verify one exact BrowserSession authentication run. Protected secret values never enter tool arguments or results. If protected fill returns needs_human, call interaction_request_human with the returned intervention id.",
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
      "Pause the current agent turn for a person to act in one exact browser tab or computer target. Use operation=wait for an intervention already returned by browser_auth; otherwise provide the exact observed resource generations and a concise reason. The same tool call resumes with the settled intervention and a fresh observation.",
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
      "List, inspect, create, or list immutable revisions of reusable BrowserIdentities. Live browser state changes only through explicit browser_publish; identities are never mutated automatically.",
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
      "Read one ComputerSession app/window/screen target, causal generation, semantic accessibility tree, focus, and frame identity without taking control.",
    input: ComputerObserveInput,
    output: ComputerObservation,
    readOnly: true,
    idempotent: true,
    execute: async (value) =>
      await input.transport.observeComputerTarget(
        input.workspaceId,
        value.computerSessionId,
        value.targetId,
      ),
  });

  add({
    name: "computer_act",
    codemodePath: ["interaction", "computer", "act"],
    title: "Act in app or window",
    description:
      "Perform one semantic, keyboard, pointer, focus, or launch action in an exact ComputerSession target. Omit fences to use a fresh observation automatically. Returns the durable causal receipt.",
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
  if (value.browserSessionId) {
    session = await transport.getBrowserSession(workspaceId, value.browserSessionId);
  } else {
    const listed = await transport.listBrowserSessions(workspaceId);
    const reusable = value.mode === "new" ? null : newestRelevant(listed.sessions, sourceSessionId);
    if (reusable) {
      session = reusable;
    } else {
      session = (
        await transport.createBrowserSession(workspaceId, {
          operationId: context.operationId,
          sessionId: sourceSessionId,
          ...(value.name ? { name: value.name } : {}),
          ...(value.initialUrl ? { initialUrl: value.initialUrl } : {}),
          ...(value.headless !== undefined ? { headless: value.headless } : {}),
          ...(value.placement ? { placement: value.placement } : {}),
          ...(value.identityId ? { identityId: value.identityId } : {}),
          ...(value.baseRevisionId ? { baseRevisionId: value.baseRevisionId } : {}),
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
  if (value.initialUrl && !targets.some((target) => target.url === value.initialUrl)) {
    await transport.openBrowserTarget(workspaceId, session.id, { url: value.initialUrl });
    targets = (await transport.listBrowserTargets(workspaceId, session.id)).targets;
  }
  return { session, targets };
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
    const listed = await transport.listComputerSessions(workspaceId);
    const reusable = value.mode === "new" ? null : newestRelevant(listed.sessions, sourceSessionId);
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

async function safeInteractionExecution<TInput extends z.ZodType, TOutput extends z.ZodType>(
  inputSchema: TInput,
  outputSchema: TOutput,
  raw: Record<string, unknown>,
  context: AttemptToolExecutionContext,
  execute: (
    value: z.output<TInput>,
    context: AttemptToolExecutionContext,
  ) => Promise<z.input<TOutput>>,
): Promise<AttemptToolResultValue> {
  try {
    const value = inputSchema.parse(raw);
    const structuredContent = outputSchema.parse(await execute(value, context));
    const result = {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent: structuredContent as NonNullable<
        AttemptToolResultValue["structuredContent"]
      >,
    };
    assertMcpPayloadWithinBytes(result, MCP_MAX_TOOL_RESULT_BYTES, "interaction tool result");
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return interactionErrorResult("invalid_arguments", "Interaction tool arguments are invalid.");
    }
    if (error instanceof McpPayloadTooLargeError) {
      return interactionErrorResult(
        "result_too_large",
        "Interaction result exceeded the bounded tool-result size; narrow the request.",
      );
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
  const url = new URL(firstPartyMcpWorkspaceUrl(settings, workspaceId));
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
