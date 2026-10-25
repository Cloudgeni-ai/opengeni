import { expect, test } from "bun:test";
import { MESSAGE_TIME_ZONE_METADATA_KEY } from "@opengeni/contracts";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createDb, createSession, getSessionTurn } from "@opengeni/db";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";

test("a sent message freezes its normalized time zone on the accepted turn", async () => {
  const shared = await acquireSharedTestDatabase("core-message-time-zone-admission");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-message-time-zone-admission] PostgreSQL unavailable, skipping");
    return;
  }
  const client = createDb(shared.appUrl);
  try {
    const sql = shared.admin;
    const [account] =
      await sql`insert into managed_accounts (name) values ('core message time zone') returning id`;
    const [workspace] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'zones') returning id`;
    const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
    await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
    const subjectId = `ada-${crypto.randomUUID()}`;
    const session = await createSession(client.db, {
      ...scope,
      subjectId,
      initialMessage: "zones",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const deps = {
      settings: testSettings({ sandboxBackend: "none" }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => {} },
      objectStorage: null,
    };
    const send = (timeZone: string | undefined, delivery: "send" | "steer" = "send") =>
      acceptSessionUserMessageWithOutcome(
        deps,
        { ...scope, subjectId, permissions: ["admin"], principalKind: "human_session" },
        scope.workspaceId,
        session.id,
        {
          text: `message in ${timeZone ?? "no zone"}`,
          clientEventId: crypto.randomUUID(),
          delivery,
          ...(timeZone ? { timeZone } : {}),
        },
      );
    const frozenZone = async (turnId: string) =>
      (await getSessionTurn(client.db, scope.workspaceId, turnId))?.metadata[
        MESSAGE_TIME_ZONE_METADATA_KEY
      ];

    expect(await frozenZone((await send("Europe/Oslo")).turn.id)).toBe("Europe/Oslo");
    expect(await frozenZone((await send("Asia/Tokyo", "steer")).turn.id)).toBe("Asia/Tokyo");
    // Case is canonicalized; a zone this runtime cannot resolve is ignored.
    expect(await frozenZone((await send("america/new_york")).turn.id)).toBe("America/New_York");
    expect(await frozenZone((await send("Mars/Olympus_Mons")).turn.id)).toBeUndefined();
    expect(await frozenZone((await send(undefined)).turn.id)).toBeUndefined();
  } finally {
    await client.close();
    await shared.release();
  }
}, 180_000);
