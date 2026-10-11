import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-audience");
  if (!acquired) throw new Error("Schedule audience tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "scheduled_tasks:run",
  "scheduled_tasks:manage",
];

async function fixture(settingsOverrides: Parameters<typeof testSettings>[0] = {}) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Schedule audience fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "scheduled_tasks:run",
      "scheduled_tasks:manage",
      "account:admin",
    ],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "configured",
      sandboxBackend: "none",
      ...settingsOverrides,
    }),
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
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async (permissions: string[]) => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person(memberPermissions);
  const other = await person(memberPermissions);
  const admin = await person([...memberPermissions, "workspace:admin"]);
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'scheduled-task-audience-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const base = `/v1/workspaces/${workspace.id}/scheduled-tasks`;
  const create = async (headers: Record<string, string>, body: Record<string, unknown>) =>
    await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Weekly review of my notes",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: {
          prompt: "Summarize my private notes",
          resources: [],
          tools: [],
          metadata: {},
          sandboxBackend: "none",
        },
        ...body,
      }),
    });
  return { app, accountId, workspace, base, owner, other, admin, create };
}

test("an Only me schedule is hidden from other members and summarized for admins", async () => {
  const f = await fixture();
  const createdPrivate = await f.create(f.owner.headers, { visibility: "private" });
  expect(createdPrivate.status).toBe(201);
  const privateTask = (await createdPrivate.json()) as { id: string; visibility: string };
  expect(privateTask.visibility).toBe("private");
  const createdShared = await f.create(f.owner.headers, { name: "Team digest" });
  expect(createdShared.status).toBe(201);
  const sharedTask = (await createdShared.json()) as { id: string; visibility: string };
  expect(sharedTask.visibility).toBe("workspace");

  const listFor = async (headers: Record<string, string>) =>
    ((await (await f.app.request(f.base, { headers })).json()) as Array<{ id: string }>).map(
      (task) => task.id,
    );
  expect((await listFor(f.owner.headers)).sort()).toEqual([privateTask.id, sharedTask.id].sort());
  expect(await listFor(f.other.headers)).toEqual([sharedTask.id]);
  expect(await listFor(f.admin.headers)).toEqual([sharedTask.id]);

  // Another member cannot tell it from a schedule that does not exist.
  const missing = crypto.randomUUID();
  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["GET", "/runs", undefined],
    ["PATCH", "", { name: "Mine now" }],
    ["POST", "/pause", undefined],
    ["POST", "/resume", undefined],
    ["POST", "/trigger", {}],
    ["DELETE", "", undefined],
  ] as const) {
    const request = async (id: string) =>
      await f.app.request(`${f.base}/${id}${suffix}`, {
        method,
        headers: f.other.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const denied = await request(privateTask.id);
    const absent = await request(missing);
    expect({ route: `${method} ${suffix}`, status: denied.status }).toEqual({
      route: `${method} ${suffix}`,
      status: absent.status,
    });
    expect(denied.status).toBe(404);
  }
  expect(
    (await f.app.request(`${f.base}/private-summaries`, { headers: f.other.headers })).status,
  ).toBe(403);

  // An admin sees that it exists, whose it is and how often it runs, never
  // its name or prompt, and can pause it.
  const summaries = await f.app.request(`${f.base}/private-summaries`, {
    headers: f.admin.headers,
  });
  expect(summaries.status).toBe(200);
  const summaryBody = (await summaries.json()) as {
    schedules: Array<Record<string, unknown>>;
  };
  expect(summaryBody.schedules).toHaveLength(1);
  expect(summaryBody.schedules[0]).toMatchObject({
    id: privateTask.id,
    ownerSubjectId: f.owner.subjectId,
    status: "active",
    schedule: { type: "interval", everySeconds: 3600 },
    lastRunAt: null,
    last30Days: { runs: 0, creditUsd: 0, estimatedProviderUsd: 0 },
  });
  const serialized = JSON.stringify(summaryBody);
  expect(serialized).not.toContain("Weekly review");
  expect(serialized).not.toContain("private notes");
  expect(
    (await f.app.request(`${f.base}/${privateTask.id}`, { headers: f.admin.headers })).status,
  ).toBe(404);
  // The ordinary pause route treats it as missing; admins pause it from its summary.
  expect(
    (
      await f.app.request(`${f.base}/${privateTask.id}/pause`, {
        method: "POST",
        headers: f.admin.headers,
      })
    ).status,
  ).toBe(404);
  const paused = await f.app.request(`${f.base}/private-summaries/${privateTask.id}/pause`, {
    method: "POST",
    headers: f.admin.headers,
  });
  expect(paused.status).toBe(200);
  const pausedBody = (await paused.json()) as Record<string, unknown>;
  expect(pausedBody).toMatchObject({ id: privateTask.id, status: "paused" });
  expect(JSON.stringify(pausedBody)).not.toContain("private notes");
  // Resuming stays with the owner.
  expect(
    (
      await f.app.request(`${f.base}/${privateTask.id}/resume`, {
        method: "POST",
        headers: f.admin.headers,
      })
    ).status,
  ).toBe(404);
  const ownerView = await f.app.request(`${f.base}/${privateTask.id}`, {
    headers: f.owner.headers,
  });
  expect(((await ownerView.json()) as { status: string }).status).toBe("paused");

  // The owner can open it up to the workspace, and everyone then sees it.
  const widened = await f.app.request(`${f.base}/${privateTask.id}`, {
    method: "PATCH",
    headers: f.owner.headers,
    body: JSON.stringify({ visibility: "workspace" }),
  });
  expect(widened.status).toBe(200);
  expect(((await widened.json()) as { visibility: string }).visibility).toBe("workspace");
  expect((await listFor(f.other.headers)).sort()).toEqual([privateTask.id, sharedTask.id].sort());
});

