import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  nestedPostgresSqlState,
  type DbClient,
  type SessionCreateInput,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-create-connection-refusal");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("real PostgreSQL is required for session-create refusal proof");
  }
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test.each([
  [false, "missing"],
  [true, "missing"],
  [false, "needs_reauth"],
  [true, "needs_reauth"],
  [false, "generation_changed"],
  [true, "generation_changed"],
] as const)(
  "create (keyed=%j, state=%s) explains a refused accepted connection without repairing or replaying it",
  async (keyed, state) => {
    if (!shared || !client) return;
    const [account] = await shared.admin`insert into managed_accounts (name)
    values ('connection-refusal-account') returning id`;
    const [workspace] = await shared.admin`insert into workspaces (account_id, name)
    values (${account!.id}, 'connection-refusal-workspace') returning id`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${account!.id}, ${workspace!.id})`;
    const connectionId = crypto.randomUUID();
    if (state !== "missing") {
      await shared.admin`insert into connections (
      id, account_id, workspace_id, origin_workspace_id, provider_domain,
      kind, status, credential_encrypted, authority_scope, authority_generation
    ) values (
      ${connectionId}, ${account!.id}, ${workspace!.id}, ${workspace!.id},
      'mail.example.test', 'oauth2', 'needs_reauth',
      'synthetic-not-a-credential', 'workspace', 1
    )`;
      if (state === "generation_changed") {
        // Exercise the real status transition that advances authority, not a
        // caller-supplied generation that the INSERT trigger initializes.
        await shared.admin`update connections set status = 'active' where id = ${connectionId}`;
      }
    }
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
      mcpAccountBindings: [
        {
          serverId: `account-${"a".repeat(64)}`,
          canonicalServerId: "mail",
          connectionId,
          originWorkspaceId: workspace!.id,
          subjectScope: "workspace",
          ownerSubjectId: null,
          accountLabel: "Synthetic mail account",
          providerDomain: "mail.example.test",
          kind: "oauth2",
          connectionRef: {
            connectionId,
            subjectScope: "workspace",
            providerDomain: "mail.example.test",
            kind: "oauth2",
          },
          connectionAuthorityGeneration: 1,
        },
      ],
    };
    const key = `connection-refusal-${crypto.randomUUID()}`;
    let failure: unknown;
    try {
      if (keyed) {
        await createSessionWithIdempotencyKeyResult(client.db, {
          ...input,
          createIdempotencyKey: key,
        });
      } else {
        await createSession(client.db, input);
      }
    } catch (error) {
      failure = error;
    }
    // Preserve the actual authorization rejection and original driver cause;
    // explain the refusal rather than converting it into a transport retry.
    expect(nestedPostgresSqlState(failure)).toBe("42501");
    expect(failure).toMatchObject({
      name: "SessionCreateConnectionSelectionUnavailableError",
      code: "SESSION_CREATE_CONNECTION_SELECTION_UNAVAILABLE",
      retryable: false,
    });
    expect(
      await shared.admin`select id from sessions where workspace_id = ${workspace!.id}`,
    ).toHaveLength(0);
    expect(
      Array.from(
        await shared.admin`select status, authority_generation from connections where id = ${connectionId}`,
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
    expect(
      await shared.admin`select id from sessions where create_idempotency_key = ${key}`,
    ).toHaveLength(0);
    // A genuinely fresh empty selection creates normally; never substitute it
    // for the failed accepted selection inside the implementation.
    const fresh = await createSession(client.db, { ...input, mcpAccountBindings: [] });
    expect(fresh.id).toBeDefined();
    expect(
      Array.from(
        await shared.admin`select initial_mcp_account_bindings from sessions where id = ${fresh.id}`,
      ),
    ).toEqual([{ initial_mcp_account_bindings: [] }]);
  },
  180_000,
);
