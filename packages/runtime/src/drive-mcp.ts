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
  readonly connectionRef?: McpServerConnectionRef;
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
  private readonly remote: MCPServer;
  constructor(
    private readonly config: DriveMcpBridgeConfig,
    private readonly context: DriveMcpBridgeContext,
  ) {
    this.remote = context.createRemoteServer();
    this.name = this.remote.name;
  }
  connect() {
    return this.remote.connect();
  }
  close() {
    return this.remote.close();
  }
  async invalidateToolsCache() {
    await this.remote.invalidateToolsCache();
  }
  async listTools() {
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
    if (!Object.hasOwn(definitions, name)) {
      const remote = this.remote;
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
    const credential = await this.context.resolveCredential({
      workspaceId: this.context.workspaceId,
      serverId: this.context.serverId,
      connectionRef: this.config.connectionRef!,
      destinationUrl: url.toString(),
      toolName: name,
      forceRefresh: false,
      ...(this.context.subjectId ? { subjectId: this.context.subjectId } : {}),
    });
    if (credential.status === "auth_needed") {
      await this.context.onAuthNeeded?.({
        ...credential,
        serverId: this.context.serverId,
        toolName: name,
      });
      return {
        isError: true,
        content: [{ type: "text", text: "Reconnect Google Drive to authorize this operation." }],
      };
    }
    this.context.onResolvedConnectionId?.(credential.connectionId);
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new Error("Google Drive authority is no longer valid");
    options?.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await (this.context.fetchImpl ?? fetch)(url, {
        ...request,
        headers: { ...credential.headers, ...request.headers },
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(options?.signal ? [options.signal] : []),
        ]),
      });
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
    config.connectionRef?.providerDomain === "drivemcp.googleapis.com" &&
    config.connectionRef.kind === "oauth2" &&
    config.connectionRef.subjectScope === "subject"
  );
}

export function mergeDriveMcpTools(remote: Awaited<ReturnType<MCPServer["listTools"]>>) {
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
