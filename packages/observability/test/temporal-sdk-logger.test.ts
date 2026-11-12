import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createObservability,
  createTemporalSdkLogger,
  TEMPORAL_SDK_FALLBACK_LOG_MESSAGE,
} from "../src/index";

const settings = {
  serviceName: "opengeni-test",
  environment: "test",
  observabilityStructuredLogs: true,
} as Parameters<typeof createObservability>[0];

const SENTINEL = "TEMPORAL_SDK_PRIVATE_SENTINEL_5c1e";
let lines: { stream: "log" | "warn" | "error"; text: string }[];
const original = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  lines = [];
  console.log = (message?: unknown) => lines.push({ stream: "log", text: String(message) });
  console.warn = (message?: unknown) => lines.push({ stream: "warn", text: String(message) });
  console.error = (message?: unknown) => lines.push({ stream: "error", text: String(message) });
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
});

function sdkLogger() {
  return createTemporalSdkLogger(
    createObservability(settings, { component: "worker-control", now: () => 1 }),
  );
}

function failure(): Error {
  const error = new Error(`recorded root is missing ${SENTINEL}`);
  error.name = `SandboxConfigError${SENTINEL}`;
  error.stack = `SandboxConfigError: ${SENTINEL}\n    at drain (/srv/${SENTINEL}.ts:1:1)`;
  return error;
}

test("an activity failure becomes one JSON line without task token, identifiers or cause", () => {
  sdkLogger().warn("Activity failed", {
    sdkComponent: "activity",
    taskQueue: `queue-${SENTINEL}`,
    taskToken: `CiQ${SENTINEL}==`,
    namespace: `ns-${SENTINEL}`,
    workflowId: `sandbox-drain-${SENTINEL}`,
    workflowRunId: `run-${SENTINEL}`,
    workflowType: "sandboxDrainWorkflow",
    activityId: `1-${SENTINEL}`,
    activityType: "drainSandboxLease",
    attempt: 4890,
    isLocal: false,
    durationMs: 12,
    error: failure(),
  });

  expect(lines).toHaveLength(1);
  expect(lines[0]!.stream).toBe("warn");
  expect(lines[0]!.text).not.toContain("\n");
  expect(lines[0]!.text).not.toContain(SENTINEL);
  expect(JSON.parse(lines[0]!.text)).toEqual({
    timestamp: new Date(1).toISOString(),
    level: "warn",
    message: "Activity failed",
    service: "opengeni-test",
    environment: "test",
    component: "worker-control",
    errorClass: "TemporalSdkOperationError",
    errorCode: "temporal_sdk_failure_logged",
    errorMessage: "temporal sdk failure logged",
    origin: "worker",
    sdkComponent: "activity",
    activity: "drainSandboxLease",
    workflowType: "sandboxDrainWorkflow",
    attempt: 4890,
    durationMs: 12,
  });
});

/** The shape a refused database write reaches the SDK in: the persistence
 * error, the query builder's error quoting SQL and parameters, and the
 * PostgreSQL error our trigger raised. */
function refusedPersistence(pg: Record<string, unknown>): Error {
  const postgres = Object.assign(new Error(), { name: "PostgresError", ...pg });
  const query = Object.assign(new Error(`Failed query: update ${SENTINEL}`, { cause: postgres }), {
    name: "DrizzleQueryError",
    query: `update "session_turn_attempts" set ${SENTINEL}`,
    params: [SENTINEL],
  });
  return Object.assign(
    new Error("Database failure while persisting session.queue.changed", { cause: query }),
    {
      name: "SessionEventPersistenceError",
      details: { code: "db_failure", stage: "session_attempts.mark_quiesced", sqlState: "OG002" },
    },
  );
}

test("an activity failing on a database refusal logs what the database refused", () => {
  sdkLogger().warn("Activity failed", {
    sdkComponent: "worker",
    workflowType: "sessionWorkflow",
    activityType: "persistSessionAttemptQuiescence",
    workflowId: `session-${SENTINEL}`,
    attempt: 18275,
    durationMs: 26,
    error: refusedPersistence({
      severity: "ERROR",
      code: "OG002",
      message: "SESSION_ARCHIVED_READ_ONLY",
      where: "PL/pgSQL function refuse_imported_archive_execution() line 37 at RAISE",
      detail: SENTINEL,
    }),
  });

  expect(lines).toHaveLength(1);
  expect(lines[0]!.text).not.toContain(SENTINEL);
  expect(JSON.parse(lines[0]!.text)).toMatchObject({
    message: "Activity failed",
    errorClass: "TemporalSdkOperationError",
    errorCode: "temporal_sdk_failure_logged",
    activity: "persistSessionAttemptQuiescence",
    workflowType: "sessionWorkflow",
    attempt: 18275,
    failureName: "SessionEventPersistenceError",
    persistenceStage: "session_attempts.mark_quiesced",
    sqlState: "OG002",
    dbReason: "SESSION_ARCHIVED_READ_ONLY",
    dbFunctions: "refuse_imported_archive_execution:37",
  });
});

test("PostgreSQL's own messages and transport codes are never logged as reasons", () => {
  sdkLogger().warn("Activity failed", {
    sdkComponent: "worker",
    error: refusedPersistence({
      severity: "ERROR",
      code: "23505",
      message: `duplicate key value violates unique constraint ${SENTINEL}`,
    }),
  });
  sdkLogger().warn("Activity failed", {
    sdkComponent: "worker",
    error: Object.assign(new Error(SENTINEL), { code: "EPIPE" }),
  });

  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line.text).not.toContain(SENTINEL);
  const [refused, transport] = lines.map((line) => JSON.parse(line.text));
  expect(refused).toMatchObject({ failureName: "SessionEventPersistenceError", sqlState: "23505" });
  expect(refused).not.toHaveProperty("dbReason");
  expect(refused).not.toHaveProperty("dbFunctions");
  expect(transport).toMatchObject({ failureName: "Error" });
  expect(transport).not.toHaveProperty("sqlState");
});

