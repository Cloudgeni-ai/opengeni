import { HTTPException } from "hono/http-exception";
import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  KnowledgeEntryListRequest,
  KnowledgeEntrySaveRequest,
  SiteDataCollectionDefinitionRequest,
  SiteDataQueryRequest,
  SiteDataWriteRequest,
  SiteHostnameLabel,
  SitePublishWarningFix,
  SiteSqlRunRequest,
  ToolGatewayInvokeResponse,
  WORKSPACE_ARTIFACT_TITLE_MAX_CHARS,
  WorkspaceArtifactRequestedTools,
} from "@opengeni/contracts";
import { z } from "zod";

import type { OrganizationActionContext } from "./organization-mcp";
import { runOrganizationAction } from "./organization-mcp";

/* ----------------------------------------------------------------------------
   Named tools on the organization MCP server (`/v1/mcp`) for coding agents
   on someone's computer (Claude Code, Codex, Cursor, Copilot): hand work to
   Opengeni and follow it, use the workspace's apps, tools, Skills and
   Knowledge. Each is a thin wrapper over the same public actions
   `opengeni_action_call` runs, as the same caller, so the routes' own checks
   decide exactly as in the app. See docs/mcp-surfaces.md.

   - The workspace: the one a call names, else the connection's default
     (`workspace_use`), else the caller's only workspace; otherwise the
     answer lists the choices.
   - Retries never start work twice: `delegate`, `session_send`,
     `skills_sync` and `knowledge_save` send a key derived from the request
     when the caller passes none, and say whether a retry is safe.
   - Approval-gated tools are listed; `tool_call` answers with a link where
     the person approves, then the same call runs once.
   -------------------------------------------------------------------------- */

const uuid = () => z.string().uuid();
const workspaceIdInput = () =>
  uuid()
    .optional()
    .describe(
      "The workspace. Omit to use this connection's default (workspace_use) or your only workspace.",
    );
/** The first-party server's identity in a workspace's tool gateway. */
const FIRST_PARTY_SERVER_ID = "opengeni";
const INVOKE_ACTION = "POST /v1/workspaces/:workspaceId/tools/invoke";
const WAIT_MAX_SECONDS = 50;
/** The approval link carries the call in its fragment; past this it is too long to open. */
const APPROVAL_LINK_MAX_BYTES = 16 * 1024;
/** Identical delegations inside this window are one retried request. */
const DELEGATE_RETRY_WINDOW_MS = 60 * 60 * 1000;

export const DelegateInput = z
  .object({
    message: z.string().min(1).max(100_000).describe("The task, as you would write it in a chat."),
    agent: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("An agent's id or name (agents_list). Omit for the workspace's default agent."),
    repository: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("A Git repository to work in: owner/name or its https URL."),
    branch: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("The branch to check out. Omit for the repository's default branch."),
    sandboxEnvironment: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("A sandbox environment's id or name (sandbox_environments_list)."),
    title: z.string().trim().min(1).max(200).optional().describe("The chat's name."),
    visibility: z
      .enum(["private", "workspace"])
      .optional()
      .describe("Who sees the chat. Omit for the person's default."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Reuse it to retry safely. Omit and an identical request within an hour is the same chat.",
      ),
    workspaceId: workspaceIdInput(),
  })
  .strict();

export const WaitForInput = z
  .object({
    sessionId: uuid(),
    cursor: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("The cursor from delegate, session_send or the last wait_for; 0 for everything."),
    maxWaitSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).default(WAIT_MAX_SECONDS),
    turnId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("The turnId from session_send: done only when that turn finishes."),
    workspaceId: workspaceIdInput(),
  })
  .strict();

export const SessionSendInput = z
  .object({
    sessionId: uuid(),
    message: z.string().min(1).max(100_000),
    mode: z
      .enum(["queue", "steer"])
      .default("queue")
      .describe("queue (default) waits for the current turn; steer changes it now."),
    idempotencyKey: uuid().optional().describe("Reuse it to retry safely."),
    workspaceId: workspaceIdInput(),
  })
  .strict();

const SessionsListInput = z
  .object({
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(512).optional(),
    activeOnly: z.boolean().optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
const SessionGetInput = z
  .object({
    sessionId: uuid(),
    detail: z.enum(["compact", "full"]).optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
const SessionEventsInput = z
  .object({
    sessionId: uuid(),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    view: z.enum(["conversation", "results", "tools"]).optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
const SessionControlInput = z
  .object({
    sessionId: uuid(),
    reason: z.string().min(1).max(500).optional(),
    idempotencyKey: uuid().optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
const WorkspaceOnlyInput = z.object({ workspaceId: workspaceIdInput() }).strict();
const WorkspaceUseInput = z.object({ workspaceId: uuid() }).strict();

const AppsListInput = z
  .object({
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(2048).optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
const appId = () => z.string().min(1).max(128).describe("The app's id (apps_list).");
const AppDescribeInput = z.object({ appId: appId(), workspaceId: workspaceIdInput() }).strict();
export const AppQueryInput = SiteDataQueryRequest.extend({
  appId: appId(),
  sqlQuery: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Run this named SQL query of the app instead of a collection query."),
  params: SiteSqlRunRequest.shape.params.optional(),
  workspaceId: workspaceIdInput(),
})
  .partial({ collection: true })
  .strict();
export const AppWriteInput = SiteDataWriteRequest.extend({
  appId: appId(),
  workspaceId: workspaceIdInput(),
}).strict();

const AppFileInput = z
  .object({
    path: z
      .string()
      .min(1)
      .max(512)
      .describe("Relative path, such as index.html or assets/app.js."),
    content: z.string().optional().describe("The file as text."),
    base64: z.string().optional().describe("Binary files (images, fonts) as base64."),
  })
  .strict();
export const AppSaveInput = z
  .object({
    appId: appId()
      .optional()
      .describe("Omit to create a new app. Pass it to save a new version or roll back."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS)
      .optional()
      .describe("The app's name. Needed for a new app."),
    html: z
      .string()
      .min(1)
      .optional()
      .describe("The whole app as one HTML document, with its JS and CSS inline."),
    files: z
      .array(AppFileInput)
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "A multi-file build instead of html: the entry HTML and its JS, CSS and asset files, with paths relative to it.",
      ),
    entry: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("The entry HTML among files. Default index.html."),
    uploadId: uuid()
      .optional()
      .describe("A large build you uploaded after prepareUpload, instead of html or files."),
    prepareUpload: z
      .boolean()
      .optional()
      .describe("Only get upload URLs for a large build; then call app_save with its uploadId."),
    requestedTools: WorkspaceArtifactRequestedTools.optional().describe(
      "Workspace tools the app calls (serverId and toolName from tools_search).",
    ),
    collections: z
      .record(z.string().min(1).max(64), SiteDataCollectionDefinitionRequest)
      .optional()
      .describe("App data collections to define or change, by name, with their rules."),
    rollbackTo: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Make this earlier version current again (needs appId)."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Reuse it to retry safely; omit and the same save within an hour is a retry."),
    workspaceId: workspaceIdInput(),
  })
  .strict();
export const AppPublishInput = z
  .object({
    appId: appId(),
    access: z
      .enum(["only_me", "workspace", "public"])
      .describe(
        "only_me: only you. workspace: the workspace's members. public: anyone with the link, on its own hostname.",
      ),
    hostname: SiteHostnameLabel.optional().describe(
      "The label of its own address, <label>.<apps domain>. Omit to keep the current one or get a suggested one.",
    ),
    fixes: z
      .array(SitePublishWarningFix)
      .max(50)
      .optional()
      .describe("Readiness fixes to apply (the fix objects of the warnings a publish returned)."),
    workspaceId: workspaceIdInput(),
  })
  .strict();
/** What file_save takes inline; larger files go through putUrl. */
export const FILE_SAVE_INLINE_MAX_BYTES = 4 * 1024 * 1024;
export const FileSaveInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("The file name with its extension, such as report.pdf."),
    content: z.string().optional().describe("A text file's content."),
    base64: z.string().optional().describe("A binary file's content as base64."),
    contentType: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Its media type. Omit to infer it from the name."),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("For a file over 4 MB: its size, to get an upload URL instead of sending it here."),
    uploadId: uuid().optional().describe("Finish an upload you sent to its putUrl."),
    visibility: z
      .enum(["private", "workspace"])
      .default("private")
      .describe("private (default): only you. workspace: everyone in the workspace."),
    workspaceId: workspaceIdInput(),
  })
  .strict();

const ToolsSearchInput = z
  .object({
    query: z.string().max(200).default(""),
    limit: z.number().int().min(1).max(50).default(20),
    includeSchemas: z.boolean().default(true),
    workspaceId: workspaceIdInput(),
  })
  .strict();
export const ToolCallInput = z
  .object({
    serverId: z.string().min(1).max(256).describe("From tools_search."),
    toolName: z.string().min(1).max(256).describe("From tools_search."),
    arguments: z.record(z.string(), z.unknown()).default({}),
    operationId: uuid()
      .optional()
      .describe(
        "Reuse it to retry, and after the person approves. A new one is a new call that may run again.",
      ),
    workspaceId: workspaceIdInput(),
  })
  .strict();

const SkillFileInput = z
  .object({
    path: z.string().min(1).max(512),
    content: z.string().max(512 * 1024),
  })
  .strict();
export const SkillsSyncInput = z
  .object({
    direction: z
      .enum(["upload", "pull", "repository"])
      .describe(
        "upload sends local Skill folders; pull returns the workspace's Skills; repository syncs every Skill folder of a public GitHub repository.",
      ),
    repository: z
      .string()
      .url()
      .max(2048)
      .optional()
      .describe(
        "For repository: a github.com repository or folder URL, such as https://github.com/owner/repo/tree/main/skills.",
      ),
    skills: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(96)
              .optional()
              .describe("Its key. Omit to use the name in SKILL.md."),
            files: z.array(SkillFileInput).min(1).max(64),
          })
          .strict(),
      )
      .max(50)
      .default([])
      .describe("For upload: each Skill folder, with SKILL.md and its other text files."),
    names: z
      .array(z.string().min(1).max(96))
      .max(100)
      .optional()
      .describe("For pull: only these Skills. Omit for all."),
    scope: z
      .enum(["user", "workspace", "organization"])
      .default("user")
      .describe("user (default) is Personal; workspace and organization share them."),
    workspaceId: workspaceIdInput(),
  })
  .strict();

export const KnowledgeSearchInput = KnowledgeEntryListRequest.extend({
  workspaceId: workspaceIdInput(),
}).strict();
const KnowledgeGetInput = z
  .object({
    entryId: uuid(),
    revisionId: uuid().optional(),
    view: z.enum(["published", "needs_review"]).optional(),
    workspaceId: workspaceIdInput(),
  })
  .strict();
export const KnowledgeSaveInput = KnowledgeEntrySaveRequest.extend({
  operationId: uuid().optional().describe("Reuse it to retry safely; omit to derive one."),
  workspaceId: workspaceIdInput(),
}).strict();

type ToolSpec = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  readOnly: boolean;
  /** Whether a call can put content on the open web. */
  openWorld?: boolean;
  run: (context: OrganizationActionContext, args: never) => Promise<CallToolResult>;
};

function tool<T extends z.ZodType>(spec: {
  name: string;
  title: string;
  description: string;
  input: T;
  readOnly: boolean;
  openWorld?: boolean;
  run: (context: OrganizationActionContext, args: z.output<T>) => Promise<CallToolResult>;
}): ToolSpec {
  return spec as unknown as ToolSpec;
}

/* ---------------------------------------------------------------- helpers */

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: details ? JSON.stringify({ error: message, ...details }) : message,
      },
    ],
    isError: true,
  };
}

type ActionOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; result: CallToolResult; status?: number; body?: unknown };

/** Run one public action as the caller and read its JSON answer. */
async function action(
  context: OrganizationActionContext,
  id: string,
  input: {
    pathParameters?: Record<string, string>;
    query?: Record<string, string | number | boolean | Array<string | number>>;
    body?: unknown;
  } = {},
  options: { claimStoredApproval?: boolean } = {},
): Promise<ActionOutcome> {
  const outcome = await runOrganizationAction(
    context,
    {
      id,
      pathParameters: input.pathParameters ?? {},
      query: input.query ?? {},
      ...(input.body === undefined ? {} : { body: input.body }),
    },
    options,
  );
  if ("refused" in outcome) return { ok: false, result: outcome.refused };
  const { response } = outcome;
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  if (response.status >= 400) {
    return {
      ok: false,
      status: response.status,
      body,
      result: failure(errorMessage(response.status, body), {
        status: response.status,
        ...errorFacts(response.status, body),
      }),
    };
  }
  return { ok: true, status: response.status, body };
}

function errorEnvelope(body: unknown): {
  message?: string;
  code?: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  details?: Record<string, unknown>;
} {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") {
    // Some routes (apps) answer {code, message} without the envelope.
    const flat = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    return {
      ...(typeof flat.message === "string" ? { message: flat.message } : {}),
      ...(typeof flat.code === "string" ? { code: flat.code } : {}),
    };
  }
  return error as ReturnType<typeof errorEnvelope>;
}

function errorMessage(status: number, body: unknown): string {
  const message = errorEnvelope(body).message ?? (typeof body === "string" ? body : "");
  if (status === 402)
    return `Opengeni has no credit left for this: ${message || "add credit or raise the usage limit in the app"}.`;
  if (status === 429) return `Too many requests: ${message || "wait and try again"}.`;
  if (status === 401) return "This connection is no longer signed in. Connect again.";
  return message || `The request failed (${status}).`;
}

/** Whether repeating the exact call is safe, from the route's own error facts. */
function errorFacts(status: number, body: unknown): Record<string, unknown> {
  const envelope = errorEnvelope(body);
  const outcomeUnknown = envelope.outcomeUnknown === true;
  const retryable = envelope.retryable ?? (status === 429 || status >= 500);
  return {
    ...(envelope.code ? { code: envelope.code } : {}),
    ...(typeof envelope.details?.code === "string" ? { reason: envelope.details.code } : {}),
    retrySafe: !outcomeUnknown && retryable,
    ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
  };
}

function stableUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  // A version-4-shaped UUID, so it passes every uuid check.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function callerKey(context: OrganizationActionContext): string {
  return context.caller.kind === "person"
    ? `${context.caller.accountId}:${context.caller.subjectId}`
    : `key:${createHash("sha256").update(context.caller.authorization).digest("hex").slice(0, 32)}`;
}

function webOrigin(context: OrganizationActionContext): string {
  return context.publicOrigin ?? context.origin;
}

function chatUrl(context: OrganizationActionContext, workspaceId: string, sessionId: string) {
  return new URL(`/workspaces/${workspaceId}/sessions/${sessionId}`, webOrigin(context)).href;
}

type Workspace = { id: string; name?: string; kind?: string };

async function listWorkspaces(
  context: OrganizationActionContext,
): Promise<{ ok: true; workspaces: Workspace[] } | { ok: false; result: CallToolResult }> {
  const listed = await action(context, "listWorkspaces");
  if (!listed.ok) return listed;
  const items = Array.isArray(listed.body) ? listed.body : [];
  return {
    ok: true,
    workspaces: items
      .filter((item): item is Workspace => typeof (item as Workspace)?.id === "string")
      .map((item) => ({
        id: item.id,
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
      })),
  };
}

/**
 * The workspace a call runs in: the one it names, the connection's default,
 * or the caller's only workspace. Otherwise the choices.
 */
export async function resolveToolWorkspace(
  context: OrganizationActionContext,
  requested: string | undefined,
): Promise<{ ok: true; workspaceId: string } | { ok: false; result: CallToolResult }> {
  if (requested) return { ok: true, workspaceId: requested };
  const fallback = context.connection?.settings.defaultWorkspaceId;
  const listed = await listWorkspaces(context);
  if (!listed.ok) return listed;
  if (fallback && listed.workspaces.some((workspace) => workspace.id === fallback))
    return { ok: true, workspaceId: fallback };
  if (listed.workspaces.length === 1) return { ok: true, workspaceId: listed.workspaces[0]!.id };
  if (listed.workspaces.length === 0)
    return {
      ok: false,
      result: failure("This connection can't reach any workspace."),
    };
  return {
    ok: false,
    result: failure(
      "Choose a workspace: pass workspaceId, or call workspace_use once to make one this connection's default.",
      { workspaces: listed.workspaces },
    ),
  };
}

async function inWorkspace(
  context: OrganizationActionContext,
  requested: string | undefined,
  run: (workspaceId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const resolved = await resolveToolWorkspace(context, requested);
  if (!resolved.ok) return resolved.result;
  return await run(resolved.workspaceId);
}

/** Run a first-party Opengeni tool in a workspace as the caller (the workspace tool gateway). */
async function firstParty(
  context: OrganizationActionContext,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<
  { ok: true; value: unknown; result: CallToolResult } | { ok: false; result: CallToolResult }
> {
  const invoked = await action(context, INVOKE_ACTION, {
    pathParameters: { workspaceId },
    body: {
      target: { identity: { serverId: FIRST_PARTY_SERVER_ID, toolName } },
      operationId: crypto.randomUUID(),
      arguments: args,
    },
  });
  if (!invoked.ok) return invoked;
  const parsed = ToolGatewayInvokeResponse.safeParse(invoked.body);
  if (!parsed.success)
    return {
      ok: false,
      result: failure("Opengeni returned an unexpected answer; retry."),
    };
  const result = parsed.data.result as CallToolResult;
  const text = (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Plain text answers stay text.
  }
  if (result.isError) return { ok: false, result: { content: result.content, isError: true } };
  return { ok: true, value, result: { content: result.content } };
}

function namedItems(body: unknown): Array<{ id: string; name: string }> {
  const found: Array<{ id: string; name: string }> = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.name === "string") {
      found.push({ id: record.id, name: record.name });
      return;
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit(body, 0);
  return found;
}

/** An id, or a name matched without regard to case, among what the caller can use. */
async function resolveNamed(
  context: OrganizationActionContext,
  workspaceId: string,
  actionId: string,
  value: string,
  noun: string,
): Promise<{ ok: true; id: string } | { ok: false; result: CallToolResult }> {
  if (z.string().uuid().safeParse(value).success) return { ok: true, id: value };
  const listed = await action(context, actionId, {
    pathParameters: { workspaceId },
  });
  if (!listed.ok) return listed;
  const items = namedItems(listed.body);
  const wanted = value.trim().toLowerCase();
  const matches = items.filter((item) => item.name.trim().toLowerCase() === wanted);
  if (matches.length === 1) return { ok: true, id: matches[0]!.id };
  return {
    ok: false,
    result: failure(
      matches.length > 1
        ? `More than one ${noun} is named "${value}". Pass its id.`
        : `No ${noun} named "${value}" here.`,
      { available: (matches.length > 1 ? matches : items).slice(0, 50) },
    ),
  };
}

function repositoryUri(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/u, "");
  if (/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) return `https://github.com/${trimmed}`;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.href.replace(/\/$/u, "") : null;
  } catch {
    return null;
  }
}

function sessionIdOf(body: unknown): string | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const session = record?.session as { id?: unknown } | undefined;
  if (typeof session?.id === "string") return session.id;
  return typeof record?.id === "string" ? record.id : null;
}

/* ----------------------------------------------------------------- tools */

const workspacesList = tool({
  name: "workspaces_list",
  title: "List workspaces",
  description:
    "List the Opengeni workspaces this connection reaches, marking this connection's default.",
  input: z.object({}).strict(),
  readOnly: true,
  run: async (context) => {
    const listed = await listWorkspaces(context);
    if (!listed.ok) return listed.result;
    const fallback = context.connection?.settings.defaultWorkspaceId ?? null;
    return json({
      workspaces: listed.workspaces.map((workspace) => ({
        ...workspace,
        ...(workspace.id === fallback ? { default: true } : {}),
      })),
    });
  },
});

const workspaceUse = tool({
  name: "workspace_use",
  title: "Use a workspace by default",
  description:
    "Make a workspace this connection's default, so tools that take workspaceId use it when you leave it out.",
  input: WorkspaceUseInput,
  readOnly: false,
  run: async (context, args) => {
    const listed = await listWorkspaces(context);
    if (!listed.ok) return listed.result;
    const workspace = listed.workspaces.find((each) => each.id === args.workspaceId);
    if (!workspace)
      return failure("This connection can't reach that workspace.", {
        workspaces: listed.workspaces,
      });
    if (!context.connection)
      return failure(
        "Only a connection made with Opengeni sign-in keeps a default workspace. Pass workspaceId on each call instead.",
      );
    await context.connection.setDefaultWorkspace(workspace.id);
    return json({ defaultWorkspace: workspace });
  },
});

