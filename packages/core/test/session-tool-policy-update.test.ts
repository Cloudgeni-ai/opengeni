import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  type AccessGrant,
  type SessionToolPolicy,
  type ToolRef,
  type UpdateSessionToolPolicyRequest,
} from "@opengeni/contracts";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  getSession,
  SessionToolPolicyVersionConflictError,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { updateSessionToolPolicy } from "../src/domain/sessions";

const OPENGENI: ToolRef = { kind: "mcp", id: "opengeni" };
const DOCS: ToolRef = { kind: "mcp", id: "docs" };
const OPTIONAL_DOCS: ToolRef = { kind: "mcp", id: "docs", optional: true };
const FILES: ToolRef = { kind: "mcp", id: "files" };
const EXPLICIT: SessionToolPolicy = {
  mode: "explicit",
  inheritedFromSessionId: null,
};

const settings = testSettings({
  mcpServers: [
    {
      id: "opengeni",
      url: "https://opengeni.example/mcp",
      cacheToolsList: false,
    },
    { id: "docs", url: "https://docs.example/mcp", cacheToolsList: false },
    { id: "files", url: "https://files.example/mcp", cacheToolsList: false },
  ],
});

let available = true;
let shared: SharedTestDatabase | null = null;
let firstClient: DbClient | null = null;
let secondClient: DbClient | null = null;
let firstDb: Database;
let secondDb: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-tool-policy-update");
  if (!shared) {
    available = false;
    return;
  }
  firstClient = createDb(shared.appUrl);
  secondClient = createDb(shared.appUrl);
  firstDb = firstClient.db;
  secondDb = secondClient.db;
}, 180_000);

afterAll(async () => {
  await Promise.all([firstClient?.close(), secondClient?.close()]);
  await shared?.release();
}, 180_000);

