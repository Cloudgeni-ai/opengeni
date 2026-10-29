import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// End to end through the HTTP app and real PostgreSQL: the credential that
// starts a chat decides the origin frozen on its first turn.
const SECRET = "billing-origin-e2e-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("billing-origin-e2e");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Billing origin end-to-end tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("a person in the app starts app use; a delegated token for the same person starts API use", async () => {
  if (!client || !shared) return;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  });
  // The local install's own person, as the desktop app signs in.
  const local = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  const grant = local.workspaceGrants[0]!;
  const create = async (authorization?: string) => {
    const response = await app.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ initialMessage: "Run", tools: [], visibility: "workspace" }),
    });
    if (response.status !== 202) throw new Error(`${response.status} ${await response.text()}`);
    const session = (await response.json()) as { id: string };
    const [turn] = await shared!.admin<{ billingOrigin: string | null }[]>`
      select billing_origin as "billingOrigin" from session_turns
      where workspace_id = ${grant.workspaceId}::uuid and session_id = ${session.id}::uuid`;
    return turn?.billingOrigin;
  };

  expect(await create()).toBe("app");
  const token = await signDelegatedAccessToken(SECRET, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  expect(await create(`Bearer ${token}`)).toBe("api");
}, 180_000);
