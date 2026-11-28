import { createHash } from "node:crypto";

import {
  approvalIdentifier,
  McpElicitationApprovalRequest,
  type HumanInputQuestion,
  type HumanInputResponse,
} from "@opengeni/contracts";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "./database";
import { fromPostgresLosslessJson, LOSSLESS_CONTENT_CODEC_VERSION } from "./lossless-json";
import * as schema from "./schema";

const SESSION_REALTIME_MIRROR_MAX_TEXT_BYTES = 131_072;
const SESSION_REALTIME_MIRROR_MAX_PAYLOAD_BYTES = 131_072;
const TRUNCATION_MARKER = "\n…realtime context truncated…";

export type SessionRealtimeMirrorChannel = "speakable" | "commentary" | null;

export type MirrorSessionRealtimeContextInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  /** Lifecycle facts target their own mode; ordinary updates reach every ringing phone. */
  realtimeId?: string | undefined;
  sourceKind:
    | "human_input"
    | "human_input_request"
    | "human_input_response"
    | "tool_approval_request"
    | "tool_approval_response"
    | "assistant_progress"
    | "assistant_terminal"
    | "agent_call";
  sourceId: string;
  text: string;
  channel: SessionRealtimeMirrorChannel;
  turnId?: string | null;
  payload?: Record<string, unknown> | undefined;
  now?: Date | undefined;
};

export type MirrorSessionRealtimeContextResult = {
  entry: typeof schema.sessionRealtimeEntries.$inferSelect;
  replay: boolean;
} | null;

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= SESSION_REALTIME_MIRROR_MAX_TEXT_BYTES) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  return `${takeUtf8Head(value, SESSION_REALTIME_MIRROR_MAX_TEXT_BYTES - markerBytes)}${TRUNCATION_MARKER}`;
}

function boundedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const payload = value;
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") > SESSION_REALTIME_MIRROR_MAX_PAYLOAD_BYTES
  ) {
    throw new Error("Realtime mirror payload exceeds the durable ledger limit");
  }
  return payload;
}

/**
 * Append one canonical same-session fact to the active realtime conversation.
 * The caller already owns the session event-write lock. Locking the active mode
 * serializes sequence allocation with lifecycle end and browser ledger sync.
 */
export async function mirrorSessionRealtimeContextInTransaction(
  db: Database,
  input: MirrorSessionRealtimeContextInput,
): Promise<MirrorSessionRealtimeContextResult> {
  const now = input.now ?? new Date();
  const modes = await db
    .select()
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        inArray(schema.sessionRealtimeModes.state, ["active", "preparing"]),
        input.realtimeId ? eq(schema.sessionRealtimeModes.id, input.realtimeId) : undefined,
        gt(schema.sessionRealtimeModes.leaseExpiresAt, now),
      ),
    )
    .orderBy(desc(schema.sessionRealtimeModes.startedAt))
    .for("update");
  if (modes.length === 0) return null;
  if (modes.filter((mode) => mode.state === "active").length > 1) {
    throw new Error(`Session ${input.sessionId} has multiple active realtime modes`);
  }
  let result: MirrorSessionRealtimeContextResult = null;
  for (const mode of modes) {
    const mirrored = await mirrorToMode(db, input, mode, now);
    if (result === null || mode.state === "active") result = mirrored;
  }
  return result;
}

async function mirrorToMode(
  db: Database,
  input: MirrorSessionRealtimeContextInput,
  mode: typeof schema.sessionRealtimeModes.$inferSelect,
  now: Date,
): Promise<MirrorSessionRealtimeContextResult> {
  const operationId = deterministicUuid(
    `opengeni:session-realtime-mirror:${mode.id}:${input.sourceKind}:${input.sourceId}`,
  );
  const [existing] = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, mode.id),
        eq(schema.sessionRealtimeEntries.operationId, operationId),
      ),
    )
    .limit(1);
  if (existing) return { entry: existing, replay: true };

  const [sequenceRow] = await db
    .select({ next: sql<number>`coalesce(max(${schema.sessionRealtimeEntries.sequence}), 0) + 1` })
    .from(schema.sessionRealtimeEntries)
    .where(eq(schema.sessionRealtimeEntries.realtimeId, mode.id));
  const payload = boundedPayload({
    ...(input.payload ?? {}),
    source: input.sourceKind,
    sourceId: input.sourceId,
    channel: input.channel,
    ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
  });
  const [entry] = await db
    .insert(schema.sessionRealtimeEntries)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: mode.id,
      operationId,
      connectionEpoch: mode.connectionEpoch,
      // Reserving the first slot puts the accepted opening before facts that
      // arrived while ringing, without sending or acknowledging any early.
      sequence:
        input.sourceKind === "agent_call" && mode.incomingCallId
          ? 1
          : Math.max(mode.state === "preparing" ? 2 : 1, Number(sequenceRow?.next ?? 1)),
      direction: "provider_out",
      kind: "session_update",
      text: boundedText(input.text),
      textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      payload,
      payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!entry) throw new Error("Failed to append realtime session context");
  return { entry, replay: false };
}