test("a schedule that posts into an Only me chat is Only me", async () => {
  const f = await fixture();
  const chat = await withSessionRlsActorContext({ subjectId: f.owner.subjectId }, () =>
    createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Private work",
      resources: [],
      metadata: {},
      visibility: "user_private",
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      subjectId: f.owner.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  );
  const message = (body: Record<string, unknown>) =>
    f.app.request(f.base, {
      method: "POST",
      headers: f.owner.headers,
      body: JSON.stringify({
        name: "Morning check-in",
        schedule: { type: "interval", everySeconds: 3600 },
        prompt: "Check in",
        targetSessionId: chat.id,
        ...body,
      }),
    });
  const refused = await message({ visibility: "workspace" });
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
    "This schedule posts into an Only me chat, so it is Only me too.",
  );
  const created = await message({});
  expect(created.status).toBe(201);
  const task = (await created.json()) as { id: string; visibility: string };
  expect(task.visibility).toBe("private");
  const widen = await f.app.request(`${f.base}/${task.id}`, {
    method: "PATCH",
    headers: f.owner.headers,
    body: JSON.stringify({ visibility: "workspace" }),
  });
  expect(widen.status).toBe(422);
  const peers = (await (
    await f.app.request(f.base, { headers: f.other.headers })
  ).json()) as Array<{ id: string }>;
  expect(peers.map((row) => row.id)).not.toContain(task.id);

  // Its runs and usage live in the owner's Only me chat, which the admin
  // cannot see. The admin still gets the run count and cost, and can pause it.
  const firedAt = new Date(Date.now() - 60_000);
  // A finished run, recorded directly rather than through run admission.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into scheduled_task_runs (task_id, trigger_type, status, account_id, workspace_id, session_id, fired_at)
      values (${task.id}, 'schedule', 'succeeded', ${f.accountId}, ${f.workspace.id}, ${chat.id}, ${firedAt})`;
  });
  await shared.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api, model,
      billing_path, input_tokens, output_tokens, cached_tokens, total_tokens,
      priced_cost_micros, estimated_provider_cost_micros, pricing_source, occurred_at, scheduled_task_id
    ) values (
      ${f.accountId}, ${f.workspace.id}, ${chat.id}, gen_random_uuid(), ${crypto.randomUUID()},
      'openai', 'responses', 'gpt-credits', 'opengeni_credits', 90, 10, 0, 100,
      1250000, 400000, 'configured_list_price', ${firedAt}, ${task.id}
    )`;
  expect((await f.app.request(f.base, { headers: f.admin.headers })).status).toBe(200);
  const adminSummaries = (await (
    await f.app.request(`${f.base}/private-summaries`, { headers: f.admin.headers })
  ).json()) as { schedules: Array<Record<string, unknown>> };
  expect(adminSummaries.schedules).toEqual([
    expect.objectContaining({
      id: task.id,
      ownerSubjectId: f.owner.subjectId,
      status: "active",
      lastRunAt: firedAt.toISOString(),
      last30Days: { runs: 1, creditUsd: 1.25, estimatedProviderUsd: 0.4 },
    }),
  ]);
  expect(JSON.stringify(adminSummaries)).not.toContain("Morning check-in");
  expect(JSON.stringify(adminSummaries)).not.toContain(chat.id);
  const paused = await f.app.request(`${f.base}/private-summaries/${task.id}/pause`, {
    method: "POST",
    headers: f.admin.headers,
  });
  expect(paused.status).toBe(200);
  expect(await paused.json()).toMatchObject({ id: task.id, status: "paused" });
  const [stored] = await shared.admin`select status from scheduled_tasks where id = ${task.id}`;
  expect(stored?.status).toBe("paused");
  // Another member still cannot pause or detect it.
  expect(
    (
      await f.app.request(`${f.base}/${task.id}/pause`, {
        method: "POST",
        headers: f.other.headers,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.app.request(`${f.base}/private-summaries/${task.id}/pause`, {
        method: "POST",
        headers: f.other.headers,
      })
    ).status,
  ).toBe(403);
  // Pausing again is a no-op that still returns the summary.
  const again = await f.app.request(`${f.base}/private-summaries/${task.id}/pause`, {
    method: "POST",
    headers: f.admin.headers,
  });
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: task.id, status: "paused" });
});

