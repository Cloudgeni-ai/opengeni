import {
  integrationForFamily,
  integrationForLabel,
  integrationForToolName,
  shortToolName,
} from "./integrations";
import type { ApprovalReceipt, CardReceipt, IntegrationId, Receipts, ToolReceipt } from "./types";

/** The subset of a public session event the parser reads. */
export type EventLike = {
  sequence: number;
  type: string;
  payload?: unknown;
  turnId?: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const ERROR_TEXT = [
  /"isError"\s*:\s*true/,
  /^\s*(?:error|failed)\b[:\s]/i,
  /\b(?:mcp_call_failed|mcp_connect_failed|account_reconnect_required|connection_unavailable)\b/,
  /\b(?:401 unauthorized|403 forbidden|invalid[_ ]token|token (?:has )?expired)\b/i,
];

/** Whether a tool output reports a failure. Conservative: unknown shapes count as success. */
export function outputErrored(payload: Record<string, unknown>, output: string | null): boolean {
  if (payload.isError === true || payload.error) return true;
  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : null;
  if (status === "failed" || status === "error") return true;
  if (output === null) return false;
  return ERROR_TEXT.some((pattern) => pattern.test(output.slice(0, 4000)));
}

const ACCOUNT_DESCRIPTION =
  /"name"\s*:\s*"([^"]+)"\s*,\s*"description"\s*:\s*"Account: ([^"]+?)\s*(?:—|·|-)\s/g;

/** Map model-visible tool names to integrations from tool_search/tool_list outputs. */
function accountLabelsFromOutputs(outputs: readonly string[]): Map<string, IntegrationId> {
  const map = new Map<string, IntegrationId>();
  for (const output of outputs) {
    for (const match of output.matchAll(ACCOUNT_DESCRIPTION)) {
      const name = match[1];
      const id = integrationForLabel(match[2]);
      if (name && id) map.set(name, id);
    }
  }
  return map;
}

const OGTOOL_CALL = /\bogtool\s+call\s+([A-Za-z0-9_.:/-]+)/;

/**
 * The MCP server's own name from a tool result (`_meta` serverInfo), such as
 * "linear". Some model routes record connector calls without a tool family,
 * and generic tool names (`list_issues`) name no integration on their own.
 */
export function mcpServerName(output: string | null): string | null {
  if (!output) return null;
  const meta = record(record(parseJson(output))._meta);
  const name = record(meta["io.modelcontextprotocol/serverInfo"]).name;
  if (typeof name === "string") return name;
  return (
    /"io\.modelcontextprotocol\/serverInfo"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/.exec(output)?.[1] ??
    null
  );
}

/**
 * Rebuild tool calls, approvals, connect cards and the answer from a
 * session's forensic events. The events are the source of truth: grading
 * never trusts the answer text alone.
 */
export function parseReceipts(events: readonly EventLike[]): Receipts {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const created = new Map<string, { event: EventLike; payload: Record<string, unknown> }>();
  const outputs = new Map<string, Record<string, unknown>>();
  const approvals: ApprovalReceipt[] = [];
  const approvalById = new Map<string, ApprovalReceipt>();
  const cards: CardReceipt[] = [];
  const answers: string[] = [];
  const turnStatuses: string[] = [];
  let humanInputRequests = 0;
  const usage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costMicros: null as number | null,
  };

  for (const event of ordered) {
    const payload = record(event.payload);
    switch (event.type) {
      case "agent.toolCall.created": {
        const id = typeof payload.id === "string" ? payload.id : `seq-${event.sequence}`;
        created.set(id, { event, payload });
        break;
      }
      case "agent.toolCall.output": {
        if (typeof payload.id === "string") outputs.set(payload.id, payload);
        break;
      }
      case "session.requiresAction": {
        const list = Array.isArray(payload.approvals) ? payload.approvals : [];
        for (const raw of list) {
          const approval = record(raw);
          const approvalId = typeof approval.id === "string" ? approval.id : null;
          if (!approvalId || approvalById.has(approvalId)) continue;
          const name = typeof approval.name === "string" ? approval.name : "tool";
          const receipt: ApprovalReceipt = {
            approvalId,
            name,
            integration: null,
            decision: null,
            sequence: event.sequence,
          };
          approvals.push(receipt);
          approvalById.set(approvalId, receipt);
        }
        break;
      }
      case "user.approvalDecision": {
        const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : null;
        const decision =
          payload.decision === "approve" || payload.decision === "reject" ? payload.decision : null;
        const receipt = approvalId ? approvalById.get(approvalId) : undefined;
        if (receipt) receipt.decision = decision;
        break;
      }
      case "tool.auth_needed": {
        const capability = record(payload.capability);
        const capabilityName = typeof capability.name === "string" ? capability.name : null;
        const capabilityId = typeof capability.id === "string" ? capability.id : null;
        const providerDomain =
          typeof payload.providerDomain === "string" ? payload.providerDomain : null;
        cards.push({
          capabilityId,
          capabilityName,
          providerDomain,
          integration:
            integrationForLabel(capabilityName) ??
            integrationForLabel(capabilityId) ??
            (providerDomain ? integrationForFamily(`integration:${providerDomain}`) : null),
          sequence: event.sequence,
        });
        break;
      }
      case "agent.message.completed": {
        if (typeof payload.text === "string" && payload.text.trim()) answers.push(payload.text);
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled":
      case "turn.interrupted":
        turnStatuses.push(event.type.slice("turn.".length));
        break;
      default: {
        if (/humaninput/i.test(event.type) && /request/i.test(event.type)) humanInputRequests += 1;
        if (/usage/i.test(event.type)) {
          const tokens = record(payload.usage ?? payload);
          const number = (key: string) =>
            typeof tokens[key] === "number" ? (tokens[key] as number) : 0;
          usage.inputTokens += number("inputTokens");
          usage.cachedTokens += number("cachedInputTokens") + number("cachedTokens");
          usage.outputTokens += number("outputTokens");
          const cost = tokens.costMicros ?? tokens.chargedMicros;
          if (typeof cost === "number") usage.costMicros = (usage.costMicros ?? 0) + cost;
        }
      }
    }
  }

  const outputTexts = [...outputs.values()].map((payload) => text(payload.output) ?? "");
  const labelled = accountLabelsFromOutputs(outputTexts);

  const tools: ToolReceipt[] = [];
  for (const [callId, { event, payload }] of created) {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = parseJson(payload.arguments);
    let effectiveName = name;
    if (name === "tool_invoke") {
      const invoked = record(args).name;
      if (typeof invoked === "string") effectiveName = invoked;
    }
    const family = typeof payload.toolFamily === "string" ? payload.toolFamily : null;
    const display = record(payload.display);
    const outputPayload = outputs.get(callId);
    const output = outputPayload ? text(outputPayload.output) : null;
    let integration =
      (effectiveName === name ? integrationForFamily(family) : null) ??
      (effectiveName === name && typeof display.providerDomain === "string"
        ? integrationForFamily(`integration:${display.providerDomain}`)
        : null) ??
      labelled.get(effectiveName) ??
      integrationForLabel(typeof display.serverLabel === "string" ? display.serverLabel : null) ??
      (effectiveName === name
        ? integrationForLabel(typeof display.connector === "string" ? display.connector : null)
        : null) ??
      integrationForToolName(effectiveName) ??
      integrationForLabel(mcpServerName(output));
    if (!integration && name === "exec_command") {
      const command = typeof record(args).cmd === "string" ? (record(args).cmd as string) : "";
      const path = OGTOOL_CALL.exec(command)?.[1];
      if (path) {
        effectiveName = path;
        integration =
          labelled.get(shortToolName(path)) ?? integrationForLabel(path.replace(/[._/]/g, " "));
      }
    }
    tools.push({
      callId,
      name,
      effectiveName,
      family,
      integration,
      arguments: args,
      output,
      errored: outputPayload ? outputErrored(outputPayload, output) : false,
      sequence: event.sequence,
    });
  }

  for (const approval of approvals) {
    const matching = tools.find(
      (tool) => tool.callId === approval.approvalId || tool.effectiveName === approval.name,
    );
    approval.integration =
      matching?.integration ?? labelled.get(approval.name) ?? integrationForToolName(approval.name);
  }

  return {
    tools,
    approvals,
    cards,
    humanInputRequests,
    finalAnswer: answers.join("\n\n"),
    turnStatuses,
    usage,
  };
}