export function renderRealtimeHumanInputContext(input: {
  delivery: "send" | "steer";
  routing: "accepted_for_execution" | "queued_for_execution" | "accepted_for_steering";
  text: string;
}): string {
  return [
    "<session_user_message>",
    `  <status>${input.routing}</status>`,
    `  <delivery>${input.delivery}</delivery>`,
    `  <text>${escapeXmlText(input.text)}</text>`,
    "  <instruction>Already routed by Opengeni; do not delegate this message again.</instruction>",
    "</session_user_message>",
  ].join("\n");
}

/**
 * The opening of a call the agent placed (call_user) and the person answered:
 * the voice side speaks first and says why it called.
 */
export function renderRealtimeAgentCallContext(input: { reason: string }): string {
  return [
    "<agent_call>",
    "  <status>answered</status>",
    `  <reason>${escapeXmlText(input.reason)}</reason>`,
    "  <instruction>You phoned the person about this and they just picked up. Speak first, right away: greet them briefly, say in one sentence why you called, then talk it through. If they already said hello, answer them that way instead. What they ask for goes to the agent in this chat as usual.</instruction>",
    "</agent_call>",
  ].join("\n");
}

export type RealtimeHumanInputRequestContext = {
  id: string;
  questions: HumanInputQuestion[];
  allowSkip: boolean;
  expiresAt?: Date | string | null;
};

/**
 * Render the exact durable question contract for the conversational surface.
 * The structured form remains authoritative, while a conversational answer is
 * ordinary new user input that the realtime model delegates once with enough
 * question context for the next underlying turn.
 */
export function renderRealtimeHumanInputRequestContext(input: {
  requests: RealtimeHumanInputRequestContext[];
}): string {
  const lines = ["<session_human_input_request>", "  <status>waiting_for_user</status>"];
  for (const request of input.requests) {
    lines.push(
      "  <request>",
      `    <id>${escapeXmlText(request.id)}</id>`,
      `    <allow_skip>${String(request.allowSkip)}</allow_skip>`,
      `    <expires_at>${escapeXmlText(renderExpiry(request.expiresAt))}</expires_at>`,
    );
    for (const question of request.questions) {
      if (question.kind === "secret") {
        // Secrets are never spoken or delegated (AC-5): point to the app.
        lines.push(
          "    <question>",
          `      <id>${escapeXmlText(question.id)}</id>`,
          "      <kind>secret</kind>",
          `      <prompt>${escapeXmlText(question.prompt)}</prompt>`,
          "      <answer_in_app>true</answer_in_app>",
          "    </question>",
        );
        continue;
      }
      lines.push(
        "    <question>",
        `      <id>${escapeXmlText(question.id)}</id>`,
        `      <kind>${escapeXmlText(question.kind)}</kind>`,
        `      <required>${String(question.required)}</required>`,
      );
      if (question.label) lines.push(`      <label>${escapeXmlText(question.label)}</label>`);
      lines.push(`      <prompt>${escapeXmlText(question.prompt)}</prompt>`);
      if (question.helpText) {
        lines.push(`      <help_text>${escapeXmlText(question.helpText)}</help_text>`);
      }
      if (question.options.length > 0) {
        lines.push("      <options>");
        for (const option of question.options) {
          lines.push(
            "        <option>",
            `          <id>${escapeXmlText(option.id)}</id>`,
            `          <label>${escapeXmlText(option.label)}</label>`,
          );
          if (option.description) {
            lines.push(`          <description>${escapeXmlText(option.description)}</description>`);
          }
          lines.push("        </option>");
        }
        lines.push("      </options>");
      }
      lines.push(
        `      <allow_other>${String(question.kind !== "text")}</allow_other>`,
        "    </question>",
      );
    }
    lines.push("  </request>");
  }
  lines.push(
    "  <instruction>The current work is waiting for the user's input. Ask the questions naturally, one at a time when useful, without changing their meaning or answering for the user. The user may answer in the visible form or answer conversationally here. If the user answers here, delegate exactly once with a complete message containing the relevant question and the user's answer. If the user changes direction instead, delegate that new direction normally. Do not claim the work resumed until a later session update confirms it. A question of kind secret (a password, key or code) is answered only in the app: tell the user to answer it in the app, never ask for it aloud, and never delegate a spoken secret.</instruction>",
    "</session_human_input_request>",
  );
  return lines.join("\n");
}

