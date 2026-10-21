import { afterAll, beforeAll, expect, test } from "bun:test";
import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  type DbClient,
  type SessionCreateInput,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-create-lapsed-shared-accounts");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("real PostgreSQL is required for the session-create account proof");
  }
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function workspaceBinding(input: {
  workspaceId: string;
  connectionId: string;
  serverId: string;
  canonicalServerId: string;
  providerDomain: string;
  generation: number;
}): McpConnectionAccountBinding {
  return {
    serverId: input.serverId,
    canonicalServerId: input.canonicalServerId,
    connectionId: input.connectionId,
    originWorkspaceId: input.workspaceId,
    subjectScope: "workspace",
    ownerSubjectId: null,
    accountLabel: `Synthetic ${input.canonicalServerId} account`,
    providerDomain: input.providerDomain,
    kind: "oauth2",
    connectionRef: {
      connectionId: input.connectionId,
      subjectScope: "workspace",
      providerDomain: input.providerDomain,
      kind: "oauth2",
    },
    connectionAuthorityGeneration: input.generation,
  };
}

test.each([
  [false, "missing"],
  [true, "missing"],
  [false, "needs_reauth"],
  [true, "needs_reauth"],
  [false, "generation_changed"],
  [true, "generation_changed"],
] as const)(
  "create (keyed=%j, state=%s) runs without a copied shared account that can no longer be used and keeps the rest",
  async (keyed, state) => {
    if (!shared || !client) return;
    const [account] = await shared.admin`insert into managed_accounts (name)
    values ('lapsed-shared-account') returning id`;
    const [workspace] = await shared.admin`insert into workspaces (account_id, name)
    values (${account!.id}, 'lapsed-shared-workspace') returning id`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${account!.id}, ${workspace!.id})`;
    const lapsedId = crypto.randomUUID();
    if (state !== "missing") {
      await shared.admin`insert into connections (
      id, account_id, workspace_id, origin_workspace_id, provider_domain,
      kind, status, credential_encrypted, authority_scope, authority_generation
    ) values (
      ${lapsedId}, ${account!.id}, ${workspace!.id}, ${workspace!.id},
      'mail.example.test', 'oauth2', 'needs_reauth',
      'synthetic-not-a-credential', 'workspace', 1
    )`;
      if (state === "generation_changed") {
        // Exercise the real status transition that advances authority, not a
        // caller-supplied generation that the INSERT trigger initializes.
        await shared.admin`update connections set status = 'active' where id = ${lapsedId}`;
      }
    }
    const keptId = crypto.randomUUID();
    await shared.admin`insert into connections (
      id, account_id, workspace_id, origin_workspace_id, provider_domain,
      kind, status, credential_encrypted, authority_scope, authority_generation
    ) values (
      ${keptId}, ${account!.id}, ${workspace!.id}, ${workspace!.id},
      'docs.example.test', 'oauth2', 'active',
      'synthetic-not-a-credential', 'workspace', 1
    )`;
    const [kept] = await shared.admin`select authority_generation from connections
    where id = ${keptId}`;
    const keptBinding = workspaceBinding({
      workspaceId: workspace!.id,
      connectionId: keptId,
      serverId: `account-${"b".repeat(64)}`,
      canonicalServerId: "docs",
      providerDomain: "docs.example.test",
      generation: Number(kept!.authority_generation),
    });
    const input: SessionCreateInput = {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "synthetic task",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      // The accounts a parent turn accepted earlier, copied unchanged.
      mcpAccountBindings: [
        workspaceBinding({
          workspaceId: workspace!.id,
          connectionId: lapsedId,
          serverId: `account-${"a".repeat(64)}`,
          canonicalServerId: "mail",
          providerDomain: "mail.example.test",
          generation: 1,
        }),
        keptBinding,
      ],
    };
    let created: { id: string };
    if (keyed) {
      const result = await createSessionWithIdempotencyKeyResult(client.db, {
        ...input,
        createIdempotencyKey: `lapsed-shared-${crypto.randomUUID()}`,
      });
      if (result.denied) throw new Error(`unexpected spawn denial: ${result.denial.code}`);
      created = result.session;
    } else {
      created = await createSession(client.db, input);
    }
    expect(
      Array.from(
        await shared.admin`select initial_mcp_account_bindings from sessions where id = ${created.id}`,
      ),
    ).toEqual([{ initial_mcp_account_bindings: [keptBinding] }]);
    // The first turn copies the session's accepted accounts.
    for (const turn of await shared.admin`select mcp_account_bindings from session_turns
    where session_id = ${created.id}`) {
      expect(turn.mcp_account_bindings).toEqual([keptBinding]);
    }
    // Narrowing never repairs, refreshes or replaces the lapsed account.
    expect(
      Array.from(
        await shared.admin`select status, authority_generation from connections where id = ${lapsedId}`,
      ),
    ).toEqual(
      state === "missing"
        ? []
        : [
            {
              status: state === "needs_reauth" ? "needs_reauth" : "active",
              authority_generation: state === "generation_changed" ? "2" : "1",
            },
          ],
    );
  },
  180_000,
);
