import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { ToolCallError } from "@openai/agents";
import { SessionEventPersistenceError } from "@opengeni/db";
import { RoutingMutationOutcomeUnknownError } from "@opengeni/runtime";
import { MandatoryHistoryPersistenceError } from "../src/activities/agent-turn/quiescence";
import {
  agentRunFailurePayload,
  postClaimDatabaseRecoveryFailure,
} from "../src/activities/agent-turn/errors";

test("unwrapped database failures retain SQLSTATE and identifiers without expanding nested content", () => {
  const driver = Object.assign(
    new Error("connection detail postgresql://fixture:synthetic@db.example.test/runtime"),
    {
      name: "PostgresError",
      code: "42501",
      severity: "ERROR",
      schema_name: "public",
      table_name: "session_turns",
      constraint_name: "accepted_authority",
      routine: "exec_stmt_raise",
      detail: "private nested query values",
      hint: "private nested hint",
    },
  );
  const outer = Object.assign(
    new Error("Failed query containing fixture-value", { cause: driver }),
    {
      code: "E1234",
      query: "INSERT INTO runtime_records (payload) VALUES ($1)",
      params: ["private parameter"],
    },
  );
  expect(agentRunFailurePayload(outer)).toEqual({
    error: "OpenGeni encountered a database error.",
    code: "db_failure",
    sqlState: "42501",
    database: {
      severity: "ERROR",
      schema: "public",
      table: "session_turns",
      constraint: "accepted_authority",
      routine: "exec_stmt_raise",
    },
  });
});

test("plain domain failures and provider retry classification stay unchanged", () => {
  expect(agentRunFailurePayload(new Error("Domain rejected this operation"))).toEqual({
    error: "Domain rejected this operation",
  });
  const rateLimit = Object.assign(new Error("Too Many Requests"), { status: 429 });
  expect(agentRunFailurePayload(rateLimit)).toMatchObject({
    code: "provider_rate_limited",
    retryable: true,
  });
  expect(agentRunFailurePayload(rateLimit)).not.toHaveProperty("database");
});

test("database transport failures add no raw driver cause or automatic retry", () => {
  const failure = Object.assign(new Error("Original database operation failed"), {
    cause: Object.assign(new Error("postgresql://fixture:synthetic@db.example.test/runtime"), {
      code: "CONNECTION_CLOSED",
    }),
  });
  expect(agentRunFailurePayload(failure)).toEqual({ error: failure.message });
});

test("five-character application codes do not become database diagnostics", () => {
  const domain = Object.assign(new Error("External domain failure"), { code: "E1234" });
  expect(agentRunFailurePayload(domain)).toEqual({ error: domain.message });
  Object.assign(domain, { severity: "ERROR", cause: domain });
  expect(agentRunFailurePayload(domain)).toEqual({ error: domain.message });
  const driver = Object.assign(new Error("PostgreSQL custom condition"), {
    name: "PostgresError",
    code: "E1234",
    severity: "ERROR",
    routine: "exec_stmt_raise",
  });
  expect(agentRunFailurePayload(driver)).toEqual({
    error: "OpenGeni encountered a database error.",
    code: "db_failure",
    sqlState: "E1234",
    database: { severity: "ERROR", routine: "exec_stmt_raise" },
  });
});

function rawDatabaseFailure(sqlState: string, message = "transaction aborted") {
  const driver = Object.assign(new Error(message), {
    name: "PostgresError",
    code: sqlState,
    severity: "ERROR",
    routine: "DeadLockReport",
  });
  return new DrizzleQueryError(
    "INSERT INTO runtime_records (payload) VALUES ($1)",
    ["fixture-value"],
    driver,
  );
}

const identity = {
  turnId: "10000000-0000-4000-8000-000000000001",
  triggerEventId: "10000000-0000-4000-8000-000000000002",
  executionGeneration: 2,
};

test("running-turn outages use structured database causes through SDK and history wrappers", () => {
  for (const code of [
    "ECONNREFUSED",
    "ECONNRESET",
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
    "ETIMEDOUT",
    "57P01",
    "57P02",
    "57P03",
    "08006",
    "08001",
  ]) {
    const driver = Object.assign(new Error("private driver detail"), {
      code,
      ...(code.length === 5 ? { name: "PostgresError" } : {}),
    });
    const orm = new DrizzleQueryError("select account_id from workspaces", ["private"], driver);
    const persistence = new SessionEventPersistenceError(
      {
        code: "db_failure",
        sqlState: code.length === 5 ? code : null,
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.reasoning.delta"],
        correlationId: "test-db-outage",
        attempts: 1,
        retryOutcome: "not_retryable",
        database: {},
      },
      orm,
    );
    for (const error of [
      orm,
      persistence,
      new ToolCallError("Failed to run function tools", orm),
      new ToolCallError("Failed to run function tools", persistence),
      new MandatoryHistoryPersistenceError("history_append", persistence),
    ]) {
      const failure = postClaimDatabaseRecoveryFailure({
        error,
        ...identity,
        requireDatabaseProvenance: true,
      });
      expect(failure).toMatchObject({
        type: "OpenGeniPostClaimDatabaseRecovery",
        nonRetryable: true,
        details: [{ ...identity, code: "db_failure" }],
      });
      expect(JSON.stringify(failure)).not.toContain("private");
      expect(JSON.stringify(failure)).not.toContain("select account_id");
    }
  }
});

