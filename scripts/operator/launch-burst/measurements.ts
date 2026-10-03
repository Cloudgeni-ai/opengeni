import { percentile } from "../connected-machine-load-profile";
import { parseExecResponseBanner } from "../../../packages/runtime/src/sandbox/exec-banner";
import { z } from "zod";
import type { Mode } from "./config";

export const Event = z.object({
  sequence: z.number().int().positive(),
  type: z.string(),
  turnId: z.string().nullish(),
  turnAttemptId: z.string().nullish(),
  occurredAt: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof Event>;
export type Sample = {
  label: string;
  identityDigest: string;
  requestedSessionId: string;
  sessionId: string | null;
  workspaceId: string | null;
  turnId: string | null;
  attemptIds: string[];
  correlationId: string;
  status: "not_started" | "success" | "failed" | "empty_output" | "timeout" | "stream_closed";
  stage: string;
  httpStatus: number | null;
  errorCode: string | null;
  signupMs: number | null;
  enrollmentStartedAt: string | null;
  enrollmentSettledAt: string | null;
  enrollmentPacingWaitMs: number | null;
  promptSentAt: string | null;
  sentMonoMs: number | null;
  acceptedMs: number | null;
  workerStartMs: number | null;
  firstOutputMs: number | null;
  completionMs: number | null;
  receiptToOutputMs: number | null;
  sandboxEstablishMs: number | null;
  sandboxEstablishServerMs: number | null;
  firstCommandMs: number | null;
  commandCount: number;
  commandExitCode: number | null;
  cleanup: "not_requested" | "requested" | "failed" | "held_unknown";
  terminalObservedAt: string | null;
};
function textOf(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const value = output as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return value.content.map(textOf).filter(Boolean).join("\n");
  }
  return Array.isArray(output) ? output.map(textOf).filter(Boolean).join("\n") : null;
}
export class TurnObserver {
  private cursor = 0;
  private receiptAt: number | null = null;
  private readonly commands = new Map<string, number>();
  constructor(
    readonly sample: Sample,
    private readonly mode: Mode,
  ) {}
  observe(event: Event, monoMs: number, wallAt: string): boolean {
    if (event.sequence <= this.cursor) return false;
    this.cursor = event.sequence;
    const sample = this.sample;
    const elapsed = monoMs - (sample.sentMonoMs ?? monoMs);
    if (
      !sample.turnId &&
      (event.type === "user.message" ||
        event.type === "turn.queued" ||
        event.type === "turn.started") &&
      event.turnId
    )
      sample.turnId = event.turnId;
    if (!sample.turnId || event.turnId !== sample.turnId) return false;
    if (event.turnAttemptId && !sample.attemptIds.includes(event.turnAttemptId))
      sample.attemptIds.push(event.turnAttemptId);
    if (event.type === "user.message" && event.occurredAt)
      this.receiptAt = Date.parse(event.occurredAt);
    if (event.type === "turn.started" && sample.workerStartMs === null)
      sample.workerStartMs = elapsed;
    if (
      (event.type === "agent.message.delta" || event.type === "agent.message.completed") &&
      typeof event.payload.text === "string" &&
      event.payload.text.trim().length > 0 &&
      sample.firstOutputMs === null
    ) {
      sample.firstOutputMs = elapsed;
      const eventAt = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
      if (this.receiptAt !== null && Number.isFinite(eventAt) && eventAt >= this.receiptAt)
        sample.receiptToOutputMs = eventAt - this.receiptAt;
    }
    if (
      event.type === "turn.startup.phase.completed" &&
      event.payload.phase === "sandbox_establish"
    ) {
      sample.sandboxEstablishMs = elapsed;
      if (typeof event.payload.durationMs === "number")
        sample.sandboxEstablishServerMs = event.payload.durationMs;
    }
    if (
      event.type === "agent.toolCall.created" &&
      (this.mode === "plain" || event.payload.name !== "exec_command")
    )
      sample.errorCode = "unexpected_tool";
    if (
      event.type === "agent.toolCall.created" &&
      event.payload.name === "exec_command" &&
      typeof event.payload.id === "string"
    ) {
      sample.commandCount++;
      this.commands.set(event.payload.id, monoMs);
      const raw = event.payload.arguments;
      let args: unknown = raw;
      if (typeof raw === "string") {
        try {
          args = JSON.parse(raw);
        } catch {
          args = null;
        }
      }
      if (
        !args ||
        typeof args !== "object" ||
        (args as Record<string, unknown>).cmd !== "/bin/true"
      )
        sample.errorCode = "unexpected_command";
    }
    if (
      event.type === "agent.toolCall.output" &&
      typeof event.payload.id === "string" &&
      this.commands.has(event.payload.id)
    ) {
      const text = textOf(event.payload.output);
      const banner = text ? parseExecResponseBanner(text) : ({ kind: "absent" } as const);
      if (banner.kind === "exited") {
        sample.commandExitCode = banner.exitCode;
        sample.firstCommandMs = monoMs - this.commands.get(event.payload.id)!;
      }
    }
    if (
      ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type)
    ) {
      sample.completionMs = elapsed;
      sample.terminalObservedAt = wallAt;
      sample.stage = "terminal";
      sample.status =
        event.type !== "turn.completed"
          ? "failed"
          : sample.firstOutputMs === null ||
              typeof event.payload.output !== "string" ||
              event.payload.output.trim().length === 0 ||
              event.payload.emptyFinalReply === true
            ? "empty_output"
            : sample.errorCode !== null ||
                (this.mode !== "plain" &&
                  (sample.commandCount !== 1 || sample.commandExitCode !== 0))
              ? "failed"
              : "success";
      if (sample.status === "failed" && !sample.errorCode)
        sample.errorCode = event.type === "turn.completed" ? "command_proof_missing" : event.type;
      return true;
    }
    return false;
  }
}

