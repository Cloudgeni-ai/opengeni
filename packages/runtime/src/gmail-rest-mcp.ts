import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import {
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import PostalMime, { addressParser, decodeWords } from "postal-mime";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";
import {
  GMAIL_EXTRA_TOOLS,
  GMAIL_EXTRA_MUTATIONS,
  GMAIL_COMPOSE_PROPERTIES,
  GMAIL_ATTACHMENT_SOURCE_PROPERTIES,
} from "./gmail-rest-tools";
export { gmailToolSupportsScopes } from "./gmail-rest-tools";

export const OFFICIAL_GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const GMAIL_REST_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const GOOGLE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const GMAIL_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const GMAIL_BINARY_RESPONSE_MAX_BYTES = Math.ceil((GMAIL_DOWNLOAD_MAX_BYTES * 4) / 3) + 1024 * 1024;
const MAX_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MUTATION_TOOLS = new Set([
  ...GMAIL_EXTRA_MUTATIONS,
  "create_draft",
  "send_message",
  "send_draft",
  "label_message",
  "label_thread",
  "unlabel_message",
  "unlabel_thread",
]);
const SENSITIVE_ADD_LABELS = new Set(["TRASH", "SPAM"]);

type ResolveCredentialResult =
  | {
      status: "ok";
      headers: Record<string, string>;
      connectionId: string;
      authoritySource?: "host";
      authorizeProviderRequest?: () => Promise<boolean>;
      expiresAt?: Date | null;
    }
  | {
      status: "auth_needed";
      reason: ToolAuthNeededPayload["reason"];
      providerDomain: string;
      authoritySource?: "host";
      provider?: string;
      connectionId?: string;
      scopes?: string[];
      resource?: string;
      selectedResources?: McpServerConnectionRef["selectedResources"];
      authorizationUrl?: string;
    };

export type GmailRestMcpServerOptions = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  connectionRef: McpServerConnectionRef;
  resolveCredential: (input: {
    workspaceId: string;
    subjectId?: string;
    serverId: string;
    toolName?: string;
    connectionRef: McpServerConnectionRef;
    destinationUrl: string;
    forceRefresh?: boolean;
  }) => Promise<ResolveCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
  /** Private host callbacks; bytes and transfer URLs never enter model results. */
  materializeGmailFile?: (request: GmailFileMaterializationRequest) => Promise<unknown>;
  readGmailFile?: (request: {
    path: string;
    sha256: string;
    maxBytes: number;
  }) => Promise<Uint8Array>;
  watchTopicName?: string;
};

export type GmailFileMaterializationRequest = {
  serverId: string;
  connectionId: string;
  operationId: string;
  providerAttachmentId: { provider: "google-gmail"; kind: "attachment"; value: string };
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  authorizeProviderRequest: () => Promise<boolean>;
};

export type GmailRestMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};

export type GmailRestMcpBridgeContext = Omit<
  GmailRestMcpServerOptions,
  "serverId" | "connectionRef"
> & {
  readonly serverId: string;
};

export const GMAIL_REST_MCP_BRIDGE_DESCRIPTOR = defineLocalMcpBridgeDescriptor({
  adapterId: "gmail-rest",
  providerId: "google-gmail",
  catalogIdentity: `mcp:${OFFICIAL_GMAIL_MCP_URL}`,
  authority: "connection",
  toolSurface: "static_reviewed",
  mutationReplay: "safe_reads_only",
  destinations: [{ origin: "https://gmail.googleapis.com", pathPrefix: "/gmail/v1/users/me/" }],
});

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  historyId?: string;
  raw?: string;
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
};
type GmailLabel = {
  id?: string;
  name?: string;
  type?: string;
  color?: { textColor?: string; backgroundColor?: string };
  threadsTotal?: number;
  threadsUnread?: number;
};

type GmailTool = Awaited<ReturnType<MCPServer["listTools"]>>[number] & {
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const messageFormatSchema = {
  type: "string",
  enum: ["MESSAGE_FORMAT_UNSPECIFIED", "MINIMAL", "FULL_CONTENT", "METADATA_ONLY"],
  description: "Controls whether metadata, snippets, or full message bodies are returned.",
} as const;

const labelMutationProperties = {
  labelIds: {
    type: "array",
    items: { type: "string" },
    description: "Label IDs returned by list_labels.",
  },
} as const;

export const GMAIL_REST_MCP_TOOLS: GmailTool[] = [
  {
    name: "create_draft",
    description: "Creates a Gmail draft. This never sends the message.",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        htmlBody: { type: "string" },
        replyToMessageId: { type: "string" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string", description: "Base64-encoded attachment bytes." },
              filename: { type: "string" },
              mimeType: { type: "string" },
              inline: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Sends a new email immediately from the connected Gmail account. Requires human approval before it runs; there is no way to un-send.",
    inputSchema: {
      type: "object",
      required: ["to"],
      additionalProperties: false,
      properties: {
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        htmlBody: { type: "string" },
        replyToMessageId: { type: "string" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string", description: "Base64-encoded attachment bytes." },
              filename: { type: "string" },
              mimeType: { type: "string" },
              inline: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "send_draft",
    description:
      "Sends an existing Gmail draft as-is. Requires human approval before it runs; there is no way to un-send. Use get_message on the draft's message ID to review its content first.",
    inputSchema: {
      type: "object",
      required: ["draftId"],
      additionalProperties: false,
      properties: {
        draftId: { type: "string" },
      },
    },
  },
  {
    name: "list_drafts",
    description: "Lists Gmail drafts with bounded pagination.",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        pageSize: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
        pageToken: { type: "string" },
        query: { type: "string" },
        view: {
          type: "string",
          enum: ["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"],
        },
      },
    },
  },
  {
    name: "get_thread",
    description: "Retrieves one Gmail thread and its messages.",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      additionalProperties: false,
      properties: { threadId: { type: "string" }, messageFormat: messageFormatSchema },
    },
  },
  {
    name: "get_message",
    description: "Retrieves one Gmail message by ID.",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      additionalProperties: false,
      properties: { messageId: { type: "string" }, messageFormat: messageFormatSchema },
    },
  },
  {
    name: "search_threads",
    description: "Searches Gmail threads using Gmail query syntax.",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
        pageToken: { type: "string" },
        includeTrash: { type: "boolean" },
        view: {
          type: "string",
          enum: ["THREAD_VIEW_UNSPECIFIED", "THREAD_VIEW_METADATA_ONLY", "THREAD_VIEW_MINIMAL"],
        },
      },
    },
  },
  {
    name: "label_thread",
    description: "Adds non-sensitive labels to a Gmail thread.",
    inputSchema: {
      type: "object",
      required: ["threadId", "labelIds"],
      additionalProperties: false,
      properties: { threadId: { type: "string" }, ...labelMutationProperties },
    },
  },
  {
    name: "unlabel_thread",
    description: "Removes labels from a Gmail thread.",
    inputSchema: {
      type: "object",
      required: ["threadId", "labelIds"],
      additionalProperties: false,
      properties: { threadId: { type: "string" }, ...labelMutationProperties },
    },
  },
  {
    name: "list_labels",
    description: "Lists user-defined Gmail labels with bounded pagination.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
        pageToken: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "label_message",
    description: "Adds non-sensitive labels to a Gmail message.",
    inputSchema: {
      type: "object",
      required: ["messageId", "labelIds"],
      additionalProperties: false,
      properties: { messageId: { type: "string" }, ...labelMutationProperties },
    },
  },
  {
    name: "unlabel_message",
    description: "Removes labels from a Gmail message.",
    inputSchema: {
      type: "object",
      required: ["messageId", "labelIds"],
      additionalProperties: false,
      properties: { messageId: { type: "string" }, ...labelMutationProperties },
    },
  },
];

GMAIL_REST_MCP_TOOLS.push(...GMAIL_EXTRA_TOOLS);
for (const tool of GMAIL_REST_MCP_TOOLS) {
  const schema = tool.inputSchema as { properties: Record<string, any>; required: string[] };
  if (["create_draft", "send_message", "update_draft"].includes(tool.name)) {
    const original = GMAIL_REST_MCP_TOOLS.find((item) => item.name === "create_draft")!
      .inputSchema as typeof schema;
    schema.properties = {
      ...original.properties,
      ...schema.properties,
      ...GMAIL_COMPOSE_PROPERTIES,
    };
    const attachments = schema.properties.attachments;
    attachments.items = {
      ...attachments.items,
      required: [],
      additionalProperties: false,
      properties: { ...attachments.items.properties, ...GMAIL_ATTACHMENT_SOURCE_PROPERTIES },
    };
    if (tool.name === "send_message") schema.required = [];
  }
  if (tool.name === "send_draft") {
    schema.properties.expectedContentSha256 = {
      type: "string",
      description:
        "SHA-256 returned by get_draft. Required to bind sending to reviewed draft bytes.",
    };
    schema.required.push("expectedContentSha256");
    tool.description =
      "Sends the exact reviewed draft bytes. Obtain contentSha256 from get_draft; changed draft content is rejected before submission. Requires human approval.";
  }
  if (tool.name === "list_labels") {
    schema.properties.includeSystem = {
      type: "boolean",
      description:
        "Include INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH and other system labels.",
    };
  }
  tool.annotations = {
    readOnlyHint: !MUTATION_TOOLS.has(tool.name),
    destructiveHint: MUTATION_TOOLS.has(tool.name),
    idempotentHint: !MUTATION_TOOLS.has(tool.name),
    openWorldHint: true,
  };
}

