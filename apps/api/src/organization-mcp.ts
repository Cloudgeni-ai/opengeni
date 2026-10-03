import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import * as contracts from "@opengeni/contracts";
import {
  isReadOnlyPermissionSet,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import { z } from "zod";

import type { ActionCatalogEntry } from "./mcp/action-catalog-types";
import { ACTION_CATALOG } from "./mcp/action-catalog.gen";

/* ----------------------------------------------------------------------------
   The organization MCP server (`/v1/mcp`).

   Every public API action is reachable through three tools: find an action,
   describe it, run it. A call runs the real route in this process as the
   caller, so the route's own permission checks decide, exactly as for the
   app:

   - a person who signed in (MCP OAuth): the request carries the verified
     person proof, re-resolving their live access and capping it by the
     connection's access setting on every call;
   - an organization API key: the request carries that key.

   The proof lives on the exact Request object in process memory; nothing a
   client sends can create it.
   -------------------------------------------------------------------------- */

export type OrganizationMcpCaller =
  | {
      kind: "person";
      accountId: string;
      subjectId: string;
      access: OrganizationAccessPolicy;
    }
  | { kind: "key"; authorization: string; accessKey: string | null };

const MAX_RESPONSE_BYTES = 256 * 1024;
const STREAM_READ_MS = 2_000;

const SearchInput = z
  .object({
    query: z.string().max(200).default(""),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const DescribeInput = z.object({ id: z.string().min(1).max(300) }).strict();
const CallInput = z
  .object({
    id: z.string().min(1).max(300),
    pathParameters: z.record(z.string(), z.string().min(1).max(1024)).default({}),
    query: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
      )
      .default({}),
    body: z.unknown().optional(),
  })
  .strict();

const TOOLS = [
  {
    name: "opengeni_actions_search",
    title: "Find Opengeni actions",
    description:
      "Search every action available in Opengeni: sessions and chats, workspaces, people, knowledge, files, schedules, connections, models, keys, billing and settings. Returns action ids to describe and call. An empty query lists everything, page by page.",
    inputSchema: z.toJSONSchema(SearchInput, { io: "input" }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "opengeni_action_describe",
    title: "Describe an Opengeni action",
    description:
      "Show an action's method, path, path parameters and the JSON schema of its input, so it can be called correctly.",
    inputSchema: z.toJSONSchema(DescribeInput, { io: "input" }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "opengeni_action_call",
    title: "Run an Opengeni action",
    description:
      "Run one Opengeni action as this connection, with exactly the access it was given. Pass path parameters (for example workspaceId), query parameters and a JSON body. Returns the HTTP status and response.",
    inputSchema: z.toJSONSchema(CallInput, { io: "input" }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
] as const;

export function buildOrganizationMcpServer(input: {
  caller: OrganizationMcpCaller;
  /** This API's own origin; the call never leaves the process. */
  origin: string;
  dispatch: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
}): Server {
  const server = new Server(
    { name: "opengeni", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Opengeni actions: use opengeni_actions_search to find what you need, opengeni_action_describe for its inputs, then opengeni_action_call. Most actions take a workspaceId path parameter; list workspaces first (search 'workspaces').",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as never })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case "opengeni_actions_search": {
        const parsed = SearchInput.safeParse(args);
        if (!parsed.success) return invalid(parsed.error);
        return json(searchActions(parsed.data));
      }
      case "opengeni_action_describe": {
        const parsed = DescribeInput.safeParse(args);
        if (!parsed.success) return invalid(parsed.error);
        const entry = findAction(parsed.data.id);
        if (!entry) return failure(`No action "${parsed.data.id}". Search for it first.`);
        return json(describeAction(entry));
      }
      case "opengeni_action_call": {
        const parsed = CallInput.safeParse(args);
        if (!parsed.success) return invalid(parsed.error);
        return await callAction(input, parsed.data);
      }
      default:
        return failure(`Unknown tool ${request.params.name}.`);
    }
  });
  return server;
}

export function findAction(id: string): ActionCatalogEntry | undefined {
  const trimmed = id.trim();
  return ACTION_CATALOG.find(
    (entry) => entry.id === trimmed || `${entry.method} ${entry.path}` === trimmed,
  );
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function searchActions(input: { query: string; limit: number; offset: number }) {
  const wanted = words(input.query);
  const scored = ACTION_CATALOG.map((entry) => {
    const haystack = [
      ...words(entry.id),
      ...words(entry.path.replace(/:\w+/g, "")),
      entry.method.toLowerCase(),
    ];
    const score = wanted.reduce(
      (total, word) =>
        total +
        (haystack.includes(word) ? 2 : haystack.some((token) => token.startsWith(word)) ? 1 : 0),
      0,
    );
    return { entry, score, size: words(entry.id).length };
  }).filter((candidate) => wanted.length === 0 || candidate.score > 0);
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.size - right.size ||
      left.entry.id.localeCompare(right.entry.id),
  );
  return {
    total: scored.length,
    offset: input.offset,
    actions: scored.slice(input.offset, input.offset + input.limit).map(({ entry }) => ({
      id: entry.id,
      method: entry.method,
      path: entry.path,
    })),
  };
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
}

function schemaFor(name: string): unknown {
  const candidate = (contracts as Record<string, unknown>)[name];
  if (!(candidate instanceof z.ZodType)) return null;
  try {
    return z.toJSONSchema(candidate, { io: "input", unrepresentable: "any" });
  } catch {
    return null;
  }
}

export function describeAction(entry: ActionCatalogEntry) {
  const reads = entry.method === "GET" || entry.method === "HEAD";
  return {
    id: entry.id,
    method: entry.method,
    path: entry.path,
    pathParameters: pathParameters(entry.path),
    input: entry.request.map((name) => ({
      name,
      in: reads ? "query" : "body",
      schema: schemaFor(name),
    })),
    response: entry.response,
  };
}

async function callAction(
  context: Parameters<typeof buildOrganizationMcpServer>[0],
  input: z.infer<typeof CallInput>,
): Promise<CallToolResult> {
  const entry = findAction(input.id);
  if (!entry) return failure(`No action "${input.id}". Search for it first.`);
  const reads = entry.method === "GET" || entry.method === "HEAD";
  if (
    context.caller.kind === "person" &&
    !reads &&
    isReadOnlyPermissionSet(context.caller.access.permissions)
  ) {
    return failure("This connection is read only, so it can't change anything.");
  }
  let path = entry.path;
  for (const name of pathParameters(entry.path)) {
    const value = input.pathParameters[name];
    if (!value) return failure(`Missing path parameter ${name}.`);
    // Encoding leaves "." alone, so a dot segment would reach another route.
    if (value === "." || value === "..") return failure(`Invalid path parameter ${name}.`);
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  const url = new URL(path, context.origin);
  if (url.pathname !== path) return failure("Invalid path parameters.");
  for (const [key, value] of Object.entries(input.query)) {
    for (const each of Array.isArray(value) ? value : [value])
      url.searchParams.append(key, String(each));
  }
  const headers = new Headers({
    accept: "application/json",
    [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
  });
  if (context.caller.kind === "key") {
    headers.set("authorization", context.caller.authorization);
    if (context.caller.accessKey) headers.set("x-opengeni-access-key", context.caller.accessKey);
  }
  const body = reads ? undefined : JSON.stringify(input.body ?? {});
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    // Exact length: the body-limit middleware otherwise rebuilds the Request,
    // and the person proof lives on this exact object.
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  const request = new Request(url, {
    method: entry.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    redirect: "manual",
  });
  if (context.caller.kind === "person") {
    stampDelegatedHumanAuthorization(request, {
      organizationId: context.caller.accountId,
      subjectId: context.caller.subjectId,
      permissions: context.caller.access.permissions,
      workspaceScope: context.caller.access.workspaceScope,
    });
  }
  const response = await context.dispatch(request);
  return await toolResult(response);
}

async function toolResult(response: Response): Promise<CallToolResult> {
  const status = response.status;
  const location = response.headers.get("location");
  if (status >= 300 && status < 400 && location) {
    await response.body?.cancel();
    return json({
      status,
      openInBrowser: location,
      hint: "Open this link in a browser to finish.",
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  const result: Record<string, unknown> = { status };
  if (/text\/event-stream/i.test(contentType)) {
    result.events = await readStream(response);
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const truncated = bytes.byteLength > MAX_RESPONSE_BYTES;
    const kept = truncated ? bytes.slice(0, MAX_RESPONSE_BYTES) : bytes;
    if (/json/i.test(contentType) && !truncated) {
      result.body = JSON.parse(new TextDecoder().decode(kept) || "null");
    } else if (/^text\/|json|xml|yaml|javascript/i.test(contentType) || contentType === "") {
      result.body = new TextDecoder().decode(kept);
    } else {
      result.contentType = contentType;
      result.base64 = Buffer.from(kept).toString("base64");
    }
    if (truncated)
      result.truncated = { returnedBytes: MAX_RESPONSE_BYTES, totalBytes: bytes.byteLength };
  }
  if (
    status === 403 &&
    /human|browser|cookie|same-origin/i.test(JSON.stringify(result.body ?? ""))
  ) {
    result.hint = "This action has to be done by the person in the Opengeni app in a browser.";
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(status >= 400 ? { isError: true } : {}),
  };
}

async function readStream(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + STREAM_READ_MS;
  try {
    while (Date.now() < deadline && text.length < MAX_RESPONSE_BYTES) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.max(0, deadline - Date.now()),
          ),
        ),
      ]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function invalid(error: z.ZodError): CallToolResult {
  return failure(`Invalid input: ${z.prettifyError(error)}`);
}