test("an ApplicationFailure logs its type and whether it retries", () => {
  class TemporalFailure extends Error {}
  class ApplicationFailure extends TemporalFailure {
    constructor(
      message: string,
      readonly type: string,
      readonly nonRetryable: boolean,
    ) {
      super(message);
    }
  }
  // Temporal defines `name` on the failure class prototype, not the instance.
  Object.defineProperty(ApplicationFailure.prototype, "name", { value: "ApplicationFailure" });
  sdkLogger().warn("Activity failed", {
    sdkComponent: "worker",
    error: new ApplicationFailure(SENTINEL, "SessionReadOnlyFailure", true),
  });
  sdkLogger().warn("Activity failed", {
    sdkComponent: "worker",
    error: new ApplicationFailure(SENTINEL, `bad type ${SENTINEL}`, false),
  });

  for (const line of lines) expect(line.text).not.toContain(SENTINEL);
  const [typed, untyped] = lines.map((line) => JSON.parse(line.text));
  expect(typed).toMatchObject({
    failureName: "ApplicationFailure",
    failureType: "SessionReadOnlyFailure",
    nonRetryable: true,
  });
  expect(untyped).toMatchObject({ failureName: "ApplicationFailure", nonRetryable: false });
  expect(untyped).not.toHaveProperty("failureType");
});

test("SDK messages that interpolate exception text publish a fixed message", () => {
  sdkLogger().error(`Error while processing ActivityTask.start: ${SENTINEL}`, {
    sdkComponent: "worker",
    error: failure(),
  });
  sdkLogger().warn(`This program is running with ${SENTINEL}\nsecond line`, {
    sdkComponent: "worker",
  });

  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line.text).not.toContain(SENTINEL);
    expect(JSON.parse(line.text).message).toBe(TEMPORAL_SDK_FALLBACK_LOG_MESSAGE);
  }
});

test("forwarded core records keep only their component", () => {
  sdkLogger().log("WARN", `Error polling: status Unavailable ${SENTINEL}`, {
    sdkComponent: "core",
    target: `temporal_sdk_core::${SENTINEL}`,
    spanContexts: [`span-${SENTINEL}`],
    error: `transport ${SENTINEL}`,
    task_queue: `queue-${SENTINEL}`,
  });

  expect(lines).toHaveLength(1);
  expect(lines[0]!.text).not.toContain(SENTINEL);
  expect(JSON.parse(lines[0]!.text)).toMatchObject({
    level: "warn",
    message: TEMPORAL_SDK_FALLBACK_LOG_MESSAGE,
    sdkComponent: "core",
    errorClass: "TemporalSdkOperationError",
  });
});

test("workflow.log keeps the workflow's constant message and drops its identifiers", () => {
  sdkLogger().warn("sandbox reaper maintenance deferred to a later sweep", {
    sdkComponent: "workflow",
    workflowType: "sandboxReaperWorkflow",
    workflowId: `reaper-${SENTINEL}`,
    runId: `run-${SENTINEL}`,
    workspaceId: `workspace-${SENTINEL}`,
    leaseEpoch: 7,
  });

  expect(lines).toHaveLength(1);
  expect(lines[0]!.text).not.toContain(SENTINEL);
  const record = JSON.parse(lines[0]!.text);
  expect(record).toMatchObject({
    level: "warn",
    message: "sandbox reaper maintenance deferred to a later sweep",
    sdkComponent: "workflow",
    workflowType: "sandboxReaperWorkflow",
  });
  expect(record).not.toHaveProperty("errorClass");
  expect(record).not.toHaveProperty("leaseEpoch");
});

test("invalid component and type names are omitted rather than published", () => {
  sdkLogger().info("Workflow started", {
    sdkComponent: `worker ${SENTINEL}`,
    workflowType: `bad type ${SENTINEL}`,
    activityType: `bad/${SENTINEL}`,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]!.stream).toBe("log");
  expect(lines[0]!.text).not.toContain(SENTINEL);
  const record = JSON.parse(lines[0]!.text);
  expect(record.message).toBe("Workflow started");
  expect(record).not.toHaveProperty("sdkComponent");
  expect(record).not.toHaveProperty("workflowType");
  expect(record).not.toHaveProperty("activity");
});

test("records below INFO are dropped by default and the threshold is configurable", () => {
  sdkLogger().debug("Activity completed", { sdkComponent: "activity" });
  sdkLogger().trace("Got activity task", { sdkComponent: "worker" });
  expect(lines).toHaveLength(0);

  const verbose = createTemporalSdkLogger(
    createObservability(settings, { component: "worker-turn", now: () => 1 }),
    { minimumLevel: "TRACE" },
  );
  verbose.trace("Activity completed", { sdkComponent: "activity" });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!.text)).toMatchObject({
    level: "debug",
    message: "Activity completed",
  });
});

test("a logging failure never propagates into the SDK", () => {
  const logger = createTemporalSdkLogger({
    log: () => {
      throw new Error("sink unavailable");
    },
  });
  expect(() => logger.error("Worker failed", { error: failure() })).not.toThrow();
});
