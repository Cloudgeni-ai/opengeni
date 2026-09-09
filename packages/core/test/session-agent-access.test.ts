import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  agentAccessListScopeForViewer,
  agentAccessPermitsCrossTreeAccess,
} from "../src/session-authorization";
import { resolveSessionCreateScope } from "../src/domain/sessions";

const acme = "user:acme";
const other = "user:other";

describe("agent access pairwise rule", () => {
  test("workspace callers reach workspace targets regardless of label", () => {
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "workspace", scopeSubjectId: null },
        { agentAccess: "workspace", scopeSubjectId: acme },
      ),
    ).toBe(true);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "workspace", scopeSubjectId: acme },
        { agentAccess: "workspace", scopeSubjectId: other },
      ),
    ).toBe(true);
  });

  test("a session-scoped side denies every cross-tree pair", () => {
    for (const peer of ["session", "user", "workspace"] as const) {
      expect(
        agentAccessPermitsCrossTreeAccess(
          { agentAccess: "session", scopeSubjectId: acme },
          { agentAccess: peer, scopeSubjectId: acme },
        ),
      ).toBe(false);
      expect(
        agentAccessPermitsCrossTreeAccess(
          { agentAccess: peer, scopeSubjectId: acme },
          { agentAccess: "session", scopeSubjectId: acme },
        ),
      ).toBe(false);
    }
  });

  test("a user-scoped side requires the exact same non-null label", () => {
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "user", scopeSubjectId: acme },
        { agentAccess: "workspace", scopeSubjectId: acme },
      ),
    ).toBe(true);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "workspace", scopeSubjectId: acme },
        { agentAccess: "user", scopeSubjectId: acme },
      ),
    ).toBe(true);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "user", scopeSubjectId: acme },
        { agentAccess: "user", scopeSubjectId: other },
      ),
    ).toBe(false);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "user", scopeSubjectId: null },
        { agentAccess: "user", scopeSubjectId: null },
      ),
    ).toBe(false);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "workspace", scopeSubjectId: null },
        { agentAccess: "user", scopeSubjectId: acme },
      ),
    ).toBe(false);
    expect(
      agentAccessPermitsCrossTreeAccess(
        { agentAccess: "user", scopeSubjectId: "external_user:other" },
        { agentAccess: "user", scopeSubjectId: acme },
      ),
    ).toBe(false);
  });
});

describe("agent access list scope", () => {
  const root = "11111111-1111-4111-8111-111111111111";

  test("session callers are scoped to their own root tree", () => {
    expect(
      agentAccessListScopeForViewer({
        callerRootSessionId: root,
        agentAccess: "session",
        scopeSubjectId: acme,
      }),
    ).toEqual({
      kind: "scoped",
      rootSessionIds: [root],
      sessionIds: [],
      agentAccessViewer: {
        callerRootSessionId: root,
        agentAccess: "session",
        scopeSubjectId: acme,
      },
    });
  });

  test("user and workspace callers keep the unscoped list behind the viewer predicate", () => {
    for (const agentAccess of ["user", "workspace"] as const) {
      const viewer = { callerRootSessionId: root, agentAccess, scopeSubjectId: null };
      expect(agentAccessListScopeForViewer(viewer)).toEqual({
        kind: "all",
        agentAccessViewer: viewer,
      });
    }
  });

  test("a host scope is intersected with the viewer, never replaced by it", () => {
    const viewer = {
      callerRootSessionId: root,
      agentAccess: "workspace" as const,
      scopeSubjectId: null,
    };
    const hostRoot = "22222222-2222-4222-8222-222222222222";
    expect(
      agentAccessListScopeForViewer(viewer, {
        kind: "scoped",
        rootSessionIds: [hostRoot],
        sessionIds: [],
      }),
    ).toEqual({
      kind: "scoped",
      rootSessionIds: [hostRoot],
      sessionIds: [],
      agentAccessViewer: viewer,
    });
    expect(
      agentAccessListScopeForViewer(
        { ...viewer, agentAccess: "session" },
        { kind: "all", agentAccessViewer: { ...viewer, agentAccess: "workspace" } },
      ),
    ).toEqual({
      kind: "scoped",
      rootSessionIds: [root],
      sessionIds: [],
      agentAccessViewer: { ...viewer, agentAccess: "session" },
    });
  });
});

