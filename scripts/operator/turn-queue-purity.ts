import { createHash } from "node:crypto";
import { z } from "zod";

export const VIDEO_WORKFLOW_TYPE = "videoGenerationWorkflow";
export const VIDEO_ACTIVITY_TYPE = "reconcileVideoGenerationOperation";
export const PURITY_OUTPUT_PREFIX = "OPENGENI_TURN_QUEUE_PURITY=";

export const PURITY_USAGE =
  "Usage: bun scripts/operator/verify-turn-queue-purity.ts --proof <private-rollout.json> --source-revision <40-hex-SHA> [--max-pages 100] [--max-history-pages 100] [--max-workflows 10000] [--page-size 100] [--timeout-ms 120000] [--proof-max-age-seconds 300]";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rolloutProofSchema = z
  .object({
    observedAt: z.iso.datetime(),
    sourceRevision: sha,
    temporalNamespace: z.string().min(1),
    baseTaskQueue: z.string().min(1),
    controlDeployment: z
      .object({
        desiredReplicas: z.number().int().positive().max(10_000),
        updatedReplicas: z.number().int().nonnegative(),
        readyReplicas: z.number().int().nonnegative(),
        availableReplicas: z.number().int().nonnegative(),
        generation: z.number().int().positive(),
        observedGeneration: z.number().int().positive(),
      })
      .strict(),
    controlPods: z
      .array(
        z
          .object({
            podUidHash: hash,
            sourceRevision: sha,
            ready: z.boolean(),
            terminating: z.boolean(),
            controlQueueRoutingEnabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export type ControlRolloutProof = z.infer<typeof rolloutProofSchema>;
export type PurityFailureCode =
  | "arguments_invalid"
  | "proof_invalid"
  | "proof_stale"
  | "proof_scope_mismatch"
  | "control_rollout_incomplete"
  | "control_routing_disabled"
  | "listing_incomplete"
  | "history_incomplete"
  | "pagination_repeated"
  | "temporal_response_invalid"
  | "temporal_read_failed"
  | "scan_changed"
  | "scan_deadline_exceeded"
  | "video_input_unknown"
  | "pending_activity_queue_unknown";

/** Deliberately contains no remote error, payload, path, or raw identity. */
export class QueuePurityError extends Error {
  constructor(readonly code: PurityFailureCode) {
    super(code);
    this.name = "QueuePurityError";
  }
}

export interface PurityLimits {
  maxPages: number;
  maxHistoryPages: number;
  maxWorkflows: number;
  pageSize: number;
  timeoutMs: number;
  proofMaxAgeSeconds: number;
}

export interface PurityArguments extends PurityLimits {
  proofPath: string;
  sourceRevision: string;
}

export function parsePurityArguments(argv: string[]): PurityArguments {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--proof",
    "--source-revision",
    "--max-pages",
    "--max-history-pages",
    "--max-workflows",
    "--page-size",
    "--timeout-ms",
    "--proof-max-age-seconds",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new QueuePurityError("arguments_invalid");
    }
    values.set(flag, value);
  }
  const proofPath = values.get("--proof");
  const sourceRevision = values.get("--source-revision");
  if (!proofPath || !sha.safeParse(sourceRevision).success) {
    throw new QueuePurityError("arguments_invalid");
  }
  const integer = (flag: string, fallback: number, maximum: number) => {
    const raw = values.get(flag) ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new QueuePurityError("arguments_invalid");
    }
    return value;
  };
  return {
    proofPath,
    sourceRevision: sourceRevision!,
    maxPages: integer("--max-pages", 100, 1_000),
    maxHistoryPages: integer("--max-history-pages", 100, 1_000),
    maxWorkflows: integer("--max-workflows", 10_000, 100_000),
    pageSize: integer("--page-size", 100, 1_000),
    timeoutMs: integer("--timeout-ms", 120_000, 600_000),
    // Operators may tighten freshness, never turn an old rollout into evidence.
    proofMaxAgeSeconds: integer("--proof-max-age-seconds", 300, 300),
  };
}

export function verifyControlRolloutProof(
  value: unknown,
  expected: { sourceRevision: string; temporalNamespace: string; baseTaskQueue: string },
  now: number,
  maxAgeSeconds: number,
): ControlRolloutProof {
  const parsed = rolloutProofSchema.safeParse(value);
  if (!parsed.success) throw new QueuePurityError("proof_invalid");
  const proof = parsed.data;
  const age = now - Date.parse(proof.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds * 1_000) {
    throw new QueuePurityError("proof_stale");
  }
  if (
    proof.sourceRevision !== expected.sourceRevision ||
    proof.temporalNamespace !== expected.temporalNamespace ||
    proof.baseTaskQueue !== expected.baseTaskQueue
  ) {
    throw new QueuePurityError("proof_scope_mismatch");
  }
  const deployment = proof.controlDeployment;
  const desired = deployment.desiredReplicas;
  if (
    deployment.updatedReplicas !== desired ||
    deployment.readyReplicas !== desired ||
    deployment.availableReplicas !== desired ||
    deployment.observedGeneration !== deployment.generation ||
    proof.controlPods.length !== desired ||
    new Set(proof.controlPods.map((pod) => pod.podUidHash)).size !== desired ||
    proof.controlPods.some(
      (pod) => !pod.ready || pod.terminating || pod.sourceRevision !== expected.sourceRevision,
    )
  ) {
    throw new QueuePurityError("control_rollout_incomplete");
  }
  if (proof.controlPods.some((pod) => !pod.controlQueueRoutingEnabled)) {
    throw new QueuePurityError("control_routing_disabled");
  }
  return proof;
}

export interface ExecutionRef {
  workflowId: string;
  runId: string;
  workflowType: string;
}

export interface PendingActivity {
  activityId: string;
  activityType: string;
  state: "scheduled" | "started" | "cancel_requested";
  retrying: boolean;
}

export interface ExecutionObservation extends ExecutionRef {
  running: boolean;
  historyLength: string;
  pendingActivities: PendingActivity[];
}

export type VideoRouting = "control" | "legacy" | "unknown";

/** The only workflow-input fact that may leave the private SDK adapter. */
export function videoRoutingFromInput(value: unknown): VideoRouting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const input = value as Record<string, unknown>;
  if (typeof input.baseTaskQueue !== "string" || input.baseTaskQueue.length === 0) return "unknown";
  if (input.controlQueueRoutingEnabled === true) return "control";
  if (
    input.controlQueueRoutingEnabled === false ||
    input.controlQueueRoutingEnabled === undefined
  ) {
    return "legacy";
  }
  return "unknown";
}

export interface PurityHistoryEvent {
  eventId: string;
  started?: { workflowType: string; videoRouting: VideoRouting };
  activityScheduled?: { activityId: string; activityType: string; taskQueue: string };
}

export interface ReadPage<T> {
  items: T[];
  nextPageToken: string;
}

/** Only read APIs. Implementations must not log raw SDK responses or errors. */
export interface TemporalPurityReader {
  listOpenExecutions(token: string, pageSize: number): Promise<ReadPage<ExecutionRef>>;
  describeExecution(ref: ExecutionRef): Promise<ExecutionObservation>;
  readHistory(
    ref: ExecutionRef,
    token: string,
    pageSize: number,
  ): Promise<ReadPage<PurityHistoryEvent>>;
}

export interface PurityReport {
  schemaVersion: 1;
  evidenceKind: "bounded_temporal_visibility_observation";
  checkedAt: string;
  complete: boolean;
  pure: boolean;
  sourceRevision: string;
  proofSha256: string | null;
  proofObservedAt: string | null;
  scopeHash: string;
  counts: {
    controlPods: number;
    openExecutions: number;
    videoWorkflows: number;
    legacyVideoWorkflows: number;
    turnQueueVideoActivities: number;
    retryingTurnQueueVideoActivities: number;
    controlQueueVideoActivities: number;
    otherQueueVideoActivities: number;
  };
  failureCode: PurityFailureCode | null;
  findings: Array<{
    executionHash: string;
    reason: "legacy_video_workflow" | "turn_queue_video_activity";
    activityHash?: string;
  }>;
  findingsTruncated: boolean;
}

export function identityHash(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function emptyPurityReport(
  sourceRevision = "",
  scopeHash = identityHash("unavailable"),
  now = Date.now(),
): PurityReport {
  return {
    schemaVersion: 1,
    evidenceKind: "bounded_temporal_visibility_observation",
    checkedAt: new Date(now).toISOString(),
    complete: false,
    pure: false,
    sourceRevision,
    proofSha256: null,
    proofObservedAt: null,
    scopeHash,
    counts: {
      controlPods: 0,
      openExecutions: 0,
      videoWorkflows: 0,
      legacyVideoWorkflows: 0,
      turnQueueVideoActivities: 0,
      retryingTurnQueueVideoActivities: 0,
      controlQueueVideoActivities: 0,
      otherQueueVideoActivities: 0,
    },
    failureCode: null,
    findings: [],
    findingsTruncated: false,
  };
}

export async function verifyTurnQueuePurity(input: {
  reader: TemporalPurityReader;
  proof: unknown;
  sourceRevision: string;
  temporalNamespace: string;
  baseTaskQueue: string;
  limits: PurityLimits;
  now?: () => number;
}): Promise<PurityReport> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.limits.timeoutMs;
  const report = emptyPurityReport(
    input.sourceRevision,
    identityHash(input.temporalNamespace, input.baseTaskQueue),
    now(),
  );
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new QueuePurityError("scan_deadline_exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new QueuePurityError("scan_deadline_exceeded")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const addFinding = (finding: PurityReport["findings"][number]) => {
    if (report.findings.length < 200) report.findings.push(finding);
    else report.findingsTruncated = true;
  };
  try {
    const proof = verifyControlRolloutProof(
      input.proof,
      input,
      now(),
      input.limits.proofMaxAgeSeconds,
    );
    report.proofSha256 = identityHash(JSON.stringify(proof));
    report.proofObservedAt = proof.observedAt;
    report.counts.controlPods = proof.controlPods.length;
    const executions = await listOpenInventory(input.reader, input.limits, read);
    report.counts.openExecutions = executions.size;
    for (const ref of executions.values()) {
      const before = await read(() => input.reader.describeExecution(ref));
      validateObservation(before, ref);
      if (!before.running) throw new QueuePurityError("scan_changed");
      const videoActivities = before.pendingActivities.filter(
        (activity) => activity.activityType === VIDEO_ACTIVITY_TYPE,
      );
      if (ref.workflowType === VIDEO_WORKFLOW_TYPE || videoActivities.length > 0) {
        const { routing, schedules } = await inspectHistory(
          input.reader,
          ref,
          before.historyLength,
          new Set(videoActivities.map((activity) => activity.activityId)),
          input.limits,
          read,
        );
        if (ref.workflowType === VIDEO_WORKFLOW_TYPE) {
          report.counts.videoWorkflows += 1;
          if (routing === "unknown") throw new QueuePurityError("video_input_unknown");
          if (routing === "legacy") {
            report.counts.legacyVideoWorkflows += 1;
            addFinding({
              executionHash: executionHash(ref),
              reason: "legacy_video_workflow",
            });
          }
        }
        for (const activity of videoActivities) {
          const schedule = schedules.get(activity.activityId);
          if (!schedule || schedule.activityType !== activity.activityType || !schedule.taskQueue) {
            throw new QueuePurityError("pending_activity_queue_unknown");
          }
          if (schedule.taskQueue === `${input.baseTaskQueue}-turns`) {
            report.counts.turnQueueVideoActivities += 1;
            if (activity.retrying) report.counts.retryingTurnQueueVideoActivities += 1;
            addFinding({
              executionHash: executionHash(ref),
              activityHash: identityHash(ref.workflowId, ref.runId, activity.activityId),
              reason: "turn_queue_video_activity",
            });
          } else if (schedule.taskQueue === input.baseTaskQueue) {
            report.counts.controlQueueVideoActivities += 1;
          } else {
            report.counts.otherQueueVideoActivities += 1;
          }
        }
      }
      const after = await read(() => input.reader.describeExecution(ref));
      validateObservation(after, ref);
      if (observationFingerprint(before) !== observationFingerprint(after)) {
        throw new QueuePurityError("scan_changed");
      }
    }
    // Visibility is eventually consistent, not a linearizable inventory. Two
    // exhausted, stable passes reject observed races but cannot prove the absence
    // of a run not yet visible. Ops owns the rollout/admission/visibility fence.
    const finalExecutions = await listOpenInventory(input.reader, input.limits, read);
    if (inventoryFingerprint(executions) !== inventoryFingerprint(finalExecutions)) {
      throw new QueuePurityError("scan_changed");
    }
    verifyControlRolloutProof(input.proof, input, now(), input.limits.proofMaxAgeSeconds);
    if (now() > deadline) throw new QueuePurityError("scan_deadline_exceeded");
    report.complete = true;
    report.pure =
      report.counts.legacyVideoWorkflows === 0 && report.counts.turnQueueVideoActivities === 0;
  } catch (error) {
    report.failureCode = error instanceof QueuePurityError ? error.code : "temporal_read_failed";
  }
  report.checkedAt = new Date(now()).toISOString();
  return report;
}

async function listOpenInventory(
  reader: TemporalPurityReader,
  limits: PurityLimits,
  read: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<Map<string, ExecutionRef>> {
  const executions = new Map<string, ExecutionRef>();
  let token = "";
  const tokens = new Set<string>();
  for (let pageNumber = 0; pageNumber < limits.maxPages; pageNumber += 1) {
    const page = await read(() => reader.listOpenExecutions(token, limits.pageSize));
    validatePage(page, limits.pageSize);
    for (const ref of page.items) {
      if (!validRef(ref)) throw new QueuePurityError("temporal_response_invalid");
      const key = executionHash(ref);
      const prior = executions.get(key);
      if (prior && prior.workflowType !== ref.workflowType) {
        throw new QueuePurityError("scan_changed");
      }
      executions.set(key, ref);
      if (executions.size > limits.maxWorkflows) throw new QueuePurityError("listing_incomplete");
    }
    token = page.nextPageToken;
    if (token === "") return executions;
    if (tokens.has(token)) throw new QueuePurityError("pagination_repeated");
    tokens.add(token);
  }
  throw new QueuePurityError("listing_incomplete");
}

async function inspectHistory(
  reader: TemporalPurityReader,
  ref: ExecutionRef,
  expectedHistoryLength: string,
  pendingVideoActivityIds: Set<string>,
  limits: PurityLimits,
  read: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<{
  routing: VideoRouting;
  schedules: Map<string, NonNullable<PurityHistoryEvent["activityScheduled"]>>;
}> {
  const schedules = new Map<string, NonNullable<PurityHistoryEvent["activityScheduled"]>>();
  let routing: VideoRouting = "unknown";
  let sawStart = false;
  let lastEventId = 0n;
  let token = "";
  const tokens = new Set<string>();
  for (let pageNumber = 0; pageNumber < limits.maxHistoryPages; pageNumber += 1) {
    const page = await read(() => reader.readHistory(ref, token, limits.pageSize));
    validatePage(page, limits.pageSize);
    for (const event of page.items) {
      if (!event || !/^\d+$/.test(event.eventId) || BigInt(event.eventId) !== lastEventId + 1n) {
        throw new QueuePurityError("history_incomplete");
      }
      lastEventId = BigInt(event.eventId);
      if (event.started) {
        if (sawStart || lastEventId !== 1n || event.started.workflowType !== ref.workflowType) {
          throw new QueuePurityError("temporal_response_invalid");
        }
        sawStart = true;
        routing = event.started.videoRouting;
      }
      if (
        event.activityScheduled?.activityType === VIDEO_ACTIVITY_TYPE &&
        pendingVideoActivityIds.has(event.activityScheduled.activityId)
      ) {
        schedules.set(event.activityScheduled.activityId, event.activityScheduled);
      }
    }
    token = page.nextPageToken;
    if (token === "") {
      if (!sawStart || lastEventId !== BigInt(expectedHistoryLength)) {
        throw new QueuePurityError("history_incomplete");
      }
      return { routing, schedules };
    }
    if (tokens.has(token)) throw new QueuePurityError("pagination_repeated");
    tokens.add(token);
  }
  throw new QueuePurityError("history_incomplete");
}

function validatePage<T>(page: ReadPage<T>, pageSize: number): void {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > pageSize ||
    typeof page.nextPageToken !== "string"
  ) {
    throw new QueuePurityError("temporal_response_invalid");
  }
}

function validRef(ref: ExecutionRef): boolean {
  return Boolean(
    ref &&
    typeof ref.workflowId === "string" &&
    ref.workflowId.length > 0 &&
    typeof ref.runId === "string" &&
    ref.runId.length > 0 &&
    typeof ref.workflowType === "string" &&
    ref.workflowType.length > 0,
  );
}

function validateObservation(observation: ExecutionObservation, ref: ExecutionRef): void {
  if (
    !validRef(observation) ||
    executionHash(observation) !== executionHash(ref) ||
    observation.workflowType !== ref.workflowType ||
    typeof observation.running !== "boolean" ||
    !/^\d+$/.test(observation.historyLength) ||
    !Array.isArray(observation.pendingActivities) ||
    new Set(observation.pendingActivities.map((activity) => activity.activityId)).size !==
      observation.pendingActivities.length ||
    observation.pendingActivities.some(
      (activity) =>
        !activity.activityId ||
        !activity.activityType ||
        !["scheduled", "started", "cancel_requested"].includes(activity.state) ||
        typeof activity.retrying !== "boolean",
    )
  ) {
    throw new QueuePurityError("temporal_response_invalid");
  }
}

function executionHash(ref: ExecutionRef): string {
  return identityHash(ref.workflowId, ref.runId);
}

function observationFingerprint(observation: ExecutionObservation): string {
  return JSON.stringify([
    observation.running,
    observation.historyLength,
    [...observation.pendingActivities].sort((left, right) =>
      left.activityId.localeCompare(right.activityId),
    ),
  ]);
}

function inventoryFingerprint(executions: Map<string, ExecutionRef>): string {
  return JSON.stringify(
    [...executions.entries()]
      .map(([key, ref]) => [key, ref.workflowType])
      .sort(([left], [right]) => left!.localeCompare(right!)),
  );
}
