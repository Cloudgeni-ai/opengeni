/**
 * A guard against a model calling the same tool with the same arguments over
 * and over in one turn while nothing changes.
 *
 * Once one exact call (same tool, same arguments) has returned the same result
 * REPEATED_CALL_LIMIT times in a row, a further identical call made soon after
 * the last one ran returns a short notice instead of running again, and the
 * run continues. A call whose result changes resets the count, so it is never
 * affected. Polling stays possible: an identical call made at least
 * REPEATED_CALL_WINDOW_MS after the last one started runs normally, and runs
 * the count again from its result. The notice is the call's ordinary tool
 * result, so it is recorded with the turn like any other result.
 *
 * Each agent instance is one turn's attempt; its clones share the counts.
 */
import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";

/** Identical results in a row before an identical call is answered with the notice. */
export const REPEATED_CALL_LIMIT = 8;

/** An identical call this long after the last one started runs again (polling). */
export const REPEATED_CALL_WINDOW_MS = 30_000;

/** Distinct calls remembered per turn; the least recently run are forgotten first. */
export const REPEATED_CALL_MEMORY = 512;

/** The model-facing result of a call the guard did not run. */
export const REPEATED_CALL_NOTICE = `Not run again: this exact call already returned the same result ${REPEATED_CALL_LIMIT} times in a row in this turn. Use that result, change the arguments, or continue with another step.`;

type CallRecord = { result: string; streak: number; startedAt: number };

export type RepeatedToolCallGuard = {
  calls: Map<string, CallRecord>;
  now: () => number;
};

export function createRepeatedToolCallGuard(now: () => number = Date.now): RepeatedToolCallGuard {
  return { calls: new Map(), now };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The same arguments in any key order and spacing are the same call. */
function callKey(toolName: string, input: unknown): string {
  let args: string;
  if (typeof input === "string") {
    try {
      args = canonicalJson(JSON.parse(input));
    } catch {
      args = input;
    }
  } else {
    args = canonicalJson(input);
  }
  // A digest, so large arguments (patches, file contents) are not kept.
  return createHash("sha256").update(`${toolName}\u0000${args}`).digest("hex");
}

/** A digest of a result, or null when it can't be compared (never counted). */
function resultDigest(output: unknown): string | null {
  let text: string | undefined;
  try {
    text = typeof output === "string" ? output : JSON.stringify(output);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Run one call through the guard: the notice when it repeats a call that keeps
 * returning the same result, otherwise the call's own result.
 */
export async function guardRepeatedToolCall<T>(
  guard: RepeatedToolCallGuard,
  toolName: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T | string> {
  const key = callKey(toolName, input);
  const previous = guard.calls.get(key);
  const startedAt = guard.now();
  if (
    previous &&
    previous.streak >= REPEATED_CALL_LIMIT &&
    startedAt - previous.startedAt < REPEATED_CALL_WINDOW_MS
  ) {
    return REPEATED_CALL_NOTICE;
  }
  const output = await run();
  const result = resultDigest(output);
  if (result === null) {
    guard.calls.delete(key);
    return output;
  }
  const latest = guard.calls.get(key);
  // Re-inserted, so the map's order is least recently run first.
  guard.calls.delete(key);
  guard.calls.set(key, {
    result,
    streak: latest?.result === result ? latest.streak + 1 : 1,
    startedAt,
  });
  while (guard.calls.size > REPEATED_CALL_MEMORY) {
    const oldest = guard.calls.keys().next().value;
    if (oldest === undefined) break;
    guard.calls.delete(oldest);
  }
  return output;
}

const guardingTools = new WeakMap<RepeatedToolCallGuard, WeakMap<object, Tool<any>>>();

/** The same function tool, answered by the guard. Stable per tool. */
export function repeatGuardedTool<T extends Tool<any>>(tool: T, guard: RepeatedToolCallGuard): T {
  if (tool.type !== "function") return tool;
  let cache = guardingTools.get(guard);
  if (!cache) {
    cache = new WeakMap();
    guardingTools.set(guard, cache);
  }
  const existing = cache.get(tool);
  if (existing) return existing as T;
  const invoke = tool.invoke.bind(tool);
  const next = {
    ...tool,
    invoke: async (...args: Parameters<typeof invoke>) =>
      (await guardRepeatedToolCall(
        guard,
        tool.name,
        args[1],
        async () => await invoke(...args),
      )) as Awaited<ReturnType<typeof invoke>>,
  } as T;
  cache.set(tool, next);
  cache.set(next, next);
  return next;
}

type GuardedAgent = {
  getAllTools: (runContext: any) => Promise<Tool<any>[]>;
  clone?: (config: any) => GuardedAgent;
};

const agentGuards = new WeakMap<object, RepeatedToolCallGuard>();

/**
 * Guard the agent's function tools against repeated identical calls. It is
 * installed inside command-completion delivery, so it compares the tool's own
 * result. Clones share the same counts.
 */
export function installRepeatedToolCallGuard(
  agent: GuardedAgent,
  guard: RepeatedToolCallGuard = createRepeatedToolCallGuard(),
): void {
  if (agentGuards.has(agent)) return;
  agentGuards.set(agent, guard);
  const getAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = async (runContext: unknown) =>
    (await getAllTools(runContext)).map((tool) => repeatGuardedTool(tool, guard));
  const clone = agent.clone?.bind(agent);
  if (clone) {
    agent.clone = (config: unknown) => {
      const cloned = clone(config);
      installRepeatedToolCallGuard(cloned, guard);
      return cloned;
    };
  }
}

/** Tools the runner binds by name outside `getAllTools` are guarded too. */
export function repeatGuardedToolResolver<
  R extends ((input: any) => Promise<Tool<any> | null | undefined>) | undefined,
>(agent: object, resolve: R): R {
  const guard = agentGuards.get(agent);
  if (!guard || !resolve) return resolve;
  const wrapped = async (input: unknown) => {
    const tool = await resolve(input);
    return tool ? repeatGuardedTool(tool, guard) : tool;
  };
  return wrapped as R;
}