export function isOfficialGmailMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  return (
    canonicalUrl(url) === canonicalUrl(OFFICIAL_GMAIL_MCP_URL) &&
    connectionRef?.providerDomain.toLowerCase() === "gmailmcp.googleapis.com" &&
    connectionRef.kind === "oauth2"
  );
}

export class GmailRestMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor = GMAIL_REST_MCP_BRIDGE_DESCRIPTOR;
  private readonly fetchImpl: FetchLike;
  private pinnedConnectionId?: string;
  private readonly requestContext = new AsyncLocalStorage<{
    signal: AbortSignal | undefined;
    mutationSubmitted: boolean;
  }>();

  constructor(private readonly options: GmailRestMcpServerOptions) {
    this.name = `opengeni-gmail-rest-${safeIdentity(options.serverId)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async connect(): Promise<void> {
    const result = await this.options.resolveCredential({
      workspaceId: this.options.workspaceId,
      serverId: this.options.serverId,
      connectionRef: this.options.connectionRef,
      destinationUrl: `${GMAIL_REST_API_BASE}/labels`,
      forceRefresh: false,
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
    if (result.status === "auth_needed") {
      await this.reportAuthNeeded(result);
      throw new GmailRestAuthError("Authentication required for Gmail");
    }
    this.options.onResolvedConnectionId?.(result.connectionId);
  }
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<GmailTool[]> {
    return structuredClone(GMAIL_REST_MCP_TOOLS);
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(toolName, args)).content;
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<any> {
    const requestContext = { signal: options?.signal, mutationSubmitted: false };
    try {
      const input = args ?? {};
      if (options?.signal?.aborted) throw new GmailRestInputError("Gmail operation cancelled");
      const operation = async () => await this.execute(toolName, input, meta, options?.signal);
      const output = await this.requestContext.run(requestContext, operation);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (
        isRoutingMutationOutcomeUnknownError(error) ||
        error instanceof GmailRestOutcomeUnknownError
      )
        throw error;
      const refused =
        error instanceof GmailRestProviderError && error.status !== undefined && error.status < 500;
      if (requestContext.mutationSubmitted && !refused)
        throw new GmailRestOutcomeUnknownError(
          "Gmail mutation was submitted but its result could not be delivered; outcome is uncertain",
        );
      return {
        isError: true,
        content: [{ type: "text", text: safeErrorMessage(error) }],
        structuredContent: { error: { connectorActionOutcome: "not_executed" } },
      };
    }
  }

  private async execute(
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (toolName) {
      case "list_labels":
        return await this.listLabels(args);
      case "get_message":
        return await this.getMessage(args);
      case "get_thread":
        return await this.getThread(args);
      case "search_threads":
        return await this.searchThreads(args);
      case "list_drafts":
        return await this.listDrafts(args);
      case "create_draft":
        return await this.createDraft(args);
      case "send_message":
        return await this.sendMessage(args);
      case "send_draft":
        return await this.sendDraft(args);
      case "label_message":
        return await this.modifyLabels("messages", args, true, false);
      case "unlabel_message":
        return await this.modifyLabels("messages", args, false, false);
      case "label_thread":
        return await this.modifyLabels("threads", args, true, true);
      case "unlabel_thread":
        return await this.modifyLabels("threads", args, false, true);
      default:
        return await this.executeExtra(toolName, args, meta, signal);
    }
  }

  private async listLabels(args: Record<string, unknown>): Promise<unknown> {
    const pageSize = boundedPageSize(args.pageSize);
    const offset = labelPageOffset(args.pageToken);
    const payload = await this.request<{ labels?: GmailLabel[] }>(
      "list_labels",
      `${GMAIL_REST_API_BASE}/labels`,
      {},
      true,
    );
    const labels = (payload.labels ?? [])
      .filter(
        (label) =>
          (args.includeSystem === true || label.type?.toLowerCase() === "user") &&
          Boolean(label.id),
      )
      .map((label) => ({
        labelId: label.id!,
        name: label.name ?? "",
        ...(args.includeSystem === true ? { type: label.type ?? null } : {}),
        ...(label.color
          ? {
              color: {
                ...(label.color.textColor ? { textColor: label.color.textColor } : {}),
                ...(label.color.backgroundColor
                  ? { backgroundColor: label.color.backgroundColor }
                  : {}),
              },
            }
          : {}),
        ...(Number.isInteger(label.threadsTotal) ? { threadsTotal: label.threadsTotal } : {}),
        ...(Number.isInteger(label.threadsUnread) ? { threadsUnread: label.threadsUnread } : {}),
      }));
    const page = labels.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      labels: page,
      ...(nextOffset < labels.length ? { nextPageToken: `opengeni-rest:${nextOffset}` } : {}),
    };
  }

  private async getMessage(args: Record<string, unknown>): Promise<unknown> {
    const messageId = requiredId(args.messageId, "messageId");
    const view = messageView(args.messageFormat);
    const url = new URL(`${GMAIL_REST_API_BASE}/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set("format", view === "full" ? "full" : "metadata");
    if (view !== "full") {
      for (const header of MESSAGE_HEADERS) url.searchParams.append("metadataHeaders", header);
    }
    const message = await this.request<GmailMessage>(
      "get_message",
      url,
      {},
      true,
      GMAIL_BINARY_RESPONSE_MAX_BYTES,
    );
    if (view === "full") await this.hydrateBody(message, "get_message");
    return projectMessage(message, view);
  }

  private async getThread(args: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredId(args.threadId, "threadId");
    const view = messageView(args.messageFormat);
    const url = new URL(`${GMAIL_REST_API_BASE}/threads/${encodeURIComponent(threadId)}`);
    url.searchParams.set("format", view === "full" ? "full" : "metadata");
    if (view !== "full") {
      for (const header of MESSAGE_HEADERS) url.searchParams.append("metadataHeaders", header);
    }
    const thread = await this.request<{
      id?: string;
      historyId?: string;
      messages?: GmailMessage[];
    }>("get_thread", url, {}, true, GMAIL_BINARY_RESPONSE_MAX_BYTES);
    if (view === "full")
      for (const message of thread.messages ?? []) await this.hydrateBody(message, "get_thread");
    return {
      id: thread.id ?? threadId,
      historyId: thread.historyId ?? null,
      messages: (thread.messages ?? []).map((message) => projectMessage(message, view)),
    };
  }

  private async searchThreads(args: Record<string, unknown>): Promise<unknown> {
    const pageSize = boundedPageSize(args.pageSize);
    const view = threadView(args.view);
    const url = new URL(`${GMAIL_REST_API_BASE}/threads`);
    url.searchParams.set("maxResults", String(pageSize));
    const query = optionalString(args.query, "query", 4_096);
    if (query) url.searchParams.set("q", query);
    const pageToken = optionalString(args.pageToken, "pageToken", 4_096);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (args.includeTrash === true) url.searchParams.set("includeSpamTrash", "true");
    const listed = await this.request<{
      threads?: Array<{ id?: string; snippet?: string; historyId?: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>("search_threads", url, {}, true);
    const threads = await boundedMap(listed.threads ?? [], 5, async (thread) => {
      if (!thread.id) return null;
      const detailUrl = new URL(`${GMAIL_REST_API_BASE}/threads/${encodeURIComponent(thread.id)}`);
      detailUrl.searchParams.set("format", "metadata");
      for (const header of MESSAGE_HEADERS)
        detailUrl.searchParams.append("metadataHeaders", header);
      const detail = await this.request<{ id?: string; messages?: GmailMessage[] }>(
        "search_threads",
        detailUrl,
        {},
        true,
        GMAIL_BINARY_RESPONSE_MAX_BYTES,
      );
      return {
        id: detail.id ?? thread.id,
        messages: (detail.messages ?? []).map((message) =>
          projectMessage(message, view === "metadata" ? "metadata" : "minimal"),
        ),
      };
    });
    return {
      threads: threads.filter((thread): thread is NonNullable<typeof thread> => thread !== null),
      ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}),
      ...(Number.isFinite(listed.resultSizeEstimate)
        ? { resultCountEstimate: String(listed.resultSizeEstimate) }
        : {}),
    };
  }

  private async listDrafts(args: Record<string, unknown>): Promise<unknown> {
    const pageSize = boundedPageSize(args.pageSize);
    const full = draftView(args.view) === "full";
    const url = new URL(`${GMAIL_REST_API_BASE}/drafts`);
    url.searchParams.set("maxResults", String(pageSize));
    const query = optionalString(args.query, "query", 4_096);
    if (query) url.searchParams.set("q", query);
    const pageToken = optionalString(args.pageToken, "pageToken", 4_096);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const listed = await this.request<{
      drafts?: Array<{ id?: string; message?: GmailMessage }>;
      nextPageToken?: string;
    }>("list_drafts", url, {}, true);
    const drafts = await boundedMap(listed.drafts ?? [], 5, async (draft) => {
      if (!draft.id) return null;
      const detailUrl = new URL(`${GMAIL_REST_API_BASE}/drafts/${encodeURIComponent(draft.id)}`);
      detailUrl.searchParams.set("format", full ? "full" : "metadata");
      if (!full) {
        for (const header of MESSAGE_HEADERS)
          detailUrl.searchParams.append("metadataHeaders", header);
      }
      const detail = await this.request<{ id?: string; message?: GmailMessage }>(
        "list_drafts",
        detailUrl,
        {},
        true,
        full ? GMAIL_BINARY_RESPONSE_MAX_BYTES : GOOGLE_RESPONSE_MAX_BYTES,
      );
      if (full && detail.message) await this.hydrateBody(detail.message, "list_drafts");
      return {
        ...(detail.message ? projectMessage(detail.message, full ? "full" : "metadata") : {}),
        id: detail.id ?? draft.id,
        draftId: detail.id ?? draft.id,
        messageId: detail.message?.id ?? null,
      };
    });
    return {
      drafts: drafts.filter((draft): draft is NonNullable<typeof draft> => draft !== null),
      ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}),
    };
  }

  private async createDraft(args: Record<string, unknown>): Promise<unknown> {
    const replyToMessageId = optionalString(args.replyToMessageId, "replyToMessageId", 256);
    let reply: GmailMessage | null = null;
    if (replyToMessageId) {
      const url = new URL(
        `${GMAIL_REST_API_BASE}/messages/${encodeURIComponent(replyToMessageId)}`,
      );
      url.searchParams.set("format", "metadata");
      for (const header of ["Message-ID", "References", "Subject", "To", "From"])
        url.searchParams.append("metadataHeaders", header);
      reply = await this.request<GmailMessage>("create_draft", url, {}, true);
    }
    const mime = await this.composeMime(args, reply, "create_draft");
    const created = await this.request<{
      id?: string;
      message?: { id?: string; threadId?: string };
    }>(
      "create_draft",
      `${GMAIL_REST_API_BASE}/drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            raw: Buffer.from(mime).toString("base64url"),
            ...(reply?.threadId ? { threadId: reply.threadId } : {}),
          },
        }),
      },
      false,
    );
    return {
      id: created.id ?? null,
      draftId: created.id ?? null,
      messageId: created.message?.id ?? null,
      threadId: created.message?.threadId ?? null,
    };
  }

  /**
   * Sends a freshly composed message immediately. Distinct from create_draft:
   * a message actually needs a recipient, and there is no reviewable
   * intermediate state - the human-approval gate on this tool IS the review.
   */
  private async sendMessage(args: Record<string, unknown>): Promise<unknown> {
    const to = optionalEmailArray(args.to, "to");
    if (
      !args.raw &&
      !args.rawFile &&
      to.length +
        optionalEmailArray(args.cc, "cc").length +
        optionalEmailArray(args.bcc, "bcc").length ===
        0
    ) {
      throw new GmailRestInputError(
        "At least one To, Cc or Bcc recipient is required to send a message",
      );
    }
    const replyToMessageId = optionalString(args.replyToMessageId, "replyToMessageId", 256);
    let reply: GmailMessage | null = null;
    if (replyToMessageId) {
      const url = new URL(
        `${GMAIL_REST_API_BASE}/messages/${encodeURIComponent(replyToMessageId)}`,
      );
      url.searchParams.set("format", "metadata");
      for (const header of ["Message-ID", "References", "Subject", "To", "From"])
        url.searchParams.append("metadataHeaders", header);
      reply = await this.request<GmailMessage>("send_message", url, {}, true);
    }
    const mime = await this.composeMime(args, reply, "send_message");
    const sent = await this.request<{ id?: string; threadId?: string }>(
      "send_message",
      `${GMAIL_REST_API_BASE}/messages/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          raw: Buffer.from(mime).toString("base64url"),
          ...(reply?.threadId ? { threadId: reply.threadId } : {}),
        }),
      },
      false,
    );
    return { id: sent.id ?? null, threadId: sent.threadId ?? null };
  }

  /** Sends an existing draft exactly as stored; the draft's own content is the review surface. */
  private async sendDraft(args: Record<string, unknown>): Promise<unknown> {
    const draftId = requiredId(args.draftId, "draftId");
    const raw = await this.readDraftRaw(draftId, "send_draft");
    assertContentHash(raw, args.expectedContentSha256);
    await this.validateRawSender(raw, "send_draft");
    const sent = await this.request<{ id?: string; threadId?: string }>(
      "send_draft",
      `${GMAIL_REST_API_BASE}/drafts/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draftId, message: { raw: raw.toString("base64url") } }),
      },
      false,
    );
    return { id: sent.id ?? null, threadId: sent.threadId ?? null };
  }

  private async modifyLabels(
    resource: "messages" | "threads",
    args: Record<string, unknown>,
    add: boolean,
    thread: boolean,
  ): Promise<unknown> {
    const idKey = thread ? "threadId" : "messageId";
    const id = requiredId(args[idKey], idKey);
    const labelIds = requiredStringArray(args.labelIds, "labelIds", 100, 256);
    if (add && labelIds.some((label) => SENSITIVE_ADD_LABELS.has(label.toUpperCase()))) {
      throw new GmailRestInputError("TRASH and SPAM cannot be added by this reviewed tool");
    }
    const toolName = `${add ? "label" : "unlabel"}_${thread ? "thread" : "message"}`;
    const output = await this.request<GmailMessage>(
      toolName,
      `${GMAIL_REST_API_BASE}/${resource}/${encodeURIComponent(id)}/modify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(add ? { addLabelIds: labelIds } : { removeLabelIds: labelIds }),
      },
      false,
    );
    return {
      id: output.id ?? id,
      threadId: output.threadId ?? (thread ? id : null),
      labelIds: output.labelIds ?? [],
    };
  }

  private async executeExtra(
    tool: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const json = (body: unknown, method = "POST"): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal: signal ?? null } : {}),
    });
    const urlFor = (path: string) => new URL(`${GMAIL_REST_API_BASE}/${path}`);
    if (tool === "get_profile")
      return await this.request(tool, urlFor("profile"), { signal: signal ?? null }, true);
    if (tool === "search_messages") {
      const url = urlFor("messages");
      addPagination(url, args);
      const query = optionalString(args.query, "query", 4096);
      if (query) url.searchParams.set("q", query);
      for (const id of optionalStrings(args.labelIds, "labelIds"))
        url.searchParams.append("labelIds", id);
      if (booleanArg(args.includeSpamTrash, "includeSpamTrash"))
        url.searchParams.set("includeSpamTrash", "true");
      const listed = await this.request<{
        messages?: GmailMessage[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(tool, url, { signal: signal ?? null }, true);
      const view = args.messageFormat === undefined ? "minimal" : messageView(args.messageFormat);
      const messages = await boundedMap(listed.messages ?? [], 5, async (message) => {
        const detailUrl = urlFor(
          `messages/${encodeURIComponent(requiredId(message.id, "provider message ID"))}`,
        );
        detailUrl.searchParams.set("format", view === "full" ? "full" : "metadata");
        const detail = await this.request<GmailMessage>(
          tool,
          detailUrl,
          { signal: signal ?? null },
          true,
          GMAIL_BINARY_RESPONSE_MAX_BYTES,
        );
        if (view === "full") await this.hydrateBody(detail, tool, signal);
        return projectMessage(detail, view);
      });
      return {
        messages,
        ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}),
        resultCountEstimate: listed.resultSizeEstimate ?? null,
      };
    }
    if (tool === "get_draft") {
      const draftId = requiredId(args.draftId, "draftId");
      const view = messageView(args.messageFormat);
      const url = urlFor(`drafts/${encodeURIComponent(draftId)}`);
      url.searchParams.set("format", "raw");
      const draft = await this.request<{ id?: string; message?: GmailMessage }>(
        tool,
        url,
        { signal: signal ?? null },
        true,
        GMAIL_BINARY_RESPONSE_MAX_BYTES,
      );
      const raw = decodeBinary(
        requiredString(draft.message?.raw, "provider draft raw", GMAIL_BINARY_RESPONSE_MAX_BYTES),
      );
      const parsed = await PostalMime.parse(raw, {
        maxHeadersSize: 128 * 1024,
        maxNestingDepth: 128,
      });
      const message: GmailMessage = {
        ...draft.message,
        payload: {
          headers: parsed.headers.map((header) => ({
            name: header.originalKey,
            value: header.value,
          })),
        },
      };
      return {
        ...projectMessage(message, view === "full" ? "minimal" : view),
        ...(view === "full"
          ? {
              plaintextBody: parsed.text?.slice(0, MAX_BODY_CHARS) ?? null,
              htmlBody: parsed.html?.slice(0, MAX_BODY_CHARS) ?? null,
              contentTruncated:
                (parsed.text?.length ?? 0) > MAX_BODY_CHARS ||
                (parsed.html?.length ?? 0) > MAX_BODY_CHARS,
              attachments: parsed.attachments.map((attachment) => ({
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                contentId: attachment.contentId ?? null,
                size:
                  typeof attachment.content === "string"
                    ? Buffer.byteLength(attachment.content)
                    : attachment.content.byteLength,
              })),
            }
          : {}),
        id: draft.id ?? draftId,
        draftId: draft.id ?? draftId,
        messageId: draft.message?.id ?? null,
        contentSha256: sha256(raw),
      };
    }
    if (tool === "delete_draft") {
      const id = requiredId(args.draftId, "draftId");
      await this.request(
        tool,
        urlFor(`drafts/${encodeURIComponent(id)}`),
        { method: "DELETE", signal: signal ?? null },
        false,
      );
      return { draftId: id, deleted: true };
    }
    if (tool === "update_draft") {
      const id = requiredId(args.draftId, "draftId");
      if (args.expectedContentSha256 !== undefined)
        assertContentHash(await this.readDraftRaw(id, tool, signal), args.expectedContentSha256);
      const reply = await this.readReply(args, tool, signal);
      const mime = await this.composeMime(args, reply, tool);
      const draft = await this.request<{ id?: string; message?: GmailMessage }>(
        tool,
        urlFor(`drafts/${encodeURIComponent(id)}`),
        json(
          {
            message: {
              raw: mime.toString("base64url"),
              ...(reply?.threadId ? { threadId: reply.threadId } : {}),
            },
          },
          "PUT",
        ),
        false,
      );
      return {
        draftId: draft.id ?? id,
        id: draft.id ?? id,
        messageId: draft.message?.id ?? null,
        contentSha256: sha256(mime),
      };
    }
    if (["get_label", "create_label", "update_label", "delete_label"].includes(tool)) {
      const id = tool === "create_label" ? undefined : requiredId(args.labelId, "labelId");
      if (id && tool !== "get_label" && !id.startsWith("Label_"))
        throw new GmailRestInputError("Only user-defined Label_ labels can be changed or deleted");
      const url = urlFor(`labels${id ? `/${encodeURIComponent(id)}` : ""}`);
      if (tool === "get_label")
        return await this.request(tool, url, { signal: signal ?? null }, true);
      if (tool === "delete_label") {
        await this.request(tool, url, { method: "DELETE", signal: signal ?? null }, false);
        return { labelId: id, deleted: true };
      }
      const body = labelDefinition(
        args,
        tool === "create_label" || booleanArg(args.replace, "replace"),
      );
      return await this.request(
        tool,
        url,
        json(body, tool === "create_label" ? "POST" : args.replace === true ? "PUT" : "PATCH"),
        false,
      );
    }
    if (["modify_message", "modify_thread", "batch_modify_messages"].includes(tool)) {
      const body: Record<string, unknown> = labelChanges(args);
      let path: string;
      if (tool === "batch_modify_messages") {
        body.ids = requiredStringArray(args.messageIds, "messageIds", 1000, 256);
        path = "messages/batchModify";
      } else {
        const thread = tool === "modify_thread";
        const id = requiredId(
          args[thread ? "threadId" : "messageId"],
          thread ? "threadId" : "messageId",
        );
        path = `${thread ? "threads" : "messages"}/${encodeURIComponent(id)}/modify`;
      }
      const result = await this.request(tool, urlFor(path), json(body), false);
      return tool === "batch_modify_messages" ? { messageIds: body.ids, modified: true } : result;
    }
    if (/^(?:trash|restore)_(?:message|thread)$/u.test(tool)) {
      const thread = tool.endsWith("_thread");
      const id = requiredId(
        args[thread ? "threadId" : "messageId"],
        thread ? "threadId" : "messageId",
      );
      return await this.request(
        tool,
        urlFor(
          `${thread ? "threads" : "messages"}/${encodeURIComponent(id)}/${tool.startsWith("trash_") ? "trash" : "untrash"}`,
        ),
        { method: "POST", signal: signal ?? null },
        false,
      );
    }
    if (tool === "get_history") {
      const url = urlFor("history");
      addPagination(url, args);
      const start = requiredString(args.startHistoryId, "startHistoryId", 256);
      if (!/^[0-9]+$/u.test(start))
        throw new GmailRestInputError("startHistoryId must be the opaque numeric Gmail cursor");
      url.searchParams.set("startHistoryId", start);
      const labelId = optionalString(args.labelId, "labelId", 256);
      if (labelId) url.searchParams.set("labelId", labelId);
      for (const type of optionalStrings(args.historyTypes, "historyTypes")) {
        enumArg(type, "historyTypes", [
          "messageAdded",
          "messageDeleted",
          "labelAdded",
          "labelRemoved",
        ]);
        url.searchParams.append("historyTypes", type);
      }
      try {
        return await this.request(tool, url, { signal: signal ?? null }, true);
      } catch (error) {
        if (error instanceof GmailRestProviderError && error.status === 404)
          return { resyncRequired: true, reason: "history_cursor_expired" };
        throw error;
      }
    }
    if (tool === "watch_mailbox") {
      const topic = this.options.watchTopicName;
      if (!topic || !/^projects\/[^/]+\/topics\/[^/]+$/u.test(topic))
        throw new GmailRestInputError("Gmail watch requires a deployment-configured Pub/Sub topic");
      const labelIds = optionalStrings(args.labelIds, "labelIds");
      const behavior = enumArg(args.labelFilterBehavior, "labelFilterBehavior", [
        "include",
        "exclude",
      ]);
      const result = await this.request<Record<string, unknown>>(
        tool,
        urlFor("watch"),
        json({
          topicName: topic,
          ...(labelIds.length ? { labelIds } : {}),
          ...(behavior ? { labelFilterBehavior: behavior } : {}),
        }),
        false,
      );
      return {
        ...result,
        requiresRenewal: true,
        notificationDelivery: "operator_managed",
        reconciliation: "get_history",
      };
    }
    if (tool === "stop_watch") {
      await this.request(tool, urlFor("stop"), { method: "POST", signal: signal ?? null }, false);
      return { stopped: true };
    }
    if (tool === "get_settings" || tool === "list_settings") {
      const resource = requiredString(args.resource, "resource", 64);
      const roots: Record<string, string> = {
        autoForwarding: "settings/autoForwarding",
        imap: "settings/imap",
        language: "settings/language",
        pop: "settings/pop",
        vacation: "settings/vacation",
        sendAs: "settings/sendAs",
        filters: "settings/filters",
        forwardingAddresses: "settings/forwardingAddresses",
        cseIdentities: "settings/cse/identities",
        cseKeypairs: "settings/cse/keypairs",
      };
      const singleton = ["autoForwarding", "imap", "language", "pop", "vacation"].includes(
        resource,
      );
      let path = roots[resource];
      if (resource === "smimeInfo")
        path = `settings/sendAs/${encodeURIComponent(requiredId(args.sendAsEmail, "sendAsEmail"))}/smimeInfo`;
      if (!path || (singleton && tool === "list_settings"))
        throw new GmailRestInputError("Unsupported Gmail settings resource");
      if (tool === "get_settings" && !singleton)
        path += `/${encodeURIComponent(requiredId(args.id, "id"))}`;
      const url = urlFor(path);
      if (tool === "list_settings" && ["cseIdentities", "cseKeypairs"].includes(resource))
        addPagination(url, args, "pageSize");
      return await this.request(tool, url, { signal: signal ?? null }, true);
    }
    if (tool === "import_message" || tool === "insert_message") {
      const raw = await this.rawInput(args);
      if (!raw) throw new GmailRestInputError("raw or rawFile is required");
      const url = urlFor(`messages/${tool === "import_message" ? "import" : "insert"}`);
      const date = enumArg(args.internalDateSource, "internalDateSource", [
        "receivedTime",
        "dateHeader",
      ]);
      if (date) url.searchParams.set("internalDateSource", date);
      if (tool === "import_message") {
        url.searchParams.set(
          "processForCalendar",
          String(booleanArg(args.processForCalendar, "processForCalendar")),
        );
        if (booleanArg(args.neverMarkSpam, "neverMarkSpam"))
          url.searchParams.set("neverMarkSpam", "true");
      }
      return await this.request(
        tool,
        url,
        json({
          raw: raw.toString("base64url"),
          labelIds: optionalStrings(args.labelIds, "labelIds"),
        }),
        false,
      );
    }
    if (tool === "download_message" || tool === "download_attachment") {
      if (!this.options.materializeGmailFile)
        throw new GmailRestInputError("Gmail file delivery requires an available agent filesystem");
      const operationId = requiredString(meta?.opengeniOperationId, "trusted operation ID", 36);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          operationId,
        )
      )
        throw new GmailRestInputError("Gmail file delivery requires trusted operation context");
      const id = requiredId(args.messageId, "messageId");
      const url = urlFor(`messages/${encodeURIComponent(id)}`);
      url.searchParams.set("format", tool === "download_message" ? "raw" : "full");
      const message = await this.request<GmailMessage>(
        tool,
        url,
        { signal: signal ?? null },
        true,
        GMAIL_BINARY_RESPONSE_MAX_BYTES,
      );
      let bytes: Buffer, filename: string, mediaType: string, identity: string;
      if (tool === "download_message") {
        bytes = decodeBinary(
          requiredString(message.raw, "provider raw message", GMAIL_BINARY_RESPONSE_MAX_BYTES),
        );
        filename = `message-${safeIdentity(id)}.eml`;
        mediaType = "message/rfc822";
        identity = `message:${id}:raw`;
      } else {
        const parts = walkParts(message.payload);
        const partId = args.partId === "" ? "" : optionalString(args.partId, "partId", 256);
        const attachmentId = optionalString(args.attachmentId, "attachmentId", 256);
        if (partId === undefined && !attachmentId)
          throw new GmailRestInputError("partId or attachmentId is required");
        const part = parts.find(
          (item) =>
            (partId === undefined || (item.partId ?? "") === partId) &&
            (!attachmentId || item.body?.attachmentId === attachmentId),
        );
        if (!part || part.parts?.length)
          throw new GmailRestInputError("Requested MIME leaf part was not found in this message");
        bytes = await this.partBytes(id, part, tool, signal);
        filename = safeFileName(part.filename || `part-${safeIdentity(part.partId || "0")}.bin`);
        mediaType = part.mimeType ?? "application/octet-stream";
        identity = `message:${id}:part:${part.partId ?? ""}`;
      }
      if (bytes.byteLength > GMAIL_DOWNLOAD_MAX_BYTES)
        throw new GmailRestInputError("Gmail download exceeds 50 MiB");
      const connectionId = this.pinnedConnectionId!;
      const destinationUrl = url.toString();
      return await this.options.materializeGmailFile({
        serverId: this.options.serverId,
        connectionId,
        operationId,
        providerAttachmentId: { provider: "google-gmail", kind: "attachment", value: identity },
        fileName: filename,
        mediaType,
        bytes,
        authorizeProviderRequest: async () => {
          if (signal?.aborted) return false;
          const current = await this.options.resolveCredential({
            workspaceId: this.options.workspaceId,
            ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
            serverId: this.options.serverId,
            toolName: tool,
            connectionRef: this.options.connectionRef,
            destinationUrl,
          });
          return (
            current.status === "ok" &&
            current.connectionId === connectionId &&
            (!current.authorizeProviderRequest || (await current.authorizeProviderRequest()))
          );
        },
      });
    }
    throw new GmailRestInputError(`Unsupported Gmail tool: ${tool}`);
  }

  private async partBytes(
    messageId: string,
    part: GmailPart,
    tool: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if ((part.body?.size ?? 0) > GMAIL_DOWNLOAD_MAX_BYTES)
      throw new GmailRestInputError("Gmail MIME part exceeds 50 MiB");
    let data = part.body?.data;
    if (data === undefined && part.body?.attachmentId) {
      const body = await this.request<{ data?: string; size?: number }>(
        tool,
        `${GMAIL_REST_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        { signal: signal ?? null },
        true,
        GMAIL_BINARY_RESPONSE_MAX_BYTES,
      );
      data = body.data;
    }
    if (data === undefined && part.body?.size === 0) return Buffer.alloc(0);
    if (data === undefined)
      throw new GmailRestProviderError("Gmail did not provide the requested MIME part bytes");
    const bytes = decodeBinary(data);
    if (
      bytes.byteLength > GMAIL_DOWNLOAD_MAX_BYTES ||
      (part.body?.size !== undefined && bytes.byteLength !== part.body.size)
    )
      throw new GmailRestProviderError("Gmail MIME part size verification failed");
    return bytes;
  }

  private async hydrateBody(
    message: GmailMessage,
    tool: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!message.id) return;
    for (const part of walkParts(message.payload)) {
      if (isTextBody(part) && part.body?.attachmentId && part.body.data === undefined) {
        part.body.data = (await this.partBytes(message.id, part, tool, signal)).toString(
          "base64url",
        );
      }
    }
  }

  private async readDraftRaw(id: string, tool: string, signal?: AbortSignal): Promise<Buffer> {
    const url = new URL(`${GMAIL_REST_API_BASE}/drafts/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "raw");
    const draft = await this.request<{ message?: GmailMessage }>(
      tool,
      url,
      { signal: signal ?? null },
      true,
      GMAIL_BINARY_RESPONSE_MAX_BYTES,
    );
    return decodeBinary(
      requiredString(draft.message?.raw, "provider draft raw", GMAIL_BINARY_RESPONSE_MAX_BYTES),
    );
  }

  private async readReply(
    args: Record<string, unknown>,
    tool: string,
    signal?: AbortSignal,
  ): Promise<GmailMessage | null> {
    const id = optionalString(args.replyToMessageId, "replyToMessageId", 256);
    if (!id) return null;
    const url = new URL(`${GMAIL_REST_API_BASE}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    return await this.request(tool, url, { signal: signal ?? null }, true);
  }

  private async rawInput(args: Record<string, unknown>): Promise<Buffer | null> {
    if (args.raw !== undefined && args.rawFile !== undefined)
      throw new GmailRestInputError("Choose raw or rawFile, not both");
    const raw = args.rawFile
      ? Buffer.from(await this.readFileInput(args.rawFile, 35 * 1024 * 1024))
      : args.raw !== undefined
        ? decodeBinary(requiredString(args.raw, "raw", GMAIL_BINARY_RESPONSE_MAX_BYTES))
        : null;
    if (raw && (raw.length === 0 || raw.length > 35 * 1024 * 1024))
      throw new GmailRestInputError("RFC 5322 message must contain 1 byte to 35 MiB");
    return raw;
  }

  private async readFileInput(
    value: unknown,
    maxBytes = MAX_ATTACHMENT_BYTES,
  ): Promise<Uint8Array> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new GmailRestInputError("file must contain path and sha256");
    const file = value as Record<string, unknown>;
    const path = requiredString(file.path, "file.path", 4096),
      hash = requiredString(file.sha256, "file.sha256", 64);
    if (!/^[0-9a-f]{64}$/iu.test(hash))
      throw new GmailRestInputError("file.sha256 must be an exact SHA-256");
    if (!this.options.readGmailFile)
      throw new GmailRestInputError("Gmail file input requires an available agent filesystem");
    const bytes = await this.options.readGmailFile({
      path,
      sha256: hash.toLowerCase(),
      maxBytes,
    });
    if (bytes.byteLength > maxBytes || sha256(bytes) !== hash.toLowerCase())
      throw new GmailRestInputError("Gmail file bytes changed or exceed the input size limit");
    return bytes;
  }

  private async composeMime(
    args: Record<string, unknown>,
    reply: GmailMessage | null,
    tool: string,
  ): Promise<Buffer> {
    const raw = await this.rawInput(args);
    if (raw) {
      if (
        ["to", "cc", "bcc", "subject", "body", "htmlBody", "attachments", "from", "replyTo"].some(
          (key) => args[key] !== undefined,
        )
      )
        throw new GmailRestInputError("raw/rawFile cannot be combined with composing fields");
      await this.validateRawSender(raw, tool);
      return raw;
    }
    if (
      args.attachments !== undefined &&
      (!Array.isArray(args.attachments) || args.attachments.length > 100)
    )
      throw new GmailRestInputError("attachments must be an array of at most 100 items");
    const attachments =
      args.attachments === undefined
        ? undefined
        : await Promise.all(
            (args.attachments as unknown[]).map(async (value) => {
              if (!value || typeof value !== "object" || Array.isArray(value))
                throw new GmailRestInputError("Invalid attachment");
              const item = value as Record<string, unknown>;
              if (item.file !== undefined && item.content !== undefined)
                throw new GmailRestInputError("Choose attachment file or content, not both");
              return item.file
                ? {
                    ...item,
                    content: Buffer.from(await this.readFileInput(item.file)).toString("base64"),
                  }
                : item;
            }),
          );
    const mime = Buffer.from(
      buildDraftMime({ ...args, ...(attachments ? { attachments } : {}) }, reply),
    );
    if (mime.length > 35 * 1024 * 1024)
      throw new GmailRestInputError("Encoded Gmail message exceeds 35 MiB");
    await this.validateRawSender(mime, tool);
    return mime;
  }

  private async validateRawSender(raw: Buffer, tool: string): Promise<void> {
    const headerEnd = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
    if (headerEnd < 0 || headerEnd > 128 * 1024)
      throw new GmailRestInputError("Invalid RFC 5322 message headers");
    const headers = raw
      .subarray(0, headerEnd)
      .toString("latin1")
      .replace(/\r?\n[ \t]+/gu, " ");
    const froms = headers.match(/^From:.*$/gimu) ?? [];
    if (froms.length > 1)
      throw new GmailRestInputError("A message must have at most one From header");
    if (froms.length === 0) return;
    const from = mailboxAddress(froms[0]!.slice(5).trim());
    const aliases = await this.request<{
      sendAs?: Array<{ sendAsEmail?: string; isPrimary?: boolean; verificationStatus?: string }>;
    }>(tool, `${GMAIL_REST_API_BASE}/settings/sendAs`, {}, true);
    if (
      !aliases.sendAs?.some(
        (alias) =>
          alias.sendAsEmail?.toLowerCase() === from.toLowerCase() &&
          (alias.isPrimary || alias.verificationStatus === "accepted"),
      )
    )
      throw new GmailRestInputError(
        "From must match the connected account or a verified send-as alias",
      );
  }

  private async reportAuthNeeded(
    result: Extract<ResolveCredentialResult, { status: "auth_needed" }>,
    toolName?: string,
  ): Promise<void> {
    await this.options.onAuthNeeded?.({
      serverId: this.options.serverId,
      ...(toolName ? { toolName } : {}),
      providerDomain: result.providerDomain,
      ...(result.provider ? { provider: result.provider } : {}),
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.authoritySource === "host" || this.options.connectionRef.authoritySource === "host"
        ? { authoritySource: "host" as const }
        : {}),
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(result.resource ? { resource: result.resource } : {}),
      ...(result.selectedResources ? { selectedResources: result.selectedResources } : {}),
      ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
  }

  private async request<T>(
    toolName: string,
    urlInput: string | URL,
    init: RequestInit,
    replaySafe: boolean,
    maxBytes = GOOGLE_RESPONSE_MAX_BYTES,
  ): Promise<T> {
    const url = new URL(urlInput);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "gmail.googleapis.com" ||
      !url.pathname.startsWith("/gmail/v1/users/me/")
    ) {
      throw new Error("Gmail REST destination binding mismatch");
    }
    const resolve = async (forceRefresh: boolean) => {
      const result = await this.options.resolveCredential({
        workspaceId: this.options.workspaceId,
        serverId: this.options.serverId,
        connectionRef: this.options.connectionRef,
        destinationUrl: url.toString(),
        toolName,
        forceRefresh,
        ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
      });
      if (result.status === "auth_needed") {
        await this.reportAuthNeeded(result, toolName);
        throw new GmailRestAuthError("Authentication required for Gmail");
      }
      this.options.onResolvedConnectionId?.(result.connectionId);
      if (this.pinnedConnectionId && this.pinnedConnectionId !== result.connectionId) {
        throw new GmailRestAuthError("Gmail account changed during this tool session");
      }
      this.pinnedConnectionId = result.connectionId;
      return result;
    };
    const send = async (headers: Record<string, string>) => {
      const context = this.requestContext.getStore();
      const request: RequestInit = {
        ...init,
        headers: { ...headers, ...headersRecord(init.headers) },
        redirect: "error",
        signal: AbortSignal.any([
          ...(init.signal || context?.signal ? [init.signal || context!.signal!] : []),
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      };
      if (!replaySafe && context) context.mutationSubmitted = true;
      return await this.fetchImpl(url, request);
    };
    const sendBounded = async (credential: Extract<ResolveCredentialResult, { status: "ok" }>) => {
      if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest())) {
        throw new GmailRestAuthError("Authentication required for Gmail");
      }
      try {
        return await send(credential.headers);
      } catch (error) {
        if (error instanceof GmailRestAuthError) throw error;
        if (!replaySafe)
          throw new GmailRestOutcomeUnknownError(
            "Gmail mutation request failed after submission; outcome is uncertain",
          );
        throw new GmailRestProviderError(
          `Gmail request failed: ${safeProviderTransportMessage(error)}`,
        );
      }
    };
    const first = await resolve(false);
    let response = await sendBounded(first);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      if (!replaySafe) {
        throw new GmailRestOutcomeUnknownError(
          "Gmail authentication expired after the mutation was submitted; outcome is uncertain",
        );
      }
      const refreshed = await resolve(true);
      response = await sendBounded(refreshed);
    }
    if (
      response.ok &&
      (response.status === 204 ||
        response.headers.get("content-length") === "0" ||
        (!replaySafe &&
          ["delete_draft", "delete_label", "batch_modify_messages", "stop_watch"].includes(
            toolName,
          )))
    ) {
      await response.body?.cancel().catch(() => undefined);
      return {} as T;
    }
    const payload = await readResponseJsonBounded<unknown>(
      response,
      maxBytes,
      "Gmail REST response",
    ).catch((error) => {
      if (!replaySafe)
        throw new GmailRestOutcomeUnknownError(
          `Gmail mutation returned an unreadable response (${response.status}); outcome is uncertain`,
        );
      throw new GmailRestProviderError(
        `Gmail returned an unreadable response (${response.status}): ${safeErrorMessage(error)}`,
      );
    });
    if (!response.ok) {
      if (!replaySafe && response.status >= 500)
        throw new GmailRestOutcomeUnknownError(
          `Gmail mutation returned ${response.status}; outcome is uncertain`,
        );
      throw new GmailRestProviderError(
        gmailProviderError(response.status, payload),
        response.status,
      );
    }
    return payload as T;
  }
}

export const GMAIL_REST_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  GmailRestMcpBridgeConfig,
  GmailRestMcpBridgeContext
> = Object.freeze({
  adapterId: GMAIL_REST_MCP_BRIDGE_DESCRIPTOR.adapterId,
  matches: (config: GmailRestMcpBridgeConfig) =>
    isOfficialGmailMcpConfig(config.url, config.connectionRef),
  create: (config: GmailRestMcpBridgeConfig, context: GmailRestMcpBridgeContext) => {
    if (!config.connectionRef) {
      throw new Error("Gmail REST bridge requires a connection reference");
    }
    return new GmailRestMcpServer({
      ...context,
      connectionRef: config.connectionRef,
    });
  },
});

const MESSAGE_HEADERS = ["Subject", "From", "To", "Cc", "Bcc", "Date", "Message-ID"];

function projectMessage(message: GmailMessage, view: "metadata" | "minimal" | "full") {
  const headers = headerMap(message.payload?.headers);
  const base = {
    id: message.id ?? null,
    threadId: message.threadId ?? null,
    sender: headers.from ?? null,
    toRecipients: splitHeader(headers.to),
    ccRecipients: splitHeader(headers.cc),
    bccRecipients: splitHeader(headers.bcc),
    date: normalizedMessageDate(headers.date),
    labelIds: message.labelIds ?? [],
    internalDate: message.internalDate ?? null,
    sizeEstimate: message.sizeEstimate ?? null,
    historyId: message.historyId ?? null,
    headers: message.payload?.headers ?? [],
    dateTime:
      headers.date && !Number.isNaN(Date.parse(headers.date))
        ? new Date(headers.date).toISOString()
        : null,
  };
  if (view === "metadata") return base;
  const minimal = {
    ...base,
    subject: headers.subject ? decodeWords(headers.subject) : null,
    snippet: message.snippet ?? null,
  };
  if (view === "minimal") return minimal;
  const content = extractContent(message.payload);
  return {
    ...minimal,
    plaintextBody: content.plaintextBody,
    htmlBody: content.htmlBody,
    attachmentIds: content.attachments.flatMap((attachment) =>
      attachment.id ? [attachment.id] : [],
    ),
    attachments: content.attachments,
    contentTruncated: content.truncated,
    decodingErrors: content.decodingErrors,
    mimeParts: walkParts(message.payload).map((part) => ({
      partId: part.partId ?? "",
      mimeType: part.mimeType ?? null,
      filename: part.filename ?? "",
      headers: part.headers ?? [],
      attachmentId: part.body?.attachmentId ?? null,
      size: part.body?.size ?? null,
    })),
  };
}

function extractContent(root: GmailPart | undefined): {
  plaintextBody: string | null;
  htmlBody: string | null;
  attachments: Array<{
    id: string | null;
    partId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId: string | null;
    disposition: string | null;
  }>;
  truncated: boolean;
  decodingErrors: string[];
} {
  let plain = "";
  let html = "";
  const attachments: Array<{
    id: string | null;
    partId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId: string | null;
    disposition: string | null;
  }> = [];
  let truncated = false;
  const decodingErrors: string[] = [];
  const pending = root ? [root] : [];
  let visited = 0;
  while (pending.length > 0 && visited < 2_048) {
    const part = pending.pop()!;
    visited += 1;
    const filename = part.filename?.trim() ?? "";
    const headers = headerMap(part.headers);
    if (!part.parts?.length && !isTextBody(part)) {
      attachments.push({
        id: part.body?.attachmentId ?? null,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
        partId: part.partId ?? "",
        contentId: headers["content-id"] ?? null,
        disposition: headers["content-disposition"] ?? null,
      });
    } else if (part.body?.data) {
      try {
        const charset =
          /charset\s*=\s*["']?([^;\s"']+)/iu.exec(headers["content-type"] ?? "")?.[1] ?? "utf-8";
        const decoded = new TextDecoder(charset, { fatal: true }).decode(
          decodeBinary(part.body.data),
        );
        if (part.mimeType === "text/plain") {
          truncated ||= plain.length + decoded.length + (plain ? 1 : 0) > MAX_BODY_CHARS;
          plain = appendBounded(plain, decoded, MAX_BODY_CHARS);
        }
        if (part.mimeType === "text/html") {
          truncated ||= html.length + decoded.length + (html ? 1 : 0) > MAX_BODY_CHARS;
          html = appendBounded(html, decoded, MAX_BODY_CHARS);
        }
      } catch {
        decodingErrors.push(part.partId ?? "");
      }
    }
    for (let index = (part.parts?.length ?? 0) - 1; index >= 0; index -= 1) {
      pending.push(part.parts![index]!);
    }
  }
  return {
    plaintextBody: plain || null,
    htmlBody: html || null,
    attachments,
    truncated: truncated || pending.length > 0,
    decodingErrors,
  };
}

function buildDraftMime(args: Record<string, unknown>, reply: GmailMessage | null): string {
  const to = optionalEmailArray(args.to, "to");
  const cc = optionalEmailArray(args.cc, "cc");
  const bcc = optionalEmailArray(args.bcc, "bcc");
  const replyHeaders = headerMap(reply?.payload?.headers);
  const subject =
    optionalString(args.subject, "subject", 998) ?? replySubject(replyHeaders.subject);
  const body = optionalString(args.body, "body", 2 * 1024 * 1024) ?? "";
  const htmlBody = optionalString(args.htmlBody, "htmlBody", 2 * 1024 * 1024);
  const attachments = parseAttachments(args.attachments);
  const headers = [
    ...(args.from ? [`From: ${formatMailbox(requiredString(args.from, "from", 998))}`] : []),
    ...(args.replyTo
      ? [`Reply-To: ${formatMailbox(requiredString(args.replyTo, "replyTo", 998))}`]
      : []),
    ...(to.length ? [`To: ${to.join(", ")}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Message-ID: <${crypto.randomUUID()}@opengeni.invalid>`,
    `Date: ${new Date().toUTCString()}`,
  ];
  const replyMessageId = replyHeaders["message-id"];
  if (replyMessageId) {
    headers.push(`In-Reply-To: ${safeHeaderValue(replyMessageId)}`);
    headers.push(
      `References: ${safeHeaderValue(
        [replyHeaders.references, replyMessageId].filter(Boolean).join(" "),
      )}`,
    );
  }
  const bodyEntity = mimeBody(body, htmlBody);
  if (attachments.length === 0) return `${headers.join("\r\n")}\r\n${bodyEntity}`;
  const boundary = `opengeni-mixed-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [`--${boundary}\r\n${bodyEntity}`];
  for (const attachment of attachments) {
    const disposition = attachment.inline ? "inline" : "attachment";
    const filename = attachment.filename
      ? `; filename="${escapeQuoted(attachment.filename.replace(/[^\x20-\x7e]/gu, "_"))}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
      : "";
    parts.push(
      `--${boundary}\r\nContent-Type: ${attachment.mimeType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ${disposition}${filename}\r\n${attachment.contentId ? `Content-ID: <${attachment.contentId}>\r\n` : ""}\r\n${wrapBase64(attachment.content.toString("base64"))}`,
    );
  }
  parts.push(`--${boundary}--`);
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

function mimeBody(plain: string, html: string | undefined): string {
  if (!html) {
    return `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(Buffer.from(plain).toString("base64"))}`;
  }
  const boundary = `opengeni-alt-${crypto.randomUUID()}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(plain).toString("base64")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(html).toString("base64")),
    `--${boundary}--`,
  ].join("\r\n");
}

function parseAttachments(value: unknown): Array<{
  content: Buffer;
  filename: string;
  mimeType: string;
  inline: boolean;
  contentId: string | undefined;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new GmailRestInputError("attachments must be an array with at most 100 items");
  }
  let total = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GmailRestInputError(`attachments[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const encoded =
      record.content === ""
        ? ""
        : requiredString(record.content, `attachments[${index}].content`, 40_000_000);
    const content = decodeAttachmentContent(encoded, index);
    total += content.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new GmailRestInputError("combined attachment bytes exceed 25MB");
    }
    return {
      content,
      filename: optionalString(record.filename, `attachments[${index}].filename`, 255) ?? "",
      mimeType: attachmentMimeType(record.mimeType, index),
      inline: record.inline === true,
      contentId: optionalContentId(record.contentId),
    };
  });
}

function decodeAttachmentContent(value: string, index: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new GmailRestInputError(`attachments[${index}].content must be valid base64`);
  }
  return Buffer.from(value, "base64");
}

function messageView(value: unknown): "metadata" | "minimal" | "full" {
  if (value === undefined || value === "MESSAGE_FORMAT_UNSPECIFIED" || value === "FULL_CONTENT")
    return "full";
  if (value === "MINIMAL") return "minimal";
  if (value === "METADATA_ONLY") return "metadata";
  throw new GmailRestInputError("messageFormat is invalid");
}

function threadView(value: unknown): "metadata" | "minimal" {
  if (value === undefined || value === "THREAD_VIEW_UNSPECIFIED" || value === "THREAD_VIEW_MINIMAL")
    return "minimal";
  if (value === "THREAD_VIEW_METADATA_ONLY") return "metadata";
  throw new GmailRestInputError("view is invalid");
}

function draftView(value: unknown): "metadata" | "full" {
  if (value === undefined || value === "DRAFT_VIEW_UNSPECIFIED" || value === "DRAFT_VIEW_FULL")
    return "full";
  if (value === "DRAFT_VIEW_METADATA_ONLY") return "metadata";
  throw new GmailRestInputError("view is invalid");
}

function boundedPageSize(value: unknown): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
    throw new GmailRestInputError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value as number;
}

function labelPageOffset(value: unknown): number {
  const token = optionalString(value, "pageToken", 4_096);
  if (!token) return 0;
  const match = /^opengeni-rest:(0|[1-9][0-9]{0,8})$/u.exec(token);
  if (!match) {
    throw new GmailRestInputError("pageToken is invalid for the Gmail REST adapter");
  }
  return Number(match[1]);
}

function requiredId(value: unknown, name: string): string {
  return requiredString(value, name, 256);
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new GmailRestInputError(
      `${name} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new GmailRestInputError(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

function requiredStringArray(value: unknown, name: string, maxItems: number, maxChars: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new GmailRestInputError(`${name} must contain 1-${maxItems} strings`);
  }
  return value.map((entry, index) => requiredString(entry, `${name}[${index}]`, maxChars));
}

function optionalEmailArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  const entries = requiredStringArray(value, name, 100, 320);
  return entries.map(formatMailbox);
}

function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (header.name && typeof header.value === "string")
      out[header.name.toLowerCase()] = header.value;
  }
  return out;
}