const agentsList = tool({
  name: "agents_list",
  title: "List agents",
  description: "List the agents you can delegate to in a workspace, with their ids and names.",
  input: WorkspaceOnlyInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const listed = await action(context, "listAgents", {
        pathParameters: { workspaceId },
      });
      return listed.ok ? json(listed.body) : listed.result;
    }),
});

const sandboxEnvironmentsList = tool({
  name: "sandbox_environments_list",
  title: "List sandbox environments",
  description: "List the sandbox environments a delegated chat can run in.",
  input: WorkspaceOnlyInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const listed = await action(context, "listRigs", {
        pathParameters: { workspaceId },
      });
      return listed.ok ? json(listed.body) : listed.result;
    }),
});

const delegate = tool({
  name: "delegate",
  title: "Delegate to Opengeni",
  description:
    "Hand a task to an Opengeni agent in the cloud. Starts a chat and returns its id, link and a cursor; follow it with wait_for. Optional: an agent, a repository and branch, a sandbox environment. Retrying the same request never starts a second chat. Stopping your own wait doesn't stop the chat.",
  input: DelegateInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      let agentId: string | undefined;
      if (args.agent) {
        const agent = await resolveNamed(context, workspaceId, "listAgents", args.agent, "agent");
        if (!agent.ok) return agent.result;
        agentId = agent.id;
      }
      let rigId: string | undefined;
      if (args.sandboxEnvironment) {
        const rig = await resolveNamed(
          context,
          workspaceId,
          "listRigs",
          args.sandboxEnvironment,
          "sandbox environment",
        );
        if (!rig.ok) return rig.result;
        rigId = rig.id;
      }
      let resources: unknown[] = [];
      if (args.repository) {
        const uri = repositoryUri(args.repository);
        if (!uri) return failure("Pass the repository as owner/name or its https URL.");
        resources = [{ kind: "repository", uri, ref: args.branch ?? "HEAD" }];
      } else if (args.branch) {
        return failure("Pass repository with branch.");
      }
      let visibility = args.visibility;
      if (!visibility) {
        // The person's default, which is Workspace wherever Only me isn't
        // available to this caller.
        const capabilities = await action(context, "getSessionTenancyCreateCapabilities", {
          pathParameters: { workspaceId },
        });
        const fallback =
          capabilities.ok &&
          (capabilities.body as { defaultVisibility?: unknown })?.defaultVisibility === "private" &&
          (capabilities.body as { canCreatePrivate?: unknown })?.canCreatePrivate === true
            ? "private"
            : "workspace";
        visibility = fallback;
      }
      const idempotencyKey =
        args.idempotencyKey ??
        `mcp-delegate:${createHash("sha256")
          .update(
            JSON.stringify([
              callerKey(context),
              workspaceId,
              Math.floor(Date.now() / DELEGATE_RETRY_WINDOW_MS),
              args.message,
              agentId ?? null,
              resources,
              rigId ?? null,
              args.title ?? null,
              // What was asked, not the looked-up default, so a retry whose
              // lookup failed still finds the first chat.
              args.visibility ?? "default",
            ]),
          )
          .digest("hex")}`;
      const created = await action(context, "createSession", {
        pathParameters: { workspaceId },
        body: {
          initialMessage: args.message,
          idempotencyKey,
          visibility,
          ...(agentId ? { agentId } : {}),
          ...(rigId ? { rigId } : {}),
          ...(resources.length > 0 ? { resources } : {}),
          ...(args.title ? { profile: { title: args.title } } : {}),
        },
      });
      if (!created.ok) {
        // The same key never starts a second chat, so repeating is safe.
        const result = created.result;
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        let details: Record<string, unknown> = {};
        try {
          details = JSON.parse(text) as Record<string, unknown>;
        } catch {
          details = { error: text };
        }
        // retrySafe: repeating with this key never starts a second chat.
        // retryable: whether repeating could help (the route's own verdict).
        const status = created.status;
        const retryable =
          typeof details.retryable === "boolean"
            ? details.retryable
            : status === undefined || status >= 500 || status === 409 || status === 429;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...details,
                idempotencyKey,
                retrySafe: true,
                retryable,
              }),
            },
          ],
          isError: true,
        };
      }
      const sessionId = sessionIdOf(created.body);
      if (!sessionId)
        return failure(
          "Opengeni didn't return the chat's id; retry with the same idempotencyKey.",
          { idempotencyKey, retrySafe: true },
        );
      const replayed = (created.body as { replayed?: unknown })?.replayed === true;
      return json({
        sessionId,
        workspaceId,
        url: chatUrl(context, workspaceId, sessionId),
        visibility,
        cursor: 0,
        idempotencyKey,
        ...(replayed ? { replayed: true } : {}),
        next: "Call wait_for with this sessionId and cursor until done is true.",
      });
    }),
});

type WaitEvent = {
  sequence: number;
  type: string;
  turnId?: string | null;
  contentComplete?: boolean;
  status?: string;
  text?: string | null;
  failure?: unknown;
  result?: unknown;
};

/** What a completion wait's events mean for the person waiting. */
export function waitState(
  events: readonly WaitEvent[],
  turnId?: string,
): {
  state: "done" | "failed" | "needs_attention" | "running";
  event?: WaitEvent;
  /** The turn to pass next time; none once the turn was merged into another. */
  turnId?: string | undefined;
} {
  // A turn merged into a later one hands its answer to that turn.
  const followed =
    turnId && !events.some((event) => event.turnId === turnId && event.type === "turn.superseded")
      ? turnId
      : undefined;
  for (const event of [...events].reverse()) {
    // A follow-up's own turn: an earlier turn ending isn't its answer.
    if (followed && event.turnId && event.turnId !== followed) continue;
    // Waiting for model capacity needs nobody; it resumes on its own.
    if (event.type.includes("capacity")) return { state: "running", event, turnId: followed };
    if (event.type === "turn.completed") return { state: "done", event, turnId: followed };
    if (
      event.type === "turn.failed" ||
      event.type === "turn.cancelled" ||
      event.type === "rig.setup.failed"
    )
      return { state: "failed", event, turnId: followed };
    if (event.type !== "turn.superseded")
      return { state: "needs_attention", event, turnId: followed };
  }
  return { state: "running", turnId: followed };
}

const waitFor = tool({
  name: "wait_for",
  title: "Wait for a chat",
  description: `Wait up to ${WAIT_MAX_SECONDS} seconds for a delegated chat. done is true when its turn finished with a final answer (finalAnswer). Otherwise call again with the returned cursor. needs_attention means the person has to answer or approve something in the chat (url). After session_send, pass its turnId, and then the turnId each answer returns.`,
  input: WaitForInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const waited = await firstParty(context, workspaceId, "session_wait", {
        targets: [{ sessionId: args.sessionId, afterSequence: args.cursor }],
        waitFor: "completion",
        includeOwnPendingUpdates: false,
        maxWaitSeconds: args.maxWaitSeconds,
      });
      if (!waited.ok) return waited.result;
      const value = waited.value as {
        changed?: Array<{
          sessionId: string;
          latestSequence?: number;
          events?: WaitEvent[];
        }>;
        timedOut?: boolean;
      };
      const target = value.changed?.find((each) => each.sessionId === args.sessionId);
      const events = target?.events ?? [];
      const { state, event, turnId } = waitState(events, args.turnId);
      return json({
        sessionId: args.sessionId,
        state,
        done: state === "done",
        ...(state === "done" && (event?.text || event?.result !== undefined)
          ? { finalAnswer: event.text || event.result }
          : {}),
        ...(state === "done" && !(event?.text || event?.result !== undefined)
          ? { note: "The turn finished without a written answer; session_events has its results." }
          : {}),
        ...(state === "done" && event?.contentComplete === false
          ? {
              note: "finalAnswer is shortened; read the full answer with session_events (view results).",
            }
          : {}),
        ...(state !== "done" && state !== "running" && event
          ? {
              event: {
                type: event.type,
                status: event.status,
                text: event.text ?? null,
                failure: event.failure ?? null,
              },
            }
          : {}),
        cursor: target?.latestSequence ?? args.cursor,
        // Pass it on the next call; gone once the turn merged into a later one.
        ...(turnId ? { turnId } : {}),
        url: chatUrl(context, workspaceId, args.sessionId),
      });
    }),
});

const sessionSend = tool({
  name: "session_send",
  title: "Send to a chat",
  description:
    "Send a follow-up message to an Opengeni chat. Returns a cursor and turnId for wait_for that skip earlier answers. Retrying sends it once: the same text within the hour is a retry unless you pass a new idempotencyKey.",
  input: SessionSendInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const before = await firstParty(context, workspaceId, "session_get", {
        sessionId: args.sessionId,
      });
      if (!before.ok) return before.result;
      const cursor = Number((before.value as { lastSequence?: unknown })?.lastSequence ?? 0);
      const idempotencyKey =
        args.idempotencyKey ??
        // Not the cursor: sending appends events, so a retry after a lost
        // answer would read a new one and send the message twice.
        stableUuid(
          "mcp-session-send",
          callerKey(context),
          workspaceId,
          args.sessionId,
          String(Math.floor(Date.now() / DELEGATE_RETRY_WINDOW_MS)),
          args.mode,
          args.message,
        );
      const sent = await firstParty(
        context,
        workspaceId,
        args.mode === "steer" ? "session_steer" : "session_queue_message",
        { sessionId: args.sessionId, text: args.message, idempotencyKey },
      );
      if (!sent.ok) return sent.result;
      // The turn this message runs in, so wait_for skips a turn already running.
      const resource = (sent.value as { resource?: { type?: unknown; id?: unknown } })?.resource;
      const turnId =
        resource?.type === "session_turn" && typeof resource.id === "string"
          ? resource.id
          : undefined;
      // An earlier call with this key already sent it: its turn may have
      // finished before the current cursor, so wait from the start.
      const replayed = (sent.value as { outcome?: unknown })?.outcome === "replayed";
      return json({
        sessionId: args.sessionId,
        cursor: replayed ? 0 : Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
        ...(turnId ? { turnId } : {}),
        idempotencyKey,
        ...(replayed
          ? {
              replayed: true,
              note: "This message was already sent in the last hour, so it wasn't sent again. Pass a new idempotencyKey to send the same text again.",
            }
          : {}),
        receipt: sent.value,
        url: chatUrl(context, workspaceId, args.sessionId),
        next: turnId
          ? "Call wait_for with this sessionId, cursor and turnId until done is true."
          : "Call wait_for with this sessionId and cursor until done is true.",
      });
    }),
});

