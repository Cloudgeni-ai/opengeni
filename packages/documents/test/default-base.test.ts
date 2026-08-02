import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bootstrapWorkspace, createDb, deleteWorkspace, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { createDocumentBase, ensureDefaultBase, listDocumentBasesEnsuringDefault } from "../src";

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let grant: Grant;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_DOCUMENT_DEFAULT_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_DOCUMENT_DEFAULT_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const appPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword });
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
    const acquired = await acquireSharedTestDatabase("documents-default-base");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl, { max: 16 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `documents-default-account-${crypto.randomUUID()}`,
    accountName: "Documents Default account",
    workspaceExternalSource: "test",
    workspaceExternalId: `documents-default-workspace-${crypto.randomUUID()}`,
    workspaceName: "Documents Default workspace",
    subjectId: "user:documents-default",
  });
  grant = access.workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && grant) await deleteWorkspace(client.db, grant.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

describe("Default document collection", () => {
  test("adopts legacy names and converges across rename, delete, and concurrent recreation", async () => {
    const legacy = await createDocumentBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: " default ",
      description: "Preserved user-created collection",
    });

    const adopted = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await ensureDefaultBase(client.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
          }),
      ),
    );
    expect(new Set(adopted.map((base) => base.id))).toEqual(new Set([legacy.id]));

    await shared.admin`
      update document_bases
      set name = 'Archive', updated_at = now()
      where id = ${legacy.id}
    `;
    const afterRename = await listDocumentBasesEnsuringDefault(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    const recreatedAfterRename = afterRename.find(
      (base) => base.name.trim().toLowerCase() === "default",
    );
    expect(recreatedAfterRename?.id).toBeDefined();
    expect(recreatedAfterRename?.id).not.toBe(legacy.id);
    expect(afterRename.some((base) => base.id === legacy.id && base.name === "Archive")).toBe(true);

    const repeatedList = await listDocumentBasesEnsuringDefault(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    expect(repeatedList.find((base) => base.name.trim().toLowerCase() === "default")?.id).toBe(
      recreatedAfterRename?.id,
    );

    await shared.admin`
      delete from document_bases
      where id = ${recreatedAfterRename!.id}
    `;
    const recreatedAfterDelete = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await ensureDefaultBase(client.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
          }),
      ),
    );
    expect(new Set(recreatedAfterDelete.map((base) => base.id)).size).toBe(1);
    expect(recreatedAfterDelete[0]?.id).not.toBe(recreatedAfterRename?.id);

    const finalList = await listDocumentBasesEnsuringDefault(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    expect(finalList.filter((base) => base.name.trim().toLowerCase() === "default")).toHaveLength(
      1,
    );
  });
});
