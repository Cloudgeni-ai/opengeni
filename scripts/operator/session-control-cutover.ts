import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  captureSessionControlCutoverSnapshot,
  reconcileSessionControlCutover,
  sha256,
  type CutoverPhase,
  type SessionControlCutoverSnapshot,
} from "@opengeni/db/session-control-cutover-audit";
import {
  createDb,
  repairDetachedCodexCapacityAttempt,
  reparkOrphanedSessionTurn,
} from "@opengeni/db";
import { getSettings } from "@opengeni/config";
import { createObjectStorage } from "@opengeni/storage";
import {
  Client as TemporalClient,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import postgres from "postgres";
import {
  SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
  SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
  SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE,
} from "../../apps/worker/src/workflow-wake-contract";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "../../apps/worker/src/concurrency";

type ParsedArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

export function workerTopologyEvidence() {
  return {
    roles: ["control", "turn"] as const,
    turnTaskQueueSuffix: "-turns",
    controlActivityConcurrencyPerPod: CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
    controlWorkflowConcurrencyPerPod: CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
    turnActivityConcurrencyPerPod: TURN_WORKER_MAX_CONCURRENT_TURNS,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index]!;
    if (!current.startsWith("--")) throw new Error(`unexpected argument: ${current}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(current);
      continue;
    }
    values.set(current, next);
    index += 1;
  }
  return { command, values, flags };
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function migrationDatabaseUrl(): string {
  const value = process.env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "OPENGENI_MIGRATIONS_DATABASE_URL is required; the runtime RLS connection is not an operator audit source",
    );
  }
  return value;
}

function assertPhase(value: string): asserts value is CutoverPhase {
  if (value !== "baseline" && value !== "migrated" && value !== "final") {
    throw new Error(`invalid --phase: ${value}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`;
  if (path.startsWith("object://")) {
    const key = path.slice("object://".length);
    if (!key || key.startsWith("/") || key.includes("..")) {
      throw new Error(`unsafe object output key: ${key}`);
    }
    const storage = createObjectStorage(getSettings());
    if (!storage) throw new Error("configured object storage is unavailable");
    const bytes = new TextEncoder().encode(serialized);
    await storage.putObject({
      key,
      contentType: "application/json",
      body: bytes,
      sha256: sha256(value),
    });
    return;
  }
  if (path === "-") {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
}

function parseJson<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${source} contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJson<T>(path: string): Promise<T> {
  if (path.startsWith("object://")) {
    const key = path.slice("object://".length);
    if (!key || key.startsWith("/") || key.includes("..")) {
      throw new Error(`unsafe object input key: ${key}`);
    }
    const storage = createObjectStorage(getSettings());
    if (!storage) throw new Error("configured object storage is unavailable");
    const value = await storage.getObjectBytes(key);
    if (!value) throw new Error(`object does not exist: ${key}`);
    return parseJson<T>(new TextDecoder().decode(value.bytes), path);
  }
  return parseJson<T>(await readFile(path, "utf8"), path);
}

function verifySnapshot(value: SessionControlCutoverSnapshot, path: string): void {
  const { sha256: recorded, ...body } = value;
  const calculated = sha256(body);
  if (calculated !== recorded) {
    throw new Error(`${path}: snapshot checksum mismatch (${recorded} != ${calculated})`);
  }
}

async function readSnapshot(path: string): Promise<SessionControlCutoverSnapshot> {
  const value = await readJson<SessionControlCutoverSnapshot>(path);
  verifySnapshot(value, path);
  return value;
}

function temporalSettings(): {
  address: string;
  namespace: string;
  taskQueue: string;
} {
  const address = process.env.OPENGENI_TEMPORAL_HOST?.trim();
  const namespace = process.env.OPENGENI_TEMPORAL_NAMESPACE?.trim();
  const taskQueue = process.env.OPENGENI_TEMPORAL_TASK_QUEUE?.trim();
  if (!address || !namespace || !taskQueue) {
    throw new Error(
      "OPENGENI_TEMPORAL_HOST, OPENGENI_TEMPORAL_NAMESPACE, and OPENGENI_TEMPORAL_TASK_QUEUE are required",
    );
  }
  return { address, namespace, taskQueue };
}

async function capture(args: ParsedArgs): Promise<void> {
  const phase = required(args, "--phase");
  assertPhase(phase);
  const output = required(args, "--output");
  const baseline =
    phase === "baseline" ? undefined : await readSnapshot(required(args, "--baseline"));
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: `opengeni-cutover-audit-${phase}` },
  });
  try {
    const snapshot = await sql.begin(async (transaction) => {
      await transaction.unsafe("set transaction isolation level repeatable read, read only");
      return await captureSessionControlCutoverSnapshot(
        transaction,
        phase,
        new Date().toISOString(),
        baseline,
      );
    });
    if (
      phase === "baseline" &&
      snapshot.sessions.length === 0 &&
      !args.flags.has("--allow-empty-baseline")
    ) {
      throw new Error(
        "baseline contains zero sessions; refusing a vacuous production proof (use --allow-empty-baseline only for a reviewed empty installation)",
      );
    }
    await writeJson(output, snapshot);
    process.stderr.write(
      `[cutover-audit] ${phase}: ${snapshot.sessions.length} sessions, ${snapshot.identityCount} identities, sha256 ${snapshot.sha256}\n`,
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function reconcile(args: ParsedArgs): Promise<void> {
  const baseline = await readSnapshot(required(args, "--baseline"));
  const observed = await readSnapshot(required(args, "--observed"));
  const mode = required(args, "--mode");
  if (mode !== "migration" && mode !== "final-fate") {
    throw new Error(`invalid --mode: ${mode}`);
  }
  const result = reconcileSessionControlCutover(baseline, observed, mode);
  await writeJson(required(args, "--output"), result);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`[cutover-audit] ${error}\n`);
    throw new Error(`${mode} reconciliation failed with ${result.errors.length} error(s)`);
  }
  process.stderr.write(
    `[cutover-audit] ${mode}: all pre-cutover identities reconciled, sha256 ${result.sha256}\n`,
  );
}

function integerArg(
  args: ParsedArgs,
  name: string,
  options: { defaultValue?: number; min: number; max: number },
): number {
  const raw =
    args.values.get(name) ??
    (options.defaultValue === undefined ? required(args, name) : String(options.defaultValue));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new Error(`${name} must be an integer between ${options.min} and ${options.max}`);
  }
  return parsed;
}

type WakeOutboxRow = {
  session_id: string;
  attempts: number;
  last_error: string | null;
};

type WakeOutboxProof = { count: number; sha256: string };

function updateLengthDelimitedHash(hash: ReturnType<typeof createHash>, fields: string[]): void {
  hash.update(String(fields.length));
  hash.update(":");
  for (const field of fields) {
    hash.update(String(Buffer.byteLength(field, "utf8")));
    hash.update(":");
    hash.update(field);
  }
}

async function captureWakeOutboxProof(
  sql: postgres.Sql,
  onlyPending: boolean,
): Promise<WakeOutboxProof> {
  const hash = createHash("sha256");
  let count = 0;
  const stream = await sql
    .unsafe(
      `copy (
         select session_id::text, wake_revision::text, delivered_revision::text
         from session_workflow_wake_outbox
         ${onlyPending ? "where wake_revision > delivered_revision" : ""}
         order by session_id
       ) to stdout`,
    )
    .readable();
  let pending = "";
  for await (const chunk of stream) {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const fields = line.split("\t");
      if (fields.length !== 3) throw new Error("malformed workflow-wake COPY proof row");
      updateLengthDelimitedHash(hash, fields);
      count += 1;
    }
  }
  if (pending.length > 0) {
    const fields = pending.split("\t");
    if (fields.length !== 3) throw new Error("malformed trailing workflow-wake COPY proof row");
    updateLengthDelimitedHash(hash, fields);
    count += 1;
  }
  return { count, sha256: hash.digest("hex") };
}

async function pendingWakeOutboxSummary(sql: postgres.Sql): Promise<{
  count: number;
  errorSamples: WakeOutboxRow[];
}> {
  const [counts, samples] = await Promise.all([
    sql<Array<{ count: number }>>`
      select count(*)::integer as count
      from session_workflow_wake_outbox
      where wake_revision > delivered_revision`,
    sql<Array<WakeOutboxRow>>`
      select session_id::text, attempts, last_error
      from session_workflow_wake_outbox
      where wake_revision > delivered_revision and last_error is not null
      order by attempts desc, session_id
      limit 100`,
  ]);
  return { count: Number(counts[0]?.count ?? 0), errorSamples: samples };
}

async function executeWakeDispatcher(
  temporal: TemporalClient,
  taskQueue: string,
  workflowId: string,
): Promise<unknown> {
  try {
    const handle = await temporal.workflow.start("sessionWorkflowWakeDispatcherWorkflow", {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [],
    });
    return await handle.result();
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    return await temporal.workflow.getHandle(workflowId).result();
  }
}

async function wakeOutbox(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const runId = safeRunId(required(args, "--run-id"));
  const execute = args.flags.has("--execute");
  const turnCapacity = integerArg(args, "--turn-capacity", { min: 1, max: 10_000 });
  const stabilitySeconds = integerArg(args, "--stability-seconds", {
    defaultValue: 150,
    min: 121,
    max: 900,
  });
  const timeoutSeconds = integerArg(args, "--timeout-seconds", {
    defaultValue: 900,
    min: stabilitySeconds,
    max: 3_600,
  });
  const sampleSeconds = integerArg(args, "--sample-seconds", {
    defaultValue: 5,
    min: 1,
    max: 30,
  });
  const temporalSettingsValue = temporalSettings();
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-cutover-wake-outbox" },
  });
  let connection: Connection | null = null;
  try {
    const baselinePendingProof = await captureWakeOutboxProof(sql, true);
    const initialRecoveryRows = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from session_events
      where type = 'turn.recovery.requested'
        and payload ->> 'reason' = 'worker_death'`;
    const initialHeartbeatRecoveries = Number(initialRecoveryRows[0]?.count ?? 0);
    const failures: Array<{ sessionId: string; error: string }> = [];
    const dispatcherResults: Array<{ workflowId: string; result: unknown }> = [];
    const samples: Array<{
      capturedAt: string;
      pendingRevisions: number;
      runningTurns: number;
      recoveringTurns: number;
      heartbeatRecoveries: number;
    }> = [];
    let temporal: TemporalClient | null = null;
    if (execute) {
      connection = await Connection.connect({ address: temporalSettingsValue.address });
      temporal = new TemporalClient({
        connection,
        namespace: temporalSettingsValue.namespace,
      });
    }
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let stableSince: number | null = null;
    let dispatchIteration = 0;
    for (;;) {
      const [pendingSummary, countRows] = await Promise.all([
        pendingWakeOutboxSummary(sql),
        sql<
          Array<{
            running_turns: number;
            recovering_turns: number;
            heartbeat_recoveries: number;
          }>
        >`
          select
            (select count(*)::integer from session_turns where status = 'running') as running_turns,
            (select count(*)::integer from session_turns where status = 'recovering') as recovering_turns,
            (select count(*)::integer from session_events
             where type = 'turn.recovery.requested'
               and payload ->> 'reason' = 'worker_death') as heartbeat_recoveries`,
      ]);
      const counts = countRows[0];
      const runningTurns = Number(counts?.running_turns ?? 0);
      const recoveringTurns = Number(counts?.recovering_turns ?? 0);
      const heartbeatRecoveries = Number(counts?.heartbeat_recoveries ?? 0);
      samples.push({
        capturedAt: new Date().toISOString(),
        pendingRevisions: pendingSummary.count,
        runningTurns,
        recoveringTurns,
        heartbeatRecoveries,
      });
      if (runningTurns > turnCapacity) {
        throw new Error(
          `database reports ${runningTurns} running turns above configured capacity ${turnCapacity}`,
        );
      }
      if (heartbeatRecoveries > initialHeartbeatRecoveries) {
        throw new Error("new heartbeat-timeout recovery appeared during wake delivery");
      }
      if (!execute) break;
      if (pendingSummary.count === 0) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= stabilitySeconds * 1_000) break;
      } else {
        stableSince = null;
        const workflowId = `session-wake-cutover-${runId}-${dispatchIteration}`;
        const result = await executeWakeDispatcher(
          temporal!,
          temporalSettingsValue.taskQueue,
          workflowId,
        );
        dispatcherResults.push({ workflowId, result });
        dispatchIteration += 1;
      }
      if (Date.now() >= deadline) {
        for (const row of pendingSummary.errorSamples) {
          failures.push({
            sessionId: row.session_id,
            error: row.last_error ?? "workflow wake was not acknowledged before the deadline",
          });
        }
        if (pendingSummary.count > failures.length) {
          failures.push({
            sessionId: "<additional-pending-revisions>",
            error: `${pendingSummary.count - failures.length} additional workflow wakes remained pending`,
          });
        }
        break;
      }
      await Bun.sleep(sampleSeconds * 1_000);
    }
    const finalPendingProof = await captureWakeOutboxProof(sql, true);
    if (execute && finalPendingProof.count > 0) {
      failures.push({
        sessionId: "<post-stability-race>",
        error: `${finalPendingProof.count} workflow wake(s) appeared after the last stable sample`,
      });
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-wake-outbox/v1",
      runId,
      executed: execute,
      capturedAt: new Date().toISOString(),
      turnCapacity,
      stabilitySeconds,
      timeoutSeconds,
      baselinePendingProof,
      finalPendingProof,
      finalAllProof: await captureWakeOutboxProof(sql, false),
      dispatcherResults,
      samples,
      failures: failures.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    };
    const receipt = { ...draft, sha256: sha256(draft) };
    await writeJson(output, receipt);
    if (failures.length > 0) {
      throw new Error(`workflow-wake delivery failed for ${failures.length} session(s)`);
    }
    process.stderr.write(
      `[cutover-wake-outbox] ${execute ? "delivered" : "found"} ${baselinePendingProof.count} revision(s), sha256 ${receipt.sha256}\n`,
    );
  } finally {
    await connection?.close().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

type SchedulePauseArtifact = {
  contractVersion: "opengeni/session-control-cutover-schedules/v1";
  action: "pause" | "resume" | "inspect";
  runId: string;
  capturedAt: string;
  schedules: Array<{
    scheduleId: string;
    wasPaused: boolean;
    paused: boolean;
    note: string | null;
  }>;
  changedScheduleIds: string[];
  sha256: string;
};

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`unsafe cutover run id: ${value}`);
  }
  return value;
}