function passthrough(
  name: string,
  title: string,
  description: string,
  input: z.ZodObject,
  readOnly: boolean,
  toolName: string,
  derive?: (
    args: Record<string, unknown>,
    context: OrganizationActionContext,
  ) => Record<string, unknown>,
): ToolSpec {
  return tool({
    name,
    title,
    description,
    input,
    readOnly,
    run: async (context, parsed) => {
      const { workspaceId: requested, ...rest } = parsed as Record<string, unknown>;
      return inWorkspace(context, requested as string | undefined, async (workspaceId) => {
        const called = await firstParty(
          context,
          workspaceId,
          toolName,
          derive ? derive(rest, context) : rest,
        );
        return called.result;
      });
    },
  });
}

// Pausing or resuming twice ends in the same state, so each call gets its own
// key: a derived one would turn pause, resume, pause into a replayed pause.
const controlKey = (_operation: string) => (args: Record<string, unknown>) => ({
  ...args,
  idempotencyKey: (args.idempotencyKey as string | undefined) ?? crypto.randomUUID(),
});

const sessionsList = passthrough(
  "sessions_list",
  "List chats",
  "List Opengeni chats in a workspace (id, title, status, goal), newest activity first.",
  SessionsListInput,
  true,
  "sessions_list",
);
const sessionGet = passthrough(
  "session_get",
  "Get a chat",
  "Read one Opengeni chat: status, goal, queue and active turn.",
  SessionGetInput,
  true,
  "session_get",
);
const sessionEvents = passthrough(
  "session_events",
  "Read a chat's messages",
  "Read a chat's messages and results, page by page (after is a cursor).",
  SessionEventsInput,
  true,
  "session_events",
);
const sessionPause = passthrough(
  "session_pause",
  "Pause a chat",
  "Pause an Opengeni chat in the cloud. Stopping your own wait doesn't; this does.",
  SessionControlInput,
  false,
  "session_pause",
  controlKey("pause"),
);
const sessionResume = passthrough(
  "session_resume",
  "Resume a chat",
  "Resume a paused Opengeni chat.",
  SessionControlInput,
  false,
  "session_resume",
  controlKey("resume"),
);

const appsList = tool({
  name: "apps_list",
  title: "List apps",
  description: "List the workspace's apps (built in Opengeni, with their own data).",
  input: AppsListInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const listed = await action(context, "listArtifactCatalog", {
        pathParameters: { workspaceId },
        query: {
          kind: "site",
          ...(args.query ? { q: args.query } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        },
      });
      return listed.ok ? json(listed.body) : listed.result;
    }),
});

const appDescribe = tool({
  name: "app_describe",
  title: "Describe an app's data",
  description:
    "Show an app's data collections, their schemas and record counts, so you can query and write them. Connected agents use app data as viewers unless the person lets this connection manage it.",
  input: AppDescribeInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const described = await action(context, "getSiteData", {
        pathParameters: { workspaceId, artifactId: args.appId },
      });
      return described.ok ? json(described.body) : described.result;
    }),
});

const appQuery = tool({
  name: "app_query",
  title: "Query an app's data",
  description:
    "Read records from an app's collection (where, sort, limit, cursor), or run one of its named SQL queries (sqlQuery, params).",
  input: AppQueryInput,
  readOnly: true,
  run: async (context, args) => {
    const { appId: artifactId, workspaceId: requested, sqlQuery, params, ...query } = args;
    return inWorkspace(context, requested, async (workspaceId) => {
      if (sqlQuery) {
        const ran = await action(context, "runSiteSqlQuery", {
          pathParameters: { workspaceId, artifactId, name: sqlQuery },
          body: { ...(params ? { params } : {}) },
        });
        return ran.ok ? json(ran.body) : ran.result;
      }
      if (!query.collection) return failure("Pass collection, or sqlQuery for a named SQL query.");
      const read = await action(context, "querySiteData", {
        pathParameters: { workspaceId, artifactId },
        body: query,
      });
      return read.ok ? json(read.body) : read.result;
    });
  },
});

const appWrite = tool({
  name: "app_write",
  title: "Write an app's data",
  description:
    "Create, update or delete records in an app's collections, following each collection's rules for viewers unless this connection manages the app's data.",
  input: AppWriteInput,
  readOnly: false,
  run: async (context, args) => {
    const { appId: artifactId, workspaceId: requested, ...write } = args;
    return inWorkspace(context, requested, async (workspaceId) => {
      const written = await action(context, "writeSiteData", {
        pathParameters: { workspaceId, artifactId },
        body: write,
      });
      return written.ok ? json(written.body) : written.result;
    });
  },
});

/* ------------------------------------------------ saving apps and files */

const PREPARE_APP_UPLOAD = "POST /v1/workspaces/:workspaceId/published-artifacts/uploads";
const PUBLICATION_GET = "sitePublicationPath";
const PUBLICATION_PUT =
  "PUT /v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication";
const PUBLICATION_FIX =
  "POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication/fixes";
/** Identical saves inside this window are one retried request. */
const SAVE_RETRY_WINDOW_MS = 60 * 60 * 1000;

function appUrl(context: OrganizationActionContext, workspaceId: string, id: string): string {
  return new URL(`/workspaces/${workspaceId}/apps/${id}`, webOrigin(context)).href;
}

function fileUrl(context: OrganizationActionContext, workspaceId: string, id: string): string {
  return new URL(`/workspaces/${workspaceId}/artifacts/files/${id}`, webOrigin(context)).href;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type PutTarget = { putUrl: string; requiredHeaders?: Record<string, string> };

function putTarget(value: unknown): PutTarget | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (typeof record?.putUrl !== "string") return null;
  const headers = record.requiredHeaders;
  return {
    putUrl: record.putUrl,
    ...(headers && typeof headers === "object"
      ? { requiredHeaders: headers as Record<string, string> }
      : {}),
  };
}

const PUT_TIMEOUT_MS = 60_000;

/**
 * Send bytes to a storage URL Opengeni just prepared. Upload URLs are signed
 * for the public storage address; where the server can't reach it (some
 * self-hosted storage), the caller uploads the bytes itself instead.
 */
