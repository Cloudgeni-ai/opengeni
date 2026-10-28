import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { appendSessionEvents, createDb, getSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// A chat frozen on Codex remote compaction can't take another model. The
// continuation route is its way out: a new chat on the chosen model, seeded
// with the earlier conversation and linked back to it, while the earlier chat
// keeps its lock.

const DELEGATION_SECRET = "session-continuation-test-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(): Promise<Workspace> {
  const name = `continuation ${crypto.randomUUID()}`;
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function app() {
  const noop = async () => undefined;
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    sandboxBackend: "none",
    openaiAllowedModels: "scripted-model,gpt-6-luna",
  });
  return createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "session-continuation-test-state",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => {
      throw new Error("document services are not used by continuation tests");
    },
  } as unknown as ApiRouteDeps);
}

async function bearer(workspace: Workspace, subjectId: string, permissions: Permission[]) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    subjectLabel: subjectId,
    permissions,
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-continuation");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Session continuation tests require real PostgreSQL");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("continue a Codex-locked chat in a new chat", () => {
  test("the new chat runs the chosen model with the earlier conversation; the earlier chat stays locked", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const api = app();
    const auth = await bearer(workspace, "continuation-owner", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);
    const headers = { "content-type": "application/json", authorization: auth };
    const base = `/v1/workspaces/${workspace.workspaceId}/sessions`;

    const created = await api.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        initialMessage: "Plan the database migration for the billing tables",
        model: "scripted-model",
        title: "Billing migration",
      }),
    });
    expect(created.status).toBe(202);
    const source = (await created.json()) as { id: string };
    await appendSessionEvents(client.db, workspace.workspaceId, source.id, [
      {
        type: "agent.message.completed",
        payload: {
          text: "Step one: add the ledger_v2 table behind a flag.",
          phase: "final_answer",
        },
      },
    ]);
    // Freeze the chat the way a Codex chat on remote compaction is frozen.
    await shared!.admin`
      update sessions set model = 'codex/gpt-6-astra', codex_compaction_mode = 'remote_v2'
      where id = ${source.id}`;

    const locked = await api.request(`${base}/${source.id}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "user.message",
        clientEventId: `send-${crypto.randomUUID()}`,
        payload: { text: "keep going", model: "gpt-6-luna" },
      }),
    });
    expect(locked.status).toBe(422);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe(
      "codex_compaction_v2_provider_locked",
    );

    const idempotencyKey = `continue-${crypto.randomUUID()}`;
    const continueRequest = () =>
      api.request(`${base}/${source.id}/continuations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey, model: "gpt-6-luna" }),
      });
    const continued = await continueRequest();
    expect(continued.status).toBe(202);
    const next = (await continued.json()) as {
      id: string;
      model: string;
      codexCompactionMode: string | null;
      metadata: Record<string, unknown>;
    };
    expect(next.id).not.toBe(source.id);
    expect(next.model).toBe("gpt-6-luna");
    expect(next.codexCompactionMode).not.toBe("remote_v2");
    expect(next.metadata.continuedFromSessionId).toBe(source.id);

    // Retrying the same request returns the same new chat.
    const retried = await continueRequest();
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as { id: string }).id).toBe(next.id);

    const [message] = await shared!.admin<{ payload: Record<string, unknown> }[]>`
      select payload from session_events
      where session_id = ${next.id} and type = 'user.message'
      order by sequence limit 1`;
    expect(String(message!.payload.text)).toContain(`(session:${source.id})`);
    const context = String(message!.payload.modelContext);
    expect(context).toContain("Plan the database migration for the billing tables");
    expect(context).toContain("Step one: add the ledger_v2 table behind a flag.");
    expect(context).toContain(source.id);

    const after = await getSession(client.db, workspace.workspaceId, source.id);
    expect(after?.codexCompactionMode).toBe("remote_v2");
    expect(after?.model).toBe("codex/gpt-6-astra");
  }, 60_000);

  test("an unknown chat is not found and a bad request is refused", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const api = app();
    const auth = await bearer(workspace, "continuation-owner", [
      "workspace:read",
      "sessions:create",
      "sessions:read",
    ]);
    const headers = { "content-type": "application/json", authorization: auth };
    const base = `/v1/workspaces/${workspace.workspaceId}/sessions`;
    const missing = await api.request(`${base}/${crypto.randomUUID()}/continuations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "missing", model: "gpt-6-luna" }),
    });
    expect(missing.status).toBe(404);
    const created = await api.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ initialMessage: "hello", model: "scripted-model" }),
    });
    const source = (await created.json()) as { id: string };
    const invalid = await api.request(`${base}/${source.id}/continuations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-6-luna" }),
    });
    expect(invalid.status).toBe(422);
  }, 60_000);
});
