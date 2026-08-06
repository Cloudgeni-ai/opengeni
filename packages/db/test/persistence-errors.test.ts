import { describe, expect, test } from "bun:test";
import {
  isDatabasePersistenceFailure,
  nestedPostgresSqlState,
  runIdempotentPersistenceTransaction,
  safeDatabaseErrorFacts,
  SessionEventPersistenceError,
} from "../src";

const syntheticValue = ["synthetic", "db", "value", "123456"].join("-");

function databaseError(overrides: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Failed query containing ${syntheticValue}`), {
    query: "insert into session_events values ($1)",
    params: [syntheticValue],
    driverError: {
      table_name: "session_events",
      detail: syntheticValue,
    },
    ...overrides,
  });
}

describe("session event persistence failure truth", () => {
  test("recognizes only database-shaped failures without SQLSTATE", () => {
    expect(
      isDatabasePersistenceFailure({
        query: "insert into session_events values ($1)",
        params: [syntheticValue],
      }),
    ).toBe(true);
    expect(isDatabasePersistenceFailure({ driverError: { name: "PostgresError" } })).toBe(true);
    expect(isDatabasePersistenceFailure({ cause: { table_name: "session_events" } })).toBe(true);
    expect(isDatabasePersistenceFailure(new Error("expected domain conflict"))).toBe(false);
  });

  test("finds nested SQLSTATE and derives value-free classification facts", () => {
    const error = databaseError({
      cause: {
        code: "40P01",
        severity: "ERROR",
        table_name: "session_events",
        constraint_name: "session_events_workspace_session_sequence_idx",
        detail: syntheticValue,
      },
    });
    expect(nestedPostgresSqlState(error)).toBe("40P01");
    const facts = safeDatabaseErrorFacts(error);
    expect(facts).toEqual({
      severity: "ERROR",
      table: "session_events",
      constraint: "session_events_workspace_session_sequence_idx",
    });
    expect(JSON.stringify(facts)).not.toContain(syntheticValue);
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

  test("exhaustion retains the exact final driver failure and one correlation id", async () => {
    const source = databaseError({
      cause: { code: "40P01", table: "session_events", detail: syntheticValue },
    });
    const error = await runIdempotentPersistenceTransaction(
      {
        stage: "session_events.append_for_turn_attempt",
        eventTypes: ["agent.model.usage"],
        maxAttempts: 2,
        correlationId: "stable-correlation",
      },
      async () => {
        throw source;
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
    expect((error as SessionEventPersistenceError).cause).toBe(source);
    expect((error as Error).message).toContain(source.message);
    expect((error as Error).message).toContain(syntheticValue);
    expect(nestedPostgresSqlState(error)).toBe("40P01");
  });

  test("non-SQLSTATE failures retain exact query, parameters, and nested detail", async () => {
    let attempts = 0;
    let retries = 0;
    const source = databaseError();
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
        throw source;
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
    expect((error as SessionEventPersistenceError).cause).toBe(source);
    expect((error as Error).message).toContain(syntheticValue);
    expect((source as Error & { query: string }).query).toBe(
      "insert into session_events values ($1)",
    );
    expect((source as Error & { params: string[] }).params).toEqual([syntheticValue]);
    expect((source as Error & { driverError: { detail: string } }).driverError.detail).toBe(
      syntheticValue,
    );
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
  });

  test("terminal database SQLSTATE retains the exact original failure without retrying", async () => {
    let attempts = 0;
    let retries = 0;
    const source = databaseError({
      cause: {
        code: "23505",
        severity: "ERROR",
        table_name: "session_command_receipts",
        constraint_name: "session_command_receipts_operation_uq",
        detail: syntheticValue,
      },
    });
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
        throw source;
      },
    ).catch((error) => error);

    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(caught).toBeInstanceOf(SessionEventPersistenceError);
    expect((caught as SessionEventPersistenceError).details).toMatchObject({
      code: "db_failure",
      sqlState: "23505",
      correlationId: "terminal-database-correlation",
      database: {
        severity: "ERROR",
        table: "session_command_receipts",
        constraint: "session_command_receipts_operation_uq",
      },
    });
    expect((caught as SessionEventPersistenceError).cause).toBe(source);
    expect((caught as Error).message).toContain(source.message);
    expect(nestedPostgresSqlState(caught)).toBe("23505");
  });
});
