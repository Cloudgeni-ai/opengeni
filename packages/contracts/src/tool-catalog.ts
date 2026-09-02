import { z } from "zod";

export const ATTEMPT_TOOL_CATALOG_VERSION = 1 as const;
export const TOOL_GATEWAY_CATALOG_VERSION = 1 as const;
export const ATTEMPT_TOOL_CATALOG_MAX_ENTRIES = 4_096;
export const ATTEMPT_TOOL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const ATTEMPT_TOOL_CATALOG_MAX_PATH_SEGMENTS = 8;
export const ATTEMPT_TOOL_CATALOG_MAX_CONTENT_BLOCKS = 1_024;
export const CODEMODE_OPERATION_VERSION = 1 as const;
export const CODEMODE_ARGUMENTS_MAX_BYTES = 4 * 1024 * 1024;
export const CODEMODE_RESULT_MAX_BYTES = 16 * 1024 * 1024;
export const CODEMODE_DISPATCH_TIMEOUT_MS = 5_000;
export const CODEMODE_CLAIM_LEASE_MS = 30_000;
export const CODEMODE_CLAIM_HEARTBEAT_MS = 10_000;
export const CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT = 16;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const serverIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const toolIdentifier = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const namespaceSegment = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value), {
    message: "unsafe Codemode namespace segment",
  });
const jsonObject = z.record(z.string().max(512), z.json());

/** Opaque authority identity. Display/wire names must never be parsed as authority. */
export const AttemptToolIdentity = z
  .object({
    serverId: serverIdentifier,
    toolName: toolIdentifier,
  })
  .strict();
export type AttemptToolIdentity = z.infer<typeof AttemptToolIdentity>;

/** Protocol-neutral tool identity shared by MCP, HTTP/SDK, agents, and Codemode. */
export const ToolGatewayIdentity = AttemptToolIdentity;
export type ToolGatewayIdentity = AttemptToolIdentity;

export const AttemptToolCatalogIcon = z
  .object({
    src: z.string().min(1).max(8_192),
    mimeType: z.string().min(1).max(128).optional(),
    sizes: z.array(z.string().min(1).max(64)).max(16).optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .strict();
export type AttemptToolCatalogIcon = z.infer<typeof AttemptToolCatalogIcon>;

/** MCP annotations retained without inventing stronger effect guarantees. */
export const AttemptToolAnnotations = z
  .object({
    title: z.string().max(512).optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .loose();
export type AttemptToolAnnotations = z.infer<typeof AttemptToolAnnotations>;

/** JSON Schema is preserved as received. Runtime byte/node guards remain authoritative. */
export const AttemptToolJsonSchema = jsonObject;
export type AttemptToolJsonSchema = z.infer<typeof AttemptToolJsonSchema>;

export const AttemptToolCatalogEntry = z
  .object({
    identity: AttemptToolIdentity,
    /** Exact model-wire projection for this generation, e.g. `slack__search`. */
    modelName: toolIdentifier,
    /** Safe generated Codemode namespace; convenience only, never authority. */
    codemodePath: z.array(namespaceSegment).min(2).max(ATTEMPT_TOOL_CATALOG_MAX_PATH_SEGMENTS),
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(32_768).optional(),
    inputSchema: AttemptToolJsonSchema,
    outputSchema: AttemptToolJsonSchema.optional(),
    annotations: AttemptToolAnnotations.optional(),
    icons: z.array(AttemptToolCatalogIcon).max(16).optional(),
    source: z.enum(["opengeni", "files", "docs", "mcp", "codex_apps", "interaction"]),
    approval: z.enum(["none", "human", "policy"]),
  })
  .strict();
export type AttemptToolCatalogEntry = z.infer<typeof AttemptToolCatalogEntry>;

/** One canonical gateway entry. Adapter-specific names are projections, never authority. */
export const ToolGatewayCatalogEntry = AttemptToolCatalogEntry;
export type ToolGatewayCatalogEntry = AttemptToolCatalogEntry;

export const ToolGatewayCatalog = z
  .object({
    version: z.literal(TOOL_GATEWAY_CATALOG_VERSION),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    generation: z.number().int().positive(),
    digest: sha256,
    createdAt: z.string().datetime({ offset: true }),
    entries: z.array(ToolGatewayCatalogEntry).max(ATTEMPT_TOOL_CATALOG_MAX_ENTRIES),
  })
  .strict()
  .superRefine((catalog, context) => {
    const identities = new Set<string>();
    const modelNames = new Set<string>();
    const toolPaths = new Set<string>();
    for (const [index, entry] of catalog.entries.entries()) {
      const identity = `${entry.identity.serverId}\u0000${entry.identity.toolName}`;
      const toolPath = entry.codemodePath.join(".");
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "identity"],
          message: "duplicate tool identity",
        });
      }
      if (modelNames.has(entry.modelName)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "modelName"],
          message: "duplicate model tool name",
        });
      }
      if (toolPaths.has(toolPath)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "codemodePath"],
          message: "duplicate tool path",
        });
      }
      identities.add(identity);
      modelNames.add(entry.modelName);
      toolPaths.add(toolPath);
    }
  });
