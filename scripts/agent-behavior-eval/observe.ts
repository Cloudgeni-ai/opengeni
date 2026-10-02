import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { SessionEvent } from "@opengeni/contracts";
import { dbSql, getAttemptToolCatalog, withWorkspaceRls } from "@opengeni/db";

import { apiRequest, listAllSessionEvents, type DriveOutcome } from "./session";
import type { EvalStack, EvalWorkspace } from "./stack";
import type { SessionObservation, ToolCallRecord, UsageTotals } from "./types";

/** `orders__search_documents` / `mcp_x__tool` → `search_documents`. */
export function normalizeToolName(name: string): string {
  const index = name.lastIndexOf("__");
  const base = index >= 0 ? name.slice(index + 2) : name;
  if (base === "apply_patch_call") return "apply_patch";
  if (base === "web_search_call" || base === "web_search_preview") return "web_search";
  return base;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function observeEvents(
  events: SessionEvent[],
): Pick<
  SessionObservation,
  "turnOutputs" | "finalAnswer" | "toolCalls" | "eventTypes" | "humanInputRequests" | "usage"
> {
  const toolCalls: ToolCallRecord[] = [];
  const byId = new Map<string, ToolCallRecord>();
  const turnOutputs: string[] = [];
  const eventTypes: Record<string, number> = {};
  const usage: UsageTotals = {
    modelCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  let humanInputRequests = 0;
  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
    const payload = record(event.payload);
    switch (event.type) {
      case "agent.toolCall.created": {
        const raw = record(payload.raw);
        const existing = typeof payload.id === "string" ? byId.get(payload.id) : undefined;
        const rawName =
          (typeof payload.name === "string" && payload.name) ||
          (typeof raw.name === "string" && raw.name) ||
          (typeof raw.type === "string" && raw.type) ||
          "unknown";
        const args =
          payload.arguments ?? raw.arguments ?? raw.operation ?? raw.action ?? raw.query ?? null;
        if (existing) {
          // Hosted tools (web_search) emit a created event per lifecycle phase.
          if (existing.arguments === null && args !== null)
            existing.arguments = parseArguments(args);
          break;
        }
        const call: ToolCallRecord = {
          name: normalizeToolName(rawName),
          rawName,
          arguments: parseArguments(args),
          output: null,
        };
        toolCalls.push(call);
        if (typeof payload.id === "string") byId.set(payload.id, call);
        break;
      }
      case "agent.toolCall.output": {
        const call = typeof payload.id === "string" ? byId.get(payload.id) : undefined;
        if (call) {
          call.output =
            typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output);
        }
        break;
      }
      case "turn.completed": {
        turnOutputs.push(typeof payload.output === "string" ? payload.output : "");
        break;
      }
      case "session.humanInput.requested": {
        humanInputRequests += 1;
        break;
      }
      case "agent.model.usage": {
        usage.modelCalls += 1;
        usage.inputTokens += numberField(payload, "inputTokens");
        usage.cachedTokens += numberField(payload, "cachedTokens");
        usage.cacheWriteTokens += numberField(payload, "cacheWriteTokens");
        usage.outputTokens += numberField(payload, "outputTokens");
        usage.reasoningTokens += numberField(payload, "reasoningTokens");
        break;
      }
      default:
        break;
    }
  }
  return {
    turnOutputs,
    finalAnswer: turnOutputs.at(-1) ?? "",
    toolCalls,
    eventTypes,
    humanInputRequests,
    usage,
  };
}

type ModelContextResponse = {
  attemptId?: string | null;
  snapshot?: {
    tokens?: { prefix?: number };
    providerRequest?: { body?: string } | null;
    instructions?: string;
    tools?: Array<{ name?: string; exposure?: string }>;
  } | null;
};

export async function observeModelContext(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
): Promise<
  Pick<SessionObservation, "systemPromptChars" | "prefixTokens" | "upfrontTools" | "availableTools">
