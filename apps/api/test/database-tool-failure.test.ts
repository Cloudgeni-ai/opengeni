import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY, type AccessGrant } from "@opengeni/contracts";
import {
  classifyTaskNoteFailure,
  TaskNoteRefusedError,
  type TaskNoteOperation,
  type TaskNoteRefusalReason,
} from "@opengeni/db";
import { DrizzleQueryError } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";

import { taskNoteRefusalResult } from "../src/mcp/database-tool-failure";
import { PolicyMcpServer } from "../src/mcp/server";

const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:test",
  principalKind: "human_session",
  permissions: ["files:read", "files:upload"],
};

// What a caller must never see: the routine's SQL, its parameters (IDs and the
// caller's own note text) and the driver's message.
const NOTE_TEXT = "private note text the model wrote";
const SESSION_ID = crypto.randomUUID();
const LEAKS = [
  "Failed query",
  "SELECT",
  "create_task_note_for_attempt",
  "params",
  SESSION_ID,
  NOTE_TEXT,
];

function postgresError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "PostgresError", code, severity: "ERROR" });
}

function failedQuery(code: string, message: string) {
  return new DrizzleQueryError(
    "SELECT * FROM create_task_note_for_attempt($1::uuid, $2::text)",
    [SESSION_ID, NOTE_TEXT],
    postgresError(code, message),
  );
}