export type ToolGatewayCatalog = z.infer<typeof ToolGatewayCatalog>;

export const ToolGatewayCaller = z
  .object({
    kind: z.enum(["model", "codemode", "http", "mcp", "browser"]),
    subjectId: z.string().min(1).max(1_024),
  })
  .strict();
export type ToolGatewayCaller = z.infer<typeof ToolGatewayCaller>;

export const AttemptToolCatalog = z
  .object({
    version: z.literal(ATTEMPT_TOOL_CATALOG_VERSION),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionGeneration: z.number().int().positive(),
    generation: z.number().int().positive(),
    digest: sha256,
    createdAt: z.string().datetime({ offset: true }),
    entries: z.array(AttemptToolCatalogEntry).max(ATTEMPT_TOOL_CATALOG_MAX_ENTRIES),
  })
  .strict()
  .superRefine((catalog, context) => {
    const identities = new Set<string>();
    const modelNames = new Set<string>();
    const codemodePaths = new Set<string>();
    for (const [index, entry] of catalog.entries.entries()) {
      const identity = `${entry.identity.serverId}\u0000${entry.identity.toolName}`;
      const codemodePath = entry.codemodePath.join(".");
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "identity"],
          message: "duplicate tool identity",
        });
      }
      if (modelNames.has(entry.modelName)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "modelName"],
          message: "duplicate model tool name",
        });
      }
      if (codemodePaths.has(codemodePath)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "codemodePath"],
          message: "duplicate Codemode tool path",
        });
      }
      identities.add(identity);
      modelNames.add(entry.modelName);
      codemodePaths.add(codemodePath);
    }
  });
export type AttemptToolCatalog = z.infer<typeof AttemptToolCatalog>;

export const AttemptToolCaller = z
  .object({
    kind: z.enum(["model", "codemode"]),
    subjectId: z.string().min(1).max(1_024),
  })
  .strict();
export type AttemptToolCaller = z.infer<typeof AttemptToolCaller>;

export const AttemptToolCall = z
  .object({
    operationId: z.string().uuid(),
    catalogDigest: sha256,
    identity: AttemptToolIdentity,
    arguments: jsonObject,
    caller: AttemptToolCaller,
  })
  .strict();
export type AttemptToolCall = z.infer<typeof AttemptToolCall>;

const McpAnnotations = z.record(z.string().max(256), z.json()).optional();
const McpMeta = z.record(z.string().max(512), z.json()).optional();

export const AttemptToolTextContent = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    annotations: McpAnnotations,
    _meta: McpMeta,
  })
  .loose();

export const AttemptToolImageContent = z
  .object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string().min(1).max(128),
    annotations: McpAnnotations,
    _meta: McpMeta,
  })
  .loose();

export const AttemptToolAudioContent = z
  .object({
    type: z.literal("audio"),
    data: z.string(),
    mimeType: z.string().min(1).max(128),
    annotations: McpAnnotations,
    _meta: McpMeta,
  })
  .loose();

export const AttemptToolResourceLinkContent = z
  .object({
    type: z.literal("resource_link"),
    name: z.string().min(1).max(1_024),
    title: z.string().max(1_024).optional(),
    uri: z.string().min(1).max(16_384),
    description: z.string().max(32_768).optional(),
    mimeType: z.string().max(128).optional(),
    size: z.number().int().nonnegative().optional(),
    icons: z.array(AttemptToolCatalogIcon).max(16).optional(),
    annotations: McpAnnotations,
    _meta: McpMeta,
  })
  .loose();

const AttemptToolTextResource = z
  .object({
    uri: z.string().min(1).max(16_384),
    mimeType: z.string().max(128).optional(),
    text: z.string(),
    _meta: McpMeta,
  })
  .loose();

const AttemptToolBlobResource = z
  .object({
    uri: z.string().min(1).max(16_384),
    mimeType: z.string().max(128).optional(),
    blob: z.string(),
    _meta: McpMeta,
  })
  .loose();

