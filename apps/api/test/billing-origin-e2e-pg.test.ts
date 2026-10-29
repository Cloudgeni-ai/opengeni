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

test("a person's edits and manual runs keep an app schedule app; a delegated token's schedule is API use", async () => {
  if (!client || !shared) return;
  const noop = async () => undefined;
  const app = createApp({
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as never,
    managedAuth: null,
  });
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
  const base = `/v1/workspaces/${grant.workspaceId}/scheduled-tasks`;
  const send = async (method: string, path: string, body: unknown, authorization?: string) => {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    if (response.status >= 300) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { id?: string };
  };
  const origin = async (taskId: string) => {
    const [task] = await shared!.admin<{ billingOrigin: string | null }[]>`
      select billing_origin as "billingOrigin" from scheduled_tasks
      where workspace_id = ${grant.workspaceId}::uuid and id = ${taskId}::uuid`;
    return task?.billingOrigin;
  };
  const schedule = (authorization?: string) =>
    send(
      "POST",
      "",
      {
        name: "Weekly review",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: {
          prompt: "Review",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
        },
      },
      authorization,
    );
  // The person's own credential, with no test override: edits and manual
  // runs from the app never turn the schedule into API use.
  const taskId = (await schedule()).id!;
  expect(await origin(taskId)).toBe("app");
  await send("PATCH", `/${taskId}`, { name: "Weekly review, renamed" });
  await send("POST", `/${taskId}/trigger`, {});
  expect(await origin(taskId)).toBe("app");
  // A product holding a delegated token for the same person: API use.
  const token = await signDelegatedAccessToken(SECRET, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const productTask = (await schedule(`Bearer ${token}`)).id!;
  expect(await origin(productTask)).toBe("api");
  await send("PATCH", `/${productTask}`, { name: "Edited by the product" }, `Bearer ${token}`);
  await send("POST", `/${productTask}/trigger`, {}, `Bearer ${token}`);
  expect(await origin(productTask)).toBe("api");
}, 180_000);
