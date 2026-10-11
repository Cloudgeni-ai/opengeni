import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@opengeni/contracts";
import { inboxSubjectForContext } from "../src/access";

function context(overrides: Partial<AccessContext>): AccessContext {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const subjectId = overrides.subjectId ?? "dev";
  return {
    mode: "local",
    subjectId,
    accountGrants: [{ accountId, subjectId, role: "owner", permissions: [] }],
    workspaceGrants: [
      { accountId, workspaceId, subjectId, permissions: [], principalKind: "human_session" },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
    ...overrides,
  } as AccessContext;
}

describe("inboxSubjectForContext", () => {
  test("a user-shaped context without verified human provenance has no inbox", () => {
    expect(inboxSubjectForContext(context({ mode: "managed", subjectId: "user:abc" }))).toBeNull();
    expect(
      inboxSubjectForContext(
        context({ mode: "managed", subjectId: "user:abc", credential: { id: "k" } as never }),
      ),
    ).toBeNull();
    for (const principalKind of ["human_session", "service", "agent_attempt"] as const) {
      const delegated = context({ mode: "managed", subjectId: "user:abc" });
      delegated.workspaceGrants = delegated.workspaceGrants.map((grant) => ({
        ...grant,
        principalKind,
        metadata: { delegated: true },
      }));
      expect(inboxSubjectForContext(delegated)).toBeNull();
    }
  });

  test("a local-human-shaped context the local bootstrap did not produce has no inbox", () => {
    // Same shape as the local human, but not resolved by the in-process local
    // bootstrap (for example a delegated bearer naming `dev`).
    expect(inboxSubjectForContext(context({}))).toBeNull();
    expect(inboxSubjectForContext(context({ mode: "configured" }))).toBeNull();
  });
});
