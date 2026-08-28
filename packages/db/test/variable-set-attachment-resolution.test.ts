import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createVariableSet,
  resolveVariableSetAttachments,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("variable-set-attachment-resolution");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("Variable Set attachment resolution", () => {
  test("resolves requested accessible ids in request order on a single-connection pool", async () => {
    if (!client) return;
    const suffix = crypto.randomUUID();
    const subjectId = `subject-${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "variable-set-attachment-resolution",
      accountExternalId: `account-${suffix}`,
      accountName: "Variable Set attachment resolution",
      workspaceExternalSource: "variable-set-attachment-resolution",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Variable Set attachment resolution",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const first = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `first-${suffix}`,
    });
    const second = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `second-${suffix}`,
    });

    await expect(
      resolveVariableSetAttachments(
        client.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId,
        },
        [second.id, crypto.randomUUID(), first.id],
      ),
    ).resolves.toEqual([
      { id: second.id, scope: "workspace" },
      { id: first.id, scope: "workspace" },
    ]);
  });
});
