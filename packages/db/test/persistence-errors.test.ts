import { describe, expect, test } from "bun:test";
import {
  nestedPostgresSqlState,
  runIdempotentPersistenceTransaction,
  safeDatabaseErrorFacts,
  SessionEventPersistenceError,
} from "../src";

describe("session event persistence failure truth", () => {
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
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    const observable = JSON.stringify({
      message: (error as Error).message,
      stack: (error as Error).stack,
      details: (error as SessionEventPersistenceError).details,
      cause: (error as Error & { cause?: unknown }).cause,
    });
    expect(observable).not.toContain("private-token");
    expect(observable).not.toContain("insert into");
    expect(observable).not.toContain("values ($1)");
  });
});
