import { createHash } from "node:crypto";

import type { AccessGrant } from "@opengeni/contracts";
import type {
  EditableArtifactAgentApplication,
  EditableArtifactAgentCommandBatch,
  EditableArtifactAgentContext,
  EditableArtifactAgentQuery,
} from "@opengeni/core/editable-artifacts";
import {
  editableArtifactClientTransactionId,
  editableArtifactId,
} from "@opengeni/core/editable-artifacts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import type { ApiRouteDeps } from "@opengeni/core";
import { editableArtifactActorForGrant } from "../routes/editable-artifacts";

const ArtifactId = z.string().regex(/^[0-9a-f]{32}$/u);
const StateHash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const PortableId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const Modality = z.enum(["spreadsheet", "document", "presentation"]);
const Format = z.enum(["xlsx", "pptx", "docx", "pdf", "png", "webp"]);
const JsonRecord = z.record(z.string(), z.unknown());
const ArtifactQuery = JsonRecord.describe(
  "Typed query for the selected modality. Spreadsheet: workbook-metadata or viewport. Document: summary, body, story, sections, or review. Presentation: metadata, slide-catalog, editor-slide, resolved-slide, viewport, or hit-test.",
);
const ArtifactCommand = z
  .object({ kind: z.string().min(1).max(128) })
  .passthrough()
  .describe(
    "One canonical modality command. Use the exact OpenGeni document, spreadsheet, or presentation skill command contract; never send local-file facade calls here.",
  );