async function putBytes(
  context: OrganizationActionContext,
  target: PutTarget,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ok: true } | { ok: false; status?: number }> {
  const headers = new Headers({ "content-type": contentType });
  for (const [name, value] of Object.entries(target.requiredHeaders ?? {}))
    headers.set(name, value);
  const timeout = AbortSignal.timeout(PUT_TIMEOUT_MS);
  try {
    const response = await fetch(target.putUrl, {
      method: "PUT",
      headers,
      body: bytes as Uint8Array<ArrayBuffer>,
      signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch {
    return { ok: false };
  }
}

function uploadFailed(what: string, status: number | undefined, selfUpload: string) {
  const retrySafe = status === undefined || status >= 500 || status === 429;
  return failure(
    `Uploading ${what} failed${status ? ` (${status})` : ""}. ${retrySafe ? "Retry, or " : ""}${selfUpload}`,
    { retrySafe },
  );
}

/** The route refused a reused idempotency key. */
/**
 * The route refused a derived key because this same save already used it with
 * another upload: the first try of this save landed.
 */
function isSameSaveConflict(outcome: ActionOutcome): boolean {
  return (
    isKeyConflict(outcome) &&
    /different (publication input|request)/iu.test(errorEnvelope(outcome.body).message ?? "")
  );
}

function isKeyConflict(outcome: ActionOutcome): boolean {
  return (
    !outcome.ok &&
    outcome.status === 409 &&
    /idempotency key was already used/iu.test(errorEnvelope(outcome.body).message ?? "")
  );
}

const KEY_REUSED =
  "This idempotencyKey was already used for another save, so nothing was saved. Pass a new key, or none.";

type AppVersionReceipt = {
  artifact?: { id?: string; title?: string; visibility?: string };
  version?: { id?: string; revision?: number | undefined };
  replayed?: boolean;
};

function savedApp(
  context: OrganizationActionContext,
  workspaceId: string,
  receipt: AppVersionReceipt,
  extra: Record<string, unknown> = {},
) {
  const id = receipt.artifact?.id ?? "";
  return {
    appId: id,
    name: receipt.artifact?.title,
    version: receipt.version?.revision,
    visibility: receipt.artifact?.visibility,
    link: appUrl(context, workspaceId, id),
    replayed: receipt.replayed === true,
    ...extra,
  };
}

type AppDetail = {
  artifact?: {
    id?: string;
    visibility?: string;
    currentVersion?: VersionFacts | null;
  };
  versions?: VersionFacts[];
};

type VersionFacts = {
  id?: string;
  revision?: number;
  sizeBytes?: number;
  createdBySubjectId?: string;
  createdAt?: string;
};

/** The app's current state, as the person sees it. */
async function readApp(
  context: OrganizationActionContext,
  workspaceId: string,
  artifactId: string,
): Promise<{ ok: true; detail: AppDetail } | { ok: false; result: CallToolResult }> {
  const read = await action(context, "getWorkspaceArtifact", {
    pathParameters: { workspaceId, artifactId },
  });
  if (!read.ok) return read;
  return { ok: true, detail: read.body as AppDetail };
}

/** html, files or uploadId as what the app routes take: inline HTML or a finished upload. */
async function appContent(
  context: OrganizationActionContext,
  workspaceId: string,
  args: z.output<typeof AppSaveInput>,
): Promise<
  | {
      ok: true;
      content: { html: string } | { uploadId: string };
      identity: string;
      /** The entry HTML, for recognising a retry; absent for a caller's own upload. */
      entryHtml?: string;
      /** A multi-file build, uploaded only once a save is due. */
      needsUpload?: boolean;
    }
  | { ok: false; result: CallToolResult }
> {
  if (args.html !== undefined)
    return {
      ok: true,
      content: { html: args.html },
      identity: digest(["html", args.html]),
      entryHtml: args.html,
    };
  if (args.uploadId !== undefined)
    return {
      ok: true,
      content: { uploadId: args.uploadId },
      identity: digest(["upload", args.uploadId]),
    };
  const files = args.files ?? [];
  const entryPath = args.entry ?? "index.html";
  const entry = files.find((file) => file.path === entryPath);
  if (!entry || entry.content === undefined)
    return {
      ok: false,
      result: failure(
        `Include the entry HTML ${entryPath} as text in files, or name another with entry.`,
      ),
    };
  for (const file of files) {
    if ((file.content === undefined) === (file.base64 === undefined))
      return { ok: false, result: failure(`Give content or base64 for ${file.path}.`) };
  }
  const identity = digest(["files", entryPath, files]);
  return {
    ok: true,
    content: { html: entry.content },
    identity,
    entryHtml: entry.content,
    needsUpload: files.length > 1,
  };
}

/** Upload a multi-file build; returns the upload to save in place of inline HTML. */
async function uploadFiles(
  context: OrganizationActionContext,
  workspaceId: string,
  args: z.output<typeof AppSaveInput>,
): Promise<{ ok: true; uploadId: string } | { ok: false; result: CallToolResult }> {
  const files = args.files ?? [];
  const entryPath = args.entry ?? "index.html";
  const entry = files.find((file) => file.path === entryPath);
  const assets = files.filter((file) => file !== entry);
  const prepared = await action(context, PREPARE_APP_UPLOAD, { pathParameters: { workspaceId } });
  if (!prepared.ok) return prepared;
  const upload = prepared.body as {
    uploadId?: unknown;
    html?: unknown;
    assets?: unknown;
    source?: unknown;
  };
  const html = putTarget(upload.html);
  const bundle = putTarget(upload.assets);
  if (typeof upload.uploadId !== "string" || !html || !bundle)
    return { ok: false, result: failure("Opengeni returned an unexpected answer; retry.") };
  const encoder = new TextEncoder();
  const parts: Array<[PutTarget, Uint8Array, string]> = [
    [html, encoder.encode(entry?.content ?? ""), "text/html"],
    [
      bundle,
      encoder.encode(
        JSON.stringify({
          files: assets.map((file) => ({
            path: file.path,
            base64: file.base64 ?? Buffer.from(file.content ?? "", "utf8").toString("base64"),
          })),
        }),
      ),
      "application/json",
    ],
  ];
  // The editable source: the text files, so the app can be changed in Opengeni later.
  const source = putTarget(upload.source);
  if (source)
    parts.push([
      source,
      encoder.encode(
        JSON.stringify({
          entrypoint: entryPath,
          files: files
            .filter((file) => file.content !== undefined)
            .map((file) => ({ path: file.path, content: file.content })),
        }),
      ),
      "application/json",
    ]);
  for (const [target, bytes, contentType] of parts) {
    const sent = await putBytes(context, target, bytes, contentType);
    if (!sent.ok)
      return {
        ok: false,
        result: uploadFailed(
          "the app's files",
          sent.status,
          "upload them yourself: call app_save with prepareUpload, PUT the files, then call it with uploadId.",
        ),
      };
  }
  return { ok: true, uploadId: upload.uploadId };
}

/**
 * A retried save whose first try succeeded: the current version is this
 * caller's, recent, the same size, and the key derived from the version before
 * it replays. Returns that version, or null to save normally.
 */
async function replayedVersion(
  context: OrganizationActionContext,
  workspaceId: string,
  args: z.output<typeof AppSaveInput>,
  detail: AppDetail,
  entryHtml: string,
  versionKey: (base: string) => string,
): Promise<AppVersionReceipt | null> {
  const current = detail.artifact?.currentVersion;
  if (context.caller.kind !== "person" || !current?.id || current.revision === undefined)
    return null;
  if (
    current.createdBySubjectId !== context.caller.subjectId ||
    Date.now() - Date.parse(current.createdAt ?? "") > SAVE_RETRY_WINDOW_MS ||
    current.sizeBytes !== new TextEncoder().encode(entryHtml).byteLength
  )
    return null;
  const previous = (detail.versions ?? [])
    .filter((version) => (version.revision ?? 0) < (current.revision ?? 0) && version.id)
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
  if (!previous?.id) return null;
  // The route replays by key before checking the version, and refuses a stale
  // version otherwise, so this probe never saves anything new.
  const probe = await action(context, "publishWorkspaceArtifactVersion", {
    pathParameters: { workspaceId, artifactId: args.appId ?? "" },
    body: {
      ...(args.name ? { title: args.name } : {}),
      html: entryHtml,
      ...(args.requestedTools ? { requestedTools: args.requestedTools } : {}),
      expectedCurrentVersionId: previous.id,
      idempotencyKey: versionKey(previous.id),
    },
  });
  if (probe.ok) {
    const receipt = probe.body as AppVersionReceipt;
    return receipt.replayed === true ? receipt : null;
  }
  // The derived key encodes this content, so a refused reuse is this save's
  // first try (it uploaded its files under another upload).
  if (isSameSaveConflict(probe))
    return {
      artifact: { id: args.appId ?? "" },
      version: { revision: current.revision },
      replayed: true,
    };
  return null;
}

/** The app an earlier try of this create made: the caller's newest app of that name. */
async function createdApp(
  context: OrganizationActionContext,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const listed = await action(context, "listArtifactCatalog", {
    pathParameters: { workspaceId },
    query: { kind: "site", q: name, sort: "newest", limit: 20 },
  });
  if (!listed.ok) return null;
  const items = ((listed.body as { items?: unknown } | null)?.items ?? []) as Array<{
    id?: string;
    title?: string;
    ownedByViewer?: boolean;
    createdAt?: string;
  }>;
  const since = Date.now() - 2 * SAVE_RETRY_WINDOW_MS;
  return (
    items.find(
      (item) =>
        item.title === name &&
        item.ownedByViewer === true &&
        Date.parse(item.createdAt ?? "") >= since,
    )?.id ?? null
  );
}

/** Define or change each named collection; report each one's outcome. */
async function defineCollections(
  context: OrganizationActionContext,
  workspaceId: string,
  artifactId: string,
  collections: Record<string, z.output<typeof SiteDataCollectionDefinitionRequest>>,
) {
  const outcomes: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const [name, definition] of Object.entries(collections)) {
    const defined = await action(context, "defineSiteDataCollection", {
      pathParameters: { workspaceId, artifactId, name },
      body: definition,
    });
    outcomes.push(
      defined.ok
        ? { name, ok: true }
        : {
            name,
            ok: false,
            error: errorMessage(defined.status ?? 400, defined.body),
          },
    );
  }
  return outcomes;
}

async function rollbackApp(
  context: OrganizationActionContext,
  workspaceId: string,
  artifactId: string,
  revision: number,
  idempotencyKey: string | undefined,
): Promise<CallToolResult> {
  const read = await readApp(context, workspaceId, artifactId);
  if (!read.ok) return read.result;
  const current = read.detail.artifact?.currentVersion;
  const target = (read.detail.versions ?? []).find((version) => version.revision === revision);
  if (!current?.id || !target?.id)
    return failure(`This app has no version ${revision}.`, {
      versions: (read.detail.versions ?? []).map((version) => version.revision),
    });
  if (current.id === target.id)
    return json({
      appId: artifactId,
      version: revision,
      link: appUrl(context, workspaceId, artifactId),
      note: `Version ${revision} is already current.`,
    });
  const key =
    idempotencyKey ??
    stableUuid(
      "mcp-app-rollback",
      workspaceId,
      callerKey(context),
      artifactId,
      current.id,
      target.id,
    );
  const rolled = await action(context, "rollbackWorkspaceArtifact", {
    pathParameters: { workspaceId, artifactId },
    body: {
      versionId: target.id,
      expectedCurrentVersionId: current.id,
      reason: `Rolled back to version ${revision} by a connected agent`,
      idempotencyKey: key,
    },
  });
  if (!rolled.ok) return rolled.result;
  return json(savedApp(context, workspaceId, rolled.body as AppVersionReceipt));
}

const appSave = tool({
  name: "app_save",
  title: "Save an app",
  description:
    "Create an app in Opengeni from a page you built, or save a new version of one you manage (appId), or roll one back (rollbackTo). Give html (one document), files (a multi-file build) or uploadId (a large build; prepareUpload first). collections defines its app data. A new app is visible only to you until you share it with app_publish. Never put credentials in app code: apps call workspace tools (requestedTools) instead.",
  input: AppSaveInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      if (args.prepareUpload) {
        const prepared = await action(context, PREPARE_APP_UPLOAD, {
          pathParameters: { workspaceId },
        });
        if (!prepared.ok) return prepared.result;
        return json({
          ...(prepared.body as object),
          nextStep:
            "PUT the entry HTML to html.putUrl and, for a multi-file build, every other file as JSON {files: [{path, base64}]} to assets.putUrl, each with its requiredHeaders. Then call app_save with this uploadId.",
        });
      }
      const given = [args.html, args.files, args.uploadId].filter(
        (value) => value !== undefined,
      ).length;
      if (given > 1) return failure("Give one of html, files or uploadId.");
      if (args.rollbackTo !== undefined) {
        if (!args.appId) return failure("Pass appId to roll an app back.");
        if (given > 0) return failure("Roll back or save new content, not both.");
        return await rollbackApp(
          context,
          workspaceId,
          args.appId,
          args.rollbackTo,
          args.idempotencyKey,
        );
      }
      if (given === 0) {
        if (!args.appId || !args.collections)
          return failure(
            "Give html, files or uploadId (prepareUpload first for a large build), or collections for an existing app.",
          );
        return json({
          appId: args.appId,
          link: appUrl(context, workspaceId, args.appId),
          collections: await defineCollections(context, workspaceId, args.appId, args.collections),
        });
      }
      if (!args.appId && !args.name) return failure("Give the new app a name.");
      const content = await appContent(context, workspaceId, args);
      if (!content.ok) return content.result;
      const tools = args.requestedTools ? { requestedTools: args.requestedTools } : {};
      const callerChoseKey = args.idempotencyKey !== undefined;
      let body: { html: string } | { uploadId: string } = content.content;
      const upload = async (): Promise<CallToolResult | null> => {
        if (!content.needsUpload) return null;
        const sent = await uploadFiles(context, workspaceId, args);
        if (!sent.ok) return sent.result;
        body = { uploadId: sent.uploadId };
        return null;
      };
      let saved: ActionOutcome;
      if (!args.appId) {
        const name = args.name ?? "";
        const key =
          args.idempotencyKey ??
          stableUuid(
            "mcp-app-create",
            workspaceId,
            callerKey(context),
            String(Math.floor(Date.now() / SAVE_RETRY_WINDOW_MS)),
            digest([name, content.identity, args.requestedTools ?? null]),
          );
        const uploadRefused = await upload();
        if (uploadRefused) return uploadRefused;
        saved = await action(context, "createWorkspaceArtifact", {
          pathParameters: { workspaceId },
          body: {
            title: name,
            ...body,
            ...tools,
            visibility: "private",
            idempotencyKey: key,
          },
        });
        if (isKeyConflict(saved)) {
          if (callerChoseKey) return failure(KEY_REUSED, { retrySafe: false });
          if (!saved.ok && !isSameSaveConflict(saved)) return saved.result;
          // An earlier try created it (a multi-file retry uploads anew, so the
          // route sees different input under the same derived key).
          const createdId = await createdApp(context, workspaceId, name);
          if (createdId)
            return json(
              savedApp(context, workspaceId, {
                artifact: { id: createdId, title: name },
                replayed: true,
              }),
            );
          return failure(
            "An earlier try of this save already created the app; find it with apps_list. Pass a new idempotencyKey to create another.",
            { retrySafe: false },
          );
        }
      } else {
        const targetId = args.appId;
        const read = await readApp(context, workspaceId, targetId);
        if (!read.ok) return read.result;
        const current = read.detail.artifact?.currentVersion?.id;
        if (!current) return failure("This app has no version to build on.");
        // The version it builds on is part of a derived key, so saving A, B,
        // then A again makes three versions.
        const versionKey = (base: string) =>
          stableUuid(
            "mcp-app-version",
            workspaceId,
            callerKey(context),
            targetId,
            base,
            digest([args.name ?? null, content.identity, args.requestedTools ?? null]),
          );
        if (!callerChoseKey && content.entryHtml !== undefined) {
          const replay = await replayedVersion(
            context,
            workspaceId,
            args,
            read.detail,
            content.entryHtml,
            versionKey,
          );
          if (replay) return json(savedApp(context, workspaceId, replay));
        }
        const uploadRefused = await upload();
        if (uploadRefused) return uploadRefused;
        saved = await action(context, "publishWorkspaceArtifactVersion", {
          pathParameters: { workspaceId, artifactId: targetId },
          body: {
            ...(args.name ? { title: args.name } : {}),
            ...body,
            ...tools,
            expectedCurrentVersionId: current,
            idempotencyKey: args.idempotencyKey ?? versionKey(current),
          },
        });
        if (isKeyConflict(saved)) {
          if (callerChoseKey) return failure(KEY_REUSED, { retrySafe: false });
          if (!saved.ok && !isSameSaveConflict(saved)) return saved.result;
          // The derived key encodes this content on this version: a multi-file
          // retry of a save that already landed on it.
          const again = await readApp(context, workspaceId, targetId);
          if (!again.ok) return again.result;
          return json(
            savedApp(context, workspaceId, {
              artifact: { id: targetId },
              version: { revision: again.detail.artifact?.currentVersion?.revision },
              replayed: true,
            }),
          );
        }
      }
      if (!saved.ok) return saved.result;
      const receipt = saved.body as AppVersionReceipt;
      const artifactId = receipt.artifact?.id;
      const collections =
        args.collections && artifactId
          ? {
              collections: await defineCollections(
                context,
                workspaceId,
                artifactId,
                args.collections,
              ),
            }
          : {};
      return json(
        savedApp(context, workspaceId, receipt, {
          ...collections,
          ...(args.appId ? {} : { nextStep: "Share it with app_publish when it's ready." }),
        }),
      );
    }),
});