export function exactQuantiles(values: Array<number | null>) {
  const sorted = values.map((value) => value ?? Infinity).sort((a, b) => a - b);
  const quantile = (q: number): number | "unobserved_or_failed" | null => {
    if (sorted.length === 0) return null;
    const result = percentile(sorted, q);
    return Number.isFinite(result) ? result : "unobserved_or_failed";
  };
  return {
    denominator: values.length,
    observed: values.filter((v) => v !== null).length,
    missing: values.filter((v) => v === null).length,
    method: "nearest-rank ceil(p*n); missing = +Infinity",
    p50: quantile(50),
    p95: quantile(95),
    p99: quantile(99),
    max: quantile(100),
  };
}
export function summarize(samples: Sample[]) {
  const successes = samples.filter((s) => s.status === "success").length;
  const failures = samples.length - successes;
  const ttft = exactQuantiles(samples.map((s) => s.firstOutputMs));
  const successRate = samples.length ? successes / samples.length : 0;
  const sent = samples.flatMap((sample) => (sample.sentMonoMs === null ? [] : [sample.sentMonoMs]));
  return {
    denominator: samples.length,
    successes,
    failures,
    successRate,
    promptSentCount: sent.length,
    promptLaunchSpreadMs: sent.length ? Math.max(...sent) - Math.min(...sent) : null,
    outcomes: Object.fromEntries(
      ["not_started", "success", "failed", "empty_output", "timeout", "stream_closed"].map(
        (status) => [status, samples.filter((s) => s.status === status).length],
      ),
    ),
    ttftMsAllUsers: ttft,
    // Failed/empty/non-completing turns have no successful completion latency.
    completionMsAllUsers: exactQuantiles(
      samples.map((s) => (s.status === "success" ? s.completionMs : null)),
    ),
    successfulOnlyTtftMs: exactQuantiles(
      samples.filter((s) => s.status === "success").map((s) => s.firstOutputMs),
    ),
    acceptedMsAllUsers: exactQuantiles(samples.map((s) => s.acceptedMs)),
    workerStartMsAllUsers: exactQuantiles(samples.map((s) => s.workerStartMs)),
    signupMsAllUsers: exactQuantiles(samples.map((s) => s.signupMs)),
    verdict: {
      successRateAtLeast99Percent: successRate >= 0.99,
      clientTtftP95Under10Seconds: typeof ttft.p95 === "number" && ttft.p95 < 10_000,
      telemetryAcceptance: "not_evaluated",
    },
  };
}

// Accept only metadata exported by the monitoring owner. No raw history payloads.
export const TemporalMetadata = z
  .object({
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid().nullable(),
    complete: z.boolean(),
    events: z.array(
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("ActivityTaskScheduled"),
            eventId: z.string(),
            eventTime: z.string().datetime(),
            activityId: z.string(),
            activityType: z.literal("runAgentTurn"),
          })
          .strict(),
        z
          .object({
            type: z.literal("ActivityTaskStarted"),
            eventId: z.string(),
            eventTime: z.string().datetime(),
            scheduledEventId: z.string(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export function correlateTemporal(raw: unknown) {
  const history = TemporalMetadata.parse(raw);
  const scheduled = history.events.filter((e) => e.type === "ActivityTaskScheduled");
  return {
    workflowId: history.workflowId,
    runId: history.runId,
    sessionId: history.sessionId,
    turnId: history.turnId,
    complete: history.complete,
    activities: scheduled.map((event) => {
      const starts = history.events.filter(
        (s) => s.type === "ActivityTaskStarted" && s.scheduledEventId === event.eventId,
      );
      return {
        activityId: event.activityId,
        scheduledEventId: event.eventId,
        scheduledAt: event.eventTime,
        starts: starts.map((start) => {
          const ms = Date.parse(start.eventTime) - Date.parse(event.eventTime);
          if (ms < 0) throw new Error("Temporal activity starts before schedule");
          return {
            startedEventId: start.eventId,
            startedAt: start.eventTime,
            scheduleToStartMs: ms,
          };
        }),
        pendingOrUnknown: starts.length === 0,
      };
    }),
    unmatchedStarts: history.events.filter(
      (e) =>
        e.type === "ActivityTaskStarted" &&
        !scheduled.some((s) => s.eventId === e.scheduledEventId),
    ).length,
  };
}
