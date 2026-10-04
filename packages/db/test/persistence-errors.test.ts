import { describe, expect, test } from "bun:test";
import {
  databaseReconnectBackoffSeconds,
  DatabaseUnavailableError,
  isDatabaseConnectionLoss,
  isDatabasePersistenceFailure,
  isRetryableDatabaseTransportFailure,
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
  test("recognizes raw postgres transport failures without message heuristics", () => {
    for (const code of [
      "CONNECTION_CLOSED",
      "CONNECTION_DESTROYED",
      "CONNECTION_ENDED",
      "CONNECT_TIMEOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ]) {
      const error = Object.assign(new Error("sanitized transport failure"), { code });
      expect(isRetryableDatabaseTransportFailure(error)).toBe(true);
      expect(isDatabasePersistenceFailure(error)).toBe(true);
    }

    expect(
      isRetryableDatabaseTransportFailure({
        cause: { driverError: { errno: "enetunreach" } },
      }),
    ).toBe(true);
    expect(isRetryableDatabaseTransportFailure({ code: "23505" })).toBe(false);
    expect(isRetryableDatabaseTransportFailure(new Error("CONNECTION_CLOSED"))).toBe(false);
    expect(nestedPostgresSqlState({ code: "EPIPE" })).toBeNull();
  });

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

  test("exhaustion retains exact internal cause but exposes one sanitized correlation", async () => {
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
    expect((error as Error).message).toBe("Database deadlock while persisting agent.model.usage");
    expect((error as Error).message).not.toContain(source.message);
    expect((error as Error).message).not.toContain(syntheticValue);
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain(syntheticValue);
    expect(JSON.stringify(error)).not.toContain("insert into");
    expect(nestedPostgresSqlState(error)).toBe("40P01");
  });

  test("non-SQLSTATE failures retain exact detail only on the internal cause", async () => {
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
    expect((error as Error).message).toBe("Database failure while persisting agent.model.usage");
    expect((error as Error).message).not.toContain(syntheticValue);
    expect((source as Error & { query: string }).query).toBe(
      "insert into session_events values ($1)",
    );
    expect((source as Error & { params: string[] }).params).toEqual([syntheticValue]);
    expect((source as Error & { driverError: { detail: string } }).driverError.detail).toBe(
      syntheticValue,
    );
  });

  test("raw transport loss is wrapped as database truth without immediate replay", async () => {
    let attempts = 0;
    const source = Object.assign(new Error("socket closed"), {
      code: "CONNECTION_CLOSED",
      errno: "CONNECTION_CLOSED",
    });
    const error = await runIdempotentPersistenceTransaction(
      {
        stage: "session_attempts.claim",
        eventTypes: ["session.turn.attempt_claimed"],
        correlationId: "raw-transport-correlation",
      },
      async () => {
        attempts += 1;
        throw source;
      },
    ).catch((caught) => caught);

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(SessionEventPersistenceError);
    expect((error as SessionEventPersistenceError).details).toMatchObject({
      code: "db_failure",
      sqlState: null,
      attempts: 1,
      retryOutcome: "not_retryable",
      correlationId: "raw-transport-correlation",
    });
    expect((error as SessionEventPersistenceError).cause).toBe(source);
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
    expect((caught as Error).message).toBe(
      "Database failure while persisting system.update.pending",
    );
    expect((caught as Error).message).not.toContain(source.message);
    expect((caught as Error).message).not.toContain(syntheticValue);
    expect(nestedPostgresSqlState(caught)).toBe("23505");
  });
});

describe("database connection loss", () => {
  test("recognizes server-ended sessions, transport codes, and node-postgres socket loss", () => {
    const adminShutdown = Object.assign(
      new Error("terminating connection due to administrator command"),
      {
        name: "PostgresError",
        code: "57P01",
        severity: "FATAL",
      },
    );
    const wrapped = Object.assign(new Error("Failed query: select 1"), {
      name: "DrizzleQueryError",
      query: "select 1",
      params: [],
      cause: adminShutdown,
    });
    for (const failure of [
      adminShutdown,
      wrapped,
      // postgres.js connection error shape.
      Object.assign(new Error("write CONNECTION_CLOSED 10.0.0.4:5432"), {
        code: "CONNECTION_CLOSED",
        errno: "CONNECTION_CLOSED",
        address: ["10.0.0.4"],
        port: [5432],
      }),
      // A socket failure postgres.js stamped with the failed query.
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", query: "select 1" }),
      Object.assign(new Error("Failed query: select 1"), {
        query: "select 1",
        params: [],
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
      Object.assign(new Error("the database system is starting up"), { code: "57P03" }),
      Object.assign(new Error("server closed the connection"), { code: "08006" }),
      new Error("Connection terminated unexpectedly"),
      new DatabaseUnavailableError("managed auth session store unavailable", {
        cause: new Error("Failed to get session"),
      }),
      new Error("outer", { cause: new Error("Connection terminated unexpectedly") }),
    ]) {
      expect(isDatabaseConnectionLoss(failure)).toBe(true);
    }
  });

  test("does not treat a rejected statement or an ordinary failure as connection loss", () => {
    for (const failure of [
      Object.assign(new Error("duplicate key"), { name: "PostgresError", code: "23505" }),
      Object.assign(new Error("syntax error"), { name: "PostgresError", code: "42601" }),
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      new Error("Connection terminated unexpectedly while parsing"),
      // The same transport codes from another service are not database loss.
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" }),
      Object.assign(new Error("closed"), { name: "NatsError", code: "CONNECTION_CLOSED" }),
      Object.assign(new Error("browser control failed"), {
        cause: Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        }),
      }),
      new Error("Failed to get session"),
      null,
      "Connection terminated unexpectedly",
    ]) {
      expect(isDatabaseConnectionLoss(failure)).toBe(false);
    }
  });
});

describe("database reconnect backoff", () => {
  test("keeps the driver's jittered growth but never waits more than 2 s", () => {
    expect(databaseReconnectBackoffSeconds(0)).toBeLessThanOrEqual(0.01);
    for (let retries = 0; retries < 40; retries += 1) {
      const delay = databaseReconnectBackoffSeconds(retries);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2);
    }
    expect(databaseReconnectBackoffSeconds(30)).toBeGreaterThanOrEqual(1);
  });
});
