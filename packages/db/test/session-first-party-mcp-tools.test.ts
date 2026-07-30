import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, createSession, getSession, type DbClient } from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-first-party-mcp-tools");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("session first-party MCP tool storage", () => {
  test("round-trips an explicit empty selection without widening", async () => {
    if (!shared || !client) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('first-party tools account') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'first-party tools workspace') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;

    const created = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "work",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
      firstPartyMcpTools: [],
    });
    expect(created.firstPartyMcpTools).toEqual([]);
    expect((await getSession(client.db, workspace!.id, created.id))?.firstPartyMcpTools).toEqual(
      [],
    );
  });
});
