// A session bound to a Sandbox Environment whose default Variable Sets the
// session did not select itself (API/SDK, Slack, scheduled and child sessions)
// must still open its terminal, Files, Git and desktop viewer. The attach lane
// materializes the environment defaults in the same order as an agent turn; before
// migration 0531 the database seam admitted only the session's own selection,
// raised P0002, and every attach answered HTTP 500 with no logged cause.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Permission, type Session } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createRig,
  createVariableSet,
  deleteVariableSet,
  encryptEnvironmentValue,
  getSession,
  type DbClient,
} from "@opengeni/db";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { sessionAttachEnvironment } from "../src/sandbox/viewer";

const SECRET = "session-attach-default-variable-sets-secret";
const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
  environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
  sandboxBackend: "local",
  sandboxOwnershipEnabled: true,
  sandboxLeaseTtlMs: 5_000,
});

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-attach-default-variable-sets");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

let cachedApp: Hono | null = null;
/** The composed public app, so failures render through the real error envelope. */
function app(): Hono {
  const noop = async () => undefined;
  cachedApp ??= createApp({
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
  });
  return cachedApp;
}

async function bearer(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  permissions: Permission[],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

/** A workspace with a Sandbox Environment whose only default Variable Set
 *  carries a value, and a session created through the public route that names
 *  the environment but not the set. */
async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-attach-default-variable-sets",
    accountExternalId: `account-${suffix}`,
    accountName: "Session attach defaults",
    workspaceExternalSource: "session-attach-default-variable-sets",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session attach defaults",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const key = Buffer.from(ENVIRONMENTS_ENCRYPTION_KEY, "base64");
  const variableSet = await createVariableSet(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: `environment-default-${suffix}`,
    variables: [
      {
        name: "ENVIRONMENT_DEFAULT_TOKEN",
        valueEncrypted: encryptEnvironmentValue(key, `default-${suffix}`),
      },
    ],
  });
  const rig = await createRig(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: `environment-${suffix}`,
    createdBy: grant.subjectId,
    initialVersion: { changelog: "v1", defaultVariableSetIds: [variableSet.id] },
  });
  const created = await app().request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
    method: "POST",
    headers: {
      authorization: await bearer(grant, [
        "sessions:create",
        "sessions:read",
        "rigs:use",
        "variable-sets:attach",
        "variable-sets:use",
      ]),
      "content-type": "application/json",
    },
    body: JSON.stringify({ initialMessage: "use the environment defaults", rigId: rig.id }),
  });
  expect(created.status).toBe(202);
  const session = (await created.json()) as Session;
  expect(session.rigId).toBe(rig.id);
  expect(session.variableSetIds).toEqual([]);
  return {
    grant,
    session,
    variableSetId: variableSet.id,
    value: `default-${suffix}`,
    attachAuthorization: await bearer(grant, ["sessions:read", "files:read", "terminal:attach"]),
  };
}

async function channelA(
  value: Awaited<ReturnType<typeof fixture>>,
  path: "terminal/exec" | "fs/list",
  body: unknown,
): Promise<Response> {
  return await app().request(
    `/v1/workspaces/${value.grant.workspaceId}/sessions/${value.session.id}/${path}`,
    {
      method: "POST",
      headers: { authorization: value.attachAuthorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("session attach with unselected Sandbox Environment default Variable Sets", () => {
  test("terminal and Files open with the environment default values", async () => {
    if (!available) return;
    const value = await fixture();

    const exec = await channelA(value, "terminal/exec", {
      command: 'printf %s "$ENVIRONMENT_DEFAULT_TOKEN"',
    });
    expect(exec.status).toBe(200);
    const execBody = (await exec.json()) as { stdout: string; exitCode: number };
    expect(execBody.exitCode).toBe(0);
    expect(execBody.stdout).toContain(value.value);

    const list = await channelA(value, "fs/list", { path: "/workspace" });
    expect(list.status).toBe(200);

    // The desktop viewer/stream resolvers build the same attach environment.
    const stored = await getSession(client.db, value.grant.workspaceId, value.session.id);
    const environment = await sessionAttachEnvironment(
      { db: client.db, settings } as never,
      value.grant.workspaceId,
      stored as Session,
      value.grant.subjectId,
    );
    expect(environment.ENVIRONMENT_DEFAULT_TOKEN).toBe(value.value);

    const [materialized] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from audit_events
      where workspace_id = ${value.grant.workspaceId}
        and action = 'variable_set.materialized'
        and target_id = ${value.variableSetId}
        and metadata->>'actorKind' = 'session_attach'
        and metadata->>'sessionId' = ${value.session.id}`;
    expect(materialized!.count).toBeGreaterThan(0);
  });

  test("a default set the session can no longer use is a 403 with a denial fact", async () => {
    if (!available) return;
    const value = await fixture();
    expect(
      await deleteVariableSet(
        client.db,
        {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId,
          subjectId: value.grant.subjectId,
        },
        value.variableSetId,
      ),
    ).toBe(true);

    for (const [path, body] of [
      ["terminal/exec", { command: "true" }],
      ["fs/list", { path: "/workspace" }],
    ] as const) {
      const response = await channelA(value, path, body);
      expect(response.status).toBe(403);
      const envelope = (await response.json()) as {
        error: { code: string; retryable: boolean; details?: Record<string, unknown> };
      };
      expect(envelope.error).toMatchObject({
        code: "forbidden",
        retryable: false,
        details: { variableSetId: value.variableSetId, source: "sandbox_environment_default" },
      });
    }

    const [denied] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from audit_events
      where workspace_id = ${value.grant.workspaceId}
        and action = 'variable_set.materialize.denied'
        and target_id = ${value.variableSetId}
        and metadata->>'sessionId' = ${value.session.id}`;
    expect(denied!.count).toBe(2);
  });
});
