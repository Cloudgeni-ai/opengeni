import { expect, test } from "bun:test";
import type { AccessContext, AccessGrant } from "@opengeni/contracts";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createDb, createSession } from "@opengeni/db";
import { accessGrantAuthorizationFromContext } from "../src/access";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";

// Accepting a message freezes, with its turn, what it may do through app
// actions. An embed's host-issued token naming a member never gets confirmed
// changes and stays capped by that token; a message without a person's
// verified request (an API key, a service) gets nothing.
test(
  "accepting a message freezes its app-action grant with the turn",
  { timeout: 180_000 },
  async () => {
    const shared = await acquireSharedTestDatabase("core-app-action-turn-grant");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
      console.warn("[core-app-action-turn-grant] PostgreSQL unavailable, skipping");
      return;
    }
    const client = createDb(shared.appUrl);
    try {
      const sql = shared.admin;
      const [account] =
        await sql`insert into managed_accounts (name) values ('app action turn grant') returning id`;
      const [workspace] =
        await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
      const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
      await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
      const owner = `user:${crypto.randomUUID()}`;
      const session = await createSession(client.db, {
        ...scope,
        subjectId: owner,
        initialMessage: "hello",
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
      const frozen = async (turnId: string) =>
        await sql<{ subject_id: string; changes: string; permissions: string[] }[]>`
        select subject_id, changes, permissions from session_turn_app_action_grants
        where turn_id = ${turnId}`;

      // A host-issued (delegated) token naming the owner, with narrow permissions.
      const token: AccessGrant = {
        ...scope,
        subjectId: owner,
        principalKind: "human_session",
        permissions: ["workspace:read", "sessions:read", "sessions:control"],
        metadata: { delegated: true },
      };
      const context: AccessContext = {
        mode: "managed",
        subjectId: owner,
        accountGrants: [{ accountId: scope.accountId, subjectId: owner, permissions: [] }],
        workspaceGrants: [token],
        defaultAccountId: scope.accountId,
        defaultWorkspaceId: scope.workspaceId,
      };
      const embedded = await acceptSessionUserMessageWithOutcome(
        deps,
        token,
        scope.workspaceId,
        session.id,
        {
          text: "make my friend an owner",
          clientEventId: crypto.randomUUID(),
          authorization: accessGrantAuthorizationFromContext(context, token),
        },
      );
      const [row] = await frozen(embedded.turn.id);
      expect(row?.subject_id).toBe(owner);
      expect(row?.changes).toBe("none");
      expect([...(row?.permissions ?? [])].sort()).toEqual(
        ["sessions:control", "sessions:read", "workspace:read"].sort(),
      );

      // No verified person behind the request: nothing is frozen, so nothing runs.
      const unverified = await acceptSessionUserMessageWithOutcome(
        deps,
        { ...token, metadata: {} },
        scope.workspaceId,
        session.id,
        { text: "and again", clientEventId: crypto.randomUUID() },
      );
      expect(await frozen(unverified.turn.id)).toHaveLength(0);
    } finally {
      await client.close();
      await shared.release();
    }
  },
);
