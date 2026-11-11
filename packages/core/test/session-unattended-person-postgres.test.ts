import { expect, test } from "bun:test";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createDb, createSession, getSession } from "@opengeni/db";
import { acceptSessionUserMessageWithOutcome, setSessionUnattended } from "../src/domain/sessions";

// A person who writes in a chat an automation started ends its unattended
// default; an explicit choice (create option, the chat's switch, a task's
// own setting) stays, and a program's message changes nothing.
test("only an automation's unattended default ends when a person writes", async () => {
  const shared = await acquireSharedTestDatabase("core-session-unattended-person");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-session-unattended-person] PostgreSQL unavailable, skipping");
    return;
  }
  const client = createDb(shared.appUrl);
  try {
    const sql = shared.admin;
    const [account] =
      await sql`insert into managed_accounts (name) values ('core unattended person') returning id`;
    const [workspace] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'unattended') returning id`;
    const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
    await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
    const subjectId = `ada-${crypto.randomUUID()}`;
    const create = async (
      extra: Partial<Parameters<typeof createSession>[1]> = {},
    ): Promise<string> =>
      (
        await createSession(client.db, {
          ...scope,
          subjectId,
          initialMessage: "work",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          ...extra,
        })
      ).id;
    const deps = {
      settings: testSettings({ sandboxBackend: "none" }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => {} },
      objectStorage: null,
    };
    const person = {
      ...scope,
      subjectId,
      permissions: ["admin", "sessions:control"],
      principalKind: "human_session",
    };
    const program = { ...scope, subjectId, permissions: ["admin"], principalKind: "api_key" };
    const send = (grant: typeof person, sessionId: string) =>
      acceptSessionUserMessageWithOutcome(
        deps,
        grant as Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
        scope.workspaceId,
        sessionId,
        { text: "here now", clientEventId: crypto.randomUUID(), delivery: "send" },
      );
    const unattended = async (sessionId: string) =>
      (await getSession(client.db, scope.workspaceId, sessionId))?.unattended;

    const automationDefault = await create({ unattendedSetting: "unattended_by_default" });
    const taskChoice = await create({ unattendedSetting: "unattended" });
    const createOption = await create({ unattended: true });
    const interactive = await create();
    for (const id of [automationDefault, taskChoice, createOption]) {
      expect(await unattended(id)).toBe(true);
    }
    expect(await unattended(interactive)).toBe(false);

    // A program's message is not a person showing up.
    await send(program, automationDefault);
    expect(await unattended(automationDefault)).toBe(true);

    for (const id of [automationDefault, taskChoice, createOption, interactive]) {
      await send(person, id);
    }
    expect(await unattended(automationDefault)).toBe(false);
    expect(await unattended(taskChoice)).toBe(true);
    expect(await unattended(createOption)).toBe(true);
    expect(await unattended(interactive)).toBe(false);

    // The chat's switch is an explicit choice either way, and stays.
    const grant = person as Parameters<typeof setSessionUnattended>[1];
    expect((await setSessionUnattended(deps, grant, interactive, true)).result.status).toBe(
      "updated",
    );
    expect((await setSessionUnattended(deps, grant, createOption, false)).result.status).toBe(
      "updated",
    );
    await send(person, interactive);
    expect(await unattended(interactive)).toBe(true);
    expect(await unattended(createOption)).toBe(false);
    await setSessionUnattended(deps, grant, automationDefault, true);
    await send(person, automationDefault);
    expect(await unattended(automationDefault)).toBe(true);
  } finally {
    await client.close();
    await shared.release();
  }
}, 180_000);