type PublicationView = {
  url?: string;
  hostname?: string;
  access?: string;
  status?: string;
  warnings?: Array<{ code?: string; message?: string; suggestion?: string; fix?: unknown }>;
};

function publicationSummary(publication: PublicationView) {
  return {
    url: publication.url,
    hostname: publication.hostname,
    access: publication.access,
    status: publication.status,
    warnings: publication.warnings ?? [],
  };
}

const appPublish = tool({
  name: "app_publish",
  title: "Share an app",
  description:
    "Choose who can open an app you manage: only_me, workspace (its members) or public (anyone with the link, on its own hostname). The answer lists readiness warnings; apply their fixes by calling again with fixes. Make an app public only when the person asked for it.",
  input: AppPublishInput,
  readOnly: false,
  openWorld: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const path = { workspaceId, artifactId: args.appId };
      const read = await readApp(context, workspaceId, args.appId);
      if (!read.ok) return read.result;
      const before = read.detail.artifact?.visibility === "workspace" ? "workspace" : "private";
      const existing = await action(context, PUBLICATION_GET, { pathParameters: path });
      // Only "not published" (or publishing off on this deployment, also a
      // 404) reads as unpublished; any other failure changes nothing.
      if (!existing.ok && existing.status !== 404) return existing.result;
      const published = existing.ok ? (existing.body as PublicationView) : null;
      const setVisibility = (visibility: "private" | "workspace") =>
        action(context, "updateWorkspaceArtifactVisibility", {
          pathParameters: path,
          body: { visibility },
        });
      const link = appUrl(context, workspaceId, args.appId);
      if (args.access === "only_me") {
        // The owner-only step first, so a refusal changes nothing.
        if (before !== "private") {
          const narrowed = await setVisibility("private");
          if (!narrowed.ok) return narrowed.result;
        }
        if (published?.status === "active") {
          const stopped = await action(context, PUBLICATION_PUT, {
            pathParameters: path,
            body: { status: "unpublished" },
          });
          if (!stopped.ok)
            return failure(
              `The app is now visible only to you, but taking it off the web failed: ${errorMessage(stopped.status ?? 400, stopped.body)} Call app_publish with only_me again.`,
              { retrySafe: true },
            );
        }
        return json({ appId: args.appId, access: "only_me", link });
      }
      const widened = before !== "workspace";
      if (widened) {
        const shared = await setVisibility("workspace");
        if (!shared.ok) return shared.result;
      }
      // Workspace without a hostname stays in the app, unless it was already
      // on the web: then only members may open it there.
      const onTheWeb = args.access === "public" || args.hostname !== undefined;
      const narrow =
        args.access === "workspace" &&
        published?.status === "active" &&
        published.access !== "members";
      let publication = published;
      if (onTheWeb || narrow) {
        const upserted = await action(context, PUBLICATION_PUT, {
          pathParameters: path,
          body: {
            ...(args.hostname ? { label: args.hostname } : {}),
            access: args.access === "public" ? "public" : "members",
            status: "active",
          },
        });
        if (!upserted.ok) {
          const reason = errorMessage(upserted.status ?? 400, upserted.body);
          if (!widened) return upserted.result;
          const restored = await setVisibility("private");
          return failure(
            restored.ok
              ? `${reason} Nothing changed.`
              : `${reason} The app is now visible to the workspace; set it back with app_publish only_me.`,
            errorFacts(upserted.status ?? 400, upserted.body),
          );
        }
        publication = upserted.body as PublicationView;
      }
      const fixed: Array<{ fix: unknown; ok: boolean; error?: string }> = [];
      if (args.fixes?.length && publication) {
        for (const fix of args.fixes) {
          const applied = await action(context, PUBLICATION_FIX, {
            pathParameters: path,
            body: fix,
          });
          if (applied.ok) publication = applied.body as PublicationView;
          fixed.push(
            applied.ok
              ? { fix, ok: true }
              : { fix, ok: false, error: errorMessage(applied.status ?? 400, applied.body) },
          );
        }
      }
      const summary = publication ? publicationSummary(publication) : null;
      const fixable = (summary?.warnings ?? []).some((warning) => warning.fix);
      return json({
        appId: args.appId,
        access: args.access,
        link,
        ...(summary ? { publication: summary } : {}),
        ...(fixed.length ? { fixes: fixed } : {}),
        ...(args.fixes?.length && !publication
          ? { fixesIgnored: "Fixes apply to an app on the web; this one isn't published." }
          : {}),
        ...(fixable
          ? {
              nextStep:
                "Fix the warnings before sharing the link: call app_publish again with fixes (the warnings' fix objects), or change the app.",
            }
          : {}),
      });
    }),
});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

