/**
 * Known-value secret masking at the agent's tool and model seams
 * (docs/secrets.md, Masking).
 *
 * - `installToolResultSecretMasking` wraps every function tool the agent
 *   resolves (sandbox tools, MCP and first-party tools, Codemode results,
 *   tool search dispatch) so its result reaches the model, the run state and
 *   stored history with every known secret value replaced by its reference.
 * - `secretValueModelInputFilter` masks the whole model input before every
 *   provider request, as the final guard for text that reached history by
 *   another path.
 * - `withAttemptSecretValues` / `activeAttemptSecretValues` carry the
 *   attempt's memory to seams that cannot receive it explicitly (first-party
 *   tool call metadata).
 *
 * Masking never throws into a tool or a turn.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallModelInputFilter, Tool } from "@openai/agents";
import {
  FIRST_PARTY_SECRET_VALUES_META_KEY,
  maskSecretValuesInError,
  revealSecretGetResult,
  type SecretValueMaskEntry,
  type SecretValueMemory,
} from "@opengeni/contracts";

const attemptMemories = new AsyncLocalStorage<SecretValueMemory>();

export function withAttemptSecretValues<T>(memory: SecretValueMemory | null, run: () => T): T {
  return memory ? attemptMemories.run(memory, run) : run();
}

export function activeAttemptSecretValues(): SecretValueMemory | undefined {
  return attemptMemories.getStore();
}

/** The values a first-party call's arguments carried, for its `_meta`. */
export function firstPartySecretValuesMeta(
  operationId: string,
  memory: SecretValueMemory | undefined = activeAttemptSecretValues(),
): Record<string, SecretValueMaskEntry[]> {
  try {
    const entries = memory?.operationEntries(operationId) ?? [];
    return entries.length > 0 ? { [FIRST_PARTY_SECRET_VALUES_META_KEY]: entries } : {};
  } catch {
    return {};
  }
}

type MaskableAgent = {
  getAllTools: (runContext: any) => Promise<Tool<any>[]>;
  clone?: (config: any) => MaskableAgent;
};

const agentMemories = new WeakMap<object, SecretValueMemory>();
const maskedTools = new WeakMap<SecretValueMemory, WeakMap<object, Tool<any>>>();

/**
 * The same function tool with its result (and error message) masked: known
 * values, then secret-shaped parts, which are first captured into the task
 * vault so their reference can replace them. Stable per tool.
 */
export function secretMaskedTool<T extends Tool<any>>(tool: T, memory: SecretValueMemory): T {
  if (tool.type !== "function") return tool;
  let cache = maskedTools.get(memory);
  if (!cache) {
    cache = new WeakMap();
    maskedTools.set(memory, cache);
  }
  const existing = cache.get(tool);
  if (existing) return existing as T;
  const invoke = tool.invoke.bind(tool);
  const next = {
    ...tool,
    invoke: async (...args: Parameters<typeof invoke>) => {
      let result: Awaited<ReturnType<typeof invoke>>;
      try {
        result = await invoke(...args);
      } catch (error) {
        await memory.refresh();
        if (error instanceof Error) await memory.captureShapes(error.message, "tool_error");
        throw maskSecretValuesInError(error, memory, "tool_output");
      }
      // Values another process resolved for this session tree (run_on, an
      // earlier turn) are loaded first, bounded and best effort.
      await memory.refresh();
      // `secret_get` is the explicit, audited plaintext read: what it reveals
      // stays readable for the rest of the attempt (docs/secrets.md, Masking).
      revealSecretGetResult(memory, tool.name, result);
      await memory.captureShapes(result, "tool_result");
      return memory.maskToolOutput(result, "tool_result");
    },
  } as T;
  cache.set(tool, next);
  // A masked tool handed back in is not wrapped twice.
  cache.set(next, next);
  return next;
}

/**
 * Wrap the agent's function tools so every result is masked with `memory`.
 * Install it last, after every other tool wrapper, so it sees what reaches
 * the model. Clones (SandboxAgent rebuilds tools on a fresh clone) get it too.
 */
export function installToolResultSecretMasking(
  agent: MaskableAgent,
  memory: SecretValueMemory,
): void {
  if (agentMemories.has(agent)) return;
  agentMemories.set(agent, memory);
  const getAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = async (runContext: unknown) =>
    (await getAllTools(runContext)).map((tool) => secretMaskedTool(tool, memory));
  const clone = agent.clone?.bind(agent);
  if (clone) {
    agent.clone = (config: unknown) => {
      const cloned = clone(config);
      installToolResultSecretMasking(cloned, memory);
      return cloned;
    };
  }
}

/**
 * Tools the runner binds by name outside `getAllTools` (remembered and
 * dispatched tools) get the same masking as the agent's listed tools.
 */
export function secretMaskedToolResolver<
  R extends ((input: any) => Promise<Tool<any> | null | undefined>) | undefined,
>(agent: object, resolve: R): R {
  const memory = agentMemories.get(agent);
  if (!memory || !resolve) return resolve;
  const wrapped = async (input: unknown) => {
    const tool = await resolve(input);
    return tool ? secretMaskedTool(tool, memory) : tool;
  };
  return wrapped as R;
}

/**
 * Mask the instructions and every model input item with the attempt's
 * memory. The runtime runs it after every other filter that can add input.
 * Items are cached by identity per memory version, so an unchanged history
 * prefix is not re-scanned on every request.
 */
export function secretValueModelInputFilter(memory: SecretValueMemory): CallModelInputFilter {
  let cache = new WeakMap<object, unknown>();
  let cachedVersion = memory.version;
  return ({ modelData }) => {
    if (memory.size === 0) return modelData;
    if (memory.version !== cachedVersion) {
      cache = new WeakMap();
      cachedVersion = memory.version;
    }
    const instructions =
      typeof modelData.instructions === "string"
        ? memory.maskText(modelData.instructions, "model_instructions")
        : undefined;
    const instructionsChanged =
      instructions !== undefined && instructions !== modelData.instructions;
    const withInstructions = instructionsChanged ? { instructions } : {};
    if (!Array.isArray(modelData.input)) {
      return instructionsChanged ? { ...modelData, ...withInstructions } : modelData;
    }
    let changed = false;
    const input = modelData.input.map((item) => {
      if (item === null || typeof item !== "object") return item;
      let masked = cache.get(item) as typeof item | undefined;
      if (masked === undefined) {
        masked = memory.mask(item, "model_input");
        cache.set(item, masked);
      }
      if (masked !== item) changed = true;
      return masked;
    });
    if (!changed && !instructionsChanged) return modelData;
    return { ...modelData, input: changed ? input : modelData.input, ...withInstructions };
  };
}