> {
  const empty = {
    systemPromptChars: null,
    prefixTokens: null,
    upfrontTools: [],
    availableTools: [],
  };
  try {
    const context = await apiRequest<ModelContextResponse>(
      stack,
      workspace,
      "GET",
      `/v1/workspaces/${workspace.workspaceId}/sessions/${sessionId}/model-context`,
    );
    const snapshot = context.snapshot;
    if (!snapshot) return empty;
    let instructions = snapshot.instructions ?? "";
    let upfrontTools: string[] = [];
    const body = snapshot.providerRequest?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as {
          instructions?: unknown;
          tools?: Array<{ name?: unknown; type?: unknown }>;
        };
        if (typeof parsed.instructions === "string" && parsed.instructions.length > 0) {
          instructions = parsed.instructions;
        }
        upfrontTools = (parsed.tools ?? [])
          .map((tool) =>
            typeof tool.name === "string"
              ? tool.name
              : typeof tool.type === "string"
                ? tool.type
                : "",
          )
          .filter((name) => name.length > 0);
      } catch {
        // Keep the structured snapshot fields.
      }
    }
    if (upfrontTools.length === 0 && Array.isArray(snapshot.tools)) {
      upfrontTools = snapshot.tools
        .filter((tool) => tool.exposure !== "searchable")
        .map((tool) => tool.name ?? "")
        .filter((name) => name.length > 0);
    }
    const available = new Set(upfrontTools.map(normalizeToolName));
    if (context.attemptId) {
      const catalog = await getAttemptToolCatalog(stack.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        attemptId: context.attemptId,
      }).catch(() => null);
      for (const entry of catalog?.entries ?? []) available.add(normalizeToolName(entry.modelName));
    }
    return {
      systemPromptChars: instructions.length > 0 ? instructions.length : null,
      prefixTokens: typeof snapshot.tokens?.prefix === "number" ? snapshot.tokens.prefix : null,
      upfrontTools,
      availableTools: [...available].sort(),
    };
  } catch {
    return empty;
  }
}

/** Tool names the router disclosed (`Disclosed tools: opengeni__x, …`) in tool_search outputs. */
export function disclosedTools(toolCalls: ToolCallRecord[]): string[] {
  const names = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== "tool_search" || !call.output) continue;
    const match = /Disclosed tools:\s*([^"\n]+)/u.exec(call.output);
    for (const name of match?.[1]?.split(",") ?? []) {
      const trimmed = name.trim();
      if (/^[A-Za-z0-9_.-]+$/u.test(trimmed)) names.add(normalizeToolName(trimmed));
    }
  }
  return [...names];
}

export async function observeSession(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
  userMessages: string[],
  drive: DriveOutcome,
  /** Tools the session was created with (e.g. its frozen first-party MCP selection). */
  selectedTools: string[] = [],
): Promise<SessionObservation> {
  const events = await listAllSessionEvents(stack, workspace, sessionId);
  const observed = observeEvents(events);
  const context = await observeModelContext(stack, workspace, sessionId);
  const available = new Set([
    ...context.availableTools,
    ...selectedTools,
    ...disclosedTools(observed.toolCalls),
    ...observed.toolCalls.map((call) => call.name),
  ]);
  return {
    sessionId,
    userMessages,
    ...observed,
    ...context,
    availableTools: [...available].sort(),
    drive,
  };
}

function findStringField(value: unknown, key: string, depth = 0): string | null {
  if (depth > 6 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  const direct = object[key];
  if (typeof direct === "string" && direct.startsWith("/")) return direct;
  for (const child of Object.values(object)) {
    const found = findStringField(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Host path of a local-backend sandbox workspace (the provider instance id). */
export async function localSandboxRoot(
  stack: EvalStack,
  workspace: EvalWorkspace,
  sessionId: string,
): Promise<string | null> {
  const rows = await withWorkspaceRls(stack.db, workspace.workspaceId, async (scoped) => {
    const result = await scoped.execute(dbSql`
      select lease.resume_state as resume_state, lease.instance_id as instance_id
      from sandbox_leases lease
      join sessions session
        on session.workspace_id = lease.workspace_id
       and session.sandbox_group_id = lease.sandbox_group_id
      where session.workspace_id = ${workspace.workspaceId}
        and session.id = ${sessionId}
    `);
    return result as unknown as Array<{ resume_state: unknown; instance_id: unknown }>;
  });
  for (const row of rows) {
    const fromState = findStringField(row.resume_state, "workspaceRootPath");
    if (fromState) return fromState;
    if (typeof row.instance_id === "string" && row.instance_id.startsWith("/")) {
      return row.instance_id;
    }
  }
  return null;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".venv", ".opengeni"]);

export async function readTextTree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let count = 0;
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (count >= MAX_FILES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) {
        files[relative(root, path)] = `<binary-or-large:${info?.size ?? "?"}>`;
      } else {
        files[relative(root, path)] = await readFile(path, "utf8").catch(() => "<unreadable>");
      }
      count += 1;
    }
  }
  await walk(root);
  return files;
}
