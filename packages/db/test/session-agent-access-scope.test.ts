import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SessionAgentAccessViewer, SessionScopeSubjectId } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  correctWorkspaceMemory,
  createDb,
  createSession,
  memoryWriteScopeForAgentScope,
  getSessionAccessProjection,
  listKnowledgeMemories,
  listSessionsForSubject,
  resolveSessionMemoryAgentScope,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  type Database,
  type DbClient,
  type MemoryAgentScope,
  type SessionCreateInput,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const u1: SessionScopeSubjectId = "user:u_1";
const u2: SessionScopeSubjectId = "external_user:u_2";

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

async function fixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "session-agent-access-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session agent access",
    workspaceExternalSource: "session-agent-access-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session agent access",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId: grant.subjectId };
}

async function session(
  f: Fixture,
  message: string,
  overrides: Partial<SessionCreateInput> = {},
): Promise<{ id: string; rootSessionId: string }> {
  const created = await createSession(db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: message,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.subjectId, label: "Owner" },
    createdByContext: {},
    ...overrides,
  });
  return { id: created.id, rootSessionId: created.rootSessionId };
}

async function listIds(
  f: Fixture,
  options: Partial<Parameters<typeof listSessionsForSubject>[2]> = {},
): Promise<Set<string>> {
  const page = await listSessionsForSubject(db, f.workspaceId, {
    subjectId: f.subjectId,
    limit: 100,
    materializeSnapshot: false,
    ...options,
  });
  return new Set([...page.pinned, ...page.sessions].map((row) => row.id));
}

