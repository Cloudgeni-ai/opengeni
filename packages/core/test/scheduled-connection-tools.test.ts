import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createDb, createSession, type DbClient } from "@opengeni/db";
import type { Session, ToolRef } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { scheduledConnectionTools } from "../src/domain/scheduled-tasks";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let target: Session;
const selected: ToolRef = { kind: "mcp", id: "selected", optional: true, eager: true };
const mandatory: ToolRef = { kind: "mcp", id: "opengeni" };
const settings = testSettings({
  codexConnectedAppsEnabled: false,
  mcpServers: ["selected", "default-a", "default-b"].map((id) => ({
    id,
    url: `https://${id}.example/mcp`,
    cacheToolsList: false,
  })),
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("scheduled-connection-tools");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${"scheduled tool policy"}) returning id`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${"Team"}) returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  target = await createSession(client.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "scheduled tool policy",
    resources: [],
    tools: [selected, { kind: "mcp", id: "removed" }],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

for (const mode of ["explicit", "inherited"] as const) {
  test(`${mode} target preserves selected refs and mandatory tools without reading ignored defaults`, async () => {
    if (!shared) return;
    const read = spyOn(client.db, "transaction");
    try {
      const result = await scheduledConnectionTools(
        client.db,
        target.workspaceId,
        settings,
        {
          ...target,
          toolPolicy: { mode, inheritedFromSessionId: mode === "inherited" ? target.id : null },
        },
        [{ kind: "mcp", id: "default-b" }],
      );
      expect(result).toEqual([selected, mandatory]);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
}

test("workspace-default target observes changed defaults and exclusions on the next call", async () => {
  if (!shared) return;
  const defaultTarget: Session = {
    ...target,
    toolPolicy: {
      mode: "workspace_default",
      inheritedFromSessionId: null,
      excludedMcpServerIds: ["default-b"],
    },
  };
  const setDefaults = async (ids: string[]) => {
    await shared!.admin`update workspaces set settings = settings || ${shared!.admin.json({
      sessionToolDefaults: { mcpServerIds: ids },
    })} where id = ${target.workspaceId}`;
  };
  await setDefaults(["default-a", "default-b"]);
  expect(
    await scheduledConnectionTools(client.db, target.workspaceId, settings, defaultTarget, []),
  ).toEqual([selected, { kind: "mcp", id: "default-a", optional: true }, mandatory]);
  await setDefaults(["default-b"]);
  expect(
    await scheduledConnectionTools(client.db, target.workspaceId, settings, defaultTarget, []),
  ).toEqual([selected, mandatory]);
  await expect(
    scheduledConnectionTools(client.db, crypto.randomUUID(), settings, defaultTarget, []),
  ).rejects.toThrow();
});

test("new-session schedule keeps its task refs without a target lookup", async () => {
  if (!shared) return;
  const read = spyOn(client.db, "transaction");
  try {
    expect(
      await scheduledConnectionTools(client.db, target.workspaceId, settings, null, [selected]),
    ).toEqual([selected, mandatory]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
