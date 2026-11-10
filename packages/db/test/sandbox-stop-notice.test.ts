// Regression: a chat's managed sandbox was stopped by the idle reaper while the
// agent waited for a person's answer, then restored from its saved /workspace.
// A runtime the agent had installed under /tmp was gone, and nothing told the
// agent; it found out from failing commands minutes later. The worker now reads
// the latest stop the model has not worked in since and tells it once.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  readUnseenSandboxStop,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | undefined;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-stop-notice");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[sandbox-stop-notice] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function chat() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Sandbox stop notice",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Sandbox stop notice",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
  });
  const workspaceId = grant.workspaceId!;
  return {
    append: (events: Parameters<typeof appendSessionEvents>[3]) =>
      appendSessionEvents(client!.db, workspaceId, session.id, events),
    read: () => readUnseenSandboxStop(client!.db, workspaceId, session.id),
  };
}

const toolCall = (id: string) => ({
  type: "agent.toolCall.created" as const,
  payload: { id, name: "exec_command", arguments: "{}" },
});
const idleStop = {
  type: "sandbox.box.terminated" as const,
  payload: { actor: "reaper", persisted: true, instanceId: "sb-old", drainReason: "idle" },
};

test("a stop after the model's last output is reported once, until the model works again", async () => {
  if (!client) return;
  const { append, read } = await chat();
  expect(await read()).toBeNull();

  // The agent installs a tool, asks a question, and the idle reaper stops the box.
  await append([toolCall("call-install"), toolCall("call-ask")]);
  expect(await read()).toBeNull();
  const [stop] = await append([idleStop]);
  // Answering the question and restoring the box are not model output.
  await append([
    { type: "sandbox.box.created", payload: { sandboxId: "sb-new", hydrated: "archive" } },
  ]);
  expect(await read()).toEqual({
    kind: "stopped",
    at: new Date(stop!.occurredAt).toISOString(),
    reason: "idle",
  });

  // Once the model has produced output after the stop, it is not repeated.
  await append([
    {
      type: "agent.message.completed",
      payload: { text: "Continuing.", phase: "commentary", messageId: "msg-1" },
    },
  ]);
  expect(await read()).toBeNull();
}, 60_000);

test("a lost box is reported as lost, and only the latest stop counts", async () => {
  if (!client) return;
  const { append, read } = await chat();
  await append([toolCall("call-1"), idleStop]);
  await append([{ type: "sandbox.box.lost", payload: { sandboxId: "sb-gone" } }]);
  expect(await read()).toMatchObject({ kind: "lost", reason: null });
}, 60_000);

test("a Connected Machine's drain is not reported as a stop", async () => {
  if (!client) return;
  const { append, read } = await chat();
  await append([toolCall("call-1")]);
  const [managedStop] = await append([idleStop]);
  await append([
    {
      type: "sandbox.box.terminated",
      payload: { ...idleStop.payload, instanceId: "machine", providerStopped: false },
    },
  ]);
  // The machine kept running; the earlier managed stop is still the news.
  expect(await read()).toEqual({
    kind: "stopped",
    at: new Date(managedStop!.occurredAt).toISOString(),
    reason: "idle",
  });
}, 60_000);
