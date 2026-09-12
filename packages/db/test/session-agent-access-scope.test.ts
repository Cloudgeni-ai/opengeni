import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SessionAgentAccessViewer, SessionScopeSubjectId } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionAccessProjection,
  listSessionsForSubject,
  resolveSessionMemoryAgentScope,
  type Database,
  type DbClient,
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
      scopeSubjectId: f.subjectId,
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
    // A user-scoped caller sees its tree plus every same-user peer, regardless of target scope.
    expect(await scoped(viewer(e.id, "user", u1))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, e.id]),
    );
    expect(await scoped(viewer(h.id, "user", u2))).toEqual(new Set([h.id, g.id]));
    // A workspace caller without a label sees every authorized peer regardless of target task scope.
    expect(await scoped(viewer(d.id, "workspace", null))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
    // A workspace caller with a label has the same reach regardless of its own user label.
    expect(await scoped(viewer(c.id, "workspace", u1))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
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
    ).toEqual(new Set([a.id, a1.id, c.id]));
    // Human/API callers without a viewer keep the complete list.
    expect(await listIds(f, { authorizationScope: { kind: "all" } })).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
  });
});
