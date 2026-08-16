import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";
import { Buffer } from "node:buffer";

export const OFFICIAL_GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const GMAIL_REST_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const GOOGLE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MUTATION_TOOLS = new Set([
  "create_draft",
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
      authorizeProviderRequest?: () => Promise<boolean>;
      expiresAt?: Date | null;
    }
  | {
      status: "auth_needed";
      reason: ToolAuthNeededPayload["reason"];
      providerDomain: string;
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
};

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
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

type GmailTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

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

export function isOfficialGmailMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  return (
    canonicalUrl(url) === canonicalUrl(OFFICIAL_GMAIL_MCP_URL) &&
    connectionRef?.providerDomain.toLowerCase() === "gmailmcp.googleapis.com" &&
    connectionRef.kind === "oauth2" &&
    connectionRef.subjectScope === "subject"
  );
}

export class GmailRestMcpServer implements MCPServer {
  readonly name: string;
  readonly cacheToolsList = false;
  private readonly fetchImpl: FetchLike;

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
    if (result.status !== "ok") {
      throw new GmailRestAuthError("Authentication required for Gmail");
    }
    this.options.onResolvedConnectionId?.(result.connectionId);
  }
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<GmailTool[]> {
    return GMAIL_REST_MCP_TOOLS.map((tool) => ({ ...tool }));
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(toolName, args)).content;
  }

  async callToolResult(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    try {
      const input = args ?? {};
      const output = await this.execute(toolName, input);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: safeErrorMessage(error) }],
      };
    }
  }

  private async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
      case "label_message":
        return await this.modifyLabels("messages", args, true, false);
      case "unlabel_message":
        return await this.modifyLabels("messages", args, false, false);
      case "label_thread":
        return await this.modifyLabels("threads", args, true, true);
      case "unlabel_thread":
        return await this.modifyLabels("threads", args, false, true);
      default:
        throw new GmailRestInputError(`Unsupported Gmail tool: ${toolName}`);
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
      .filter((label) => label.type?.toLowerCase() === "user" && Boolean(label.id))
      .map((label) => ({
        labelId: label.id!,
        name: label.name ?? "",
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
    const message = await this.request<GmailMessage>("get_message", url, {}, true);
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
    }>("get_thread", url, {}, true);
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
      );
      return {
        ...(detail.message ? projectMessage(detail.message, full ? "full" : "metadata") : {}),
        id: detail.id ?? draft.id,
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
    const mime = buildDraftMime(args, reply);
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
    return { id: created.id ?? null };
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

  private async request<T>(
    toolName: string,
    urlInput: string | URL,
    init: RequestInit,
    replaySafe: boolean,
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
        await this.options.onAuthNeeded?.({
          serverId: this.options.serverId,
          toolName,
          providerDomain: result.providerDomain,
          ...(result.provider ? { provider: result.provider } : {}),
          reason: result.reason,
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
          ...(result.scopes ? { scopes: result.scopes } : {}),
          ...(result.resource ? { resource: result.resource } : {}),
          ...(result.selectedResources ? { selectedResources: result.selectedResources } : {}),
          ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
          ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
        });
        throw new GmailRestAuthError("Authentication required for Gmail");
      }
      this.options.onResolvedConnectionId?.(result.connectionId);
      return result;
    };
    const send = async (headers: Record<string, string>) =>
      await this.fetchImpl(url, {
        ...init,
        headers: { ...headers, ...headersRecord(init.headers) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    const sendBounded = async (credential: Extract<ResolveCredentialResult, { status: "ok" }>) => {
      try {
        if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest())) {
          throw new GmailRestAuthError("Authentication required for Gmail");
        }
        return await send(credential.headers);
      } catch (error) {
        if (error instanceof GmailRestAuthError) throw error;
        throw new GmailRestProviderError(
          replaySafe
            ? `Gmail request failed: ${safeProviderTransportMessage(error)}`
            : "Gmail mutation request failed after submission; outcome is uncertain",
        );
      }
    };
    const first = await resolve(false);
    let response = await sendBounded(first);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      if (!replaySafe) {
        throw new GmailRestProviderError(
          "Gmail authentication expired after the mutation was submitted; outcome is uncertain",
        );
      }
      const refreshed = await resolve(true);
      response = await sendBounded(refreshed);
    }
    const payload = await readResponseJsonBounded<unknown>(
      response,
      GOOGLE_RESPONSE_MAX_BYTES,
      "Gmail REST response",
    ).catch((error) => {
      throw new GmailRestProviderError(
        `Gmail returned an unreadable response (${response.status}): ${safeErrorMessage(error)}`,
      );
    });
    if (!response.ok) {
      throw new GmailRestProviderError(gmailProviderError(response.status, payload));
    }
    return payload as T;
  }
}

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
  };
  if (view === "metadata") return base;
  const minimal = { ...base, subject: headers.subject ?? null, snippet: message.snippet ?? null };
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
  };
}

function extractContent(root: GmailPart | undefined): {
  plaintextBody: string | null;
  htmlBody: string | null;
  attachments: Array<{ id: string | null; filename: string; mimeType: string; size: number }>;
} {
  let plain = "";
  let html = "";
  const attachments: Array<{
    id: string | null;
    filename: string;
    mimeType: string;
    size: number;
  }> = [];
  const pending = root ? [root] : [];
  let visited = 0;
  while (pending.length > 0 && visited < 2_048) {
    const part = pending.pop()!;
    visited += 1;
    const filename = part.filename?.trim() ?? "";
    if (filename || part.body?.attachmentId) {
      attachments.push({
        id: part.body?.attachmentId ?? null,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
      });
    } else if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === "text/plain") plain = appendBounded(plain, decoded, MAX_BODY_CHARS);
      if (part.mimeType === "text/html") html = appendBounded(html, decoded, MAX_BODY_CHARS);
    }
    for (let index = (part.parts?.length ?? 0) - 1; index >= 0; index -= 1) {
      pending.push(part.parts![index]!);
    }
  }
  return {
    plaintextBody: plain || null,
    htmlBody: html || null,
    attachments,
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
    ...(to.length ? [`To: ${to.join(", ")}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
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
    const filename = attachment.filename ? `; filename="${escapeQuoted(attachment.filename)}"` : "";
    parts.push(
      `--${boundary}\r\nContent-Type: ${attachment.mimeType}${filename}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: ${disposition}${filename}\r\n\r\n${wrapBase64(attachment.content.toString("base64"))}`,
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
    const encoded = requiredString(record.content, `attachments[${index}].content`, 40_000_000);
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
  const entries = requiredStringArray(value, name, 100, 320);
  for (const entry of entries) {
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(entry)) {
      throw new GmailRestInputError(`${name} contains an invalid plain email address`);
    }
  }
  return entries;
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
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function normalizedMessageDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 998) : date.toISOString().slice(0, 10);
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
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
  return /[^\x20-\x7e]/u.test(value)
    ? `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`
    : value.replace(/[\r\n]+/gu, " ");
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
class GmailRestProviderError extends Error {}
class GmailRestAuthError extends Error {}

export function gmailRestToolIsMutation(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName);
}