export const AttemptToolEmbeddedResourceContent = z
  .object({
    type: z.literal("resource"),
    resource: z.union([AttemptToolTextResource, AttemptToolBlobResource]),
    annotations: McpAnnotations,
    _meta: McpMeta,
  })
  .loose();

export const AttemptToolContent = z.discriminatedUnion("type", [
  AttemptToolTextContent,
  AttemptToolImageContent,
  AttemptToolAudioContent,
  AttemptToolResourceLinkContent,
  AttemptToolEmbeddedResourceContent,
]);
export type AttemptToolContent = z.infer<typeof AttemptToolContent>;

/** Exact MCP-shaped result. No output type is fabricated when `outputSchema` is absent. */
export const AttemptToolResult = z
  .object({
    content: z.array(AttemptToolContent).max(ATTEMPT_TOOL_CATALOG_MAX_CONTENT_BLOCKS),
    structuredContent: jsonObject.optional(),
    isError: z.boolean().optional(),
    _meta: McpMeta,
  })
  .loose();
export type AttemptToolResult = z.infer<typeof AttemptToolResult>;

export const ToolGatewayResult = AttemptToolResult;
export type ToolGatewayResult = AttemptToolResult;

export const ToolGatewayCallRequest = z
  .object({
    operationId: z.string().uuid().optional(),
    catalogDigest: sha256,
    identity: ToolGatewayIdentity,
    arguments: jsonObject,
  })
  .strict();
export type ToolGatewayCallRequest = z.infer<typeof ToolGatewayCallRequest>;

export const ToolGatewayCallResponse = z
  .object({
    operationId: z.string().uuid(),
    catalogDigest: sha256,
    result: ToolGatewayResult,
  })
  .strict();
export type ToolGatewayCallResponse = z.infer<typeof ToolGatewayCallResponse>;

export const ToolGatewayDeclarationsResponse = z
  .object({
    catalogDigest: sha256,
    moduleSpecifier: z.string().min(1).max(512),
    source: z.string().max(16 * 1024 * 1024),
  })
  .strict();
export type ToolGatewayDeclarationsResponse = z.infer<typeof ToolGatewayDeclarationsResponse>;

export const CodemodeOperationState = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "outcome_unknown",
  "cancelled",
]);
export type CodemodeOperationState = z.infer<typeof CodemodeOperationState>;

/**
 * Durable, attempt-fenced Codemode operation. `requestDigest` binds an
 * idempotency key to one exact call; callers may safely poll/retry the same
 * operation id but may never repurpose it.
 */
export const CodemodeOperation = z
  .object({
    version: z.literal(CODEMODE_OPERATION_VERSION),
    operationId: z.string().uuid(),
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionGeneration: z.number().int().positive(),
    catalogDigest: sha256,
    requestDigest: sha256,
    identity: AttemptToolIdentity,
    arguments: jsonObject,
    caller: AttemptToolCaller.refine((caller) => caller.kind === "codemode", {
      message: "Codemode operation caller must be codemode",
    }),
    state: CodemodeOperationState,
    result: AttemptToolResult.nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    errorMessage: z.string().min(1).max(4_096).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    claimedAt: z.string().datetime({ offset: true }).nullable(),
    executionStartedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CodemodeOperation = z.infer<typeof CodemodeOperation>;

export const CodemodeCallRequest = z
  .object({
    operationId: z.string().uuid(),
    catalogDigest: sha256,
    identity: AttemptToolIdentity,
    arguments: jsonObject,
  })
  .strict();
export type CodemodeCallRequest = z.infer<typeof CodemodeCallRequest>;

export const CodemodeCallSubmission = z
  .object({
    operation: CodemodeOperation,
    dispatch: z.enum(["accepted", "already_running", "terminal", "unavailable", "rejected"]),
  })
  .strict();
export type CodemodeCallSubmission = z.infer<typeof CodemodeCallSubmission>;

/** Tiny NATS wake-up. Postgres, never the broker payload, is durable truth. */
export const CodemodeDispatchRequest = z
  .object({
    version: z.literal(CODEMODE_OPERATION_VERSION),
    operationId: z.string().uuid(),
    catalogDigest: sha256,
  })
  .strict();
export type CodemodeDispatchRequest = z.infer<typeof CodemodeDispatchRequest>;

export const CodemodeDispatchAck = z
  .object({
    version: z.literal(CODEMODE_OPERATION_VERSION),
    operationId: z.string().uuid(),
    status: z.enum(["accepted", "already_running", "terminal", "unavailable", "rejected"]),
  })
  .strict();
export type CodemodeDispatchAck = z.infer<typeof CodemodeDispatchAck>;
