import { expect, test } from "bun:test";
import { acquireSharedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import { createDb, createSession, getSessionTurnMcpAccountBindings } from "@opengeni/db";
import { seedSenderConnections } from "../../db/test/sender-connection-fixture";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";

test("actual Send and Steer capture the sender's accounts; child admission preserves a frozen empty parent", async () => {
  const shared = await acquireSharedTestDatabase("core-sender-account-admission");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-sender-account-admission] PostgreSQL unavailable, skipping");
    return;
  }
  const client = createDb(shared.appUrl);
  try {
    const sql = shared.admin;
    const [account] =
      await sql`insert into managed_accounts (name) values ('core sender admission') returning id`;
    const [workspace] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
    const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
    await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
    const alice = `alice-${crypto.randomUUID()}`;
    const bob = `bob-${crypto.randomUUID()}`;
    const accounts = [alice, bob].map((ownerSubjectId) => ({
      serverId: "mail",
      connectionId: crypto.randomUUID(),
      ownerSubjectId,
      providerDomain: "mail.example.test",
      kind: "oauth2" as const,
    }));
    await seedSenderConnections(sql, scope, accounts);
    const server = {
      id: "mail",
      url: "https://mail.example.test/mcp",
      cacheToolsList: false,
      connectionRef: { providerDomain: "mail.example.test", kind: "oauth2" as const },
    };
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [server] });
    const session = await createSession(client.db, {
      ...scope,
      subjectId: alice,
      initialMessage: "shared session",
      resources: [],
      tools: [{ kind: "mcp", id: "mail" }],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const deps = {
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => {} },
      objectStorage: null,
    };
    const send = (subjectId: string, delivery: "send" | "steer") =>
      acceptSessionUserMessageWithOutcome(
        deps,
        { ...scope, subjectId, permissions: ["admin"], principalKind: "human_session" },
        scope.workspaceId,
        session.id,
        { text: `${subjectId} ${delivery}`, clientEventId: crypto.randomUUID(), delivery },
      );
    const aliceTurn = await send(alice, "send");
    expect(
      (
        await getSessionTurnMcpAccountBindings(
          client.db,
          scope.workspaceId,
          session.id,
          aliceTurn.turn.id,
        )
      )?.map((binding) => binding.connectionId),
    ).toEqual([accounts[0]!.connectionId]);
    const bobTurn = await send(bob, "steer");
    expect(
      (
        await getSessionTurnMcpAccountBindings(
          client.db,
          scope.workspaceId,
          session.id,
          bobTurn.turn.id,
        )
      )?.map((binding) => binding.connectionId),
    ).toEqual([accounts[1]!.connectionId]);
    await sql`update connections set status = 'revoked' where id = ${accounts[1]!.connectionId}`;
    const emptyTurn = await send(bob, "send");
    expect(
      await getSessionTurnMcpAccountBindings(
        client.db,
        scope.workspaceId,
        session.id,
        emptyTurn.turn.id,
      ),
    ).toEqual([]);
    await sql`update connections set status = 'active' where id = ${accounts[1]!.connectionId}`;
    const child = await freezeConnectionAccounts({
      db: client.db,
      ...scope,
      settings,
      tools: [{ kind: "mcp", id: "mail" }],
      source: { kind: "turn", sessionId: session.id, turnId: emptyTurn.turn.id },
    });
    expect(child.mcpAccountBindings).toEqual([]);
    expect(child.personalConnectionDelegations).toEqual([]);
  } finally {
    await client.close();
    await shared.release();
  }
}, 180_000);