function contentTypeFor(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

type SavedFile = { id?: string; filename?: string; sizeBytes?: number; access?: unknown };

function savedFile(
  context: OrganizationActionContext,
  workspaceId: string,
  file: SavedFile,
  replayed = false,
) {
  return {
    fileId: file.id,
    name: file.filename,
    sizeBytes: file.sizeBytes,
    ...(file.access ? { access: file.access } : {}),
    link: fileUrl(context, workspaceId, file.id ?? ""),
    replayed,
  };
}

const fileSave = tool({
  name: "file_save",
  title: "Share a file",
  description:
    "Save a file you made (a report, image, document or data) in the workspace's files and get its link. Send it as content (text) or base64 up to 4 MB; for a larger file pass name and sizeBytes to get a putUrl, upload it there, then call again with uploadId. Visible only to you unless visibility is workspace. Saving the same name and content again within an hour returns the first file.",
  input: FileSaveInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      if (args.uploadId) {
        const completed = await action(context, "completeFileUpload", {
          pathParameters: { workspaceId, uploadId: args.uploadId },
        });
        if (!completed.ok) return completed.result;
        const file = (completed.body as { file?: SavedFile }).file ?? {};
        return json(savedFile(context, workspaceId, file));
      }
      if (!args.name) return failure("Give the file a name, such as report.pdf.");
      if (args.content !== undefined && args.base64 !== undefined)
        return failure("Give content or base64, not both.");
      const contentType = args.contentType ?? contentTypeFor(args.name);
      const scope = args.visibility === "workspace" ? "workspace" : "personal";
      const inline = args.content ?? args.base64;
      if (inline === undefined) {
        if (!args.sizeBytes) return failure("Give content, base64, or sizeBytes for a large file.");
        const begun = await action(context, "beginFileUpload", {
          pathParameters: { workspaceId },
          body: { scope, filename: args.name, contentType, sizeBytes: args.sizeBytes },
        });
        if (!begun.ok) return begun.result;
        const upload = begun.body as Record<string, unknown>;
        return json({
          uploadId: upload.uploadId,
          putUrl: upload.putUrl,
          requiredHeaders: upload.requiredHeaders,
          expiresAt: upload.expiresAt,
          nextStep: `PUT the file's bytes to putUrl with requiredHeaders and content-type ${contentType}, then call file_save with this uploadId.`,
        });
      }
      const bytes =
        args.content !== undefined
          ? new TextEncoder().encode(args.content)
          : new Uint8Array(Buffer.from(args.base64 ?? "", "base64"));
      if (bytes.byteLength === 0) return failure("The file is empty.");
      if (bytes.byteLength > FILE_SAVE_INLINE_MAX_BYTES)
        return failure(
          "This file is over 4 MB: pass name and sizeBytes instead to get an upload URL.",
        );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // A retry within the hour finds the file the first try saved.
      const listed = await action(context, "listFiles", {
        pathParameters: { workspaceId },
        query: { scope, limit: 50 },
      });
      if (listed.ok) {
        const since = Date.now() - SAVE_RETRY_WINDOW_MS;
        const page = listed.body as { files?: unknown } | null;
        const files = (Array.isArray(page?.files) ? page.files : []) as Array<
          SavedFile & {
            sha256?: string | null;
            status?: string;
            createdAt?: string;
            ownerSubjectId?: string | null;
          }
        >;
        const owner = context.caller.kind === "person" ? context.caller.subjectId : null;
        const earlier = files.find(
          (file) =>
            owner !== null &&
            file.ownerSubjectId === owner &&
            file.filename === args.name &&
            file.sha256 === sha256 &&
            file.status === "ready" &&
            Date.parse(file.createdAt ?? "") >= since,
        );
        if (earlier) return json(savedFile(context, workspaceId, earlier, true));
      }
      const begun = await action(context, "beginFileUpload", {
        pathParameters: { workspaceId },
        // With its checksum, storage verifies the bytes and the file records it.
        body: { scope, filename: args.name, contentType, sizeBytes: bytes.byteLength, sha256 },
      });
      if (!begun.ok) return begun.result;
      const upload = begun.body as { uploadId?: unknown };
      const target = putTarget(begun.body);
      if (typeof upload.uploadId !== "string" || !target)
        return failure("Opengeni returned an unexpected answer; retry.");
      const sent = await putBytes(context, target, bytes, contentType);
      if (!sent.ok)
        return uploadFailed(
          "the file",
          sent.status,
          "upload it yourself: call file_save with name and sizeBytes, PUT the bytes, then call it with uploadId.",
        );
      const completed = await action(context, "completeFileUpload", {
        pathParameters: { workspaceId, uploadId: upload.uploadId },
      });
      if (!completed.ok) return completed.result;
      const file = (completed.body as { file?: SavedFile }).file ?? {};
      return json(savedFile(context, workspaceId, file));
    }),
});

type CatalogEntry = {
  identity: { serverId: string; toolName: string };
  modelName?: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  approval?: string;
  permission?: { decision?: string; fromSetting?: boolean };
  source?: string;
};

/**
 * What a call needs, for an outside agent: `none`, `human` (the person
 * approves each call) or `blocked` (refused), and whether that comes from the
 * tool itself or from the person's and workspace's tool settings.
 */
export function toolsSearchApproval(entry: Pick<CatalogEntry, "approval" | "permission">): {
  approval: "none" | "human" | "blocked";
  approvalSource: "tool" | "policy";
} {
  const decision = entry.permission?.decision;
  const approvalSource = entry.permission?.fromSetting === true ? "policy" : "tool";
  if (decision === "block") return { approval: "blocked", approvalSource };
  if (decision === "ask" || entry.approval === "human")
    return { approval: "human", approvalSource };
  return { approval: "none", approvalSource };
}

const toolsSearch = tool({
  name: "tools_search",
  title: "Find workspace tools",
  description:
    "Find the tools Opengeni agents use in this workspace (its connected apps, MCP servers and Opengeni's own), including ones that need the person's approval (approval: human) and ones their tool settings block (approval: blocked). approvalSource says whether that comes from the tool or from tool settings. Call one with tool_call.",
  input: ToolsSearchInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const catalog = await action(context, "GET /v1/workspaces/:workspaceId/tools/catalog", {
        pathParameters: { workspaceId },
      });
      if (!catalog.ok) return catalog.result;
      const entries = ((catalog.body as { entries?: CatalogEntry[] })?.entries ?? []).filter(
        (entry) => entry?.identity,
      );
      const words = args.query
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(Boolean);
      const scored = entries
        .map((entry) => {
          const name =
            `${entry.identity.serverId} ${entry.identity.toolName} ${entry.modelName ?? ""} ${entry.title ?? ""}`.toLowerCase();
          const text = (entry.description ?? "").toLowerCase();
          const score = words.reduce(
            (total, word) => total + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0),
            0,
          );
          return { entry, score };
        })
        .filter((candidate) => words.length === 0 || candidate.score > 0)
        .sort((left, right) => right.score - left.score);
      return json({
        total: scored.length,
        tools: scored.slice(0, args.limit).map(({ entry }) => ({
          serverId: entry.identity.serverId,
          toolName: entry.identity.toolName,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.description ? { description: entry.description.slice(0, 1_000) } : {}),
          ...toolsSearchApproval(entry),
          ...(args.includeSchemas && entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
        })),
      });
    }),
});

/** A link where the person approves exactly this call in the Opengeni app. */
export function toolApprovalUrl(
  origin: string,
  workspaceId: string,
  call: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    operationId: string;
  },
): string | null {
  const fragment = Buffer.from(JSON.stringify(call)).toString("base64url");
  if (fragment.length > APPROVAL_LINK_MAX_BYTES) return null;
  return `${new URL(`/workspaces/${workspaceId}/tool-approval`, origin).href}#${fragment}`;
}

const toolCall = tool({
  name: "tool_call",
  title: "Call a workspace tool",
  description:
    "Call a tool from tools_search as the person, with their connected accounts. A tool that needs approval returns needsApproval and a link: show it to the person, and after they approve call again with the same operationId; it runs once. A result with retrySafe false may already have run: check before calling again with a new operationId.",
  input: ToolCallInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const operationId = args.operationId ?? crypto.randomUUID();
      const invoked = await action(
        context,
        INVOKE_ACTION,
        {
          pathParameters: { workspaceId },
          body: {
            target: {
              identity: { serverId: args.serverId, toolName: args.toolName },
            },
            operationId,
            arguments: args.arguments,
          },
        },
        { claimStoredApproval: true },
      );
      if (!invoked.ok) {
        const reason = errorEnvelope(invoked.body).details?.code;
        if (invoked.status === 409 && reason === "tool_gateway_approval_required") {
          const url = toolApprovalUrl(webOrigin(context), workspaceId, {
            serverId: args.serverId,
            toolName: args.toolName,
            arguments: args.arguments,
            operationId,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  needsApproval: true,
                  operationId,
                  ...(url
                    ? { approvalUrl: url }
                    : {
                        hint: "These arguments are too large for an approval link; ask an Opengeni chat to make this call instead.",
                      }),
                  retrySafe: true,
                  next: "Show the link to the person. After they approve, call tool_call again with the same arguments and this operationId within 5 minutes.",
                }),
              },
            ],
            isError: true,
          };
        }
        return { ...invoked.result, content: [...invoked.result.content] };
      }
      const parsed = ToolGatewayInvokeResponse.safeParse(invoked.body);
      if (!parsed.success)
        return failure("The tool answered in an unexpected shape.", {
          operationId,
          retrySafe: false,
          outcomeUnknown: true,
        });
      const result = parsed.data.result as CallToolResult;
      return {
        ...result,
        content: [
          ...(result.content ?? []),
          { type: "text", text: JSON.stringify({ operationId }) },
        ],
      };
    }),
});

type SkillSummary = {
  id: string;
  stableKey: string;
  scope: string;
  scopeVersion: number;
  activeRevisionId: string | null;
  revisionId: string | null;
  title: string | null;
  description: string | null;
  status: string;
  pendingRevisionIds?: string[];
};

async function listAllSkills(
  context: OrganizationActionContext,
  workspaceId: string,
): Promise<{ ok: true; skills: SkillSummary[] } | { ok: false; result: CallToolResult }> {
  const skills: SkillSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await action(context, "listWorkspaceSkills", {
      pathParameters: { workspaceId },
      query: { limit: 250, ...(cursor ? { cursor } : {}) },
    });
    if (!listed.ok) return listed;
    const body = listed.body as {
      skills?: SkillSummary[];
      nextCursor?: string | null;
    };
    skills.push(...(body.skills ?? []));
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return { ok: true, skills };
}

