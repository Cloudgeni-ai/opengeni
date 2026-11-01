import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES } from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import { createDb, createOrganizationApiKey, createWorkspace, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// Inline Skills on a task that starts its own chats are bounded by the Skill
// limits a session create uses, not by the agent config byte cap; the rest of
// the config keeps that cap.

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-inline-skills");
  if (!acquired) throw new Error("Scheduled task inline Skill tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Inline Skill fixture') returning id`;
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
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "scheduled_tasks:run",
      "scheduled_tasks:manage",
    ],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
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
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `/v1/workspaces/${workspace.id}/scheduled-tasks`;
  const request = async (method: string, path: string, body?: unknown) =>
    await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { base, request };
}

/** Sixteen valid Skills of about 9.6 KB each: about 150 KB in total. */
function inlineSkills(prefix: string, count = 16, bodyBytes = 9_600) {
  return Array.from({ length: count }, (_, index) => ({
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${prefix}-${index}\ndescription: ${prefix} step ${index}.\n---\n${"r".repeat(bodyBytes)}\n`,
      },
    ],
  }));
}

const agentConfig = (fields: Record<string, unknown>) => ({
  prompt: "Review the open work",
  resources: [],
  tools: [],
  metadata: {},
  sandboxBackend: "none",
  ...fields,
});

const task = (fields: Record<string, unknown>) => ({
  name: "Nightly review",
  schedule: { type: "manual" },
  runMode: "new_session_per_run",
  overlapPolicy: "skip",
  ...fields,
});

type StoredTask = {
  id: string;
  agentConfig: { skills?: Array<{ name: string }> };
};

test("a task with about 150 KB of inline Skills is created, stored and updated", async () => {
  const { base, request } = await fixture();
  const skills = inlineSkills("review");
  expect(new TextEncoder().encode(JSON.stringify(skills)).byteLength).toBeGreaterThan(
    SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES,
  );

  const created = await request("POST", base, task({ agentConfig: agentConfig({ skills }) }));
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as StoredTask;

  const read = await request("GET", `${base}/${id}`);
  expect(read.status).toBe(200);
  const stored = (await read.json()) as StoredTask;
  expect(stored.agentConfig.skills?.map((skill) => skill.name)).toEqual(
    skills.map((_, index) => `review-${index}`),
  );

  const replacement = inlineSkills("triage");
  const updated = await request("PATCH", `${base}/${id}`, {
    agentConfig: agentConfig({ skills: replacement }),
  });
  expect(updated.status).toBe(200);
  const reread = (await (await request("GET", `${base}/${id}`)).json()) as StoredTask;
  expect(reread.agentConfig.skills?.map((skill) => skill.name)).toEqual(
    replacement.map((_, index) => `triage-${index}`),
  );
});

test("an oversized config is still rejected, with or without Skills", async () => {
  const { base, request } = await fixture();
  // About 150 KB of UTF-8 within the instructions character limit.
  const instructions = "€".repeat(50_000);
  for (const skills of [undefined, inlineSkills("small", 2, 1_000)]) {
    const rejected = await request(
      "POST",
      base,
      task({
        agentConfig: agentConfig({ agent: { instructions }, ...(skills ? { skills } : {}) }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(
      `agent config exceeds ${SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES} UTF-8 bytes`,
    );
  }

  const created = await request("POST", base, task({ agentConfig: agentConfig({}) }));
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as StoredTask;
  const patched = await request("PATCH", `${base}/${id}`, {
    agentConfig: agentConfig({ agent: { instructions } }),
  });
  expect(patched.status).toBe(400);
});

test("inline Skills are still validated like a session create's", async () => {
  const { base, request } = await fixture();
  const rejected = await request(
    "POST",
    base,
    task({
      agentConfig: agentConfig({
        skills: [{ files: [{ path: "SKILL.md", content: "no front matter" }] }],
      }),
    }),
  );
  expect(rejected.status).toBe(422);
});
