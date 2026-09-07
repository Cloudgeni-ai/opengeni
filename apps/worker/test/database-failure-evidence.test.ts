import { expect, test } from "bun:test";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";

test("unwrapped database failures retain SQLSTATE and identifiers without expanding nested content", () => {
  const driver = Object.assign(
    new Error("connection detail postgresql://user:private@db/runtime"),
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
  const outer = Object.assign(new Error("Original query error remains exact", { cause: driver }), {
    code: "E1234",
    query: "SELECT * FROM company_brain_context_get_or_create_selection($1)",
    params: ["private parameter"],
  });
  expect(agentRunFailurePayload(outer)).toEqual({
    error: outer.message,
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
    cause: Object.assign(new Error("postgresql://user:private@db/runtime"), {
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
    error: driver.message,
    sqlState: "E1234",
    database: { severity: "ERROR", routine: "exec_stmt_raise" },
  });
});