export function schedulePauseOwnedByRun(
  wasPaused: boolean,
  currentNote: string | null | undefined,
  runNote: string,
): boolean {
  return !wasPaused || currentNote === runNote;
}

async function temporalSchedules(args: ParsedArgs): Promise<void> {
  const action = required(args, "--action");
  if (action !== "pause" && action !== "resume" && action !== "inspect") {
    throw new Error(`invalid schedule action: ${action}`);
  }
  const runId = safeRunId(required(args, "--run-id"));
  const output = required(args, "--output");
  const note = `OpenGeni production maintenance ${runId}`;
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: settings.namespace,
    });
    if (action === "pause") {
      try {
        await temporal.schedule.create({
          scheduleId: SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
          spec: { intervals: [{ every: SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS }] },
          action: {
            type: "startWorkflow",
            workflowType: SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE,
            taskQueue: settings.taskQueue,
            args: [],
          },
          policies: {
            overlap: ScheduleOverlapPolicy.SKIP,
            catchupWindow: "1m",
            pauseOnFailure: false,
          },
          state: { paused: true, note },
        });
      } catch (error) {
        if (!(error instanceof ScheduleAlreadyRunning)) throw error;
      }
    }
    let expectedResumeIds: Set<string> | null = null;
    if (action === "resume") {
      const pauseArtifact = await readJson<SchedulePauseArtifact>(required(args, "--input"));
      const { sha256: recorded, ...body } = pauseArtifact;
      if (
        pauseArtifact.contractVersion !== "opengeni/session-control-cutover-schedules/v1" ||
        pauseArtifact.action !== "pause" ||
        pauseArtifact.runId !== runId ||
        sha256(body) !== recorded ||
        !Array.isArray(pauseArtifact.changedScheduleIds) ||
        pauseArtifact.changedScheduleIds.some(
          (id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id),
        ) ||
        new Set(pauseArtifact.changedScheduleIds).size !== pauseArtifact.changedScheduleIds.length
      ) {
        throw new Error("schedule pause artifact is stale, malformed, or belongs to another run");
      }
      expectedResumeIds = new Set(pauseArtifact.changedScheduleIds);
    }
    const summaries: Array<{
      scheduleId: string;
      wasPaused: boolean;
      paused: boolean;
      note: string | null;
    }> = [];
    const changedScheduleIds: string[] = [];
    const listed: string[] = [];
    for await (const summary of temporal.schedule.list({ pageSize: 1000 })) {
      listed.push(summary.scheduleId);
    }
    listed.sort();
    for (const scheduleId of listed) {
      const handle = temporal.schedule.getHandle(scheduleId);
      const before = await handle.describe();
      const wasPaused = before.state.paused;
      if (action === "pause" && schedulePauseOwnedByRun(wasPaused, before.state.note, note)) {
        if (!wasPaused) await handle.pause(note);
        // A retry after the pause succeeded but before its receipt was committed
        // still owns this schedule. Re-emit that ownership so the eventual resume
        // receipt cannot lose schedules merely because the command is idempotent.
        changedScheduleIds.push(scheduleId);
      } else if (action === "resume" && expectedResumeIds?.has(scheduleId)) {
        if (!wasPaused || before.state.note !== note) {
          throw new Error(
            `schedule ${scheduleId} is not paused by this exact cutover run; refusing to unpause it`,
          );
        }
        await handle.unpause(note);
        changedScheduleIds.push(scheduleId);
      }
      const after = await handle.describe();
      if (action === "pause" && !after.state.paused) {
        throw new Error(`schedule ${scheduleId} did not acknowledge pause`);
      }
      if (action === "resume" && expectedResumeIds?.has(scheduleId) && after.state.paused) {
        throw new Error(`schedule ${scheduleId} did not acknowledge resume`);
      }
      summaries.push({
        scheduleId,
        wasPaused,
        paused: after.state.paused,
        note: after.state.note ?? null,
      });
    }
    if (expectedResumeIds) {
      const missing = [...expectedResumeIds].filter((id) => !listed.includes(id));
      if (missing.length > 0) {
        throw new Error(`paused schedules disappeared before resume: ${missing.join(", ")}`);
      }
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-schedules/v1" as const,
      action,
      runId,
      capturedAt: new Date().toISOString(),
      schedules: summaries,
      changedScheduleIds: changedScheduleIds.sort(),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-schedules] ${action}: ${summaries.length} observed, ${changedScheduleIds.length} changed, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function temporalWorkflows(args: ParsedArgs): Promise<void> {
  const action = required(args, "--action");
  if (action !== "inspect" && action !== "terminate") {
    throw new Error(`invalid workflow action: ${action}`);
  }
  const execute = args.flags.has("--execute");
  if (action === "terminate" && !execute) {
    throw new Error("workflow termination requires --execute");
  }
  const runId = safeRunId(required(args, "--run-id"));
  const output = required(args, "--output");
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: settings.namespace,
    });
    const captured: Array<{
      workflowId: string;
      runId: string;
      startTime: string;
    }> = [];
    for await (const execution of temporal.workflow.list({
      query: "ExecutionStatus='Running'",
    })) {
      if (!execution.workflowId.startsWith("session-")) continue;
      captured.push({
        workflowId: execution.workflowId,
        runId: execution.runId,
        startTime: execution.startTime.toISOString(),
      });
    }
    captured.sort(
      (a, b) => a.workflowId.localeCompare(b.workflowId) || a.runId.localeCompare(b.runId),
    );
    const terminated: Array<{ workflowId: string; runId: string }> = [];
    if (action === "terminate") {
      for (const execution of captured) {
        await temporal.workflow
          .getHandle(execution.workflowId, execution.runId)
          .terminate(`OpenGeni production maintenance ${runId}`);
        terminated.push({
          workflowId: execution.workflowId,
          runId: execution.runId,
        });
      }
      for (const execution of captured) {
        const description = await temporal.workflow
          .getHandle(execution.workflowId, execution.runId)
          .describe();
        if (description.status.name === "RUNNING") {
          throw new Error(
            `workflow ${execution.workflowId}/${execution.runId} remained running after termination`,
          );
        }
      }
    }
    const remaining: Array<{ workflowId: string; runId: string }> = [];
    for await (const execution of temporal.workflow.list({
      query: "ExecutionStatus='Running'",
    })) {
      if (execution.workflowId.startsWith("session-")) {
        remaining.push({
          workflowId: execution.workflowId,
          runId: execution.runId,
        });
      }
    }
    if (action === "terminate" && remaining.length > 0) {
      throw new Error(`${remaining.length} running session workflows remain after termination`);
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-workflows/v1",
      action,
      executed: action === "terminate" && execute,
      runId,
      capturedAt: new Date().toISOString(),
      captured,
      terminated,
      remaining: remaining.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-workflows] ${action}: ${captured.length} captured, ${terminated.length} terminated, ${remaining.length} remaining, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    await connection.close().catch(() => undefined);
  }
}