async function workspace(label: string): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`${label} account`}) returning id`;
  const [created] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`${label} workspace`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${created!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: created!.id };
}

async function session(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    tools: ToolRef[];
    toolPolicy?: SessionToolPolicy;
    parentSessionId?: string;
  },
) {
  return await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "tool-policy test",
    resources: [],
    tools: input.tools,
    toolPolicy: input.toolPolicy ?? EXPLICIT,
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
}

function grant(workspaceId: string, accountId: string): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:session-tool-policy-test",
    permissions: ["sessions:control"],
  };
}

function deps(db: Database, bus: MemoryEventBus, settingsOverride = settings) {
  return { db, bus, settings: settingsOverride };
}

function explicitTools(tools: ToolRef[], expectedVersion: number): UpdateSessionToolPolicyRequest {
  return {
    mode: "explicit",
    tools,
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
    expectedVersion,
  };
}

describe("durable session tool-policy updates", () => {
  test("persists the policy/version, publishes a bounded audit event, and treats a repeat as a no-op", async () => {
    if (!available) return;
    const owner = await workspace("policy-update");
    const created = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const bus = new MemoryEventBus();

    const updated = await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      explicitTools([OPENGENI, DOCS], 1),
    );

    expect(updated.tools).toEqual([OPENGENI, DOCS]);
    expect(updated.toolPolicy).toEqual(EXPLICIT);
    expect(updated.toolPolicyVersion).toBe(2);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]).toHaveLength(1);
    expect(bus.published[0]![0]).toMatchObject({
      type: "session.tool_policy.updated",
      payload: {
        before: {
          mode: "explicit",
          inheritedFromSessionId: null,
          toolIds: ["opengeni"],
        },
        after: {
          mode: "explicit",
          inheritedFromSessionId: null,
          toolIds: ["docs", "opengeni"],
        },
        version: 2,
        effectiveFrom: "next_attempt",
      },
    });
    expect(JSON.stringify(bus.published[0])).not.toContain("https://");

    const repeated = await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      explicitTools([OPENGENI, DOCS], 2),
    );
    expect(repeated.toolPolicyVersion).toBe(2);
    expect(bus.published).toHaveLength(1);

    const persisted = await getSession(firstDb, owner.workspaceId, created.id);
    expect(persisted?.toolPolicyVersion).toBe(2);
    expect(persisted?.tools).toEqual([OPENGENI, DOCS]);
  }, 180_000);

  test("rejects unknown optional refs instead of silently dropping them", async () => {
    if (!available) return;
    const owner = await workspace("unknown-optional");
    const created = await session(firstDb, { ...owner, tools: [OPENGENI] });

    await expect(
      updateSessionToolPolicy(
        deps(firstDb, new MemoryEventBus()),
        grant(owner.workspaceId, owner.accountId),
        created.id,
        explicitTools([{ kind: "mcp", id: "not-configured", optional: true }], 1),
      ),
    ).rejects.toMatchObject({ status: 422 });
  }, 180_000);

  test("keeps optional-to-strict changes visible in the durable audit snapshot", async () => {
    if (!available) return;
    const owner = await workspace("optional-to-strict");
    const created = await session(firstDb, {
      ...owner,
      tools: [OPENGENI, OPTIONAL_DOCS],
    });
    const bus = new MemoryEventBus();

    await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      explicitTools([OPENGENI, DOCS], 1),
    );

    const payload = bus.published[0]![0]!.payload as {
      before: { toolRefs: ToolRef[]; toolCount: number; truncated: boolean };
      after: { toolRefs: ToolRef[]; toolCount: number; truncated: boolean };
    };
    expect(payload.before.toolRefs).toContainEqual(OPTIONAL_DOCS);
    expect(payload.before.toolCount).toBe(2);
    expect(payload.before.truncated).toBe(false);
    expect(payload.after.toolRefs).toContainEqual(DOCS);
    expect(payload.after.toolRefs).not.toContainEqual(OPTIONAL_DOCS);
    expect(payload.after.toolCount).toBe(2);
    expect(payload.after.truncated).toBe(false);
  }, 180_000);

  test("records the workspace-default to explicit policy transition in the audit snapshot", async () => {
    if (!available) return;
    const owner = await workspace("audit-workspace-default-transition");
    const created = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    });
    const bus = new MemoryEventBus();

    await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      explicitTools([OPENGENI, DOCS], 1),
    );

    const payload = bus.published[0]![0]!.payload as {
      before: { mode: string; inheritedFromSessionId: string | null };
      after: { mode: string; inheritedFromSessionId: string | null };
    };
    expect(payload.before).toMatchObject({
      mode: "workspace_default",
      inheritedFromSessionId: null,
    });
    expect(payload.after).toMatchObject({
      mode: "explicit",
      inheritedFromSessionId: null,
    });
  }, 180_000);

  test("lets an existing top-level explicit session explicitly adopt workspace defaults", async () => {
    if (!available) return;
    const owner = await workspace("adopt-workspace-defaults");
    const created = await session(firstDb, {
      ...owner,
      tools: [OPENGENI, DOCS],
    });
    const bus = new MemoryEventBus();

    const updated = await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      { mode: "workspace_default", expectedVersion: 1 },
    );

    expect(updated.tools).toEqual([OPENGENI]);
    expect(updated.toolPolicy).toEqual({
      mode: "workspace_default",
      inheritedFromSessionId: null,
    });
    expect(updated.toolPolicyVersion).toBe(2);
    expect(bus.published[0]![0]).toMatchObject({
      type: "session.tool_policy.updated",
      payload: {
        before: { mode: "explicit", toolIds: ["docs", "opengeni"] },
        after: { mode: "workspace_default", toolIds: ["opengeni"] },
        version: 2,
        effectiveFrom: "next_attempt",
      },
    });
  }, 180_000);

  test("allows default adoption only through a workspace-default parent ceiling", async () => {
    if (!available) return;
    const owner = await workspace("child-adopt-workspace-defaults");
    const defaultParent = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    });
    const defaultChild = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      parentSessionId: defaultParent.id,
      toolPolicy: { mode: "explicit", inheritedFromSessionId: defaultParent.id },
    });

    const adopted = await updateSessionToolPolicy(
      deps(firstDb, new MemoryEventBus()),
      grant(owner.workspaceId, owner.accountId),
      defaultChild.id,
      { mode: "workspace_default", expectedVersion: 1 },
    );
    expect(adopted.toolPolicy).toEqual({
      mode: "workspace_default",
      inheritedFromSessionId: defaultParent.id,
    });

    const explicitParent = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const explicitChild = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      parentSessionId: explicitParent.id,
      toolPolicy: { mode: "inherited", inheritedFromSessionId: explicitParent.id },
    });
    await expect(
      updateSessionToolPolicy(
        deps(firstDb, new MemoryEventBus()),
        grant(owner.workspaceId, owner.accountId),
        explicitChild.id,
        { mode: "workspace_default", expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ status: 403 });
  }, 180_000);

  test("records the inherited to explicit policy transition in the audit snapshot", async () => {
    if (!available) return;
    const owner = await workspace("audit-inherited-transition");
    const parent = await session(firstDb, {
      ...owner,
      tools: [OPENGENI, DOCS],
    });
    const child = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      parentSessionId: parent.id,
      toolPolicy: { mode: "inherited", inheritedFromSessionId: parent.id },
    });
    const bus = new MemoryEventBus();

    await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      child.id,
      explicitTools([OPENGENI, DOCS], 1),
    );

    const payload = bus.published[0]![0]!.payload as {
      before: { mode: string; inheritedFromSessionId: string | null };
      after: { mode: string; inheritedFromSessionId: string | null };
    };
    expect(payload.before).toMatchObject({
      mode: "inherited",
      inheritedFromSessionId: parent.id,
    });
    expect(payload.after).toMatchObject({
      mode: "explicit",
      inheritedFromSessionId: parent.id,
    });
  }, 180_000);

  test("records the mandatory first-party ref beyond the 64-ref request cap", async () => {
    if (!available) return;
    const extraServers = Array.from({ length: 64 }, (_, index) => ({
      id: `audit-server-${index.toString().padStart(2, "0")}`,
      url: `https://audit-${index}.example/mcp`,
      cacheToolsList: false,
    }));
    const largeSettings = testSettings({
      mcpServers: [
        {
          id: "opengeni",
          url: "https://opengeni.example/mcp",
          cacheToolsList: false,
        },
        ...extraServers,
      ],
    });
    const owner = await workspace("audit-cap");
    const created = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const bus = new MemoryEventBus();
    const requestedTools = extraServers.map(({ id }) => ({ kind: "mcp" as const, id }));

    await updateSessionToolPolicy(
      deps(firstDb, bus, largeSettings),
      grant(owner.workspaceId, owner.accountId),
      created.id,
      explicitTools(requestedTools, 1),
    );

    const payload = bus.published[0]![0]!.payload as {
      after: { toolRefs: ToolRef[]; toolCount: number; truncated: boolean };
    };
    expect(payload.after.toolCount).toBe(65);
    expect(payload.after.toolRefs).toHaveLength(40);
    expect(payload.after.toolRefs).toContainEqual(OPENGENI);
    expect(payload.after.truncated).toBe(true);
  }, 180_000);

  test("enforces the immediate parent ceiling while allowing a parent-approved child update", async () => {
    if (!available) return;
    const owner = await workspace("parent-ceiling");
    const parent = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const child = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      parentSessionId: parent.id,
      toolPolicy: { mode: "inherited", inheritedFromSessionId: parent.id },
    });
    const bus = new MemoryEventBus();

    await expect(
      updateSessionToolPolicy(
        deps(firstDb, bus),
        grant(owner.workspaceId, owner.accountId),
        child.id,
        explicitTools([OPENGENI, DOCS], 1),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await getSession(firstDb, owner.workspaceId, child.id))?.toolPolicyVersion).toBe(1);

    await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      parent.id,
      explicitTools([OPENGENI, DOCS], 1),
    );
    const widenedWithinParent = await updateSessionToolPolicy(
      deps(firstDb, bus),
      grant(owner.workspaceId, owner.accountId),
      child.id,
      explicitTools([OPENGENI, DOCS], 1),
    );
    expect(widenedWithinParent.tools).toEqual([OPENGENI, DOCS]);
    expect(widenedWithinParent.toolPolicy?.inheritedFromSessionId).toBe(parent.id);

    const raceParent = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const raceChild = await session(firstDb, {
      ...owner,
      tools: [OPENGENI],
      parentSessionId: raceParent.id,
      toolPolicy: { mode: "inherited", inheritedFromSessionId: raceParent.id },
    });
    const [parentUpdate, childUpdate] = await Promise.all([
      updateSessionToolPolicy(
        deps(firstDb, bus),
        grant(owner.workspaceId, owner.accountId),
        raceParent.id,
        explicitTools([OPENGENI, DOCS], 1),
      ),
      updateSessionToolPolicy(
        deps(secondDb, bus),
        grant(owner.workspaceId, owner.accountId),
        raceChild.id,
        explicitTools([OPENGENI], 1),
      ),
    ]);
    expect(parentUpdate.toolPolicyVersion).toBe(2);
    expect(childUpdate.toolPolicyVersion).toBe(2);
  }, 180_000);

  test("serializes concurrent writers and returns one version conflict under FORCE RLS", async () => {
    if (!available) return;
    const owner = await workspace("concurrent-cas");
    const created = await session(firstDb, { ...owner, tools: [OPENGENI] });
    const firstBus = new MemoryEventBus();
    const secondBus = new MemoryEventBus();
    const access = grant(owner.workspaceId, owner.accountId);

    const results = await Promise.allSettled([
      updateSessionToolPolicy(
        deps(firstDb, firstBus),
        access,
        created.id,
        explicitTools([OPENGENI, DOCS], 1),
      ),
      updateSessionToolPolicy(
        deps(secondDb, secondBus),
        access,
        created.id,
        explicitTools([OPENGENI, FILES], 1),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      SessionToolPolicyVersionConflictError,
    );
    expect((rejected as PromiseRejectedResult).reason.currentVersion).toBe(2);

    const persisted = await getSession(firstDb, owner.workspaceId, created.id);
    expect(persisted?.toolPolicyVersion).toBe(2);
    expect([DOCS.id, FILES.id]).toContain(
      persisted?.tools.find((tool) => tool.id !== "opengeni")?.id,
    );
    expect(firstBus.published.length + secondBus.published.length).toBe(1);
  }, 180_000);

  test("does not expose a session from another workspace through the update path", async () => {
    if (!available) return;
    const firstOwner = await workspace("tenant-a");
    const secondOwner = await workspace("tenant-b");
    const foreign = await session(secondDb, {
      ...secondOwner,
      tools: [OPENGENI],
    });

    await expect(
      updateSessionToolPolicy(
        deps(firstDb, new MemoryEventBus()),
        grant(firstOwner.workspaceId, firstOwner.accountId),
        foreign.id,
        explicitTools([OPENGENI, DOCS], 1),
      ),
    ).rejects.toThrow(`Session not found: ${foreign.id}`);
  }, 180_000);
});
