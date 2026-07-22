import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createRig,
  createRigChange,
  createRigVersion,
  getRigChange,
  updateRigChangeStatus,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let accountId = "";
let workspaceId = "";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_rigs_mcp");
  if (!shared) {
    available = false;
    console.warn("[rigs-mcp] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    accountName: "Rigs MCP",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    workspaceName: "Rigs MCP",
    subjectId: "user:mcp",
  });
  accountId = access.defaultAccountId!;
  workspaceId = access.defaultWorkspaceId!;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("rig MCP tools", () => {
  test("rig_list and rig_get are available under rigs:use", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-list-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));
    const tools = toolNames(server);
    expect(tools).toContain("rig_list");
    expect(tools).toContain("rig_get");

    const listed = await callMcpTool<{ rigs: Array<{ id: string }> }>(server, "rig_list", {});
    expect(listed.rigs.some((candidate) => candidate.id === rig.id)).toBe(true);
    const got = await callMcpTool<{ rig: { id: string }; versions: unknown[]; changes: unknown[] }>(
      server,
      "rig_get",
      { rigId: rig.id },
    );
    expect(got.rig.id).toBe(rig.id);
    expect(got.versions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(got.changes)).toBe(true);

    const clamped = await callMcpTool<{ versions: unknown[]; changes: unknown[] }>(
      server,
      "rig_get",
      { rigId: rig.id, versionLimit: 1_000, changeLimit: 1_000 },
    );
    expect(clamped.versions).toHaveLength(1);
    expect(clamped.changes).toHaveLength(0);
  });

  test("rig_propose_change creates a setup_append change and triggers verification", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const sessionId = crypto.randomUUID();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-propose-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "mkdir -p /opt/mcp", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"], { sessionId }));
    const proposed = await callMcpTool<{
      change: { id: string; status: string };
      verificationStarted: boolean;
    }>(server, "rig_propose_change", {
      rigId: rig.id,
      command: "touch /opt/mcp/tool",
      note: "mcp proposal",
      idempotencyKey: "mcp-rig-proposal-1",
    });
    expect(proposed.change.status).toBe("verifying");
    expect(proposed.verificationStarted).toBe(true);
    expect(workflow.rigVerifications).toEqual([
      {
        workspaceId,
        changeId: proposed.change.id,
        attempt: 1,
        workflowId: `rig-verification-change-${proposed.change.id}-attempt-1`,
      },
    ]);
    const stored = await getRigChange(client.db, workspaceId, proposed.change.id);
    expect(stored?.kind).toBe("setup_append");
    expect(stored?.proposedBy).toBe(`session:${sessionId}`);
    expect(stored?.idempotencyKey).toBe("mcp-rig-proposal-1");
  });

  test("rig_get keeps one bounded active definition and summary-only history", async () => {
    if (!available) return;
    const huge = "界🙂".repeat(75_000);
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-bounded-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: {
        image: `registry.example.com/${huge}`,
        setupScript: `echo active-start\n${huge}\necho active-end`,
        checks: Array.from({ length: 40 }, (_, index) => ({
          name: `check-${index}`,
          command: `${huge}-${index}`,
        })),
        credentialHooks: Array.from({ length: 100 }, (_, index) => `${huge}-${index}`),
        changelog: huge,
      },
    });
    for (let version = 2; version <= 7; version += 1) {
      await createRigVersion(client.db, workspaceId, rig.id, {
        image: `registry.example.com/version-${version}-${huge}`,
        setupScript: `echo version-${version}\n${huge}`,
        checks: Array.from({ length: version }, (_, index) => ({
          name: `v${version}-check-${index}`,
          command: huge,
        })),
        changelog: `${huge}-${version}`,
      });
    }
    for (let index = 0; index < 7; index += 1) {
      const change = await createRigChange(client.db, {
        accountId,
        workspaceId,
        rigId: rig.id,
        baseVersionId: rig.activeVersion!.id,
        kind: "setup_append",
        payload: {
          command: `echo change-${index}\n${huge}`,
          nested: { exactPayloadMustNotReachModelHistory: huge },
        },
        proposedBy: `session:${crypto.randomUUID()}`,
      });
      await updateRigChangeStatus(client.db, workspaceId, change.id, {
        status: "verifying",
        verification: {
          attempt: index + 1,
          startedAt: `2026-07-19T00:00:0${index}.000Z`,
          finishedAt: `2026-07-19T00:01:0${index}.000Z`,
          passed: index % 2 === 0,
          log: `verification-${index}-${huge}`,
        },
      });
    }

    const server = buildOpenGeniMcpServer(deps(new FakeWorkflowClient()), grant(["rigs:use"]));
    const got = await callMcpTool<{
      rig: {
        activeVersion: { setupScript: string; checks: unknown };
        versionCount: number;
      };
      versions: Array<Record<string, unknown>>;
      versionsTotal: number;
      versionsTruncated: boolean;
      changes: Array<Record<string, unknown>>;
      changesTotal: number;
      changesTruncated: boolean;
      projection: {
        bytes: number;
        maxBytes: number;
        truncated: boolean;
        fields: Record<string, { originalBytes: number | null; truncated: boolean }>;
      };
    }>(server, "rig_get", { rigId: rig.id, versionLimit: 3, changeLimit: 5 });
    expect(got.projection.bytes).toBe(Buffer.byteLength(JSON.stringify(got, null, 2), "utf8"));
    expect(got.projection.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(got.projection.maxBytes).toBe(64 * 1024);
    expect(got.projection.truncated).toBeTrue();
    expect(got.rig.versionCount).toBe(7);
    expect(got.rig.activeVersion.setupScript).toContain("model monitoring projection");
    expect(got.versionsTotal).toBe(7);
    expect(got.versionsTruncated).toBeTrue();
    expect(got.versions).toHaveLength(3);
    expect(got.versions[0]).toMatchObject({
      setupScriptBytes: expect.any(Number),
      checkCount: expect.any(Number),
    });
    expect(got.versions[0]).not.toHaveProperty("setupScript");
    expect(got.versions[0]).not.toHaveProperty("checks");
    expect(got.changesTotal).toBe(7);
    expect(got.changesTruncated).toBeTrue();
    expect(got.changes).toHaveLength(5);
    expect(got.changes[0]).toMatchObject({
      payloadBytes: expect.any(Number),
      verificationBytes: expect.any(Number),
      verificationLogBytes: expect.any(Number),
      verificationPassed: expect.any(Boolean),
    });
    expect(got.changes[0]).not.toHaveProperty("payload");
    expect(got.changes[0]).not.toHaveProperty("verification");
    expect(JSON.stringify(got)).not.toContain("exactPayloadMustNotReachModelHistory");
    expect(got.projection.fields.activeSetupScript.originalBytes).toBeGreaterThan(100_000);
  });

  test("rig_promote is not agent-visible even with rigs:manage", async () => {
    const server = buildOpenGeniMcpServer(
      deps(new FakeWorkflowClient()),
      grant(["rigs:use", "rigs:manage"]),
    );
    expect(toolNames(server)).not.toContain("rig_promote");
    await expect(
      callMcpTool(server, "rig_promote", {
        rigId: crypto.randomUUID(),
        changeId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("MCP tool not registered");
  });
});

function deps(
  workflowClient: SessionWorkflowClient,
  db = client?.db ?? ({} as never),
): ApiRouteDeps {
  return {
    settings: testSettings({}),
    db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

function grant(permissions: Permission[], metadata: Record<string, unknown> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:mcp",
    permissions,
    metadata,
  };
}

function toolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).sort();
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  rigVerifications: unknown[] = [];
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(input: unknown): Promise<void> {
    this.rigVerifications.push(input);
  }
}
