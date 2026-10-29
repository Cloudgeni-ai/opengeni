import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SESSION_UNATTENDED_METADATA_KEY,
  sessionMetadataUnattended,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createDb, getSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// `unattended: true` on session create (real PostgreSQL): frozen under the
// reserved metadata key, which a caller-supplied metadata value never sets.

const DELEGATION_SECRET = "session-unattended-api-test-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: ReturnType<typeof createApp>;

class WorkflowStub implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-unattended");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Unattended session API tests require PostgreSQL");
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new WorkflowStub(),
    objectStorage: null,
    githubStateSecret: "session-unattended-test-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used here");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspaceAuth(): Promise<{ workspaceId: string; auth: string }> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Unattended') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Unattended') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: "unattended-service",
    subjectLabel: "unattended-service",
    permissions: ["workspace:read", "sessions:create", "sessions:read"],
    principalKind: "service",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return { workspaceId: workspace!.id, auth: `Bearer ${token}` };
}

async function create(
  target: { workspaceId: string; auth: string },
  body: Record<string, unknown>,
): Promise<string> {
  const response = await app.request(`/v1/workspaces/${target.workspaceId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: target.auth },
    body: JSON.stringify({ initialMessage: "Run the task", model: "scripted-model", ...body }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(202);
  return (JSON.parse(text) as { id: string }).id;
}

describe("unattended session create (real PostgreSQL)", () => {
  test("only the explicit option makes a session unattended", async () => {
    if (!shared) return;
    const target = await workspaceAuth();
    const unattended = await create(target, { unattended: true });
    const interactive = await create(target, {});
    const spoofed = await create(target, {
      metadata: { team: "ops", [SESSION_UNATTENDED_METADATA_KEY]: true },
    });
    const read = async (id: string) =>
      (await getSession(client.db, target.workspaceId, id))?.metadata;
    expect(sessionMetadataUnattended(await read(unattended))).toBe(true);
    expect(sessionMetadataUnattended(await read(interactive))).toBe(false);
    const spoofedMetadata = await read(spoofed);
    expect(spoofedMetadata?.["team"]).toBe("ops");
    expect(sessionMetadataUnattended(spoofedMetadata)).toBe(false);
  }, 60_000);
});