export function renderRealtimeHumanInputResponseContext(input: {
  requestId: string;
  questions: HumanInputQuestion[];
  response: HumanInputResponse;
}): string {
  const lines = [
    "<session_human_input_response>",
    `  <request_id>${escapeXmlText(input.requestId)}</request_id>`,
    `  <outcome>${escapeXmlText(input.response.outcome)}</outcome>`,
  ];
  if (input.response.outcome === "answered") {
    const questions = new Map(input.questions.map((question) => [question.id, question]));
    lines.push("  <answers>");
    for (const answer of input.response.answers) {
      const question = questions.get(answer.questionId);
      const optionLabels = new Map(
        question?.options.map((option) => [option.id, option.label]) ?? [],
      );
      lines.push(
        "    <answer>",
        `      <question_id>${escapeXmlText(answer.questionId)}</question_id>`,
      );
      if (question) lines.push(`      <question>${escapeXmlText(question.prompt)}</question>`);
      for (const value of answer.values) {
        lines.push(`      <value>${escapeXmlText(optionLabels.get(value) ?? value)}</value>`);
      }
      if (answer.other) lines.push(`      <other>${escapeXmlText(answer.other)}</other>`);
      lines.push("    </answer>");
    }
    lines.push("  </answers>");
  }
  lines.push(
    input.response.outcome === "answered" || input.response.outcome === "skipped"
      ? "  <instruction>This structured response was accepted through the session UI and the same work can resume. Treat it as authoritative user context, do not delegate it again, and acknowledge briefly only if useful.</instruction>"
      : "  <instruction>This pending question is no longer active. Do not ask it again unless the user raises it.</instruction>",
    "</session_human_input_response>",
  );
  return lines.join("\n");
}

function renderExpiry(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "none";
  return value instanceof Date ? value.toISOString() : value;
}

const REALTIME_TOOL_APPROVAL_TEXT_MAX_BYTES = 512;

/** One tool call waiting for the person's approval, as its approval card names it. */
export type RealtimeToolApprovalContext = {
  /** The approval id `user.approvalDecision` answers (the tool call id). */
  id: string;
  /** The MCP server's question round, when the server asks one; null otherwise. */
  round: number | null;
  /** The card's sentence ("Send an email to …"), else the tool's name in words. */
  action: string;
  /** Where it runs: the integration, and the account when there are several. */
  where: string | null;
  /** The MCP server's own question in the middle of the call, if any. */
  serverQuestion: string | null;
};

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedApprovalText(value: string): string {
  return takeUtf8Head(value, REALTIME_TOOL_APPROVAL_TEXT_MAX_BYTES);
}

/** The tool's name in words, the way the approval inbox titles an untitled call. */
function toolNameInWords(name: string | null): string {
  if (!name || name === "tool" || /^[a-f0-9]{64}$/.test(name)) return "A tool call";
  const words = name
    .replace(/^.*__/, "")
    .replace(/^batch[_-]+(?=[A-Za-z])/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "A tool call";
}

/**
 * The approvals one `session.requiresAction` payload asks the person for, with
 * the same title and source its approval card and inbox item show.
 */
export function realtimeToolApprovalsFromRequiresAction(
  payload: Record<string, unknown>,
): RealtimeToolApprovalContext[] {
  const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
  const seen = new Set<string>();
  const result: RealtimeToolApprovalContext[] = [];
  for (const approval of approvals) {
    const id = approvalIdentifier(approval);
    if (!id || seen.has(id) || !approval || typeof approval !== "object") continue;
    seen.add(id);
    const item = approval as Record<string, unknown>;
    const display =
      item.display && typeof item.display === "object" && !Array.isArray(item.display)
        ? (item.display as Record<string, unknown>)
        : {};
    const nested = [item.rawItem, item.raw].find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate),
    );
    const name =
      nonEmptyText(display.toolName) ??
      nonEmptyText(item.name) ??
      nonEmptyText(item.toolName) ??
      nonEmptyText(nested?.name);
    const where = [nonEmptyText(display.connector), nonEmptyText(display.accountLabel)]
      .filter((part): part is string => part !== null)
      .join(" · ");
    const elicitation = McpElicitationApprovalRequest.safeParse(item.elicitation);
    const serverQuestion = elicitation.success
      ? nonEmptyText(elicitation.data.requests[0]?.message)
      : null;
    result.push({
      id,
      round: elicitation.success ? elicitation.data.round : null,
      action: boundedApprovalText(nonEmptyText(display.title) ?? toolNameInWords(name)),
      where: where ? boundedApprovalText(where) : null,
      serverQuestion: serverQuestion ? boundedApprovalText(serverQuestion) : null,
    });
  }
  return result;
}

