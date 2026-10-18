import { expect, test } from "bun:test";
import { SessionEventPersistenceError } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { reportSessionPersistenceFailure } from "../src/activities/agent-turn/persistence-diagnostic";

test.each([false, true])(
  "claim logs identify the rejected statement when diagnostic export fails: %s",
  (exportFails) => {
    const secret = "PRIVATE_SQL_PARAMETER";
    const driver = Object.assign(new Error(secret), {
      name: "PostgresError",
      code: "42501",
      where: `PL/pgSQL function admit_session_attempt_personal_machine() line 62 at RAISE\nSQL statement ${secret}`,
    });
    const query = Object.assign(new Error(secret, { cause: driver }), {
      query: 'insert into "session_turn_attempts" ("id") values ($1)',
      params: [secret],
    });
    const error = new SessionEventPersistenceError(
      {
        code: "db_failure",
        sqlState: "42501",
        stage: "session_attempts.claim",
        correlationId: crypto.randomUUID(),
        attempts: 1,
        retryOutcome: "not_retryable",
        eventTypes: ["session.turn.attempt_claimed"],
        database: {},
      },
      query,
    );
    const logs: string[] = [];
    const obs = createObservability(
      {
        serviceName: "test",
        environment: "test",
        observabilityMetricsEnabled: false,
        observabilityStructuredLogs: true,
      },
      { component: "worker" },
    );
    const original = console.error;
    console.error = (message) => {
      logs.push(String(message));
    };
    try {
      reportSessionPersistenceFailure(
        {
          recordFailureDiagnostic: (input) => {
            if (exportFails) throw new Error(secret);
            return obs.recordFailureDiagnostic(input);
          },
          error: (message, attributes) => obs.error(message, attributes),
        },
        error,
        { sessionId: crypto.randomUUID(), attemptId: crypto.randomUUID() },
      );
    } finally {
      console.error = original;
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("stage=session_attempts.claim sqlState=42501");
    expect(logs[0]).toContain("statement=insert:session_turn_attempts");
    expect(logs[0]).toContain("admit_session_attempt_personal_machine:62");
    expect(logs[0]).toContain(error.details.correlationId);
    expect(logs[0]).not.toContain(secret);
  },
);