type OrphanedRunningTurn = {
  workspace_id: string;
  session_id: string;
  turn_id: string;
  active_attempt_id: string | null;
};

type DetachedTerminalAttempt = {
  workspace_id: string;
  session_id: string;
  turn_id: string;
  active_attempt_id: string;
};

async function listRunningSessionWorkflows(
  temporal: TemporalClient,
): Promise<Array<{ workflowId: string; runId: string }>> {
  const running: Array<{ workflowId: string; runId: string }> = [];
  for await (const execution of temporal.workflow.list({ query: "ExecutionStatus='Running'" })) {
    if (execution.workflowId.startsWith("session-")) {
      running.push({ workflowId: execution.workflowId, runId: execution.runId });
    }
  }
  return running.sort(
    (left, right) =>
      left.workflowId.localeCompare(right.workflowId) || left.runId.localeCompare(right.runId),
  );
}

async function reparkOrphanedTurns(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const runId = safeRunId(required(args, "--run-id"));
  const execute = args.flags.has("--execute");
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-cutover-repark" },
  });
  const client = createDb(migrationDatabaseUrl(), { max: 1 });
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: settings.namespace,
    });
    const runningWorkflows = await listRunningSessionWorkflows(temporal);
    if (runningWorkflows.length > 0) {
      throw new Error(
        `refusing to repark while ${runningWorkflows.length} session workflow(s) remain running`,
      );
    }
    const migrations = await sql<Array<{ name: string }>>`
      select name from schema_migrations
      where name in (
        '0057_durable_queue_control.sql',
        '0058_turn_admission_usage_enrollment.sql',
        '0061_session_workflow_wake_outbox.sql',
        '0062_session_list_snapshot_reaper.sql'
      )
      order by name`;
    const migrationNames = new Set(migrations.map((row) => row.name));
    if (
      !migrationNames.has("0057_durable_queue_control.sql") ||
      !migrationNames.has("0058_turn_admission_usage_enrollment.sql") ||
      !migrationNames.has("0061_session_workflow_wake_outbox.sql") ||
      !migrationNames.has("0062_session_list_snapshot_reaper.sql")
    ) {
      throw new Error("repark requires the complete ordered 0057+0058+0061+0062 schema");
    }
    const rows = (await sql.unsafe<OrphanedRunningTurn[]>(
      `select workspace_id, session_id, id as turn_id, active_attempt_id
       from session_turns
       where status = 'running'
       order by workspace_id, session_id, id`,
    )) as unknown as OrphanedRunningTurn[];
    const reparks: Array<{
      workspaceId: string;
      sessionId: string;
      turnId: string;
      attemptId: string | null;
      sessionStatus: "recovering" | "paused";
      closedToolCalls: number;
      eventIds: string[];
    }> = [];
    if (execute) {
      for (const row of rows) {
        const result = await reparkOrphanedSessionTurn(client.db, row.workspace_id, {
          sessionId: row.session_id,
          turnId: row.turn_id,
          attemptId: row.active_attempt_id,
          reason: `production_cutover:${runId}`,
        });
        if (result.action !== "recovering") {
          throw new Error(
            `orphaned turn ${row.turn_id} changed ownership during the maintenance repark`,
          );
        }
        reparks.push({
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          attemptId: row.active_attempt_id,
          sessionStatus: result.sessionStatus,
          closedToolCalls: result.closedToolCalls,
          eventIds: result.events.map((event) => event.id),
        });
      }
    }
    const remaining = await sql<Array<{ turn_id: string }>>`
      select id as turn_id from session_turns where status = 'running' order by id`;
    if (execute && remaining.length > 0) {
      throw new Error(`${remaining.length} running turn(s) remain after cutover repark`);
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-repark/v2",
      runId,
      executed: execute,
      capturedAt: new Date().toISOString(),
      runningSessionWorkflowCount: runningWorkflows.length,
      candidateTurns: rows.map((row) => ({
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        attemptId: row.active_attempt_id,
      })),
      reparks,
      remainingRunningTurnIds: remaining.map((row) => row.turn_id),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-repark] ${execute ? "reparked" : "found"} ${rows.length} orphaned running turn(s), sha256 ${artifact.sha256}\n`,
    );
  } finally {
    await client.close().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function repairDetachedCapacityAttempts(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const runId = safeRunId(required(args, "--run-id"));
  const execute = args.flags.has("--execute");
  const settings = temporalSettings();
  const connection = await Connection.connect({ address: settings.address });
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-cutover-terminal-owner-repair" },
  });
  const client = createDb(migrationDatabaseUrl(), { max: 1 });
  try {
    const temporal = new TemporalClient({ connection, namespace: settings.namespace });
    const runningWorkflows = await listRunningSessionWorkflows(temporal);
    if (runningWorkflows.length > 0) {
      throw new Error(
        `refusing detached-owner repair while ${runningWorkflows.length} session workflow(s) remain running`,
      );
    }
    const rows = (await sql.unsafe<DetachedTerminalAttempt[]>(
      `select workspace_id, session_id, id as turn_id, active_attempt_id
       from session_turns
       where status <> 'running' and active_attempt_id is not null
       order by workspace_id, session_id, id`,
    )) as unknown as DetachedTerminalAttempt[];
    const repairs: Array<{
      workspaceId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      closedToolCalls: number;
      eventIds: string[];
    }> = [];
    const refused: Array<{
      workspaceId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      observed: Awaited<ReturnType<typeof repairDetachedCodexCapacityAttempt>>;
    }> = [];
    if (execute) {
      for (const row of rows) {
        const result = await repairDetachedCodexCapacityAttempt(client.db, row.workspace_id, {
          sessionId: row.session_id,
          turnId: row.turn_id,
          attemptId: row.active_attempt_id,
          reason: `production_cutover:${runId}:detached_capacity_attempt`,
        });
        if (result.action !== "repaired") {
          refused.push({
            workspaceId: row.workspace_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            attemptId: row.active_attempt_id,
            observed: result,
          });
          continue;
        }
        repairs.push({
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          attemptId: row.active_attempt_id,
          closedToolCalls: result.closedToolCalls,
          eventIds: result.events.map((event) => event.id),
        });
      }
    }
    const remaining = await sql<Array<{ turn_id: string }>>`
      select id as turn_id from session_turns
      where status <> 'running' and active_attempt_id is not null
      order by id`;
    const draft = {
      contractVersion: "opengeni/session-control-cutover-terminal-owner-repair/v1",
      runId,
      executed: execute,
      capturedAt: new Date().toISOString(),
      runningSessionWorkflowCount: runningWorkflows.length,
      candidateTurns: rows.map((row) => ({
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        attemptId: row.active_attempt_id,
      })),
      repairs,
      refused,
      remainingTurnIds: remaining.map((row) => row.turn_id),
    };
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-terminal-owner-repair] ${execute ? "repaired" : "found"} ${rows.length} detached attempt owner(s), sha256 ${artifact.sha256}\n`,
    );
    if (execute && (refused.length > 0 || remaining.length > 0)) {
      throw new Error(
        `${refused.length} detached terminal turn(s) were refused and ${remaining.length} detached attempt owner(s) remain; partial audit written to ${output}`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${operation} returned HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

async function productionCodexCanary(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const runId = safeRunId(required(args, "--run-id"));
  const model = required(args, "--model");
  if (!model.startsWith("codex/")) {
    throw new Error("production canary model must use an existing Codex subscription");
  }
  const apiBaseUrl = required(args, "--api-base-url").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBaseUrl)) throw new Error("--api-base-url must be HTTP(S)");
  const requestedWorkspaceId = args.values.get("--workspace-id")?.trim() || null;
  if (requestedWorkspaceId && !/^[0-9a-f-]{36}$/.test(requestedWorkspaceId)) {
    throw new Error("--workspace-id must be a UUID");
  }
  const timeoutSeconds = Number.parseInt(args.values.get("--timeout-seconds") ?? "600", 10);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1_800) {
    throw new Error("--timeout-seconds must be between 30 and 1800");
  }
  const sql = postgres(migrationDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 15,
    connection: { application_name: "opengeni-production-codex-canary" },
  });
  let apiKeyId: string | null = null;
  try {
    const candidates = (await sql.unsafe<Array<{ workspace_id: string; account_id: string }>>(
      `select w.id as workspace_id, w.account_id
       from workspaces w
       where w.inference_state = 'active'
         and ($1::uuid is null or w.id = $1::uuid)
         and exists (
           select 1 from codex_subscription_credentials c
           where c.workspace_id = w.id and c.status = 'active'
         )
       order by w.id limit 1`,
      [requestedWorkspaceId],
    )) as unknown as Array<{ workspace_id: string; account_id: string }>;
    const candidate = candidates[0];
    if (!candidate) {
      throw new Error(
        "no active workspace with an existing connected Codex subscription was found",
      );
    }
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = `ogk_${Buffer.from(randomBytes).toString("hex")}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    const apiKeyTtlSeconds = timeoutSeconds + 300;
    const inserted = await sql<Array<{ id: string }>>`
      insert into api_keys (
        account_id, workspace_id, name, prefix, key_hash, permissions, expires_at
      ) values (
        ${candidate.account_id}, ${candidate.workspace_id}, ${`OpenGeni production canary ${runId}`},
        ${token.slice(0, 14)}, ${keyHash},
        ${sql.json(["workspace:read", "sessions:create", "sessions:read", "sessions:control"])},
        now() + ${apiKeyTtlSeconds} * interval '1 second'
      ) returning id`;
    apiKeyId = inserted[0]?.id ?? null;
    if (!apiKeyId) throw new Error("failed to create the temporary canary API key");

    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const canaryMarker = `OPENGENI_CANARY_OK_${runId.replaceAll(/[^A-Za-z0-9]/g, "_")}`;
    const idempotencyKey = `production-cutover-canary:${runId}`;
    const createBody = JSON.stringify({
      initialMessage: `Reply with exactly ${canaryMarker} and nothing else. Do not call tools.`,
      resources: [],
      tools: [],
      metadata: { productionCutoverCanary: runId },
      model,
      reasoningEffort: "low",
      sandbox: "new",
      idempotencyKey,
    });
    const overallDeadline = Date.now() + timeoutSeconds * 1_000;
    const createAttempts: Array<{
      attempt: number;
      startedAt: string;
      durationMs: number;
      httpStatus: number | null;
      outcome: "created" | "authoritative-existing" | "retryable";
      error: string | null;
    }> = [];
    let sessionId: string | null = null;
    for (let attempt = 1; attempt <= 5 && Date.now() < overallDeadline; attempt += 1) {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      let httpStatus: number | null = null;
      let retryableError: string | null = null;
      let nonRetryable = false;
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/workspaces/${candidate.workspace_id}/sessions`,
          {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(
              Math.max(1_000, Math.min(30_000, overallDeadline - Date.now())),
            ),
            body: createBody,
          },
        );
        httpStatus = response.status;
        if (response.ok) {
          const created = await responseJson(response, "canary session creation");
          sessionId = typeof created.id === "string" ? created.id : null;
          if (!sessionId) throw new Error("canary session creation returned no session id");
          createAttempts.push({
            attempt,
            startedAt,
            durationMs: Date.now() - startedMs,
            httpStatus,
            outcome: "created",
            error: null,
          });
          break;
        }
        if (response.status < 500) {
          nonRetryable = true;
          await responseJson(response, "canary session creation");
        }
        retryableError = `HTTP ${response.status}`;
      } catch (error) {
        retryableError = error instanceof Error ? error.message : String(error);
      }
      if (nonRetryable) throw new Error(retryableError ?? "canary session creation was rejected");
      const [existing] = await sql<Array<{ id: string }>>`
        select id from sessions
        where workspace_id = ${candidate.workspace_id}
          and create_idempotency_key = ${idempotencyKey}
        limit 1`;
      if (existing?.id) {
        sessionId = existing.id;
        createAttempts.push({
          attempt,
          startedAt,
          durationMs: Date.now() - startedMs,
          httpStatus,
          outcome: "authoritative-existing",
          error: retryableError,
        });
        break;
      }
      createAttempts.push({
        attempt,
        startedAt,
        durationMs: Date.now() - startedMs,
        httpStatus,
        outcome: "retryable",
        error: retryableError,
      });
      if (Date.now() < overallDeadline) await Bun.sleep(1_000);
    }
    if (!sessionId) throw new Error("canary session creation returned no session id");

    const deadline = overallDeadline;
    let completedEventId: string | null = null;
    let usageEventId: string | null = null;
    let observedProvider: string | null = null;
    let observedModel: string | null = null;
    let terminalFailure = false;
    const turnStateSamples: Array<{
      capturedAt: string;
      turnId: string;
      status: string;
      activeAttemptId: string | null;
    }> = [];
    while (Date.now() < deadline) {
      const response = await fetch(
        `${apiBaseUrl}/v1/workspaces/${candidate.workspace_id}/sessions/${sessionId}/events?limit=1000`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      const rawEvents = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rawEvents)) {
        throw new Error(`canary event replay returned HTTP ${response.status}`);
      }
      for (const raw of rawEvents) {
        if (!raw || typeof raw !== "object") continue;
        const event = raw as Record<string, unknown>;
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        if (event.type === "agent.message.completed" && payload.text === canaryMarker) {
          completedEventId = typeof event.id === "string" ? event.id : null;
        }
        if (event.type === "agent.model.usage" && payload.model === model) {
          usageEventId = typeof event.id === "string" ? event.id : null;
          observedProvider = typeof payload.provider === "string" ? payload.provider : null;
          observedModel = typeof payload.model === "string" ? payload.model : null;
        }
        if (event.type === "turn.failed" || event.type === "turn.cancelled") terminalFailure = true;
      }
      const turnRows = await sql<
        Array<{ id: string; status: string; active_attempt_id: string | null }>
      >`
        select id, status, active_attempt_id from session_turns
        where workspace_id = ${candidate.workspace_id} and session_id = ${sessionId}
        order by position desc, id desc limit 1`;
      const sampledTurn = turnRows[0];
      if (sampledTurn) {
        turnStateSamples.push({
          capturedAt: new Date().toISOString(),
          turnId: sampledTurn.id,
          status: sampledTurn.status,
          activeAttemptId: sampledTurn.active_attempt_id,
        });
        if (sampledTurn.status === "running" && !sampledTurn.active_attempt_id) {
          throw new Error("canary became running without a registered attempt owner");
        }
      }
      if (completedEventId && usageEventId) break;
      if (terminalFailure) throw new Error("production Codex canary turn failed or was cancelled");
      await Bun.sleep(2_000);
    }
    if (!completedEventId || !usageEventId || observedModel !== model) {
      throw new Error(
        "production Codex canary did not produce the exact reply and usage evidence in time",
      );
    }
    if (observedProvider !== "codex-subscription") {
      throw new Error(
        `production canary used ${observedProvider ?? "an unknown provider"}, expected codex-subscription`,
      );
    }
    const currentUsage = await sql<
      Array<{
        id: string;
        turn_id: string;
        source_key: string;
        provider: string;
        model: string;
      }>
    >`
      select id, turn_id, payload ->> 'sourceKey' as source_key,
        payload ->> 'provider' as provider, payload ->> 'model' as model
      from session_events
      where workspace_id = ${candidate.workspace_id}
        and session_id = ${sessionId}
        and type = 'agent.model.usage'
        and turn_association = 'current'
      order by sequence`;
    if (
      currentUsage.length !== 1 ||
      currentUsage[0]?.id !== usageEventId ||
      currentUsage[0]?.provider !== "codex-subscription" ||
      currentUsage[0]?.model !== model ||
      !currentUsage[0]?.source_key
    ) {
      throw new Error("canary did not produce exactly one authoritative Codex usage source");
    }
    const usage = currentUsage[0]!;
    const duplicateUsage = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from session_events
      where workspace_id = ${candidate.workspace_id}
        and session_id = ${sessionId}
        and type = 'agent.model.usage'
        and payload ->> 'sourceKey' = ${usage.source_key}
        and turn_association = 'duplicate'
        and duplicate_of_event_id = ${usage.id}`;
    const billingMarkers = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from usage_events
      where workspace_id = ${candidate.workspace_id}
        and event_type = 'model.cost'
        and quantity = 0
        and source_resource_id = ${`${usage.turn_id}:${usage.source_key}`}`;
    const creditDebits = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from credit_ledger_entries
      where workspace_id = ${candidate.workspace_id}
        and source_type = 'model_response'
        and source_id = ${`${usage.turn_id}:${usage.source_key}`}`;
    const startedAttempts = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from session_events
      where workspace_id = ${candidate.workspace_id}
        and session_id = ${sessionId}
        and turn_id = ${usage.turn_id}
        and type = 'turn.started'
        and turn_attempt_id is not null
        and turn_association = 'current'`;
    if (Number(billingMarkers[0]?.count ?? 0) !== 1) {
      throw new Error("canary is missing its one idempotent zero-cost Codex billing marker");
    }
    if (Number(creditDebits[0]?.count ?? 0) !== 0) {
      throw new Error("canary unexpectedly debited OpenGeni credits");
    }
    if (Number(startedAttempts[0]?.count ?? 0) !== 1) {
      throw new Error("canary has no unique current turn.started attempt evidence");
    }
    const draft = {
      contractVersion: "opengeni/session-control-cutover-canary/v2",
      runId,
      capturedAt: new Date().toISOString(),
      workspaceId: candidate.workspace_id,
      sessionId,
      completedEventId,
      usageEventId,
      provider: observedProvider,
      model: observedModel,
      exactReplyMatched: true,
      createIdempotencyKey: idempotencyKey,
      createAttempts,
      turnStateSamples,
      usageSourceKey: usage.source_key,
      classifiedDuplicateUsageCount: Number(duplicateUsage[0]?.count ?? 0),
      zeroCostBillingMarkerCount: Number(billingMarkers[0]?.count ?? 0),
      creditDebitCount: Number(creditDebits[0]?.count ?? 0),
      currentStartedAttemptCount: Number(startedAttempts[0]?.count ?? 0),
      azureModelTokensUsed: false,
      temporaryApiKeyRevoked: true,
    };
    await sql`update api_keys set revoked_at = now(), updated_at = now() where id = ${apiKeyId}`;
    apiKeyId = null;
    const artifact = { ...draft, sha256: sha256(draft) };
    await writeJson(output, artifact);
    process.stderr.write(
      `[cutover-canary] session ${sessionId} completed through ${observedModel}, sha256 ${artifact.sha256}\n`,
    );
  } finally {
    if (apiKeyId) {
      await sql`
        update api_keys set revoked_at = now(), updated_at = now() where id = ${apiKeyId}`.catch(
        () => undefined,
      );
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

async function maintenanceServer(): Promise<never> {
  const port = Number.parseInt(process.env.OPENGENI_MAINTENANCE_PORT ?? "8000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENGENI_MAINTENANCE_PORT must be a valid TCP port");
  }
  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/healthz") {
        return Response.json({ ok: true, mode: "production-maintenance" });
      }
      return Response.json(
        {
          error: {
            code: "production_maintenance",
            message: "OpenGeni is briefly paused for a production update. Retry shortly.",
          },
        },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "retry-after": "120",
          },
        },
      );
    },
  });
  process.stderr.write(`[cutover-maintenance] serving on port ${port}\n`);
  // The Kubernetes pod owns this process lifetime and terminates it after the
  // ingress backend has been restored.
  return await new Promise<never>(() => undefined);
}

