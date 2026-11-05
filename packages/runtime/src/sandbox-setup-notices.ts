/**
 * Model-facing notices from sandbox setup, such as a repository folder that
 * was moved aside instead of deleted.
 *
 * Setup that finishes before the model runs puts its notices into the turn's
 * input. Setup that runs at the first sandbox operation (a workspace machine
 * started on demand) has no input left to extend, so its notices follow the next
 * plain-text result of a sandbox shell tool: normally the result of the very
 * command that waited for the machine. The text is appended when the result is
 * produced and is stored with it, so earlier history and the prompt-cache
 * prefix never change. Only the shell tools are wrapped: every other tool keeps
 * its exact identity, which the SDK and Opengeni's approval and human-input
 * handling rely on.
 */
import type { Tool } from "@openai/agents";
import { appendToPlainTextToolOutput } from "./command-completion-delivery";

type SetupNoticeQueue = {
  pending: string[];
  /** The exact text appended to a tool result, for audit views. */
  onDelivered?: ((appended: string) => void) | undefined;
};

const agentQueues = new WeakMap<object, SetupNoticeQueue>();
const installedAgents = new WeakSet<object>();
const deliveringTools = new WeakMap<SetupNoticeQueue, WeakMap<object, Tool<any>>>();

/** The sandbox shell tools, whose results are plain command output. */
const SETUP_NOTICE_TOOL_NAMES: ReadonlySet<string> = new Set(["exec_command", "write_stdin"]);

function queueForAgent(agent: object): SetupNoticeQueue {
  let queue = agentQueues.get(agent);
  if (!queue) {
    queue = { pending: [] };
    agentQueues.set(agent, queue);
  }
  return queue;
}

/** Hold a setup notice until the model can read it. */
export function queueSandboxSetupNotice(agent: object, notice: string): void {
  const text = notice.trim();
  if (!text) return;
  const queue = queueForAgent(agent);
  if (!queue.pending.includes(text)) queue.pending.push(text);
}

/** Take every held notice as one text, or null when none are held. */
export function takeSandboxSetupNotices(agent: object): string | null {
  const queue = agentQueues.get(agent);
  if (!queue || queue.pending.length === 0) return null;
  const text = queue.pending.join("\n\n");
  queue.pending = [];
  return text;
}

function setupNoticeDeliveringTool<T extends Tool<any>>(tool: T, queue: SetupNoticeQueue): T {
  if (tool.type !== "function" || !SETUP_NOTICE_TOOL_NAMES.has(tool.name)) return tool;
  let cache = deliveringTools.get(queue);
  if (!cache) {
    cache = new WeakMap();
    deliveringTools.set(queue, cache);
  }
  const existing = cache.get(tool);
  if (existing) return existing as T;
  const invoke = tool.invoke.bind(tool);
  const next = {
    ...tool,
    invoke: async (...args: Parameters<typeof invoke>) => {
      const output = await invoke(...args);
      if (queue.pending.length === 0) return output;
      const notice = queue.pending.join("\n\n");
      const appended = appendToPlainTextToolOutput(output, notice);
      // JSON, images and structured results stay exactly as the tool returned
      // them; the notice waits for the next plain-text result.
      if (appended === null) return output;
      queue.pending = [];
      queue.onDelivered?.(notice);
      return appended as Awaited<ReturnType<typeof invoke>>;
    },
  } as T;
  cache.set(tool, next);
  cache.set(next, next);
  return next;
}

type DeliveringAgent = {
  getAllTools: (runContext: any) => Promise<Tool<any>[]>;
  clone?: (config: any) => DeliveringAgent;
};

/**
 * Let the agent's function tool results carry held setup notices. Clones share
 * the same notices.
 */
export function installSandboxSetupNoticeDelivery(
  agent: DeliveringAgent,
  options: { onDelivered?: (appended: string) => void } = {},
): void {
  if (installedAgents.has(agent)) return;
  installedAgents.add(agent);
  const queue = queueForAgent(agent);
  if (options.onDelivered) queue.onDelivered = options.onDelivered;
  const getAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = async (runContext: unknown) =>
    (await getAllTools(runContext)).map((tool) => setupNoticeDeliveringTool(tool, queue));
  const clone = agent.clone?.bind(agent);
  if (clone) {
    agent.clone = (config: unknown) => {
      const cloned = clone(config);
      agentQueues.set(cloned, queue);
      installSandboxSetupNoticeDelivery(cloned);
      return cloned;
    };
  }
}