describe("session create scope resolution", () => {
  const defaults = {
    agentAccess: "workspace" as const,
    agentAccessProvided: false,
    scopeSubjectId: null,
    endUserProvided: false,
    memoryScope: "workspace" as const,
    memoryScopeProvided: false,
  };

  test("top-level requests take their explicit values", () => {
    expect(
      resolveSessionCreateScope({
        requested: {
          ...defaults,
          agentAccess: "session",
          agentAccessProvided: true,
          scopeSubjectId: acme,
          endUserProvided: true,
          memoryScope: "user",
          memoryScopeProvided: true,
        },
        parent: null,
      }),
    ).toEqual({ agentAccess: "session", scopeSubjectId: acme, memoryScope: "user" });
    expect(resolveSessionCreateScope({ requested: defaults, parent: null })).toEqual({
      agentAccess: "workspace",
      scopeSubjectId: null,
      memoryScope: "workspace",
    });
  });

  test("memory user without a label is a 422 even for a top-level request", () => {
    expect(() =>
      resolveSessionCreateScope({
        requested: { ...defaults, memoryScope: "user", memoryScopeProvided: true },
        parent: null,
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });

  test("a child inherits every omitted value from its parent", () => {
    expect(
      resolveSessionCreateScope({
        requested: defaults,
        parent: { agentAccess: "user", scopeSubjectId: acme, memoryScope: "off" },
      }),
    ).toEqual({ agentAccess: "user", scopeSubjectId: acme, memoryScope: "off" });
  });

  test("a child may narrow but never widen agent access", () => {
    expect(
      resolveSessionCreateScope({
        requested: { ...defaults, agentAccess: "session", agentAccessProvided: true },
        parent: { agentAccess: "user", scopeSubjectId: acme, memoryScope: "workspace" },
      }).agentAccess,
    ).toBe("session");
    for (const [parent, child] of [
      ["session", "user"],
      ["session", "workspace"],
      ["user", "workspace"],
    ] as const) {
      let error: unknown;
      try {
        resolveSessionCreateScope({
          requested: { ...defaults, agentAccess: child, agentAccessProvided: true },
          parent: { agentAccess: parent, scopeSubjectId: acme, memoryScope: "workspace" },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(403);
      expect((error as HTTPException).message).toBe(
        "child agent access may only narrow the parent session",
      );
    }
  });

  test("a child keeps its parent's end-user label and may not name another", () => {
    expect(
      resolveSessionCreateScope({
        requested: { ...defaults, scopeSubjectId: acme, endUserProvided: true },
        parent: { agentAccess: "workspace", scopeSubjectId: acme, memoryScope: "workspace" },
      }).scopeSubjectId,
    ).toEqual(acme);
    for (const [parentLabel, childLabel] of [
      [acme, other],
      [null, acme],
      [acme, null],
    ] as const) {
      expect(() =>
        resolveSessionCreateScope({
          requested: { ...defaults, scopeSubjectId: childLabel, endUserProvided: true },
          parent: {
            agentAccess: "workspace",
            scopeSubjectId: parentLabel,
            memoryScope: "workspace",
          },
        }),
      ).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  test("a child may narrow memory scope down to off but never widen it", () => {
    expect(
      resolveSessionCreateScope({
        requested: { ...defaults, memoryScope: "off", memoryScopeProvided: true },
        parent: { agentAccess: "workspace", scopeSubjectId: acme, memoryScope: "user" },
      }).memoryScope,
    ).toBe("off");
    for (const [parent, child] of [
      ["off", "user"],
      ["user", "workspace"],
      ["off", "workspace"],
    ] as const) {
      expect(() =>
        resolveSessionCreateScope({
          requested: { ...defaults, memoryScope: child, memoryScopeProvided: true },
          parent: { agentAccess: "workspace", scopeSubjectId: acme, memoryScope: parent },
        }),
      ).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  test("a child asking for memory user inherits the parent's label", () => {
    expect(
      resolveSessionCreateScope({
        requested: { ...defaults, memoryScope: "user", memoryScopeProvided: true },
        parent: { agentAccess: "workspace", scopeSubjectId: acme, memoryScope: "workspace" },
      }),
    ).toEqual({ agentAccess: "workspace", scopeSubjectId: acme, memoryScope: "user" });
    expect(() =>
      resolveSessionCreateScope({
        requested: { ...defaults, memoryScope: "user", memoryScopeProvided: true },
        parent: { agentAccess: "workspace", scopeSubjectId: null, memoryScope: "workspace" },
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });
});