test("Only me schedules follow the organization's Only me setting", async () => {
  const f = await fixture();
  await shared.admin`update organization_private_session_settings set enabled = false where account_id = ${f.accountId}`;
  const refused = await f.create(f.owner.headers, { visibility: "private" });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
    "Only me schedules are turned off for this organization.",
  );
  expect((await f.create(f.owner.headers, {})).status).toBe(201);
});

test("only its owner's Only me schedules can run on a personal machine", async () => {
  const f = await fixture({ sandboxOwnershipEnabled: true, sandboxSelfhostedEnabled: true });
  const machine = await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${f.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${f.workspace.id}, true)`;
    await tx`select set_config('opengeni.subject_id', ${f.owner.subjectId}, true)`;
    const [row] = await tx<Array<{ sandboxId: string }>>`
      select sandbox_id as "sandboxId" from finalize_scoped_enrollment(
        ${f.accountId}::uuid, ${f.workspace.id}::uuid, 'user',
        ${`pubkey-${crypto.randomUUID()}`}, false, false, 'linux', 'x86_64', 'My laptop', false
      )`;
    return row!;
  });
  const onMachine = {
    prompt: "Tidy my downloads folder",
    resources: [],
    tools: [],
    metadata: {},
    machineTarget: { targetSandboxId: machine.sandboxId },
  };

  const forEveryone = await f.create(f.owner.headers, { agentConfig: onMachine });
  expect(forEveryone.status).toBe(422);
  expect(await forEveryone.text()).toContain("Only me");
  const notTheirs = await f.create(f.other.headers, {
    visibility: "private",
    agentConfig: onMachine,
  });
  expect(notTheirs.status).toBe(422);

  const created = await f.create(f.owner.headers, {
    visibility: "private",
    agentConfig: onMachine,
  });
  expect(created.status).toBe(201);
  const task = (await created.json()) as { id: string; visibility: string };
  expect(task.visibility).toBe("private");
  const widened = await f.app.request(`${f.base}/${task.id}`, {
    method: "PATCH",
    headers: f.owner.headers,
    body: JSON.stringify({ visibility: "workspace" }),
  });
  expect(widened.status).toBe(422);
  expect(await widened.text()).toContain("Only me");
  const renamed = await f.app.request(`${f.base}/${task.id}`, {
    method: "PATCH",
    headers: f.owner.headers,
    body: JSON.stringify({ name: "Tidy downloads" }),
  });
  expect(renamed.status).toBe(200);
});
