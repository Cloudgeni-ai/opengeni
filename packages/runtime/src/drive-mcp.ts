import type { MCPServer } from "@openai/agents";
import { z } from "zod";
import { Buffer } from "node:buffer";
import {
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import type { ResolveConnectionCredentialInput, ResolveConnectionCredentialResult } from "./index";
import { nangoProviderDomain } from "@opengeni/contracts/nango";
import {
  NANGO_PROXY_TRANSPORTS,
  sendWithCredential,
  type NangoUsageRecorder,
} from "./nango-transport";
import {
  connectorAttachmentFileName,
  type ConnectorFileMaterializationRequest,
} from "./connector-attachments";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";
import {
  NANGO_DRIVE_MAX_DOWNLOAD_BYTES,
  NANGO_DRIVE_MAX_INLINE_BYTES,
  NANGO_DRIVE_READ_TOOLS,
  isNangoDriveReadTool,
  nangoDriveContentUrl,
  nangoDriveListUrl,
  nangoDriveMetadataUrl,
  nangoDrivePermissionsUrl,
  parseNangoDriveRead,
  projectNangoDriveText,
  type NangoDriveReadName,
} from "./drive-nango-read-tools";

export const OFFICIAL_DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";
const api = "https://www.googleapis.com/drive/v3/";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const file = { fileId: id };
const role = z.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer"]);
const definitions = {
  update_file: {
    description:
      "Rename a file or update its description. Requires the app's existing drive.file access to this file.",
    schema: z
      .object({
        ...file,
        name: z.string().min(1).max(1024).optional(),
        description: z.string().max(16000).optional(),
      })
      .strict(),
  },
  overwrite_file_content: {
    description:
      "Overwrite the bytes of an existing binary file, preserving its ID. Requires drive.file access. Does not edit native Google Docs/Sheets contents.",
    schema: z
      .object({
        ...file,
        base64Content: z.string().max(34952536),
        contentMimeType: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[\w.+-]+\/[\w.+-]+$/u),
      })
      .strict(),
  },
  move_file: {
    description:
      "Move an existing file between folders. Specify the current parent and destination. Requires drive.file access.",
    schema: z.object({ ...file, fromParentId: id, toParentId: id }).strict(),
  },
  trash_file: {
    description: "Move a file to Trash. Requires drive.file access.",
    schema: z.object(file).strict(),
  },
  restore_file: {
    description: "Restore a file from Trash. Requires drive.file access.",
    schema: z.object(file).strict(),
  },
  delete_file: {
    description: "Permanently delete a file. This cannot be undone. Requires drive.file access.",
    schema: z.object(file).strict(),
  },
  create_permission: {
    description:
      "Share a file with a user, group, domain, or anyone. Requires drive.file access and sharing permission. Never transfers ownership.",
    schema: z
      .object({
        ...file,
        type: z.enum(["user", "group", "domain", "anyone"]),
        role,
        emailAddress: z.string().email().optional(),
        domain: z.string().min(1).max(253).optional(),
        allowFileDiscovery: z.boolean().optional(),
      })
      .strict(),
  },
  update_permission: {
    description:
      "Change an existing sharing permission's role. Never transfers ownership. Requires drive.file access.",
    schema: z.object({ ...file, permissionId: id, role }).strict(),
  },
  delete_permission: {
    description: "Remove a file's sharing permission. Requires drive.file access.",
    schema: z.object({ ...file, permissionId: id }).strict(),
  },
  get_changes_start_token: {
    description:
      "Get a Drive change-feed checkpoint for an ordinary scheduled agent. Save the returned token for list_changes.",
    schema: z.object({ driveId: id.optional() }).strict(),
  },
  list_changes: {
    description:
      "Read a page of changes since a saved pageToken. Follow nextPageToken; save newStartPageToken only after processing every page. Removed items do not grant access to their old contents.",
    schema: z
      .object({
        pageToken: z.string().min(1).max(2048),
        driveId: id.optional(),
        pageSize: z.number().int().min(1).max(1000).default(100),
      })
      .strict(),
  },
};
type ExtraName = keyof typeof definitions;
const readNames = new Set<ExtraName>(["get_changes_start_token", "list_changes"]);
export const DRIVE_EXTRA_TOOLS = Object.entries(definitions).map(([name, definition]) => ({
  name,
  description: definition.description,
  inputSchema: z.toJSONSchema(definition.schema) as Awaited<
    ReturnType<MCPServer["listTools"]>
  >[number]["inputSchema"],
  annotations: {
    readOnlyHint: readNames.has(name as ExtraName),
    destructiveHint: !readNames.has(name as ExtraName),
    idempotentHint: readNames.has(name as ExtraName),
    openWorldHint: true,
  },
}));
export const DRIVE_MCP_BRIDGE_DESCRIPTOR = defineLocalMcpBridgeDescriptor({
  adapterId: "drive-mcp-extensions",
  providerId: "google-drive",
  catalogIdentity: `mcp:${OFFICIAL_DRIVE_MCP_URL}`,
  authority: "connection",
  toolSurface: "remote_with_reviewed_extensions",
  mutationReplay: "safe_reads_only",
  destinations: [
    { origin: "https://drivemcp.googleapis.com", pathPrefix: "/mcp/v1" },
    { origin: "https://www.googleapis.com", pathPrefix: "/drive/v3/" },
    { origin: "https://www.googleapis.com", pathPrefix: "/upload/drive/v3/files/" },
  ],
});
export type DriveMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef | undefined;
};
export type DriveMcpBridgeContext = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  resolveCredential: (
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
  createRemoteServer: () => MCPServer;
  /** Best-effort accounting for requests sent through the Nango proxy. */
  recordNangoUsage?: NangoUsageRecorder;
  /** Saves a downloaded file to the agent's files (Nango-served downloads). */
  materializeConnectorFile?: (request: ConnectorFileMaterializationRequest) => Promise<unknown>;
};
type DriveToolResult = Awaited<ReturnType<NonNullable<MCPServer["callToolResult"]>>>;
type ParsedCall = {
  [Name in ExtraName]: { name: Name; input: z.infer<(typeof definitions)[Name]["schema"]> };
}[ExtraName];
function inputError(text: string): DriveToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
export class DriveMcpServer implements LocalMcpBridgeServer {
  readonly bridge = DRIVE_MCP_BRIDGE_DESCRIPTOR;
  readonly cacheToolsList = false;
  readonly name: string;
  /** Absent when Drive is routed through Nango: reads then come from Drive REST. */
  private readonly remote: MCPServer | null;
  constructor(
    private readonly config: DriveMcpBridgeConfig,
    private readonly context: DriveMcpBridgeContext,
  ) {
    this.remote = isNangoDriveConfig(config) ? null : context.createRemoteServer();
    this.name =
      this.remote?.name ??
      `opengeni-drive-rest-${context.serverId.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
  }
  async connect() {
    await this.remote?.connect();
  }
  async close() {
    await this.remote?.close();
  }
  async invalidateToolsCache() {
    await this.remote?.invalidateToolsCache();
  }
  async listTools() {
    if (!this.remote)
      return [...structuredClone(NANGO_DRIVE_READ_TOOLS), ...structuredClone(DRIVE_EXTRA_TOOLS)];
    return mergeDriveMcpTools(await this.remote.listTools());
  }
  async callTool(
    name: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ) {
    return (await this.callToolResult(name, args, meta, options)).content;
  }
  async callToolResult(
    name: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<DriveToolResult> {
    options?.signal?.throwIfAborted();
    if (!this.remote && isNangoDriveReadTool(name))
      return await this.callRestRead(name, args, meta, options);
    if (!Object.hasOwn(definitions, name)) {
      const remote = this.remote;
      if (!remote) return inputError(`Unknown Google Drive tool: ${name}`);
      if (remote.callToolResult) return remote.callToolResult(name, args, meta, options);
      return { content: await remote.callTool(name, args, meta, options) };
    }
    const tool = name as ExtraName;
    const parsed = definitions[tool].schema.safeParse(args ?? {});
    if (!parsed.success)
      return { isError: true, content: [{ type: "text", text: parsed.error.message }] };
    const call = { name: tool, input: parsed.data } as ParsedCall;
    const fileId = "fileId" in call.input ? call.input.fileId : undefined;
    const url = new URL(api + (fileId ? `files/${fileId}` : "changes"));
    const request: RequestInit = { method: "GET" };
    let body: Record<string, unknown> | undefined;
    if (fileId) url.searchParams.set("supportsAllDrives", "true");
    switch (call.name) {
      case "update_file": {
        const { input } = call;
        if (input.name === undefined && input.description === undefined)
          return inputError("Supply name or description.");
        request.method = "PATCH";
        body = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        };
        break;
      }
      case "overwrite_file_content": {
        const { input } = call;
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            input.base64Content,
          )
        )
          return inputError("base64Content must be canonical base64.");
        const bytes = Buffer.from(input.base64Content, "base64");
        if (bytes.toString("base64") !== input.base64Content)
          return inputError("base64Content must be canonical base64.");
        if (bytes.length > 25 * 1024 * 1024) return inputError("Content exceeds 25 MiB.");
        url.pathname = `/upload/drive/v3/files/${input.fileId}`;
        url.searchParams.set("uploadType", "media");
        request.method = "PATCH";
        request.body = bytes;
        request.headers = { "content-type": input.contentMimeType };
        break;
      }
      case "move_file": {
        const { input } = call;
        if (input.fromParentId === input.toParentId)
          return inputError("The current and destination folders must differ.");
        request.method = "PATCH";
        body = {};
        url.searchParams.set("addParents", input.toParentId);
        url.searchParams.set("removeParents", input.fromParentId);
        break;
      }
      case "trash_file":
      case "restore_file":
        request.method = "PATCH";
        body = { trashed: call.name === "trash_file" };
        break;
      case "delete_file":
        request.method = "DELETE";
        break;
      case "create_permission": {
        const { input } = call;
        const person = input.type === "user" || input.type === "group";
        if (
          person
            ? !input.emailAddress ||
              input.domain !== undefined ||
              input.allowFileDiscovery !== undefined
            : input.emailAddress !== undefined ||
              (input.type === "domain" ? !input.domain : input.domain !== undefined)
        )
          return inputError(
            "User/group sharing requires only emailAddress; domain sharing requires only domain; anyone sharing accepts neither. allowFileDiscovery applies only to domain/anyone.",
          );
        request.method = "POST";
        url.pathname += "/permissions";
        body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "fileId"));
        break;
      }
      case "update_permission":
        request.method = "PATCH";
        url.pathname += `/permissions/${call.input.permissionId}`;
        body = { role: call.input.role };
        break;
      case "delete_permission":
        request.method = "DELETE";
        url.pathname += `/permissions/${call.input.permissionId}`;
        break;
      case "get_changes_start_token":
        url.pathname += "/startPageToken";
        if (call.input.driveId) url.searchParams.set("driveId", call.input.driveId);
        url.searchParams.set("supportsAllDrives", "true");
        break;
      case "list_changes": {
        const { input } = call;
        for (const key of ["pageToken", "pageSize", "driveId"] as const)
          if (input[key] !== undefined) url.searchParams.set(key, String(input[key]));
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        url.searchParams.set(
          "fields",
          "nextPageToken,newStartPageToken,changes(fileId,removed,time,driveId,file(id,name,mimeType,modifiedTime,parents,trashed))",
        );
        break;
      }
    }
    if (body) {
      request.body = JSON.stringify(body);
      request.headers = { "content-type": "application/json" };
    }
    const read = readNames.has(tool);
    const credential = await this.resolve(name, url);
    if (credential.status === "auth_needed") return reconnectResult();
    options?.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.send(name, url, request, credential, options?.signal);
      if (!read && response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        throw new DriveMutationOutcomeUnknown();
      }
    } catch (error) {
      if (!read) throw new DriveMutationOutcomeUnknown();
      throw new Error("Google Drive request failed", { cause: error });
    }
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      return { content: [{ type: "text", text: "{}" }], structuredContent: {} };
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readResponseJsonBounded(response, 8 * 1024 * 1024, "Google Drive response");
    } catch (error) {
      if (!read && response.ok) throw new DriveMutationOutcomeUnknown();
      throw error;
    }
    return {
      ...(response.ok ? {} : { isError: true }),
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
  private async resolve(toolName: string, url: URL) {
    const credential = await this.context.resolveCredential({
      workspaceId: this.context.workspaceId,
      serverId: this.context.serverId,
      connectionRef: this.config.connectionRef!,
      destinationUrl: url.toString(),
      toolName,
      forceRefresh: false,
      acceptedTransports: NANGO_PROXY_TRANSPORTS,
      ...(this.context.subjectId ? { subjectId: this.context.subjectId } : {}),
    });
    if (credential.status === "auth_needed") {
      await this.context.onAuthNeeded?.({
        ...credential,
        serverId: this.context.serverId,
        toolName,
      });
      return credential;
    }
    this.context.onResolvedConnectionId?.(credential.connectionId);
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new Error("Google Drive authority is no longer valid");
    return credential;
  }
  private async send(
    toolName: string,
    url: URL,
    request: RequestInit,
    credential: OkCredential,
    signal?: AbortSignal,
  ) {
    return await sendWithCredential(
      this.context.fetchImpl ?? fetch,
      url,
      {
        ...request,
        headers: { ...((request.headers as Record<string, string> | undefined) ?? {}) },
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      },
      credential,
      {
        ...(this.context.recordNangoUsage ? { recorder: this.context.recordNangoUsage } : {}),
        toolName,
      },
    );
  }
  private async callRestRead(
    name: NangoDriveReadName,
    args: Record<string, unknown> | null,
    meta: Record<string, unknown> | null | undefined,
    options?: { signal?: AbortSignal },
  ) {
    const parsed = parseNangoDriveRead(name, args);
    if (!parsed.ok) return inputError(parsed.error);
    const input = parsed.input;
    const getJson = async (
      url: URL,
    ): Promise<{ ok: boolean; payload: Record<string, unknown> } | null> => {
      const credential = await this.resolve(name, url);
      if (credential.status === "auth_needed") return null;
      options?.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.send(name, url, { method: "GET" }, credential, options?.signal);
      } catch (error) {
        throw new Error("Google Drive request failed", { cause: error });
      }
      const payload = await readResponseJsonBounded<Record<string, unknown>>(
        response,
        8 * 1024 * 1024,
        "Google Drive response",
      );
      return { ok: response.ok, payload };
    };
    if (name === "search_files" || name === "list_recent_files") {
      const result = await getJson(nangoDriveListUrl(name, input));
      return result ? jsonResult(result.payload, result.ok) : reconnectResult();
    }
    const fileId = String(input.fileId);
    if (name === "get_file_permissions") {
      const result = await getJson(nangoDrivePermissionsUrl(fileId));
      return result ? jsonResult(result.payload, result.ok) : reconnectResult();
    }
    const metadata = await getJson(nangoDriveMetadataUrl(fileId));
    if (!metadata) return reconnectResult();
    if (name === "get_file_metadata" || !metadata.ok)
      return jsonResult(metadata.payload, metadata.ok);
    const mimeType = typeof metadata.payload.mimeType === "string" ? metadata.payload.mimeType : "";
    const purpose = name === "read_file_content" ? "text" : "bytes";
    const target = nangoDriveContentUrl(
      fileId,
      mimeType,
      purpose,
      typeof input.exportMimeType === "string" ? input.exportMimeType : undefined,
    );
    if (!(target instanceof URL)) return inputError(target.error);
    const credential = await this.resolve(name, target);
    if (credential.status === "auth_needed") return reconnectResult();
    options?.signal?.throwIfAborted();
    const response = await this.send(name, target, { method: "GET" }, credential, options?.signal);
    if (!response.ok) {
      const payload = await readResponseJsonBounded<Record<string, unknown>>(
        response,
        1024 * 1024,
        "Google Drive response",
      ).catch(() => ({ error: { code: response.status } }));
      return jsonResult(payload, false);
    }
    const bytes = await readBoundedBytes(response, NANGO_DRIVE_MAX_DOWNLOAD_BYTES);
    if (!bytes) return inputError("The file is larger than 10 MiB.");
    const fileSummary = { id: fileId, name: metadata.payload.name, mimeType };
    if (purpose === "text") {
      const { text, truncated } = projectNangoDriveText(bytes);
      return jsonResult({ file: fileSummary, content: text, truncated });
    }
    const contentMimeType = (response.headers.get("content-type") ?? mimeType)
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const operationId = meta?.opengeniOperationId;
    if (
      this.context.materializeConnectorFile &&
      typeof operationId === "string" &&
      UUID_PATTERN.test(operationId)
    ) {
      let materialized: unknown;
      try {
        materialized = await this.context.materializeConnectorFile({
          serverId: this.context.serverId,
          toolName: name,
          connectionId: credential.connectionId ?? "",
          operationId,
          providerAttachmentId: { provider: "google-drive", kind: "attachment", value: fileId },
          fileName: connectorAttachmentFileName(
            typeof metadata.payload.name === "string" ? metadata.payload.name : "",
            `${fileId}.bin`,
          ),
          mediaType: /^[\w.+-]+\/[\w.+-]+$/u.test(contentMimeType)
            ? contentMimeType
            : "application/octet-stream",
          bytes,
          authorizeProviderRequest: async () => {
            if (options?.signal?.aborted) return false;
            const current = await this.resolve(name, target);
            return (
              current.status === "ok" &&
              current.connectionId === credential.connectionId &&
              (!current.authorizeProviderRequest || (await current.authorizeProviderRequest()))
            );
          },
        });
      } catch (error) {
        if (isRoutingMutationOutcomeUnknownError(error)) throw error;
        return inputError("The Google Drive file could not be saved to the agent's files.");
      }
      const attachments =
        materialized && typeof materialized === "object" && "attachments" in materialized
          ? (materialized as { attachments: unknown }).attachments
          : undefined;
      if (Array.isArray(attachments))
        return jsonResult({
          file: fileSummary,
          contentMimeType,
          sizeBytes: bytes.byteLength,
          attachments,
        });
      return inputError("The Google Drive file could not be saved to the agent's files.");
    }
    if (bytes.byteLength > NANGO_DRIVE_MAX_INLINE_BYTES)
      return inputError(
        "The file is larger than 1 MiB and this chat has no agent files to save it to.",
      );
    return jsonResult({
      file: fileSummary,
      contentMimeType,
      sizeBytes: bytes.byteLength,
      base64Content: Buffer.from(bytes).toString("base64"),
    });
  }
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type OkCredential = Extract<ResolveConnectionCredentialResult, { status: "ok" }>;
function reconnectResult(): DriveToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: "Reconnect Google Drive to authorize this operation." }],
  };
}
function jsonResult(payload: Record<string, unknown>, ok = true): DriveToolResult {
  return {
    ...(ok ? {} : { isError: true }),
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

class DriveMutationOutcomeUnknown extends Error {
  readonly code = 40102;
  readonly connectorActionOutcome = "uncertain";
  readonly retryable = false;
  constructor() {
    super(
      "Google Drive mutation was submitted but its outcome is uncertain. Inspect the file before trying again.",
    );
  }
}
export function isOfficialDriveMcpConfig(config: DriveMcpBridgeConfig): boolean {
  return (
    config.url === OFFICIAL_DRIVE_MCP_URL &&
    (config.connectionRef?.providerDomain === "drivemcp.googleapis.com" ||
      isNangoDriveConfig(config)) &&
    config.connectionRef?.kind === "oauth2" &&
    config.connectionRef.subjectScope === "subject"
  );
}

/** Drive routed through Nango by the operator switch (docs/nango.md). */
export function isNangoDriveConfig(config: DriveMcpBridgeConfig): boolean {
  return (
    config.url === OFFICIAL_DRIVE_MCP_URL &&
    config.connectionRef?.providerDomain === nangoProviderDomain("google-drive")
  );
}

export function mergeDriveMcpTools<T extends { name: string }>(remote: T[]) {
  // Never shadow a future official tool with different arguments/semantics.
  const collisions = remote.filter((tool) => Object.hasOwn(definitions, tool.name));
  if (collisions.length)
    throw new Error(
      `Drive tool extension collision: ${collisions.map((tool) => tool.name).join(", ")}`,
    );
  return [...remote, ...structuredClone(DRIVE_EXTRA_TOOLS)];
}

export const DRIVE_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  DriveMcpBridgeConfig,
  DriveMcpBridgeContext
> = {
  adapterId: DRIVE_MCP_BRIDGE_DESCRIPTOR.adapterId,
  matches: isOfficialDriveMcpConfig,
  create: (config, context) => new DriveMcpServer(config, context),
};
