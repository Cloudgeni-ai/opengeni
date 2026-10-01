import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken, type Session } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
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
        agentConfigAdmissionEnabled: true,
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
    const create = async (agent?: { capabilities: "all" | "none" }): Promise<Session> => {
      const response = await app.request(path, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage: "hello",
          resources: [],
          bundledSkillIds: [],
          ...(agent ? { agent } : {}),
        }),
      });
      expect(response.status).toBe(202);
      return (await response.json()) as Session;
    };
    const legacy = await create();
    const all = await create({ capabilities: "all" });
    const none = await create({ capabilities: "none" });
    expect(Object.hasOwn(legacy, "effectiveTools")).toBe(false);
    for (const created of [all, none]) {
      const names = created.effectiveTools!.tools.map((tool) => tool.name);
      expect(names).not.toContain("web_search");
      expect(names).not.toContain("generate_image");
      expect(names).not.toContain("generate_video");
      expect(names).not.toContain("exec_command");
      expect(created.effectiveTools!.tools.every((tool) => tool.visibility !== undefined)).toBe(
        true,
      );
      const detail = await app.request(`${path}/${created.id}`, { headers: { authorization } });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as Session).effectiveTools).toEqual(created.effectiveTools);
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
  });
});
