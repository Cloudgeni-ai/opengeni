import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { appendSessionEvents, createDb, createSession, type DbClient } from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0661_session_first_party_default_intent.sql",
  import.meta.url,
);
let fixture: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | undefined;
let client: DbClient | undefined;

beforeAll(async () => {
  fixture = await acquireOwnerMigratedTestDatabase("first-party-default-intent");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  await migrate(fixture.ownerUrl);
  owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => undefined });
  client = createDb(fixture.adminUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await fixture?.release();
}, 180_000);

test("only proven default resets migrate under the non-bypass owner; retries are inert", async () => {
  if (!fixture || !owner || !client) return;
  const admin = fixture.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts(name) values ('Default intent fixture') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces(account_id, name) values (${account!.id}, 'Default intent') returning id`;
  await admin`insert into workspace_inference_controls(workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const selected = ["session_get", "session_events"];
  const cases = [
    {
      name: "reset changed selection",
      beforeMode: "workspace_default",
      before: ["session_get"],
      migrate: true,
    },
    { name: "reset explicit selection", beforeMode: "explicit", before: selected, migrate: true },
    {
      name: "connector-only edit",
      beforeMode: "workspace_default",
      before: selected,
      migrate: false,
    },
    {
      name: "explicit pin",
      beforeMode: "workspace_default",
      before: ["session_get"],
      afterMode: "explicit",
      migrate: false,
    },
    { name: "no retained event", skipEvent: true, migrate: false },
    {
      name: "stored list changed",
      beforeMode: "workspace_default",
      before: [],
      stored: ["session_get"],
      migrate: false,
    },
    {
      name: "explicit empty",
      beforeMode: "workspace_default",
      before: selected,
      afterMode: "explicit",
      stored: [],
      migrate: false,
    },
    {
      name: "already pinned intent",
      beforeMode: "workspace_default",
      before: [],
      firstPartyMode: "explicit" as const,
      migrate: false,
    },
    {
      name: "later explicit pin",
      beforeMode: "workspace_default",
      before: [],
      laterPin: true,
      migrate: false,
    },
  ];
  const ids: string[] = [];
  for (const item of cases) {
    const session = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: item.name,
      resources: [],
      tools: [],
      toolPolicy: {
        mode: "workspace_default",
        inheritedFromSessionId: null,
        ...(item.firstPartyMode ? { firstPartyMode: item.firstPartyMode } : {}),
      },
      firstPartyMcpTools: (item.stored ?? selected) as FirstPartyMcpToolName[],
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      metadata: {},
    });
    ids.push(session.id);
    if (item.skipEvent) continue;
    const payload = {
      before: { mode: item.beforeMode, firstPartyMcpTools: item.before },
      after: { mode: item.afterMode ?? "workspace_default", firstPartyMcpTools: selected },
    };
    await appendSessionEvents(client.db, workspace!.id, session.id, [
      { type: "session.tool_policy.updated", payload },
    ]);
    if (item.laterPin) {
      await appendSessionEvents(client.db, workspace!.id, session.id, [
        {
          type: "session.tool_policy.updated",
          payload: { ...payload, after: { mode: "explicit", firstPartyMcpTools: selected } },
        },
      ]);
    }
  }
  const source = await readFile(migrationUrl, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  const [posture] = await admin<{ superuser: boolean; bypass: boolean }[]>`
    select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = ${fixture.ownerRole}`;
  expect(posture).toEqual({ superuser: false, bypass: false });
  for (let pass = 0; pass < 2; pass++) {
    await owner.begin(async (tx) => {
      await tx.unsafe(source);
    });
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index]!;
      const [row] = await admin<{ mode: string | null; version: number; tools: string[] }[]>`
        select tool_policy ->> 'firstPartyMode' as mode, tool_policy_version as version,
          first_party_mcp_tools as tools from sessions where id = ${ids[index]!}`;
      expect(row, item.name).toEqual({
        mode: item.migrate ? "workspace_default" : (item.firstPartyMode ?? null),
        version: item.migrate ? 2 : 1,
        tools: item.stored ?? selected,
      });
    }
    const tables = await admin<{ forced: boolean }[]>`
      select relforcerowsecurity as forced from pg_class where oid in ('sessions'::regclass, 'session_events'::regclass)`;
    expect([...tables]).toEqual([{ forced: true }, { forced: true }]);
  }
}, 30_000);