test("running-turn recovery rejects permanent errors, provider sockets and message lookalikes", () => {
  const uncertain = new RoutingMutationOutcomeUnknownError("execCommand", "outcome unknown", {
    cause: rawDatabaseFailure("57P01"),
  });
  for (const error of [
    uncertain,
    new ToolCallError("Failed to run function tools", uncertain),
    new AggregateError([rawDatabaseFailure("57P01"), uncertain], "parallel tool failure"),
    ...["23505", "42501", "42601", "40003", "40P01", "40001"].map(
      (code) => new ToolCallError("Failed to run function tools", rawDatabaseFailure(code)),
    ),
    new ToolCallError("Failed query select account_id from workspaces CONNECT_TIMEOUT", "57P01"),
    Object.assign(new Error("provider socket reset"), { code: "ECONNRESET" }),
    new Error("write CONNECT_TIMEOUT SQLSTATE 08006"),
    Object.assign(new Error("application rejection"), { code: "57P03" }),
    new SessionEventPersistenceError({
      code: "db_failure",
      sqlState: null,
      stage: "session_events.append_for_turn_attempt",
      eventTypes: ["agent.reasoning.delta"],
      correlationId: "unknown-db-cause",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: {},
    }),
  ]) {
    expect(
      postClaimDatabaseRecoveryFailure({ error, ...identity, requireDatabaseProvenance: true }),
    ).toBeNull();
  }
});

test("raw PostgreSQL rollback failures recover only the exact claimed attempt", () => {
  for (const [sqlState, code] of [
    ["40P01", "db_deadlock"],
    ["40001", "db_serialization_failure"],
  ] as const) {
    const error = rawDatabaseFailure(sqlState);
    const failure = postClaimDatabaseRecoveryFailure({ error, ...identity });
    expect(failure).toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
      nonRetryable: true,
      details: [{ ...identity, code }],
    });
    expect(JSON.stringify(failure?.details)).not.toContain("fixture-value");
    expect(error.cause).toMatchObject({ name: "PostgresError", code: sqlState });
  }
});

test("raw permanent, uncertain and lookalike failures cannot enter database recovery", () => {
  for (const sqlState of ["23505", "42501", "40003", "E1234"]) {
    expect(
      postClaimDatabaseRecoveryFailure({ error: rawDatabaseFailure(sqlState), ...identity }),
    ).toBeNull();
  }
  expect(
    postClaimDatabaseRecoveryFailure({
      error: Object.assign(new Error("domain failure"), { code: "40P01" }),
      ...identity,
    }),
  ).toBeNull();
  expect(
    postClaimDatabaseRecoveryFailure({
      error: rawDatabaseFailure("40P01"),
      ...identity,
      executionGeneration: 0,
    }),
  ).toBeNull();
  const uncertain = Object.assign(new Error("statement completion unknown"), {
    name: "PostgresError",
    code: "40003",
    cause: rawDatabaseFailure("40P01"),
  });
  expect(postClaimDatabaseRecoveryFailure({ error: uncertain, ...identity })).toBeNull();
});

test("database history wrappers and ORM transport errors keep raw evidence out of payloads", () => {
  const error = rawDatabaseFailure("40P01");
  const history = new MandatoryHistoryPersistenceError("history_append", error);
  const payload = agentRunFailurePayload(history);
  expect(payload).toMatchObject({ code: "db_deadlock", historyPersistenceStage: "history_append" });
  expect(JSON.stringify(payload)).not.toContain("fixture-value");
  expect(history.cause).toBe(error);
  const transport = new DrizzleQueryError(
    "INSERT INTO runtime_records VALUES ($1)",
    ["fixture-value"],
    Object.assign(new Error("fixture-value"), { code: "CONNECTION_CLOSED" }),
  );
  expect(agentRunFailurePayload(transport)).toEqual({
    error: "OpenGeni encountered a database error.",
    code: "db_failure",
    sqlState: null,
  });
});

test("raw database payloads never expose SQL or acquire provider replay authority", () => {
  for (const sqlState of ["40P01", "40001", "40003", "42501"]) {
    const error = rawDatabaseFailure(sqlState, "rate limit 429 fixture-value");
    const payload = agentRunFailurePayload(error);
    expect(payload).toMatchObject({ error: "OpenGeni encountered a database error.", sqlState });
    expect(payload.retryable).not.toBe(true);
    expect(payload.code).not.toBe("provider_rate_limited");
    expect(JSON.stringify(payload)).not.toContain("fixture-value");
    expect(JSON.stringify(payload)).not.toContain("INSERT INTO");
  }
});
