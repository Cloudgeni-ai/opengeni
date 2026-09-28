import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimPendingSessionSystemUpdateOutbox,
  createDb,
  createSession,
  getOrCreateSessionSystemUpdateOutbox,
} from "../src/index";

// The outbox claim is deployment-global. This file owns its database, so every
// claim below sees exactly the rows these tests created.
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0528-outbox-claim-order");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function parentWithChildren(children: number) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Outbox claim order",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Outbox claim order",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspace = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const create = (initialMessage: string) =>
    createSession(client.db, {
      ...workspace,
      initialMessage,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
  const parent = await create("parent");
  const childIds: string[] = [];
  for (let index = 0; index < children; index += 1) {
    childIds.push((await create(`child ${index}`)).id);
  }
  return { ...workspace, parentId: parent.id, childIds };
}

type Parent = Awaited<ReturnType<typeof parentWithChildren>>;

async function childResult(parent: Parent, childId: string) {
  return await getOrCreateSessionSystemUpdateOutbox(client.db, {
    accountId: parent.accountId,
    workspaceId: parent.workspaceId,
    sourceSessionId: childId,
    targetSessionId: parent.parentId,
    dedupeKey: `child-result:${childId}`,
    kind: "child_terminal_result",
    classification: "success",
    sourceId: childId,
    summary: `child ${childId} finished`,
    payload: { type: "child_terminal_result", childSessionId: childId, status: "idle" },
    lineage: { childSessionId: childId, parentSessionId: parent.parentId },
    personalConnectionDelegations: [],
    mcpAccountBindings: [],
    xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
  });
}

async function heapOrder(ids: string[]): Promise<string[]> {
  const [row] = await shared.admin<{ ids: string[] }[]>`
    select array_agg(id::text order by ctid) as ids
    from session_system_update_outbox
    where id = any(${ids}::uuid[])
  `;
  return row?.ids ?? [];
}

test("the migration is rolling", async () => {
  const migration = await readFile(
    new URL("../drizzle/0528_system_update_outbox_claim_order.sql", import.meta.url),
    "utf8",
  );
  expect(migration.split("\n")[0]).toBe("-- deployment-mode: rolling");
});

test("the claim keeps its row type, private definer posture, and pinned search_path", async () => {
  const [claim] = await shared.admin<
    {
      result: string;
      securityDefiner: boolean;
      config: string[] | null;
      appExecute: boolean;
      publicExecute: boolean;
    }[]
  >`
    select
      pg_get_function_result(procedure.oid) as "result",
      procedure.prosecdef as "securityDefiner",
      procedure.proconfig as "config",
      has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
      exists (
        select 1 from aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ) as "publicExecute"
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'opengeni_private'
      and procedure.proname = 'claim_session_system_update_outbox'
  `;
  // 0528 reads the row type from the installed function; after the full
  // ledger that is exactly the 0494 shape current callers read.
  expect(claim).toEqual({
    result:
      "TABLE(id uuid, account_id uuid, workspace_id uuid, source_session_id uuid, " +
      "target_session_id uuid, dedupe_key text, kind text, classification text, " +
      "source_id text, summary text, summary_codec_version integer, payload jsonb, " +
      "payload_codec_version integer, lineage jsonb, mcp_account_bindings jsonb, " +
      "personal_connection_delegations jsonb, codex_provider_account_authority_snapshot jsonb, " +
      "xai_provider_account_authority_snapshot jsonb)",
    securityDefiner: true,
    config: ["search_path=pg_catalog, public"],
    appExecute: true,
    publicExecute: false,
  });
});

test("claimed rows come back in production order even when the heap order differs", async () => {
  const parent = await parentWithChildren(3);
  const produced = [];
  for (const childId of parent.childIds) produced.push(await childResult(parent, childId));
  const producedIds = produced.map((row) => row.id);
  // Relocate the oldest row's tuple behind the others, as free-space reuse or
  // any earlier update of that row (a previous claim's attempt bump) can.
  await shared.admin`
    update session_system_update_outbox set updated_at = updated_at where id = ${producedIds[0]!}
  `;
  expect(await heapOrder(producedIds)).toEqual([producedIds[1]!, producedIds[2]!, producedIds[0]!]);

  const claimed = await claimPendingSessionSystemUpdateOutbox(client.db, 100);

  expect(
    claimed.filter((row) => row.targetSessionId === parent.parentId).map((row) => row.id),
  ).toEqual(producedIds);
  const attempts = await shared.admin<{ id: string; attempts: number }[]>`
    select id::text, attempts from session_system_update_outbox where id = any(${producedIds}::uuid[])
  `;
  expect(attempts.every((row) => row.attempts === 1)).toBe(true);
});
