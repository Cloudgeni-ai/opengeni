import { describe, expect, test } from "bun:test";
import {
  isDatabasePersistenceFailure,
  nestedPostgresSqlState,
  runIdempotentPersistenceTransaction,
  safeDatabaseErrorFacts,
  SanitizedDatabasePersistenceCause,
  SessionEventPersistenceError,
} from "../src";

describe("session event persistence failure truth", () => {
  test("recognizes only database-shaped failures without SQLSTATE", () => {
    expect(
      isDatabasePersistenceFailure({
        query: "insert into session_events values ($1)",
        params: ["private-token"],
      }),
    ).toBe(true);
    expect(isDatabasePersistenceFailure({ driverError: { name: "PostgresError" } })).toBe(true);
    expect(isDatabasePersistenceFailure({ cause: { table_name: "session_events" } })).toBe(true);
    expect(isDatabasePersistenceFailure(new Error("expected domain conflict"))).toBe(false);
  });

  test("finds nested SQLSTATE and retains only allowlisted catalog facts", () => {
    const error = Object.assign(new Error("Failed query: insert into session_events"), {
      query: "insert into session_events values ($1)",
      params: ["private-token"],
      cause: {
        code: "40P01",
        severity: "ERROR",
        table_name: "session_events",
        constraint_name: "session_events_workspace_session_sequence_idx",
        detail: "raw row includes private-token",
      },
    });
    expect(nestedPostgresSqlState(error)).toBe("40P01");
    const facts = safeDatabaseErrorFacts(error);
    expect(facts).toEqual({
      severity: "ERROR",
      table: "session_events",
      constraint: "session_events_workspace_session_sequence_idx",
    });
    expect(JSON.stringify(facts)).not.toContain("private-token");
    expect(JSON.stringify(facts)).not.toContain("insert into");
  });

  test("retries only the persistence closure with stable correlation", async () => {
    let providerCalls = 0;
    let persistenceAttempts = 0;
    const providerResult = await (async () => {
      providerCalls += 1;
      return { responseId: "response-once" };
    })();
    const persisted = await runIdempotentPersistenceTransaction(
      {
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.model.usage"],
        correlationId: "stable-correlation",
      },
      async () => {
        persistenceAttempts += 1;
        if (persistenceAttempts < 3) {
          throw {
            cause: { code: persistenceAttempts === 1 ? "40P01" : "40001" },
          };
        }
        return providerResult.responseId;
      },
    );
    expect(persisted).toBe("response-once");
    expect(providerCalls).toBe(1);
    expect(persistenceAttempts).toBe(3);
  });

  test("exhaustion is sanitized and keeps one correlation id", async () => {
    const error = await runIdempotentPersistenceTransaction(
      {
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.model.usage"],
        maxAttempts: 2,
        correlationId: "stable-correlation",
      },
      async () => {
        throw {
          message: "Failed query: insert into session_events",
          params: ["private-token"],
          cause: { code: "40P01", table: "session_events" },
        };
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toMatchObject({
      code: "db_deadlock",
      sqlState: "40P01",
      attempts: 2,
      retryOutcome: "exhausted",
      correlationId: "stable-correlation",
      database: { table: "session_events" },
    });
    expect((error as SessionEventPersistenceError).cause).toBeInstanceOf(
      SanitizedDatabasePersistenceCause,
    );
    expect((error as SessionEventPersistenceError).cause).toMatchObject({
      sqlState: "40P01",
      database: { table: "session_events" },
    });
    expect(nestedPostgresSqlState(error)).toBe("40P01");
    expect(JSON.stringify((error as SessionEventPersistenceError).details)).not.toContain(
      "private-token",
    );
  });

  test("sanitizes failures without SQLSTATE and never retries them", async () => {
    let attempts = 0;
    let retries = 0;
    const error = await runIdempotentPersistenceTransaction(
      {
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.model.usage"],
        correlationId: "unknown-state-correlation",
        onRetry: () => {
          retries += 1;
        },
      },
      async () => {
        attempts += 1;
        throw Object.assign(new Error("Failed query: insert into session_events (private-token)"), {
          query: "insert into session_events values ($1)",
          params: ["private-token"],
          cause: {
            table_name: "session_events",
            detail: "bound parameter private-token",
          },
        });
      },
    ).catch((caught) => caught);

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toEqual({
      code: "db_failure",
      sqlState: null,
      stage: "session_events.append_for_turn_attempt",
      eventTypes: ["agent.model.usage"],
      correlationId: "unknown-state-correlation",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: { table: "session_events" },
    });
    expect((error as SessionEventPersistenceError).cause).toMatchObject({
      name: "SanitizedDatabasePersistenceCause",
      sqlState: null,
      database: { table: "session_events" },
    });
    const observable = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      details: (error as SessionEventPersistenceError).details,
      cause: (error as SessionEventPersistenceError).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
    expect(observable).not.toContain("values ($1)");
  });

  test("rethrows a domain error unchanged and never retries it", async () => {
    class ExpectedDomainError extends Error {
      readonly code = "EXPECTED_DOMAIN_CONFLICT";
    }

    const original = new ExpectedDomainError("preserve this domain error");
    let attempts = 0;
    let retries = 0;
    const caught = await runIdempotentPersistenceTransaction(
      {
        stage: "session_commands.agent_message",
        eventTypes: ["system.update.pending"],
        onRetry: () => {
          retries += 1;
        },
      },
      async () => {
        attempts += 1;
        throw original;
      },
    ).catch((error) => error);

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(ExpectedDomainError);
    expect(caught).toMatchObject({
      code: "EXPECTED_DOMAIN_CONFLICT",
      message: "preserve this domain error",
    });
  });

  test("sanitizes a terminal database SQLSTATE without retrying it", async () => {
    let attempts = 0;
    let retries = 0;
    const caught = await runIdempotentPersistenceTransaction(
      {
        stage: "session_commands.agent_message",
        eventTypes: ["system.update.pending"],
        correlationId: "terminal-database-correlation",
        onRetry: () => {
          retries += 1;
        },
      },
      async () => {
        attempts += 1;
        throw Object.assign(new Error("private duplicate value"), {
          query: "insert into session_command_receipts values ($1)",
          params: ["private-token"],
          cause: {
            code: "23505",
            severity: "ERROR",
            table_name: "session_command_receipts",
            constraint_name: "session_command_receipts_operation_uq",
          },
        });
      },
    ).catch((error) => error);

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(caught).toBeInstanceOf(SessionEventPersistenceError);
    expect((caught as SessionEventPersistenceError).details).toEqual({
      code: "db_failure",
      sqlState: "23505",
      stage: "session_commands.agent_message",
      eventTypes: ["system.update.pending"],
      correlationId: "terminal-database-correlation",
      attempts: 1,
      retryOutcome: "not_retryable",
      database: {
        severity: "ERROR",
        table: "session_command_receipts",
        constraint: "session_command_receipts_operation_uq",
      },
    });
    expect((caught as SessionEventPersistenceError).cause).toMatchObject({
      name: "SanitizedDatabasePersistenceCause",
      sqlState: "23505",
      database: {
        severity: "ERROR",
        table: "session_command_receipts",
        constraint: "session_command_receipts_operation_uq",
      },
    });
    expect(nestedPostgresSqlState(caught)).toBe("23505");
    const observable = JSON.stringify({
      message: (caught as Error).message,
      stack: (caught as Error).stack,
      details: (caught as SessionEventPersistenceError).details,
      cause: (caught as SessionEventPersistenceError).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
  });
});
