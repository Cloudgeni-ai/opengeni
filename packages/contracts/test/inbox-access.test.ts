import { describe, expect, test } from "bun:test";
import { accessContextHasInbox, LOCAL_HUMAN_SUBJECT_ID } from "../src/index";

const humanGrant = { principalKind: "human_session" };

describe("accessContextHasInbox", () => {
  test("a signed-in person has an inbox, but not through a key", () => {
    expect(accessContextHasInbox({ mode: "managed", subjectId: "user:abc" })).toBe(true);
    expect(
      accessContextHasInbox({ mode: "managed", subjectId: "user:abc", credential: { id: "k" } }),
    ).toBe(false);
  });

  test("a local install's one human has an inbox", () => {
    expect(LOCAL_HUMAN_SUBJECT_ID).toBe("dev");
    expect(
      accessContextHasInbox({ mode: "local", subjectId: "dev", workspaceGrants: [humanGrant] }),
    ).toBe(true);
  });

  test("other non-person subjects and machine principals have none", () => {
    const cases = [
      // `dev` outside local mode, or without a human session.
      { mode: "configured", subjectId: "dev", workspaceGrants: [humanGrant] },
      { mode: "local", subjectId: "dev" },
      { mode: "local", subjectId: "dev", workspaceGrants: [] },
      { mode: "local", subjectId: "dev", workspaceGrants: [{ principalKind: "configured_key" }] },
      { mode: "local", subjectId: "dev", workspaceGrants: [{ principalKind: "agent_attempt" }] },
      { mode: "local", subjectId: "dev", workspaceGrants: [{ principalKind: "service" }] },
      {
        mode: "local",
        subjectId: "dev",
        workspaceGrants: [{ ...humanGrant, metadata: { delegated: true } }],
      },
      {
        mode: "local",
        subjectId: "dev",
        workspaceGrants: [humanGrant, { ...humanGrant, serviceInitiator: { kind: "service" } }],
      },
      { mode: "local", subjectId: "dev", workspaceGrants: [humanGrant], credential: { id: "k" } },
      // Any other non-person subject, local or not.
      { mode: "local", subjectId: "apikey:abc", workspaceGrants: [humanGrant] },
      { mode: "local", subjectId: "scheduler", workspaceGrants: [humanGrant] },
      { mode: "configured", subjectId: "configured", workspaceGrants: [humanGrant] },
    ];
    for (const context of cases) expect(accessContextHasInbox(context)).toBe(false);
    expect(accessContextHasInbox(null)).toBe(false);
    expect(accessContextHasInbox(undefined)).toBe(false);
  });
});