export function renderRealtimeToolApprovalRequestContext(
  approval: RealtimeToolApprovalContext,
): string {
  const lines = [
    "<session_tool_approval_request>",
    "  <status>waiting_for_user_approval</status>",
    `  <id>${escapeXmlText(approval.id)}</id>`,
    `  <action>${escapeXmlText(approval.action)}</action>`,
  ];
  if (approval.where) lines.push(`  <where>${escapeXmlText(approval.where)}</where>`);
  if (approval.serverQuestion) {
    lines.push(`  <server_question>${escapeXmlText(approval.serverQuestion)}</server_question>`);
  }
  lines.push(
    "  <instruction>This is prepared but has not run: it waits for the user to approve it in the chat. Tell the user now, briefly and in their language, what it is and that they need to open the chat and approve it. It cannot be approved by voice.</instruction>",
    "</session_tool_approval_request>",
  );
  return lines.join("\n");
}

export function renderRealtimeToolApprovalResponseContext(input: {
  approvalId: string;
  outcome: "approved" | "declined";
}): string {
  return [
    "<session_tool_approval_response>",
    `  <id>${escapeXmlText(input.approvalId)}</id>`,
    `  <outcome>${input.outcome}</outcome>`,
    input.outcome === "approved"
      ? "  <instruction>It was approved in the chat and the work continues. Do not say it is done until a later update confirms it; acknowledge briefly only if useful.</instruction>"
      : "  <instruction>It was declined in the chat and will not run as prepared. Do not ask the user to approve it again unless they raise it.</instruction>",
    "</session_tool_approval_response>",
  ].join("\n");
}

/**
 * Tell the voice about tool calls waiting for the person's approval: one
 * speakable update per approval and question round, so the same wait reaches
 * a call once whether it was raised during the call or already pending when
 * the call started, and a later pause naming it again adds nothing.
 */
export async function mirrorRealtimeToolApprovalRequestsInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    realtimeId?: string | undefined;
    turnId: string;
    approvals: readonly RealtimeToolApprovalContext[];
    sourceEventId: string;
    trigger?: "realtime_start" | undefined;
    now?: Date | undefined;
  },
): Promise<void> {
  for (const approval of input.approvals) {
    await mirrorSessionRealtimeContextInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: input.realtimeId,
      sourceKind: "tool_approval_request",
      sourceId: `${input.turnId}:${approval.id}:${approval.round ?? 0}`,
      turnId: input.turnId,
      channel: "speakable",
      text: renderRealtimeToolApprovalRequestContext(approval),
      payload: {
        status: "waiting_for_user_approval",
        approvalId: approval.id,
        sourceEventId: input.sourceEventId,
        ...(input.trigger ? { trigger: input.trigger } : {}),
      },
      now: input.now,
    });
  }
}

/**
 * The approvals of this live turn's latest pause that no decision has answered
 * yet: what its approval cards still ask, for a call that starts meanwhile.
 */
export async function loadPendingRealtimeToolApprovalsInTransaction(
  db: Database,
  input: { workspaceId: string; sessionId: string; turnId: string },
): Promise<{ sourceEventId: string; approvals: RealtimeToolApprovalContext[] } | null> {
  const [pause] = await db
    .select({
      id: schema.sessionEvents.id,
      sequence: schema.sessionEvents.sequence,
      payload: schema.sessionEvents.payload,
      payloadCodecVersion: schema.sessionEvents.payloadCodecVersion,
    })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.type, "session.requiresAction"),
        eq(schema.sessionEvents.turnId, input.turnId),
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
  if (!pause) return null;
  const decisions = await db
    .select({
      payload: schema.sessionEvents.payload,
      payloadCodecVersion: schema.sessionEvents.payloadCodecVersion,
    })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.type, "user.approvalDecision"),
        eq(schema.sessionEvents.turnId, input.turnId),
        gt(schema.sessionEvents.sequence, pause.sequence),
      ),
    );
  const decided = new Set(
    decisions.flatMap((decision) => {
      const payload = eventPayloadRecord(decision.payload, decision.payloadCodecVersion);
      return typeof payload.approvalId === "string" ? [payload.approvalId] : [];
    }),
  );
  const approvals = realtimeToolApprovalsFromRequiresAction(
    eventPayloadRecord(pause.payload, pause.payloadCodecVersion),
  ).filter((approval) => !decided.has(approval.id));
  return approvals.length > 0 ? { sourceEventId: pause.id, approvals } : null;
}

function eventPayloadRecord(
  payload: unknown,
  payloadCodecVersion: number | null,
): Record<string, unknown> {
  const value = fromPostgresLosslessJson(payload, payloadCodecVersion);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
