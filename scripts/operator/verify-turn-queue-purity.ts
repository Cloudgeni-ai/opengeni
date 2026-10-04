/**
 * Read-only admission evidence for the video -> control queue cutover.
 *
 * Ops supplies a private ControlRolloutProof (see adjacent helper), including
 * every control pod, not just the ready subset. SHA equality does not establish
 * that routing is enabled; each pod must attest the frozen-input routing flag.
 * This CLI never deploys, changes configuration, or enables an autoscaler.
 *
 * A successful scan is bounded Temporal visibility evidence, not a linearizable
 * absence proof. Ops must ensure the rollout/admission/visibility fence and rerun
 * on observed races. Legacy registration stays until all legacy runs drain.
 */
import { createReadStream } from "node:fs";
import { Connection, defaultPayloadConverter } from "@temporalio/client";
import { getSettings, temporalConnectionOptions } from "@opengeni/config";
import {
  emptyPurityReport,
  parsePurityArguments,
  PURITY_OUTPUT_PREFIX,
  PURITY_USAGE,
  QueuePurityError,
  verifyControlRolloutProof,
  verifyTurnQueuePurity,
  VIDEO_WORKFLOW_TYPE,
  videoRoutingFromInput,
  type ExecutionRef,
  type PendingActivity,
  type PurityHistoryEvent,
  type TemporalPurityReader,
  type VideoRouting,
} from "./turn-queue-purity";

/** Supports private files and /dev/stdin without trusting a pipe's stat size. */
export async function readControlRolloutProof(path: string, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const stream = createReadStream(path, { highWaterMark: 65_536, signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1_048_576) throw new QueuePurityError("proof_invalid");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch (error) {
    if (error instanceof QueuePurityError) throw error;
    throw new QueuePurityError(signal.aborted ? "scan_deadline_exceeded" : "proof_invalid");
  } finally {
    stream.destroy();
  }
}

/** Uses only List, Describe, and History; never DescribeTaskQueue's untyped count. */
export function temporalPurityReader(
  connection: Pick<Connection, "workflowService">,
  namespace: string,
): TemporalPurityReader {
  return {
    listOpenExecutions: async (token, pageSize) => {
      const response = await connection.workflowService.listWorkflowExecutions({
        namespace,
        query: "ExecutionStatus = 'Running'",
        pageSize,
        nextPageToken: Buffer.from(token, "base64"),
      });
      return {
        items: (response.executions ?? []).map((execution) => ({
          workflowId: execution.execution?.workflowId ?? "",
          runId: execution.execution?.runId ?? "",
          workflowType: execution.type?.name ?? "",
        })),
        nextPageToken: Buffer.from(response.nextPageToken ?? []).toString("base64"),
      };
    },
    describeExecution: async (ref) => {
      const response = await connection.workflowService.describeWorkflowExecution({
        namespace,
        execution: { workflowId: ref.workflowId, runId: ref.runId },
      });
      const info = response.workflowExecutionInfo;
      if (!info || info.status == null || !info.historyLength) {
        throw new QueuePurityError("temporal_response_invalid");
      }
      return {
        workflowId: info.execution?.workflowId ?? "",
        runId: info.execution?.runId ?? "",
        workflowType: info.type?.name ?? "",
        // temporal.api.enums.v1.WORKFLOW_EXECUTION_STATUS_RUNNING.
        running: info.status === 1,
        historyLength: info.historyLength.toString(),
        pendingActivities: (response.pendingActivities ?? []).map((activity): PendingActivity => {
          const states = { 1: "scheduled", 2: "started", 3: "cancel_requested" } as const;
          const state = states[activity.state as keyof typeof states];
          if (!state) throw new QueuePurityError("temporal_response_invalid");
          return {
            activityId: activity.activityId ?? "",
            activityType: activity.activityType?.name ?? "",
            state,
            retrying: Boolean(activity.nextAttemptScheduleTime) || (activity.attempt ?? 0) > 1,
          };
        }),
      };
    },
    readHistory: async (ref: ExecutionRef, token, pageSize) => {
      const response = await connection.workflowService.getWorkflowExecutionHistory({
        namespace,
        execution: { workflowId: ref.workflowId, runId: ref.runId },
        maximumPageSize: pageSize,
        nextPageToken: Buffer.from(token, "base64"),
        waitNewEvent: false,
      });
      if (!response.history || (response.rawHistory?.length ?? 0) > 0 || response.archived) {
        throw new QueuePurityError("history_incomplete");
      }
      return {
        items: (response.history.events ?? []).map((event): PurityHistoryEvent => {
          const projection: PurityHistoryEvent = { eventId: event.eventId?.toString() ?? "" };
          const start = event.workflowExecutionStartedEventAttributes;
          if (start) {
            const workflowType = start.workflowType?.name ?? "";
            let videoRouting: VideoRouting = "unknown";
            if (workflowType === VIDEO_WORKFLOW_TYPE) {
              // Decode privately and project one boolean policy fact only. No
              // input/result/failure/heartbeat/search-attribute bytes are logged.
              const payloads = start.input?.payloads;
              if (payloads?.length === 1) {
                try {
                  videoRouting = videoRoutingFromInput(
                    defaultPayloadConverter.fromPayload(payloads[0]!),
                  );
                } catch {
                  throw new QueuePurityError("video_input_unknown");
                }
              }
            }
            projection.started = { workflowType, videoRouting };
          }
          const schedule = event.activityTaskScheduledEventAttributes;
          if (schedule) {
            projection.activityScheduled = {
              activityId: schedule.activityId ?? "",
              activityType: schedule.activityType?.name ?? "",
              taskQueue: schedule.taskQueue?.name ?? "",
            };
          }
          return projection;
        }),
        nextPageToken: Buffer.from(response.nextPageToken ?? []).toString("base64"),
      };
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(PURITY_USAGE);
    return;
  }
  let report = emptyPurityReport();
  let connection: Connection | undefined;
  try {
    const args = parsePurityArguments(argv);
    report.sourceRevision = args.sourceRevision;
    const deadline = Date.now() + args.timeoutMs;
    const proof = await readControlRolloutProof(args.proofPath, args.timeoutMs);
    const settings = getSettings();
    const expected = {
      sourceRevision: args.sourceRevision,
      temporalNamespace: settings.temporalNamespace,
      baseTaskQueue: settings.temporalTaskQueue,
    };
    // Reject an invalid/stale rollout without contacting Temporal at all.
    verifyControlRolloutProof(proof, expected, Date.now(), args.proofMaxAgeSeconds);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new QueuePurityError("scan_deadline_exceeded");
    connection = await Connection.connect({
      ...temporalConnectionOptions(settings),
      connectTimeout: remaining,
    });
    const connected = connection;
    report = await connected.withDeadline(deadline, () =>
      verifyTurnQueuePurity({
        ...expected,
        proof,
        limits: { ...args, timeoutMs: Math.max(1, deadline - Date.now()) },
        reader: temporalPurityReader(connected, settings.temporalNamespace),
      }),
    );
  } catch (error) {
    report.failureCode = error instanceof QueuePurityError ? error.code : "temporal_read_failed";
  } finally {
    try {
      await connection?.close();
    } catch {
      report.complete = false;
      report.pure = false;
      report.failureCode = "temporal_read_failed";
    }
  }
  console.log(`${PURITY_OUTPUT_PREFIX}${JSON.stringify(report)}`);
  if (!report.complete || !report.pure) process.exitCode = 1;
}

if (import.meta.main) await main();
