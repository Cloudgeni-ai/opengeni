import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { createDb, listWorkspaceStateMemoryRecords, type DbClient } from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const EQUAL_UPDATED_AT = new Date("2026-07-30T08:00:00.000Z");
const MEMORY_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "active",
  "superseded",
  "archived",
] as const;
const MEMORY_KINDS = ["semantic", "episodic", "procedural", "decision", "preference"] as const;

function stableId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

let shared: SharedTestDatabase;
let client: DbClient;
let appProbe: postgres.Sql;
let accountId: string;
let workspaceA: string;
let workspaceB: string;
let expectedWorkspaceAIds: string[];

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_STATE_MEMORY_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_STATE_MEMORY_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const explicitAppPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword: explicitAppPassword });
    const admin = postgres(explicitAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    const acquired = await acquireSharedTestDatabase("workspace-state-memory-projection");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  appProbe = postgres(shared.appUrl, { max: 1, prepare: false });

  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Workspace State memory account') returning id
  `;
  accountId = account!.id;
  const [firstWorkspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Workspace State memory A')
    returning id
  `;
  const [secondWorkspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Workspace State memory B')
    returning id
  `;
  workspaceA = firstWorkspace!.id;
  workspaceB = secondWorkspace!.id;

  expectedWorkspaceAIds = Array.from(
    { length: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT + 2 },
    (_, index) => stableId(index + 1_000),
  );
  const memoryRows = expectedWorkspaceAIds.map((id, index) => ({
    id,
    account_id: account!.id,
    workspace_id: workspaceA,
    status: MEMORY_STATUSES[index % MEMORY_STATUSES.length]!,
    kind: MEMORY_KINDS[index % MEMORY_KINDS.length]!,
    scope: "workspace",
    text: index === 0 ? `BODY_SENTINEL_${"x".repeat(16_384)}` : `memory ${index}`,
    source_refs: index === 0 ? [{ kind: "external", id: "SOURCE_REF_SENTINEL" }] : [],
    metadata: index === 0 ? { marker: "METADATA_SENTINEL" } : {},
    created_at: EQUAL_UPDATED_AT,
    updated_at: EQUAL_UPDATED_AT,
  }));
  await shared.admin`
    insert into knowledge_memories
      (id, account_id, workspace_id, status, kind, scope, text, source_refs, metadata,
       created_at, updated_at)
    select id, account_id, workspace_id, status, kind, scope, text, source_refs, metadata,
           created_at, updated_at
    from jsonb_to_recordset(${shared.admin.json(memoryRows)}::jsonb) as memory(
      id uuid,
      account_id uuid,
      workspace_id uuid,
      status text,
      kind text,
      scope text,
      text text,
      source_refs jsonb,
      metadata jsonb,
      created_at timestamptz,
      updated_at timestamptz
    )
  `;
  await shared.admin`
    update knowledge_memories
    set embedding = ${`[${Array.from({ length: 3_072 }, () => "0").join(",")}]`}::vector
    where id = ${expectedWorkspaceAIds[0]!}
  `;
  await shared.admin`
    insert into knowledge_memories
      (id, account_id, workspace_id, status, kind, scope, text, source_refs, metadata,
       created_at, updated_at)
    values
      (${stableId(9_000)}, ${account!.id}, ${workspaceB}, 'active', 'decision', 'workspace',
       'TENANT_B_BODY_SENTINEL', ${shared.admin.json([
         { kind: "external", id: "tenant-b" },
       ])}::jsonb,
       ${shared.admin.json({ marker: "tenant-b" })}::jsonb,
       ${EQUAL_UPDATED_AT}, ${EQUAL_UPDATED_AT})
  `;

  // A successful projection under these grants proves the executed PostgreSQL
  // query cannot select general Memory bodies, provenance blobs, metadata, or
  // embeddings. The dedicated test database is dropped after this file.
  await shared.admin.unsafe('REVOKE SELECT ON TABLE "knowledge_memories" FROM opengeni_app');
  await shared.admin.unsafe(
    'GRANT SELECT ("id", "workspace_id", "status", "kind", "updated_at") ON TABLE "knowledge_memories" TO opengeni_app',
  );
}, 180_000);

afterAll(async () => {
  await appProbe?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("Workspace State Memory projection (real PostgreSQL + FORCE RLS)", () => {
  test("is tenant-scoped, fixed-limit, and deterministic for equal timestamps", async () => {
    const [posture] = await shared.admin<
      Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>
    >`
      select relrowsecurity as "rowSecurity", relforcerowsecurity as "forceRowSecurity"
      from pg_class
      where oid = 'knowledge_memories'::regclass
    `;
    expect(posture).toEqual({ rowSecurity: true, forceRowSecurity: true });

    const firstRead = await listWorkspaceStateMemoryRecords(client.db, workspaceA);
    const secondRead = await listWorkspaceStateMemoryRecords(client.db, workspaceA);
    expect(firstRead).toHaveLength(WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT);
    expect(secondRead).toEqual(firstRead);
    expect(firstRead.map((record) => record.id)).toEqual(
      expectedWorkspaceAIds.slice(0, WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT),
    );
    expect(Object.keys(firstRead[0]!).sort()).toEqual(["id", "kind", "status", "updatedAt"]);
    expect(JSON.stringify(firstRead)).not.toContain("BODY_SENTINEL");
    expect(JSON.stringify(firstRead)).not.toContain("SOURCE_REF_SENTINEL");
    expect(JSON.stringify(firstRead)).not.toContain("METADATA_SENTINEL");
    expect(JSON.stringify(firstRead)).not.toContain("TENANT_B_BODY_SENTINEL");

    const tenantBRead = await listWorkspaceStateMemoryRecords(client.db, workspaceB);
    expect(tenantBRead).toEqual([
      {
        id: stableId(9_000),
        status: "active",
        kind: "decision",
        updatedAt: EQUAL_UPDATED_AT.toISOString(),
      },
    ]);
  });

  test("succeeds without body/vector privileges while direct body/vector reads fail", async () => {
    const projected = await listWorkspaceStateMemoryRecords(client.db, workspaceA);
    expect(projected).toHaveLength(WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT);

    await expect(
      appProbe.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspaceA}, true)`;
        return await tx`
          select text, source_refs, metadata, embedding
          from knowledge_memories
          where workspace_id = ${workspaceA}
          limit 1
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