function splitHeader(value: string | undefined): string[] {
  if (!value) return [];
  return addressParser(value, { flatten: true }).flatMap((entry) =>
    entry.address
      ? [
          entry.name
            ? `"${entry.name.replace(/["\\]/gu, "\\$&")}" <${entry.address}>`
            : entry.address,
        ]
      : [],
  );
}

function normalizedMessageDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 998) : date.toISOString().slice(0, 10);
}

function appendBounded(current: string, next: string, limit: number): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  const appended =
    next.length > remaining
      ? `${next.slice(0, Math.max(0, remaining - 18))}\n[content truncated]`
      : next;
  return current ? `${current}\n${appended}`.slice(0, limit) : appended.slice(0, limit);
}

function replySubject(value: string | undefined): string {
  if (!value) return "";
  return /^re:/iu.test(value) ? value : `Re: ${value}`;
}

function encodeHeader(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, " ");
  if (normalized.length <= 70 && !/[^\x20-\x7e]/u.test(normalized)) return normalized;
  const chunks: string[] = [];
  let chunk = "";
  for (const character of normalized) {
    if (Buffer.byteLength(chunk + character) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 998);
}

function attachmentMimeType(value: unknown, index: number): string {
  const mimeType =
    optionalString(value, `attachments[${index}].mimeType`, 255) ?? "application/octet-stream";
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
    throw new GmailRestInputError(`attachments[${index}].mimeType is invalid`);
  }
  return mimeType;
}