const ArtifactMetadata = z
  .object({
    id: ArtifactId,
    modality: Modality,
    title: z.string(),
    lifecycle: z.enum(["active", "archived"]),
    headSequence: z.number().int().nonnegative(),
    stateHash: StateHash,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const MutationReceipt = z
  .object({
    artifact: ArtifactMetadata,
    transaction: z
      .object({
        id: z.string(),
        clientTransactionId: z.string(),
        sequenceStart: z.number().int().positive(),
        sequenceEnd: z.number().int().positive(),
        stateHash: z.string(),
        committedAt: z.string(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();
const ExportFile = z
  .object({
    fileId: z.string().uuid(),
    filename: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    artifactId: ArtifactId,
    versionId: z.string(),
    materializationJobId: z.string(),
    sourceHeadSequence: z.number().int().nonnegative(),
    sourceStateHash: z.string(),
  })
  .strict();

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type RegisterEditableArtifactToolsInput = Readonly<{
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize(): Promise<void>;
}>;

/** Register the one canonical agent artifact surface used directly and by CodeMode. */
export function registerEditableArtifactAgentTools(
  input: RegisterEditableArtifactToolsInput,
): void {
  const application = () => requireApplication(input.deps);
  const context = (toolName: string, extra: ToolExtra) =>
    artifactAttemptContext(input.grant, input.sessionId, toolName, extra);
  const execute = async <T>(
    operation: () => Promise<T>,
  ): Promise<ReturnType<typeof jsonResult>> => {
    await input.authorize();
    return jsonResult(await operation());
  };

  input.server.registerTool(
    "editable_artifact_list",
    {
      title: "List session artifacts",
      description:
        "List the durable editable workbooks, documents, and presentations used in this session. These are the same live artifacts visible to the user.",
      inputSchema: { limit: z.number().int().min(1).max(64).optional() },
      outputSchema: { artifacts: z.array(ArtifactMetadata) },
      annotations: readOnlyAnnotations("List session artifacts"),
    },
    async ({ limit }, extra) =>
      await execute(async () => ({
        artifacts: await application().list({
          ...context("editable_artifact_list", extra),
          ...(limit === undefined ? {} : { limit }),
        }),
      })),
  );

  input.server.registerTool(
    "editable_artifact_create",
    {
      title: "Create editable artifact",
      description:
        "Create an empty durable workbook, document, or presentation and associate it with this session. Continue editing it with editable_artifact_apply; do not create a shadow Office file.",
      inputSchema: {
        modality: Modality,
        title: z.string().trim().min(1).max(512),
      },
      outputSchema: ArtifactMetadata,
      annotations: mutationAnnotations("Create editable artifact", { idempotent: true }),
    },
    async ({ modality, title }, extra) => {
      const invocation = context("editable_artifact_create", extra);
      return await execute(
        async () =>
          await application().create({
            ...invocation,
            idempotencyKey: editableArtifactClientTransactionId(invocation.operationKey),
            modality,
            title,
            signal: extra.signal,
          }),
      );
    },
  );

  input.server.registerTool(
    "editable_artifact_import",
    {
      title: "Import Office file",
      description:
        "Import one ready workspace DOCX, XLSX, or PPTX file into a new durable editable artifact. The imported artifact becomes the shared working state; the source file remains immutable provenance.",
      inputSchema: {
        fileId: z.string().uuid(),
        modality: Modality,
        title: z.string().trim().min(1).max(512),
      },
      outputSchema: ArtifactMetadata,
      annotations: mutationAnnotations("Import Office file", { idempotent: true }),
    },
    async ({ fileId, modality, title }, extra) => {
      const invocation = context("editable_artifact_import", extra);
      return await execute(
        async () =>
          await application().import({
            ...invocation,
            idempotencyKey: editableArtifactClientTransactionId(invocation.operationKey),
            fileId,
            modality,
            title,
            signal: extra.signal,
          }),
      );
    },
  );

  input.server.registerTool(
    "editable_artifact_get",
    {
      title: "Get editable artifact",
      description:
        "Read current durable metadata for one editable artifact and associate it with this session.",
      inputSchema: { artifactId: ArtifactId },
      outputSchema: ArtifactMetadata,
      annotations: readOnlyAnnotations("Get editable artifact"),
    },
    async ({ artifactId }, extra) =>
      await execute(
        async () =>
          await application().get({
            ...context("editable_artifact_get", extra),
            artifactId: editableArtifactId(artifactId),
          }),
      ),
  );

  input.server.registerTool(
    "editable_artifact_inspect",
    {
      title: "Inspect editable artifact",
      description:
        "Query the artifact's current canonical head through the same native kernel used by the browser. Use bounded modality queries; results are current, not a sandbox-file snapshot.",
      inputSchema: {
        artifactId: ArtifactId,
        modality: Modality,
        query: ArtifactQuery,
      },
      outputSchema: { artifact: ArtifactMetadata, projection: z.unknown() },
      annotations: readOnlyAnnotations("Inspect editable artifact"),
    },
    async ({ artifactId, modality, query }, extra) =>
      await execute(
        async () =>
          await application().inspect({
            ...context("editable_artifact_inspect", extra),
            artifactId: editableArtifactId(artifactId),
            request: { modality, query } as EditableArtifactAgentQuery,
          }),
      ),
  );

  input.server.registerTool(
    "editable_artifact_apply",
    {
      title: "Edit editable artifact",
      description:
        "Atomically apply a bounded modality command batch to the current durable artifact head. Inspect first, use stable object IDs from that projection, and verify the result afterward.",
      inputSchema: {
        artifactId: ArtifactId,
        modality: Modality,
        expectedHeadSequence: z.number().int().nonnegative(),
        expectedStateHash: StateHash,
        commands: z.array(ArtifactCommand).min(1).max(4_096),
      },
      outputSchema: MutationReceipt,
      annotations: mutationAnnotations("Edit editable artifact", {
        destructive: true,
        idempotent: true,
      }),
    },
    async ({ artifactId, modality, expectedHeadSequence, expectedStateHash, commands }, extra) => {
      const invocation = context("editable_artifact_apply", extra);
      return await execute(
        async () =>
          await application().apply({
            ...invocation,
            artifactId: editableArtifactId(artifactId),
            clientTransactionId: editableArtifactClientTransactionId(invocation.operationKey),
            expectedHeadSequence,
            expectedStateHash,
            batch: { modality, commands } as EditableArtifactAgentCommandBatch,
          }),
      );
    },
  );

  input.server.registerTool(
    "editable_artifact_export",
    {
      title: "Export editable artifact",
      description:
        "Pin the current artifact head and start an immutable Office/PDF/image export. This does not write into the sandbox. Poll editable_artifact_export_status for the resulting workspace file ID.",
      inputSchema: {
        artifactId: ArtifactId,
        format: Format,
        options: JsonRecord.optional(),
      },
      outputSchema: {
        artifact: ArtifactMetadata,
        versionId: z.string(),
        jobId: z.string(),
        sourceHeadSequence: z.number().int().nonnegative(),
        sourceStateHash: z.string(),
        state: z.enum(["pending", "running", "succeeded", "failed"]),
      },
      annotations: mutationAnnotations("Export editable artifact", { idempotent: true }),
    },
    async ({ artifactId, format, options }, extra) => {
      const invocation = context("editable_artifact_export", extra);
      return await execute(
        async () =>
          await application().startExport({
            ...invocation,
            artifactId: editableArtifactId(artifactId),
            idempotencyKey: invocation.operationKey,
            format,
            ...(options ? { options } : {}),
            signal: extra.signal,
          }),
      );
    },
  );

  input.server.registerTool(
    "editable_artifact_export_status",
    {
      title: "Get artifact export",
      description:
        "Read export status. When complete, atomically promote the immutable result into the workspace file domain and return its file ID; download it only when sandbox-local bytes are actually needed.",
      inputSchema: {
        artifactId: ArtifactId,
        versionId: PortableId,
        jobId: PortableId,
      },
      outputSchema: {
        artifact: ArtifactMetadata,
        versionId: z.string(),
        jobId: z.string(),
        sourceHeadSequence: z.number().int().nonnegative(),
        sourceStateHash: z.string(),
        state: z.enum(["pending", "running", "succeeded", "failed"]),
        errorCode: z.string().nullable(),
        file: ExportFile.nullable(),
      },
      annotations: mutationAnnotations("Get artifact export", { idempotent: true }),
    },
    async ({ artifactId, versionId, jobId }, extra) =>
      await execute(
        async () =>
          await application().exportStatus({
            ...context("editable_artifact_export_status", extra),
            artifactId: editableArtifactId(artifactId),
            versionId,
            jobId,
            signal: extra.signal,
          }),
      ),
  );
}

function artifactAttemptContext(
  grant: AccessGrant,
  sessionId: string,
  toolName: string,
  extra: ToolExtra,
): EditableArtifactAgentContext & Readonly<{ operationKey: string }> {
  const operationId = trustedOperationId(extra);
  const digest = createHash("sha256")
    .update("opengeni:editable-artifact-agent-call:v1\0", "utf8")
    .update(grant.accountId, "utf8")
    .update("\0", "utf8")
    .update(grant.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .update("\0", "utf8")
    .update(String(grant.metadata?.["turnId"] ?? ""), "utf8")
    .update("\0", "utf8")
    .update(String(grant.metadata?.["attemptId"] ?? ""), "utf8")
    .update("\0", "utf8")
    .update(String(grant.metadata?.["executionGeneration"] ?? ""), "utf8")
    .update("\0", "utf8")
    .update(toolName, "utf8")
    .update("\0", "utf8")
    .update(operationId, "utf8")
    .digest("hex");
  const replicaId =
    digest.slice(0, 16) === "0".repeat(16) ? `1${digest.slice(1, 16)}` : digest.slice(0, 16);
  const actor = editableArtifactActorForGrant(grant, replicaId);
  if (actor.kind !== "agent" || actor.sessionId !== sessionId) {
    throw new Error("Editable artifact tools require exact signed attempt authority");
  }
  return Object.freeze({
    scope: Object.freeze({ accountId: grant.accountId, workspaceId: grant.workspaceId }),
    actor,
    sessionId,
    operationKey: `artifact:${toolName}:${digest}`,
  });
}

function trustedOperationId(extra: ToolExtra): string {
  const value = extra._meta?.["opengeniOperationId"];
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/u.test(value)) return value;
  const requestId = String(extra.requestId);
  if (requestId.length < 1 || requestId.length > 256) {
    throw new Error("Editable artifact tool request identity is invalid");
  }
  return requestId;
}

function requireApplication(deps: ApiRouteDeps): EditableArtifactAgentApplication {
  if (!deps.editableArtifactAgent) {
    throw new Error("Editable artifact agent service is unavailable");
  }
  return deps.editableArtifactAgent;
}

function jsonResult(value: unknown) {
  const structuredContent = jsonValue(value);
  if (!isRecord(structuredContent)) {
    throw new Error("Editable artifact tool result must be an object");
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Artifact result contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Uint8Array) {
    return Object.freeze({ encoding: "base64", data: Buffer.from(value).toString("base64") });
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) output[key] = jsonValue(entry);
    }
    return output;
  }
  throw new Error("Artifact result contains unsupported data");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOnlyAnnotations(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
}

function mutationAnnotations(
  title: string,
  options: Readonly<{ destructive?: boolean; idempotent: boolean }>,
) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: options.destructive === true,
    idempotentHint: options.idempotent,
    openWorldHint: false,
  } as const;
}