function viewer(
  root: string,
  agentAccess: SessionAgentAccessViewer["agentAccess"],
  scopeSubjectId: SessionScopeSubjectId | null,
): SessionAgentAccessViewer {
  return { callerRootSessionId: root, agentAccess, scopeSubjectId };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-agent-access-scope");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    console.warn("[session-agent-access-scope] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("session agent access scope (real PostgreSQL)", () => {
  test("private agents cannot correct, archive, or replace shared memory", async () => {
    if (!available) return;
    const f = await fixture();
    const root = await session(f, "private memory test");
    const base = { accountId: f.accountId, workspaceId: f.workspaceId, origin: "agent" as const };
    const fact = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra shared customer reference",
    });
    const scopes: MemoryAgentScope[] = [{ mode: "user", userSubjectId: u1, rootSessionId: null }];
    for (const agentScope of scopes) {
      for (const replacement of [undefined, "zebra private account detail", fact.memory.text]) {
        await expect(
          correctWorkspaceMemory(db, {
            ...base,
            id: fact.memory.id,
            ...(replacement !== undefined ? { replacementText: replacement } : {}),
            agentScope,
          }),
        ).rejects.toThrow("writable scope");
      }
      for (const text of ["zebra private account detail", fact.memory.text]) {
        await expect(
          saveWorkspaceMemory(db, {
            ...base,
            replacesId: fact.memory.id,
            text,
            scope: memoryWriteScopeForAgentScope(agentScope)!,
          }),
        ).rejects.toThrow("writable scope");
      }
    }
    const visible = await searchWorkspaceMemories(db, f.workspaceId, {
      query: "zebra",
      mode: "keyword",
      agentScope: {
        mode: "user",
        userSubjectId: u2,
        rootSessionId: null,
      },
    });
    expect(visible.map((row) => row.memory.text)).toEqual([fact.memory.text]);
    expect(visible[0]!.memory.status).toBe("active");
  });

  test("distinct user identity pairs cannot read each other's memory", async () => {
    if (!available) return;
    const f = await fixture();
    const a = "user:alice";
    const b = "external_user:alice";
    await saveWorkspaceMemory(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      origin: "agent",
      text: "zebra private detail for identity A",
      scope: { type: "user", subjectId: a },
    });
    const visible = await searchWorkspaceMemories(db, f.workspaceId, {
      query: "zebra",
      mode: "keyword",
      agentScope: {
        mode: "user",
        userSubjectId: b,
        rootSessionId: null,
      },
    });
    expect(visible).toHaveLength(0);
  });

  test("the create insert stores the frozen scope and the projections read it back", async () => {
    if (!available) return;
    const f = await fixture();
    const scoped = await session(f, "scoped", {
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "user",
    });
    const plain = await session(f, "plain");
    expect(await getSessionAccessProjection(db, f.workspaceId, scoped.id)).toEqual({
      sessionId: scoped.id,
      rootSessionId: scoped.id,
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "user",
    });
    expect(await getSessionAccessProjection(db, f.workspaceId, plain.id)).toEqual({
      sessionId: plain.id,
      rootSessionId: plain.id,
      agentAccess: "workspace",
      scopeSubjectId: null,
      memoryScope: "workspace",
    });
    expect(await getSessionAccessProjection(db, f.workspaceId, crypto.randomUUID())).toBeNull();
    const listed = await listSessionsForSubject(db, f.workspaceId, {
      subjectId: f.subjectId,
      limit: 10,
      materializeSnapshot: false,
    });
    const row = [...listed.pinned, ...listed.sessions].find((entry) => entry.id === scoped.id);
    expect(row).toMatchObject({ agentAccess: "session", scopeSubjectId: u1, memoryScope: "user" });
    expect(await resolveSessionMemoryAgentScope(db, f.workspaceId, scoped.id)).toEqual({
      mode: "off",
      userSubjectId: null,
      rootSessionId: scoped.id,
    });
    expect(u1).toBe("user:u_1");
  });

  test("the end-user filter and the viewer predicate select exactly the reachable rows", async () => {
    if (!available) return;
    const f = await fixture();
    const a = await session(f, "A session-scoped u1", {
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const a1 = await session(f, "A1 child of A", {
      parentSessionId: a.id,
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const b = await session(f, "B session-scoped u1", {
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const c = await session(f, "C workspace u1", { agentAccess: "workspace", scopeSubjectId: u1 });
    const d = await session(f, "D workspace unlabelled");
    const e = await session(f, "E user u1", { agentAccess: "user", scopeSubjectId: u1 });
    const g = await session(f, "G workspace u2", { agentAccess: "workspace", scopeSubjectId: u2 });
    const h = await session(f, "H user u2", { agentAccess: "user", scopeSubjectId: u2 });

    expect(a1.rootSessionId).toBe(a.id);
    expect(await listIds(f)).toEqual(new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]));
    expect(await listIds(f, { scopeSubjectId: u1 })).toEqual(
      new Set([a.id, a1.id, b.id, c.id, e.id]),
    );
    expect(await listIds(f, { scopeSubjectId: "user:other" })).toEqual(new Set());

    const scoped = (agentAccessViewer: SessionAgentAccessViewer) =>
      listIds(f, { authorizationScope: { kind: "all", agentAccessViewer } });
    // A session-scoped caller sees only its own tree.
    expect(await scoped(viewer(a.id, "session", u1))).toEqual(new Set([a.id, a1.id]));
    // A user-scoped caller sees its tree plus non-session peers with its label.
    expect(await scoped(viewer(e.id, "user", u1))).toEqual(new Set([e.id, c.id]));
    expect(await scoped(viewer(h.id, "user", u2))).toEqual(new Set([h.id, g.id]));
    // A workspace caller without a label sees every workspace peer and no user peer.
    expect(await scoped(viewer(d.id, "workspace", null))).toEqual(new Set([c.id, d.id, g.id]));
    // A workspace caller with a label additionally sees the user peers carrying it.
    expect(await scoped(viewer(c.id, "workspace", u1))).toEqual(new Set([c.id, d.id, g.id, e.id]));
    // The viewer intersects a host root scope rather than replacing it.
    expect(
      await listIds(f, {
        authorizationScope: {
          kind: "scoped",
          rootSessionIds: [a.id, c.id],
          sessionIds: [],
          agentAccessViewer: viewer(a.id, "session", u1),
        },
      }),
    ).toEqual(new Set([a.id, a1.id]));
    expect(
      await listIds(f, {
        authorizationScope: {
          kind: "scoped",
          rootSessionIds: [a.id, c.id],
          sessionIds: [],
          agentAccessViewer: viewer(d.id, "workspace", null),
        },
      }),
    ).toEqual(new Set([c.id]));
    // Human/API callers without a viewer keep the complete list.
    expect(await listIds(f, { authorizationScope: { kind: "all" } })).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
  });

  test("memory scope writes typed selectors and reads workspace plus one private layer", async () => {
    if (!available) return;
    const f = await fixture();
    const root = await session(f, "root of a session-memory tree", {
      memoryScope: "off",
    });
    const u1Scope: MemoryAgentScope = {
      mode: "user",
      userSubjectId: u1,
      rootSessionId: null,
    };
    const u2Scope: MemoryAgentScope = {
      mode: "user",
      userSubjectId: u2,
      rootSessionId: null,
    };
    const treeScope: MemoryAgentScope = {
      mode: "off",
      userSubjectId: null,
      rootSessionId: root.id,
    };
    const workspaceScope: MemoryAgentScope = {
      mode: "workspace",
      userSubjectId: null,
      rootSessionId: null,
    };
    const base = { accountId: f.accountId, workspaceId: f.workspaceId, origin: "agent" as const };

    const sharedFact = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra pricing is shared across the workspace",
    });
    const privateU1 = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra preference private to user one",
      scope: { type: "user", subjectId: u1Scope.userSubjectId! },
    });
    const privateU2 = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra preference private to user two",
      scope: { type: "user", subjectId: u2Scope.userSubjectId! },
    });
    const treeOnly = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra fact private to one session tree",
      scope: { type: "session", sessionId: root.id },
    });
    expect(privateU1.deduped).toBe(false);
    expect(privateU2.deduped).toBe(false);
    expect(privateU1.memory).toMatchObject({
      scope: "user",
      scopeType: "user",
      scopeSubjectId: u1,
      scopeSessionId: null,
    });
    expect(treeOnly.memory).toMatchObject({
      scope: "session",
      scopeType: "session",
      scopeSubjectId: null,
      scopeSessionId: root.id,
    });
    expect(sharedFact.memory).toMatchObject({ scope: "workspace", scopeType: "workspace" });
    const [stored] = await shared!.admin<
      Array<{ scope: string; scopeType: string; subject: string }>
    >`
      select scope, scope_type as "scopeType", scope_subject_id as subject
      from knowledge_memories where id = ${privateU1.memory.id}`;
    expect(stored).toEqual({
      scope: "user",
      scopeType: "user",
      subject: u1,
    });

    const ids = async (agentScope: MemoryAgentScope | undefined) =>
      new Set(
        (
          await searchWorkspaceMemories(db, f.workspaceId, {
            query: "zebra",
            mode: "keyword",
            limit: 20,
            ...(agentScope ? { agentScope } : {}),
          })
        ).map((result) => result.memory.id),
      );
    expect(await ids(u1Scope)).toEqual(new Set([sharedFact.memory.id, privateU1.memory.id]));
    expect(await ids(u2Scope)).toEqual(new Set([sharedFact.memory.id, privateU2.memory.id]));
    expect(await ids(treeScope)).toEqual(new Set());
    expect(await ids(workspaceScope)).toEqual(new Set([sharedFact.memory.id]));
    // Human callers (no agent scope) keep today's workspace-only read.
    expect(await ids(undefined)).toEqual(new Set([sharedFact.memory.id]));
    expect(await ids({ mode: "off", userSubjectId: null, rootSessionId: null })).toEqual(new Set());

    const listIdsFor = async (agentScope: MemoryAgentScope | undefined) =>
      new Set(
        (
          await listKnowledgeMemories(db, f.workspaceId, {
            query: "zebra",
            status: ["active", "approved"],
            ...(agentScope ? { agentScope } : {}),
          })
        ).map((memory) => memory.id),
      );
    expect(await listIdsFor(u1Scope)).toEqual(new Set([sharedFact.memory.id, privateU1.memory.id]));
    expect(await listIdsFor(treeScope)).toEqual(new Set());
    expect(await listIdsFor(undefined)).toEqual(new Set([sharedFact.memory.id]));

    // The same text is one record per typed layer, never deduped across users,
    // while a private write of an already-shared fact dedupes to the shared row.
    const sameTextU1 = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra fact both users learn",
      scope: { type: "user", subjectId: u1Scope.userSubjectId! },
    });
    const sameTextU2 = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra fact both users learn",
      scope: { type: "user", subjectId: u2Scope.userSubjectId! },
    });
    expect(sameTextU2.deduped).toBe(false);
    expect(sameTextU2.memory.id).not.toBe(sameTextU1.memory.id);
    const sharedAgain = await saveWorkspaceMemory(db, {
      ...base,
      text: "zebra pricing is shared across the workspace",
      scope: { type: "user", subjectId: u1Scope.userSubjectId! },
    });
    expect(sharedAgain).toMatchObject({ deduped: true, memory: { id: sharedFact.memory.id } });

    // A correction stays in the corrected record's layer and is invisible to
    // the other user's layer.
    const corrected = await correctWorkspaceMemory(db, {
      ...base,
      id: privateU1.memory.id,
      replacementText: "zebra preference private to user one, revised",
      agentScope: u1Scope,
    });
    expect(corrected.action).toBe("superseded");
    expect(corrected.replacement).toMatchObject({
      scopeType: "user",
      scopeSubjectId: u1,
    });
    expect(await ids(u1Scope)).toEqual(
      new Set([sharedFact.memory.id, corrected.replacement!.id, sameTextU1.memory.id]),
    );
    expect(await ids(u2Scope)).toEqual(
      new Set([sharedFact.memory.id, privateU2.memory.id, sameTextU2.memory.id]),
    );
    // User two cannot correct user one's private record: it is not visible.
    await expect(
      correctWorkspaceMemory(db, {
        ...base,
        id: corrected.replacement!.id,
        reason: "not mine",
        agentScope: u2Scope,
      }),
    ).rejects.toThrow(/not found in this workspace/u);
    await expect(
      saveWorkspaceMemory(db, {
        ...base,
        text: "role scopes are not an agent write target",
        scope: { type: "role", roleKey: "operator" },
      }),
    ).rejects.toThrow(/do not accept the role scope/u);
  });
});