function escapeQuoted(value: string): string {
  return value.replace(/[\r\n]/gu, " ").replace(/["\\]/gu, "\\$&");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertContentHash(bytes: Uint8Array, value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(value) ||
    sha256(bytes) !== value.toLowerCase()
  )
    throw new GmailRestInputError(
      "Draft content changed or no exact reviewed contentSha256 was supplied; read the draft again before sending",
    );
}
function optionalStrings(value: unknown, name: string): string[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  return [...new Set(requiredStringArray(value, name, 100, 256))];
}
function booleanArg(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new GmailRestInputError(`${name} must be boolean`);
  return value;
}
function enumArg(value: unknown, name: string, values: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value))
    throw new GmailRestInputError(`${name} is invalid`);
  return value;
}
function addPagination(url: URL, args: Record<string, unknown>, sizeName = "maxResults"): void {
  url.searchParams.set(sizeName, String(boundedPageSize(args.pageSize)));
  const token = optionalString(args.pageToken, "pageToken", 4096);
  if (token) url.searchParams.set("pageToken", token);
}
function labelDefinition(
  args: Record<string, unknown>,
  requireName: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (requireName) body.name = requiredString(args.name, "name", 225);
  else if (args.name !== undefined) body.name = requiredString(args.name, "name", 225);
  for (const [key, values] of Object.entries({
    messageListVisibility: ["show", "hide"],
    labelListVisibility: ["labelShow", "labelShowIfUnread", "labelHide"],
  })) {
    const value = enumArg(args[key], key, values);
    if (value) body[key] = value;
  }
  if (args.color !== undefined) {
    if (!args.color || typeof args.color !== "object" || Array.isArray(args.color))
      throw new GmailRestInputError("color must be an object");
    const color = args.color as Record<string, unknown>,
      output: Record<string, string> = {};
    for (const key of ["textColor", "backgroundColor"]) {
      const value = optionalString(color[key], key, 7);
      if (value && !/^#[a-f0-9]{6}$/iu.test(value))
        throw new GmailRestInputError(
          "Label colors must be #RRGGBB values from Gmail's supported palette",
        );
      if (value) output[key] = value;
    }
    body.color = output;
  }
  if (!Object.keys(body).length)
    throw new GmailRestInputError("Supply at least one label field to change");
  return body;
}
function labelChanges(args: Record<string, unknown>): {
  addLabelIds: string[];
  removeLabelIds: string[];
} {
  const addLabelIds = optionalStrings(args.addLabelIds, "addLabelIds"),
    removeLabelIds = optionalStrings(args.removeLabelIds, "removeLabelIds");
  if (!addLabelIds.length && !removeLabelIds.length)
    throw new GmailRestInputError("Supply addLabelIds or removeLabelIds");
  if ([...addLabelIds, ...removeLabelIds].includes("TRASH"))
    throw new GmailRestInputError("Use the dedicated trash/restore tool for Trash");
  if (addLabelIds.some((id) => removeLabelIds.includes(id)))
    throw new GmailRestInputError("A label cannot be both added and removed");
  return { addLabelIds, removeLabelIds };
}
function decodeBinary(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value) || value.replace(/=+$/u, "").length % 4 === 1)
    throw new GmailRestProviderError("Invalid base64url Gmail bytes");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value.replace(/=+$/u, ""))
    throw new GmailRestProviderError("Invalid base64url Gmail bytes");
  return bytes;
}
function walkParts(root: GmailPart | undefined): GmailPart[] {
  const pending = root ? [root] : [],
    result: GmailPart[] = [];
  while (pending.length && result.length < 2048) {
    const part = pending.pop()!;
    result.push(part);
    for (let i = (part.parts?.length ?? 0) - 1; i >= 0; i--) pending.push(part.parts![i]!);
  }
  return result;
}
function isTextBody(part: GmailPart): boolean {
  const disposition = headerMap(part.headers)["content-disposition"] ?? "";
  return (
    !part.filename &&
    !/^attachment\b/iu.test(disposition) &&
    ["text/plain", "text/html"].includes(part.mimeType ?? "")
  );
}
function safeFileName(value: string): string {
  let name = value
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "_")
    .replace(/[ .]+$/u, "")
    .trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  )
    name = "attachment.bin";
  while (Buffer.byteLength(name) > 240) name = [...name].slice(0, -1).join("");
  return name;
}
function mailboxAddress(value: string): string {
  if (/[\r\n\u0000]/u.test(value))
    throw new GmailRestInputError("Email address contains an invalid header character");
  const addresses = addressParser(value, { flatten: true });
  const address = addresses[0]?.address;
  if (addresses.length !== 1 || !address || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(address))
    throw new GmailRestInputError("Supply exactly one valid mailbox address per recipient");
  return address;
}
function formatMailbox(value: string): string {
  const address = mailboxAddress(value),
    parsed = addressParser(value, { flatten: true })[0]!;
  return parsed.name
    ? `${/[^\x20-\x7e]/u.test(parsed.name) ? encodeHeader(parsed.name) : `"${escapeQuoted(parsed.name)}"`} <${address}>`
    : address;
}
function optionalContentId(value: unknown): string | undefined {
  const id = optionalString(value, "contentId", 255);
  if (id && !/^[^<>\s\u0000-\u001f\u007f]+$/u.test(id))
    throw new GmailRestInputError("contentId is invalid");
  return id;
}