function expectNoLeak(text: string) {
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

const failures: Record<string, () => unknown> = {
  refused: () => failedQuery("54000", "task note active-record limit reached"),
  // Another error that copied Drizzle's message into its own.
  copied: () => new Error(`Could not save: ${failedQuery("23514", "check").message}`),
  driver: () => postgresError("23514", `new row violates check for ${NOTE_TEXT}`),
  lost: () => failedQuery("57P01", "terminating connection due to administrator command"),
  deadlock: () => failedQuery("40P01", "deadlock detected"),
  readOnly: () =>
    new DrizzleQueryError("UPDATE sessions SET x = $1", [NOTE_TEXT], {
      ...postgresError("OG002", "SESSION_ARCHIVED_READ_ONLY"),
      message: "SESSION_ARCHIVED_READ_ONLY",
    }),
  // Errors whose own message is safe keep it, also with a database cause.
  wrapped: () => new Error("The sandbox is not available", { cause: failedQuery("23514", "x") }),
  http: () => new HTTPException(409, { message: "sandbox not available" }),
  plain: () => new Error("database connection lost"),
};

async function connect(server: McpServer) {
  server.registerTool(
    "sandbox_file_publish",
    {
      description: "Publish one file.",
      inputSchema: { path: z4.string().min(1).describe("The file.") },
    },
    async ({ path }) => {
      throw failures[path]!();
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "database-tool-failure", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("first-party tools never echo a raw database error", () => {
  test("a failed query becomes a typed result without SQL, parameters or driver text", async () => {
    const policy = await connect(new PolicyMcpServer(grant, crypto.randomUUID(), null));
    const expected: Record<string, { code: string; retryable: boolean; sqlState?: string }> = {
      refused: { code: "sandbox_file_publish_failed", retryable: false, sqlState: "54000" },
      copied: { code: "sandbox_file_publish_failed", retryable: false, sqlState: undefined },
      driver: { code: "sandbox_file_publish_failed", retryable: false, sqlState: "23514" },
      lost: {
        code: "sandbox_file_publish_temporarily_unavailable",
        retryable: true,
        sqlState: "57P01",
      },
      deadlock: {
        code: "sandbox_file_publish_temporarily_unavailable",
        retryable: true,
        sqlState: "40P01",
      },
      readOnly: { code: "sandbox_file_publish_session_read_only", retryable: false },
    };
    for (const [path, want] of Object.entries(expected)) {
      const result = await policy.callTool({ name: "sandbox_file_publish", arguments: { path } });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expectNoLeak(text);
      const { error } = JSON.parse(text) as {
        error: { code: string; message: string; retryable: boolean; sqlState?: string };
      };
      expect(error.code).toBe(want.code);
      expect(error.retryable).toBe(want.retryable);
      expect(error.sqlState).toBe(want.sqlState);
      expect(error.message.length).toBeGreaterThan(20);
      expect(result.structuredContent).toEqual({ error });
    }
  });

  test("errors with their own safe message are returned exactly as the SDK would", async () => {
    const policy = await connect(new PolicyMcpServer(grant, crypto.randomUUID(), null));
    const plain = await connect(new McpServer({ name: "plain", version: "1" }));
    for (const path of ["wrapped", "http", "plain"]) {
      const call = { name: "sandbox_file_publish", arguments: { path } };
      const { _meta: _ignored, ...visible } = await policy.callTool(call);
      expect(visible).toEqual(await plain.callTool(call));
    }
  });

  test("the unguarded SDK would have echoed the query and the note text", async () => {
    // The defect this guards against, shown on a plain MCP server.
    const plain = await connect(new McpServer({ name: "plain", version: "1" }));
    const text = textOf(
      await plain.callTool({ name: "sandbox_file_publish", arguments: { path: "refused" } }),
    );
    expect(text).toContain("Failed query");
    expect(text).toContain(NOTE_TEXT);
  });
});

describe("task-note refusals", () => {
  const raised: Array<{
    operation: TaskNoteOperation;
    sqlState: string;
    message: string;
    reason: TaskNoteRefusalReason;
  }> = [
    {
      operation: "save",
      sqlState: "54000",
      message: "task note active-record limit reached",
      reason: "active_note_limit",
    },
    {
      operation: "save",
      sqlState: "22023",
      message: "task note input is invalid",
      reason: "invalid_input",
    },
    {
      operation: "archive",
      sqlState: "22023",
      message: "task note archive input is invalid",
      reason: "invalid_input",
    },
    {
      operation: "list",
      sqlState: "22023",
      message: "task note list input is invalid",
      reason: "invalid_input",
    },
    {
      operation: "replace",
      sqlState: "22023",
      message: "Task-note replacement input is invalid",
      reason: "invalid_input",
    },
    {
      operation: "save",
      sqlState: "23505",
      message: "task note operation conflicts with another input or attempt",
      reason: "operation_conflict",
    },
    {
      operation: "archive",
      sqlState: "23505",
      message: "task note archive operation conflicts with another input or attempt",
      reason: "operation_conflict",
    },
    {
      operation: "replace",
      sqlState: "23505",
      message: "Task-note replacement operation conflicts with another input or attempt",
      reason: "operation_conflict",
    },
    {
      operation: "archive",
      sqlState: "P0002",
      message: "task note is unavailable",
      reason: "note_not_found",
    },
    {
      operation: "replace",
      sqlState: "P0002",
      message: "Task note is unavailable for replacement",
      reason: "note_not_found",
    },
    {
      operation: "archive",
      sqlState: "40001",
      message: "task note archive version conflict",
      reason: "note_not_active",
    },
    {
      operation: "replace",
      sqlState: "40001",
      message: "Task-note replacement version or lifecycle conflict",
      reason: "note_not_active",
    },
    {
      operation: "save",
      sqlState: "42501",
      message: "task notes require the exact current attempt",
      reason: "attempt_not_authorized",
    },
    {
      operation: "list",
      sqlState: "42501",
      message: "task note session tree is not visible to this actor",
      reason: "attempt_not_authorized",
    },
    // Driver failures the routines did not raise themselves.
    {
      operation: "save",
      sqlState: "40001",
      message: "could not serialize access due to concurrent update",
      reason: "transient",
    },
    { operation: "archive", sqlState: "40P01", message: "deadlock detected", reason: "transient" },
    {
      operation: "replace",
      sqlState: "55P03",
      message: "could not obtain lock on row",
      reason: "transient",
    },
    {
      operation: "save",
      sqlState: "23505",
      message: 'duplicate key value violates unique constraint "task_note_events_operation_key"',
      reason: "transient",
    },
    {
      operation: "list",
      sqlState: "57P01",
      message: "terminating connection due to administrator command",
      reason: "transient",
    },
  ];

  test("every SQLSTATE the routines raise is classified, keeping only a fixed message", () => {
    for (const { operation, sqlState, message, reason } of raised) {
      const refusal = classifyTaskNoteFailure(operation, failedQuery(sqlState, message));
      expect(refusal, `${sqlState} ${message}`).toBeInstanceOf(TaskNoteRefusedError);
      expect(refusal!.reason).toBe(reason);
      expect(refusal!.operation).toBe(operation);
      expect(refusal!.sqlState).toBe(sqlState);
      expectNoLeak(refusal!.message);
    }
  });

  test("a socket lost before PostgreSQL answered is transient", () => {
    const socket = Object.assign(new Error("write ECONNRESET 10.0.0.1:5432"), {
      code: "ECONNRESET",
      errno: "ECONNRESET",
      address: "10.0.0.1",
    });
    const lost = new DrizzleQueryError("SELECT 1", [NOTE_TEXT], socket);
    expect(classifyTaskNoteFailure("save", lost)?.reason).toBe("transient");
  });

  test("unknown failures keep their original error", () => {
    expect(
      classifyTaskNoteFailure(
        "save",
        failedQuery("23514", "task note create projection is invalid"),
      ),
    ).toBeNull();
    expect(
      classifyTaskNoteFailure("save", failedQuery("P0002", "query returned no rows")),
    ).toBeNull();
    expect(classifyTaskNoteFailure("save", new Error("boom"))).toBeNull();
  });

  const expectations: Record<
    TaskNoteRefusalReason,
    { code: string; argumentRejection: boolean; retryable: boolean; mentions: string[] }
  > = {
    active_note_limit: {
      code: "task_note_active_limit_reached",
      argumentRejection: false,
      retryable: false,
      mentions: ["500 active notes", "task_note_archive", "task_notes_list"],
    },
    invalid_input: {
      code: "task_note_invalid_input",
      argumentRejection: true,
      retryable: false,
      mentions: ["must be"],
    },
    operation_conflict: {
      code: "task_note_operation_id_conflict",
      argumentRejection: true,
      retryable: false,
      mentions: ["fresh operationId"],
    },
    note_not_found: {
      code: "task_note_not_found",
      argumentRejection: true,
      retryable: false,
      mentions: ["task_notes_list"],
    },
    note_not_active: {
      code: "task_note_not_active",
      argumentRejection: false,
      retryable: false,
      mentions: ["no longer active", "includeArchived"],
    },
    attempt_not_authorized: {
      code: "task_note_not_authorized",
      argumentRejection: false,
      retryable: false,
      mentions: ["current turn and attempt"],
    },
    transient: {
      code: "task_note_temporarily_unavailable",
      argumentRejection: false,
      retryable: true,
      mentions: ["Retry"],
    },
  };

  test("each refusal tells the agent what happened and what to do, and nothing else", () => {
    for (const { operation, sqlState, message, reason } of raised) {
      const refusal = classifyTaskNoteFailure(operation, failedQuery(sqlState, message))!;
      const result = taskNoteRefusalResult(refusal);
      const want = expectations[reason];
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expectNoLeak(text);
      // The routines' own wording stays internal too.
      expect(text).not.toContain(message);
      const { error } = JSON.parse(text) as {
        error: { code: string; message: string; retryable: boolean };
      };
      expect(error.code).toBe(want.code);
      expect(error.retryable).toBe(want.retryable);
      for (const mention of want.mentions) expect(error.message).toContain(mention);
      const meta = (result as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.[FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY] === true).toBe(
        want.argumentRejection,
      );
    }
  });

  test("a refused save at the active-note limit reads as one plain instruction", () => {
    const refusal = classifyTaskNoteFailure(
      "save",
      failedQuery("54000", "task note active-record limit reached"),
    )!;
    expect(JSON.parse(taskNoteRefusalResult(refusal).content[0].text)).toEqual({
      error: {
        code: "task_note_active_limit_reached",
        message:
          "Not saved: this task tree already has 500 active notes, the most it can hold. Archive notes that are done with task_note_archive (task_notes_list shows them), then save again. Expired notes stop counting on their own.",
        retryable: false,
      },
    });
  });
});
