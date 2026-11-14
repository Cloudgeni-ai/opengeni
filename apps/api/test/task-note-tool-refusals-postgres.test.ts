import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY,
  TASK_NOTE_ACTIVE_RECORD_CAP,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { withMcpClient } from "./helpers/first-party-tool-client";

// A refused task-note call reaches the agent as a typed, actionable error. It
// used to arrive as Drizzle's "Failed query: SELECT * FROM
// create_task_note_for_attempt(...) params: ..." with every ID and the whole
// note text, and the agent had to guess that the tree was full.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const TOOLS = [
  "task_notes_list",
  "task_note_save",
  "task_note_archive",
  "task_note_replace",
] as const satisfies readonly FirstPartyMcpToolName[];
const PERMISSIONS: Permission[] = ["sessions:read", "sessions:control"];

let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-task-note-tool-refusals");
  if (!shared && requireRealDatabase) {
    throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function settings() {
  return testSettings({
    productAccessMode: "managed",
    sandboxBackend: "none",
    allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
  });
}

function routeDeps(): ApiRouteDeps {
  return {
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {},
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function liveAgent() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "task-note-refusal-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Task note refusals",
    workspaceExternalSource: "task-note-refusal-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Task note refusals",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const root = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: "root",
    resources: [],
    tools: [],
    metadata: {},
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...TOOLS],
    createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: root.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: root.id,
    workflowId: `session-${root.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const grant = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    permissions: PERMISSIONS,
    principalKind: "agent_attempt" as const,
    metadata: {
      sessionId: root.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: [...TOOLS],
    },
  };
  return {
    owner,
    root,
    turnId: claimed.turn.id,
    attemptId,
    server: buildOpenGeniMcpServer(routeDeps(), grant),
  };
}

type ToolOutcome = {
  isError: boolean;
  text: string;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
  argumentRejection: boolean;
};

async function callTool(
  mcp: Client,
  name: (typeof TOOLS)[number],
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return {
    isError: result.isError === true,
    text,
    body: JSON.parse(text) as ToolOutcome["body"],
    argumentRejection: result._meta?.[FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY] === true,
  };
}

describe("task-note tools report refusals the agent can act on", () => {
  test("a full task tree, an unknown note, a reused operation ID and an archived note", async () => {
    if (!shared) return;
    const agent = await liveAgent();
    const ids = [agent.owner.accountId, agent.owner.workspaceId, agent.root.id, agent.turnId];
    const expectPlainRefusal = (outcome: ToolOutcome, code: string, privateText: string) => {
      expect(outcome.isError).toBe(true);
      expect(outcome.body.error?.code).toBe(code);
      for (const leak of [
        "Failed query",
        "SELECT",
        "_for_attempt",
        "params",
        privateText,
        ...ids,
      ]) {
        expect(outcome.text).not.toContain(leak);
      }
    };
    await withMcpClient(agent.server, async (mcp) => {
      const firstOperation = crypto.randomUUID();
      const first = await callTool(mcp, "task_note_save", {
        operationId: firstOperation,
        kind: "finding",
        text: "The first finding of this task tree.",
        expiresInDays: 1,
      });
      expect(first.isError, first.text).toBe(false);
      const firstNoteId = (first.body as { note: { id: string } }).note.id;

      // Fill the tree to its active-note limit.
      await shared!.admin.begin(async (sql) => {
        const capabilityId = crypto.randomUUID();
        await sql`select set_config('opengeni.account_id', ${agent.owner.accountId}, true),
          set_config('opengeni.workspace_id', ${agent.owner.workspaceId}, true)`;
        await sql`insert into task_note_write_capabilities
          (backend_pid, transaction_id, capability_id)
          values (pg_backend_pid(), pg_current_xact_id(), ${capabilityId})`;
        await sql`select set_config('opengeni.task_note_write_capability', ${capabilityId}, true)`;
        await sql`
          insert into task_notes (
            account_id, workspace_id, root_session_id, kind, text, text_hash,
            expires_at, create_operation_id, create_input_hash,
            created_by_actor_kind, created_by_actor_subject_id,
            created_by_initiating_human_subject_id, created_by_session_id,
            created_by_turn_id, created_by_attempt_id, created_by_execution_generation
          )
          select ${agent.owner.accountId}, ${agent.owner.workspaceId}, ${agent.root.id},
            'finding', 'seed-' || series::text,
            encode(sha256(convert_to('seed-' || series::text, 'UTF8')), 'hex'),
            now() + interval '1 day', gen_random_uuid(), repeat('a', 64),
            'human', ${agent.owner.subjectId}, ${agent.owner.subjectId}, ${agent.root.id},
            ${agent.turnId}, ${agent.attemptId}, 1
          from generate_series(1, ${TASK_NOTE_ACTIVE_RECORD_CAP - 1}) series
        `;
      });

      const fullText = "A finding that does not fit in a full tree.";
      const full = await callTool(mcp, "task_note_save", {
        operationId: crypto.randomUUID(),
        kind: "finding",
        text: fullText,
        expiresInDays: 1,
      });
      expectPlainRefusal(full, "task_note_active_limit_reached", fullText);
      expect(full.body.error?.message).toContain(
        `already has ${TASK_NOTE_ACTIVE_RECORD_CAP} active notes`,
      );
      expect(full.body.error?.message).toContain("task_note_archive");
      expect(full.argumentRejection).toBe(false);

      // Following the advice frees a slot.
      const archived = await callTool(mcp, "task_note_archive", {
        operationId: crypto.randomUUID(),
        noteId: firstNoteId,
        expectedVersion: 1,
        reason: "Done with this finding.",
      });
      expect(archived.isError, archived.text).toBe(false);
      const saved = await callTool(mcp, "task_note_save", {
        operationId: crypto.randomUUID(),
        kind: "finding",
        text: fullText,
        expiresInDays: 1,
      });
      expect(saved.isError, saved.text).toBe(false);

      const unknownReason = "Archiving a note that never existed.";
      const unknown = await callTool(mcp, "task_note_archive", {
        operationId: crypto.randomUUID(),
        noteId: crypto.randomUUID(),
        expectedVersion: 1,
        reason: unknownReason,
      });
      expectPlainRefusal(unknown, "task_note_not_found", unknownReason);
      expect(unknown.argumentRejection).toBe(true);

      const changedText = "Different text under a used operation ID.";
      const reused = await callTool(mcp, "task_note_save", {
        operationId: firstOperation,
        kind: "finding",
        text: changedText,
        expiresInDays: 1,
      });
      expectPlainRefusal(reused, "task_note_operation_id_conflict", changedText);
      expect(reused.argumentRejection).toBe(true);

      const againReason = "Archive the same finding twice.";
      const again = await callTool(mcp, "task_note_archive", {
        operationId: crypto.randomUUID(),
        noteId: firstNoteId,
        expectedVersion: 1,
        reason: againReason,
      });
      expectPlainRefusal(again, "task_note_not_active", againReason);
    });
  });
});
