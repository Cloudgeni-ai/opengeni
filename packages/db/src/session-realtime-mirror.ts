import { createHash } from "node:crypto";

import type { HumanInputQuestion, HumanInputResponse } from "@opengeni/contracts";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import type { Database } from "./database";
import * as schema from "./schema";

const SESSION_REALTIME_MIRROR_MAX_TEXT_BYTES = 131_072;
const SESSION_REALTIME_MIRROR_MAX_PAYLOAD_BYTES = 131_072;
const TRUNCATION_MARKER = "\n…realtime context truncated…";

export type SessionRealtimeMirrorChannel = "speakable" | "commentary" | null;

export type MirrorSessionRealtimeContextInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sourceKind:
    | "human_input"
    | "human_input_request"
    | "human_input_response"
    | "assistant_progress"
    | "assistant_terminal";
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
        eq(schema.sessionRealtimeModes.state, "active"),
        gt(schema.sessionRealtimeModes.leaseExpiresAt, now),
      ),
    )
    .orderBy(desc(schema.sessionRealtimeModes.startedAt))
    .for("update")
    .limit(2);
  if (modes.length === 0) return null;
  if (modes.length !== 1) {
    throw new Error(`Session ${input.sessionId} has multiple active realtime modes`);
  }
  const mode = modes[0]!;
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
      sequence: Number(sequenceRow?.next ?? 1),
      direction: "provider_out",
      kind: "session_update",
      text: boundedText(input.text),
      payload,
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
    "  <instruction>Already routed by OpenGeni; do not delegate this message again.</instruction>",
    "</session_user_message>",
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
        `      <allow_other>${String(question.allowOther)}</allow_other>`,
        "    </question>",
      );
    }
    lines.push("  </request>");
  }
  lines.push(
    "  <instruction>The current work is waiting for the user's input. Ask the questions naturally, one at a time when useful, without changing their meaning or answering for the user. The user may answer in the visible form or answer conversationally here. If the user answers here, delegate exactly once with a complete message containing the relevant question and the user's answer. If the user changes direction instead, delegate that new direction normally. Do not claim the work resumed until a later session update confirms it.</instruction>",
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

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