function headersRecord(value: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(value).forEach((headerValue, name) => {
    out[name] = headerValue;
  });
  return out;
}

function gmailProviderError(status: number, payload: unknown): string {
  const message =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: { message?: unknown; status?: unknown } }).error
      : undefined;
  const safe =
    typeof message?.status === "string"
      ? message.status
      : typeof message?.message === "string"
        ? message.message.slice(0, 240)
        : "provider request failed";
  return `Gmail REST request failed (${status}): ${safe}`;
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof GmailRestInputError ||
    error instanceof GmailRestProviderError ||
    error instanceof GmailRestAuthError
  )
    return error.message;
  return "Gmail REST tool failed";
}

function safeProviderTransportMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "request timed out";
  return "provider transport failed";
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function safeIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "gmail";
}

async function boundedMap<T, R>(values: T[], concurrency: number, map: (value: T) => Promise<R>) {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await map(values[index]!);
      }
    }),
  );
  return output;
}

class GmailRestInputError extends Error {}
/** Shared MCP uncertainty code preserves the gateway/connector journal outcome. */
class GmailRestOutcomeUnknownError extends Error {
  readonly code = 40_102;
  readonly connectorActionOutcome = "uncertain";
  readonly retryable = false;
}
class GmailRestProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
class GmailRestAuthError extends Error {}

export function gmailRestToolIsMutation(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName);
}

/** Only used for the trusted local Gmail bridge's durable connector settlement. */
export function gmailRestResultOutcome(output: unknown): "not_executed" | "uncertain" | null {
  const result = output as {
    isError?: boolean;
    structuredContent?: { error?: { connectorActionOutcome?: string; outcomeUnknown?: boolean } };
  } | null;
  if (result?.isError !== true) return null;
  const error = result.structuredContent?.error;
  return error?.outcomeUnknown === true
    ? "uncertain"
    : error?.connectorActionOutcome === "not_executed"
      ? "not_executed"
      : null;
}
