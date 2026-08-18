import { RunContext, type Agent } from "@openai/agents";
import {
  INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME,
  OPEN_SUFFIX_RUN_STATE_BLOB,
} from "@opengeni/contracts";
import { HUMAN_INPUT_TOOL_NAME } from "./run-events";
import {
  extractOpenSuffixMembers,
  type HistoryItem,
  type OpenSuffixMember,
} from "./history-sanitizer";

export type OpenSuffixInterruptionKind = "human_input" | "approval" | "interaction_intervention";

export class OpenSuffixUnresumableError extends Error {
  readonly code = "open_suffix_unresumable";

  constructor(message: string) {
    super(message);
    this.name = "OpenSuffixUnresumableError";
  }
}

/** Bounded control checkpoint; never a generatedItems heap dump. */
export const OPEN_SUFFIX_MAX_JSON_BYTES = 3 * 1024 * 1024;

export function protocolItemsFromGeneratedItems(generatedItems: unknown): HistoryItem[] {
  if (!Array.isArray(generatedItems)) {
    return [];
  }
  const items: HistoryItem[] = [];
  for (const wrapper of generatedItems) {
    if (!wrapper || typeof wrapper !== "object") {
      continue;
    }
    const rawItem = (wrapper as { rawItem?: unknown }).rawItem;
    if (rawItem && typeof rawItem === "object" && !Array.isArray(rawItem)) {
      items.push(rawItem as HistoryItem);
    }
  }
  return items;
}

export function extractOpenSuffixFromSerializedRunState(serialized: string): OpenSuffixMember[] {
  try {
    const parsed = JSON.parse(serialized) as {
      generatedItems?: unknown;
      _generatedItems?: unknown;
    };
    return extractOpenSuffixMembers(
      protocolItemsFromGeneratedItems(parsed.generatedItems ?? parsed._generatedItems),
    );
  } catch {
    return [];
  }
}

export function extractOpenSuffixFromRunState(state: unknown): OpenSuffixMember[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const record = state as {
    generatedItems?: unknown;
    _generatedItems?: unknown;
    history?: unknown;
    toString?: () => string;
  };
  const fromGenerated = extractOpenSuffixMembers(
    protocolItemsFromGeneratedItems(record.generatedItems ?? record._generatedItems),
  );
  if (fromGenerated.length > 0) {
    return fromGenerated;
  }
  if (Array.isArray(record.history)) {
    const fromHistory = extractOpenSuffixMembers(record.history as HistoryItem[]);
    if (fromHistory.length > 0) {
      return fromHistory;
    }
  }
  if (typeof record.toString === "function") {
    const serialized = record.toString();
    if (serialized !== "[object Object]") {
      return extractOpenSuffixFromSerializedRunState(serialized);
    }
  }
  return [];
}

export function serializedRunStateForOpenSuffixPause(
  compacted: string,
  maximumJsonBytes = OPEN_SUFFIX_MAX_JSON_BYTES,
): string {
  return Buffer.byteLength(compacted, "utf8") > maximumJsonBytes
    ? OPEN_SUFFIX_RUN_STATE_BLOB
    : compacted;
}

export function interruptionKindForCallItem(
  callItem: Record<string, unknown>,
): OpenSuffixInterruptionKind {
  const name = typeof callItem.name === "string" ? callItem.name : "";
  if (name === HUMAN_INPUT_TOOL_NAME) {
    return "human_input";
  }
  if (name === INTERACTION_REQUEST_HUMAN_MODEL_TOOL_NAME) {
    return "interaction_intervention";
  }
  return "approval";
}

export function assertOpenSuffixResumable(
  members: readonly OpenSuffixMember[],
  interruptionCallIds: readonly string[],
): void {
  const byCallId = new Map(members.map((member) => [member.callId, member]));
  const interruptionIds = new Set(interruptionCallIds);
  for (const member of members) {
    if (!interruptionIds.has(member.callId)) {
      throw new OpenSuffixUnresumableError(
        `open suffix has unpaired ${member.callType}:${member.callId} that is not a requires_action interruption`,
      );
    }
  }
  for (const callId of interruptionCallIds) {
    const member = byCallId.get(callId);
    if (!member) {
      throw new OpenSuffixUnresumableError(
        `requires_action interruption ${callId} has no open-suffix call item`,
      );
    }
    if (member.callType === "computer_call") {
      throw new OpenSuffixUnresumableError(
        `requires_action cannot pause a computer_call interruption without a typed suffix member`,
      );
    }
  }
  let suffixBytes = 0;
  for (const callId of interruptionCallIds) {
    const member = byCallId.get(callId);
    if (!member) {
      continue;
    }
    suffixBytes += Buffer.byteLength(
      JSON.stringify({
        callItem: member.callItem,
        reasoningItems: member.reasoningItems,
      }),
      "utf8",
    );
  }
  if (suffixBytes > OPEN_SUFFIX_MAX_JSON_BYTES) {
    throw new OpenSuffixUnresumableError(
      `open suffix is ${suffixBytes} UTF-8 bytes; the bound is ${OPEN_SUFFIX_MAX_JSON_BYTES}`,
    );
  }
}

export function functionCallResultItem(input: {
  callId: string;
  name: string;
  output: unknown;
  status?: "completed" | "incomplete";
}): Record<string, unknown> {
  const text =
    typeof input.output === "string" ? input.output : JSON.stringify(input.output ?? null);
  return {
    type: "function_call_result",
    name: input.name,
    callId: input.callId,
    status: input.status ?? "completed",
    output: { type: "text", text },
  };
}

export async function invokePreparedAgentTool(input: {
  agent: Agent<any, any>;
  toolName: string;
  argumentsJson: string;
  callId: string;
}): Promise<unknown> {
  const hosted = input.agent.tools.find(
    (tool) => tool.type === "function" && tool.name === input.toolName,
  );
  const mcpTools =
    typeof input.agent.getMcpTools === "function"
      ? await input.agent.getMcpTools(new RunContext())
      : [];
  const mcp = mcpTools.find((tool) => tool.type === "function" && tool.name === input.toolName);
  const tool = hosted ?? mcp;
  if (!tool || tool.type !== "function") {
    throw new OpenSuffixUnresumableError(
      `Open suffix cannot invoke missing tool ${input.toolName}`,
    );
  }
  return await tool.invoke(new RunContext(), input.argumentsJson, {
    toolCall: {
      type: "function_call",
      callId: input.callId,
      name: input.toolName,
      arguments: input.argumentsJson,
    },
  });
}