/** The `name:` in a SKILL.md frontmatter, or null when there is none to read. */
export function skillFrontmatterName(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return null;
  const line = /^name:\s*(.+)$/mu.exec(match[1]!);
  return line ? line[1]!.trim().replace(/^["']|["']$/gu, "") : null;
}

export function skillKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function sameFiles(
  left: ReadonlyArray<{ path: string; content: string }>,
  right: ReadonlyArray<{ path: string; content: string }>,
): boolean {
  const key = (files: ReadonlyArray<{ path: string; content: string }>) =>
    JSON.stringify([...files].map(({ path, content }) => [path, content]).sort());
  return key(left) === key(right);
}

/**
 * Save Skill folders as the caller, one result each: Personal unless `scope`
 * says otherwise, following the workspace's Agent learning setting (Review
 * first leaves them pending), and skipping unchanged ones.
 */
async function uploadSkills(
  context: OrganizationActionContext,
  workspaceId: string,
  listed: SkillSummary[],
  scope: "user" | "workspace" | "organization",
  uploads: ReadonlyArray<{
    name?: string | undefined;
    files: ReadonlyArray<{ path: string; content: string }>;
  }>,
  reason: string,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  // Two folders naming the same Skill would save over each other in one sync.
  const seen = new Set<string>();
  for (const upload of uploads) {
    const main = upload.files.find((file) => file.path === "SKILL.md");
    const name = upload.name ?? (main ? skillFrontmatterName(main.content) : null);
    if (!main) {
      results.push({
        name: upload.name ?? null,
        status: "invalid",
        error: "The folder has no SKILL.md.",
      });
      continue;
    }
    if (!name) {
      results.push({
        name: null,
        status: "invalid",
        error: "SKILL.md needs YAML frontmatter between --- lines with name: and description:.",
      });
      continue;
    }
    const stableKey = skillKey(name);
    if (!stableKey) {
      results.push({
        name,
        status: "invalid",
        error: "The Skill's name needs letters or digits.",
      });
      continue;
    }
    if (seen.has(stableKey)) {
      results.push({
        name,
        status: "invalid",
        error: "Another folder in this sync has a Skill with the same name.",
      });
      continue;
    }
    seen.add(stableKey);
    const current = listed.find((skill) => skill.stableKey === stableKey && skill.scope === scope);
    if (current) {
      const read = await action(context, "readWorkspaceSkill", {
        pathParameters: { workspaceId, skillId: current.id },
      });
      const files = read.ok
        ? ((
            read.body as {
              files?: Array<{ path: string; content: string }>;
            }
          ).files ?? [])
        : null;
      if (files && sameFiles(files, upload.files)) {
        results.push({
          name: stableKey,
          status: "unchanged",
          skillId: current.id,
        });
        continue;
      }
    }
    const filesDigest = createHash("sha256").update(JSON.stringify(upload.files)).digest("hex");
    const skillId =
      current?.id ?? stableUuid("mcp-skill", workspaceId, callerKey(context), scope, stableKey);
    // The exact head the lifecycle checks: its active revision (null while
    // only a pending one exists) and scope version; a new Skill starts at 1.
    const expectedRevisionId = current ? current.activeRevisionId : null;
    const operationId = stableUuid(
      "mcp-skill-save",
      workspaceId,
      callerKey(context),
      skillId,
      String(expectedRevisionId),
      filesDigest,
    );
    const saved = await action(context, "saveWorkspaceSkill", {
      pathParameters: { workspaceId },
      body: {
        operationId,
        skillId,
        expectedRevisionId,
        expectedScopeVersion: current ? current.scopeVersion : 1,
        scope,
        stableKey,
        files: upload.files,
        deletions: [],
        reason,
      },
    });
    if (!saved.ok) {
      const envelope = errorEnvelope(saved.body);
      results.push({
        name: stableKey,
        status:
          saved.status === 409
            ? "conflict"
            : saved.status === 400 || saved.status === 422
              ? "invalid"
              : "failed",
        error: envelope.message ?? errorMessage(saved.status ?? 0, saved.body),
      });
      continue;
    }
    const receipt = saved.body as {
      outcome?: string;
      skillId?: string;
      revisionId?: string;
    };
    results.push({
      name: stableKey,
      status: receipt.outcome === "pending" ? "pending_review" : current ? "updated" : "created",
      skillId: receipt.skillId ?? skillId,
      ...(receipt.revisionId ? { revisionId: receipt.revisionId } : {}),
    });
  }
  return results;
}

const skillsSync = tool({
  name: "skills_sync",
  title: "Sync Skills",
  description:
    "Upload local Skill folders to Opengeni, sync every Skill folder of a GitHub repository (direction repository, read at one commit), or pull the workspace's Skills to write locally. Uploads and syncs are Personal unless you pass scope, follow the workspace's Agent learning setting (Review first leaves them waiting for the person's review), skip unchanged Skills and report each Skill's result.",
  input: SkillsSyncInput,
  readOnly: false,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const listed = await listAllSkills(context, workspaceId);
      if (!listed.ok) return listed.result;
      if (args.direction === "pull") {
        const wanted = args.names ? new Set(args.names.map(skillKey)) : null;
        const pulled: unknown[] = [];
        for (const summary of listed.skills) {
          if (wanted && !wanted.has(summary.stableKey)) continue;
          if (pulled.length >= 100) break;
          const read = await action(context, "readWorkspaceSkill", {
            pathParameters: { workspaceId, skillId: summary.id },
          });
          if (!read.ok) {
            pulled.push({ name: summary.stableKey, status: "unreadable" });
            continue;
          }
          const skill = read.body as {
            files?: unknown;
            scope?: unknown;
            status?: unknown;
          };
          pulled.push({
            name: summary.stableKey,
            scope: skill.scope,
            status: skill.status,
            files: skill.files,
          });
        }
        return json({ skills: pulled });
      }
      if (args.direction === "repository") {
        if (!args.repository) return failure("Pass repository: a GitHub repository or folder URL.");
        if (!context.readSkillRepository) {
          return failure("Syncing from a repository isn't available on this server.");
        }
        let snapshot: Awaited<ReturnType<NonNullable<typeof context.readSkillRepository>>>;
        try {
          snapshot = await context.readSkillRepository(args.repository);
        } catch (error) {
          if (error instanceof HTTPException && error.status === 429) {
            return failure(
              "GitHub's request limit for this server has been reached. Try again after it resets, or upload the Skills from a local checkout.",
            );
          }
          return failure(
            error instanceof Error && error.message
              ? `Couldn't read the repository: ${error.message}`
              : "Couldn't read the repository.",
          );
        }
        const source = `${snapshot.owner}/${snapshot.repository}@${snapshot.commit.slice(0, 12)}`;
        const results = await uploadSkills(
          context,
          workspaceId,
          listed.skills,
          args.scope,
          snapshot.skills.map((skill) => ({ files: skill.files })),
          `Synced from ${source}`,
        );
        snapshot.skills.forEach((skill, index) => {
          if (results[index]) results[index] = { ...results[index], path: skill.path };
        });
        return json({
          scope: args.scope,
          repository: `https://github.com/${snapshot.owner}/${snapshot.repository}`,
          commit: snapshot.commit,
          results: [
            ...results,
            ...snapshot.skipped.map((skip) => ({
              path: skip.path,
              status: "invalid",
              error: skip.reason,
            })),
          ],
          ...(snapshot.truncated
            ? {
                note: "Only the first 50 Skill folders were synced. Sync a folder URL for the rest.",
              }
            : results.some((result) => result.status === "pending_review")
              ? {
                  note: "Skills waiting for review appear on the Skills page in Opengeni for the person to approve.",
                }
              : {}),
        });
      }
      if (args.skills.length === 0) return failure("Pass skills to upload.");
      const results = await uploadSkills(
        context,
        workspaceId,
        listed.skills,
        args.scope,
        args.skills,
        "Uploaded from a connected agent",
      );
      return json({
        scope: args.scope,
        results,
        ...(results.some((result) => result.status === "pending_review")
          ? {
              note: "Skills waiting for review appear on the Skills page in Opengeni for the person to approve.",
            }
          : {}),
      });
    }),
});

const skillsList = tool({
  name: "skills_list",
  title: "List Skills",
  description:
    "List the workspace's Skills (Personal, workspace and organization) without their files.",
  input: WorkspaceOnlyInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const listed = await listAllSkills(context, workspaceId);
      return listed.ok ? json({ skills: listed.skills }) : listed.result;
    }),
});

const knowledgeSearch = tool({
  name: "knowledge_search",
  title: "Search Knowledge",
  description:
    "Search the workspace's Knowledge (facts, decisions, requirements, incidents, notes). Open a match with knowledge_get.",
  input: KnowledgeSearchInput,
  readOnly: true,
  run: async (context, args) => {
    const { workspaceId: requested, ...search } = args;
    return inWorkspace(context, requested, async (workspaceId) => {
      const found = await action(context, "listKnowledgeEntries", {
        pathParameters: { workspaceId },
        body: search,
      });
      return found.ok ? json(found.body) : found.result;
    });
  },
});

const knowledgeGet = tool({
  name: "knowledge_get",
  title: "Read Knowledge",
  description: "Read one Knowledge entry in full, with its version for a correction.",
  input: KnowledgeGetInput,
  readOnly: true,
  run: async (context, args) =>
    inWorkspace(context, args.workspaceId, async (workspaceId) => {
      const read = await action(context, "getKnowledgeEntry", {
        pathParameters: { workspaceId, entryId: args.entryId },
        query: {
          ...(args.revisionId ? { revisionId: args.revisionId } : {}),
          ...(args.view ? { view: args.view } : {}),
        },
      });
      return read.ok ? json(read.body) : read.result;
    }),
});

const knowledgeSave = tool({
  name: "knowledge_save",
  title: "Save Knowledge",
  description:
    "Save a lasting fact, decision, requirement, incident or note to the workspace's Knowledge, or correct an entry (entryId and expectedVersion from knowledge_get). Search first so you don't save a duplicate.",
  input: KnowledgeSaveInput,
  readOnly: false,
  run: async (context, args) => {
    const { workspaceId: requested, operationId, ...save } = args;
    return inWorkspace(context, requested, async (workspaceId) => {
      const key =
        operationId ??
        stableUuid("mcp-knowledge-save", workspaceId, callerKey(context), JSON.stringify(save));
      const saved = await action(context, "saveKnowledgeEntry", {
        pathParameters: { workspaceId },
        body: { ...save, operationId: key },
      });
      return saved.ok ? json({ ...(saved.body as object), operationId: key }) : saved.result;
    });
  },
});

/** Every named tool, in the order clients list them. */
export const NAMED_TOOLS: readonly ToolSpec[] = [
  delegate,
  waitFor,
  sessionSend,
  sessionsList,
  sessionGet,
  sessionEvents,
  sessionPause,
  sessionResume,
  agentsList,
  sandboxEnvironmentsList,
  workspacesList,
  workspaceUse,
  appsList,
  appDescribe,
  appQuery,
  appWrite,
  appSave,
  appPublish,
  fileSave,
  toolsSearch,
  toolCall,
  skillsSync,
  skillsList,
  knowledgeSearch,
  knowledgeGet,
  knowledgeSave,
];

/**
 * Hidden aliases: older or alternative names that keep working but aren't
 * listed. App tools also answer to their Site names.
 */
export const NAMED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  sites_list: "apps_list",
  site_describe: "app_describe",
  site_query: "app_query",
  site_write: "app_write",
  session_wait_for: "wait_for",
};

const BY_NAME = new Map(NAMED_TOOLS.map((spec) => [spec.name, spec] as const));

export function findNamedTool(name: string): ToolSpec | undefined {
  return BY_NAME.get(NAMED_TOOL_ALIASES[name] ?? name);
}

export function namedToolDescriptors() {
  return NAMED_TOOLS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input, {
      io: "input",
      unrepresentable: "any",
    }) as never,
    annotations: {
      readOnlyHint: spec.readOnly,
      ...(spec.readOnly ? {} : { openWorldHint: spec.openWorld === true }),
    },
  }));
}

export async function callNamedTool(
  context: OrganizationActionContext,
  spec: ToolSpec,
  args: unknown,
): Promise<CallToolResult> {
  const parsed = spec.input.safeParse(args ?? {});
  if (!parsed.success) return failure(`Invalid input: ${z.prettifyError(parsed.error)}`);
  return await spec.run(context, parsed.data as never);
}