async function preflight(args: ParsedArgs): Promise<void> {
  const output = required(args, "--output");
  const expectedSourceSha = required(args, "--source-sha");
  if (!/^[0-9a-f]{40}$/.test(expectedSourceSha)) {
    throw new Error("--source-sha must be a full lowercase Git commit SHA");
  }
  const bakedSourceSha = process.env.OPENGENI_SERVER_VERSION?.trim() ?? "";
  if (bakedSourceSha !== expectedSourceSha) {
    throw new Error(
      `reviewed source ${expectedSourceSha} does not match image source ${bakedSourceSha || "<unset>"}`,
    );
  }

  const migrationPaths = [
    "packages/db/drizzle/0057_durable_queue_control.sql",
    "packages/db/drizzle/0058_turn_admission_usage_enrollment.sql",
    "packages/db/drizzle/0061_session_workflow_wake_outbox.sql",
    "packages/db/drizzle/0062_session_list_snapshot_reaper.sql",
  ] as const;
  const migrations = await Promise.all(
    migrationPaths.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  const workerPackage = parseJson<{
    devDependencies?: Record<string, string>;
  }>(await readFile("apps/worker/package.json", "utf8"), "apps/worker/package.json");
  const agentsCoreVersion = workerPackage.devDependencies?.["@openai/agents-core"];
  if (!agentsCoreVersion || !/^\d+\.\d+\.\d+$/.test(agentsCoreVersion)) {
    throw new Error("apps/worker must pin an exact @openai/agents-core version");
  }

  const schemaProbe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--cwd",
      "apps/worker",
      "-e",
      `import {Agent,RunContext,RunState} from "@openai/agents-core"; const agent=new Agent({name:"cutover-preflight",instructions:""}); const state=new RunState(new RunContext(),"",agent,1); process.stdout.write(JSON.stringify({schemaVersion:state.toJSON().$schemaVersion}));`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (schemaProbe.exitCode !== 0) {
    throw new Error(
      `RunState schema probe failed: ${schemaProbe.stderr.toString().trim() || "unknown error"}`,
    );
  }
  const schema = parseJson<{ schemaVersion?: unknown }>(
    schemaProbe.stdout.toString(),
    "RunState schema probe",
  );
  if (typeof schema.schemaVersion !== "string" || !/^\d+\.\d+$/.test(schema.schemaVersion)) {
    throw new Error("RunState schema probe returned an invalid version");
  }

  const draft = {
    contractVersion: "opengeni/session-control-cutover-preflight/v2",
    capturedAt: new Date().toISOString(),
    sourceSha: bakedSourceSha,
    migrations,
    workerTopology: workerTopologyEvidence(),
    validationModelPolicy: {
      allowedPrefix: "codex/",
      azureModelTokensAllowed: false,
    },
    agentsCoreVersion,
    runStateSchemaVersion: schema.schemaVersion,
  };
  const artifact = { ...draft, sha256: sha256(draft) };
  await writeJson(output, artifact);
  process.stderr.write(
    `[cutover-preflight] source ${bakedSourceSha}, migrations ${migrations.map((migration) => migration.sha256).join(",")}, RunState ${schema.schemaVersion}\n`,
  );
}

function usage(): void {
  process.stdout.write(`Usage:
  bun run operator:session-control-cutover preflight --source-sha SHA --output FILE
  bun run operator:session-control-cutover capture --phase baseline --output FILE [--allow-empty-baseline]
  bun run operator:session-control-cutover capture --phase migrated|final --baseline FILE --output FILE
  bun run operator:session-control-cutover reconcile --baseline FILE --observed FILE --mode migration|final-fate --output FILE
  bun run operator:session-control-cutover wake-outbox --run-id ID --turn-capacity N --output FILE [--execute] [--stability-seconds N]
  bun run operator:session-control-cutover temporal-schedules --action pause|resume|inspect --run-id ID [--input FILE] --output FILE
  bun run operator:session-control-cutover temporal-workflows --action inspect|terminate --run-id ID --output FILE [--execute]
  bun run operator:session-control-cutover repark-orphaned-turns --run-id ID --output FILE [--execute]
  bun run operator:session-control-cutover repair-detached-capacity-attempts --run-id ID --output FILE [--execute]
  bun run operator:session-control-cutover canary --run-id ID --workspace-id UUID --model codex/MODEL --api-base-url URL --output FILE [--timeout-seconds N]
  bun run operator:session-control-cutover maintenance-server

capture, repark, canary, and wake-outbox require OPENGENI_MIGRATIONS_DATABASE_URL. repark and wake-outbox also require the production Temporal settings.
`);
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "preflight") await preflight(args);
    else if (args.command === "capture") await capture(args);
    else if (args.command === "reconcile") await reconcile(args);
    else if (args.command === "wake-outbox") await wakeOutbox(args);
    else if (args.command === "temporal-schedules") await temporalSchedules(args);
    else if (args.command === "temporal-workflows") await temporalWorkflows(args);
    else if (args.command === "repark-orphaned-turns") await reparkOrphanedTurns(args);
    else if (args.command === "repair-detached-capacity-attempts")
      await repairDetachedCapacityAttempts(args);
    else if (args.command === "canary") await productionCodexCanary(args);
    else if (args.command === "maintenance-server") await maintenanceServer();
    else if (args.command === "help" || args.flags.has("--help")) usage();
    else throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
