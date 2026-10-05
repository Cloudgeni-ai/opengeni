import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import { signDelegatedAccessToken, type Session } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const secret = "session-effective-tools-route-test";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-effective-tools");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL unavailable");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("effectiveTools on session responses (PostgreSQL)", () => {
  test("create, detail, and list share environment narrowing; null stays legacy", async () => {
    if (!client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "effective-tools-test",
      accountExternalId: suffix,
      accountName: "Effective tools",
      workspaceExternalSource: "effective-tools-test",
      workspaceExternalId: suffix,
      workspaceName: "Effective tools",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: ["sessions:create", "sessions:read", "sessions:control", "goals:manage"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
    const noop = async () => undefined;
    const app = createApp({
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret: secret,
        environmentsEncryptionKey: Buffer.alloc(32, 57).toString("base64"),
        sandboxBackend: "none",
        webSearchEnabled: false,
        lazyToolSearchEnabled: true,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
        signalSessionControl: noop,
        syncScheduledTask: noop,
        deleteScheduledTaskSchedule: noop,
        triggerScheduledTask: noop,
      },
    } as Parameters<typeof createApp>[0]);
    const path = `/v1/workspaces/${grant.workspaceId}/sessions`;
    const create = async (
      agent?: { capabilities: "all" | "none" },
      bundledSkillIds: string[] | "omit" = [],
    ): Promise<Session> => {
      const response = await app.request(path, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage: "hello",
          resources: [],
          ...(bundledSkillIds !== "omit" ? { bundledSkillIds } : {}),
          ...(agent ? { agent } : {}),
        }),
      });
      expect(response.status).toBe(202);
      return (await response.json()) as Session;
    };
    // A session created before agent configuration keeps a null config.
    const legacy = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "hello",
      resources: [],
      tools: [],
      metadata: {},
      model: testSettings().openaiModel,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
      createdByContext: {},
    });
    const omitted = await create();
    const all = await create({ capabilities: "all" });
    const none = await create({ capabilities: "none" });
    expect(omitted.agent).toMatchObject({ source: "deployment_default" });
    for (const created of [omitted, all, none]) {
      const names = created.effectiveTools!.tools.map((tool) => tool.name);
      expect(names).not.toContain("web_search");
      expect(names).not.toContain("generate_image");
      expect(names).not.toContain("generate_video");
      expect(names).not.toContain("exec_command");
      expect(created.effectiveTools!.tools.every((tool) => tool.visibility !== undefined)).toBe(
        true,
      );
      const workspaceRead = spyOn(database, "requireWorkspace");
      try {
        const detail = await app.request(`${path}/${created.id}`, { headers: { authorization } });
        expect(detail.status).toBe(200);
        expect(((await detail.json()) as Session).effectiveTools).toEqual(created.effectiveTools);
        expect(workspaceRead).toHaveBeenCalledTimes(1);
      } finally {
        workspaceRead.mockRestore();
      }
    }
    expect(none.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("skill_read");
    const list = await app.request(path, { headers: { authorization } });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Session[];
    expect(Object.hasOwn(rows.find((row) => row.id === legacy.id)!, "effectiveTools")).toBe(false);
    for (const created of [all, none]) {
      expect(rows.find((row) => row.id === created.id)?.effectiveTools).toEqual(
        created.effectiveTools,
      );
    }

    // "none" freezes no bundled guides unless the request lists them; "all"
    // keeps the omitted bundled defaults.
    const noneOmitted = await create({ capabilities: "none" }, "omit");
    expect(noneOmitted.bundledSkillIds).toEqual([]);
    expect(noneOmitted.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("skill_read");
    const noneExplicit = await create({ capabilities: "none" }, ["builtin:opengeni-help"]);
    expect(noneExplicit.bundledSkillIds).toEqual(["builtin:opengeni-help"]);
    expect(noneExplicit.effectiveTools!.tools.map((tool) => tool.name)).toContain("skill_read");
    const allOmitted = await create({ capabilities: "all" }, "omit");
    expect(allOmitted.bundledSkillIds).toBeUndefined();
    expect(allOmitted.effectiveTools!.tools.map((tool) => tool.name)).toContain("skill_read");
    const noneDetail = await app.request(`${path}/${noneOmitted.id}`, {
      headers: { authorization },
    });
    expect(((await noneDetail.json()) as Session).bundledSkillIds).toEqual([]);

    // No sandbox or Connected Machine: background-command tools are withheld.
    for (const created of [all, none, noneOmitted]) {
      const names = created.effectiveTools!.tools.map((tool) => tool.name);
      expect(names).not.toContain("opengeni__command_read");
      expect(names).not.toContain("opengeni__command_wait");
    }
  });
});
