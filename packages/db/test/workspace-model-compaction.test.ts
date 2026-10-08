import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, requireWorkspace, updateWorkspaceSettings } from "../src";
import { updateWorkspaceSettingsWithToolDefaults } from "../src/workspace-tool-defaults";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-model-compaction");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("independent atomic model edits, reset and unrelated nested patches compose", async () => {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Synthetic account",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Synthetic workspace",
    subjectId: `subject-${id}`,
  });
  const workspaceId = access.workspaceGrants[0]!.workspaceId!;
  await updateWorkspaceSettings(client.db, workspaceId, { unknownFuture: { keep: true } });
  await Promise.all([
    updateWorkspaceSettings(client.db, workspaceId, {
      modelCompactionThresholds: { "native/fast": 95_000 },
    }),
    updateWorkspaceSettings(client.db, workspaceId, {
      modelCompactionThresholds: { "native/deep": 250_000 },
    }),
  ]);
  expect(
    (await requireWorkspace(client.db, workspaceId)).settings.modelCompactionThresholds,
  ).toEqual({ "native/fast": 95_000, "native/deep": 250_000 });
  const updated = await updateWorkspaceSettingsWithToolDefaults(
    client.db,
    workspaceId,
    {
      modelCompactionThresholds: { "native/fast": null },
      sessionToolDefaults: { firstPartyMcpTools: [] },
      maxNestedAgentDepth: null,
    },
    { requireWorkspace, updateWorkspaceSettings },
  );
  expect(updated.settings.modelCompactionThresholds).toEqual({ "native/deep": 250_000 });
  expect(updated.settings.sessionToolDefaults).toEqual({ firstPartyMcpTools: [] });
  expect(updated.settings.unknownFuture).toEqual({ keep: true });
  expect(updated.settings.maxNestedAgentDepth).toBeUndefined();
  await expect(
    updateWorkspaceSettings(client.db, workspaceId, {
      modelCompactionThresholds: { "native/fast": 3 },
    }),
  ).rejects.toThrow();
  expect(
    (await requireWorkspace(client.db, workspaceId)).settings.modelCompactionThresholds,
  ).toEqual({ "native/deep": 250_000 });
}, 30_000);
