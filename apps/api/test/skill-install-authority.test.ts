import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { accessGrantAuthorizationFromContext } from "@opengeni/core";
import { skillInstallerActor } from "../src/routes/skill-install-authority";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
function authorization(overrides: Partial<AccessGrant> = {}, contextSubject?: string) {
  const grant: AccessGrant = {
    workspaceId,
    accountId,
    subjectId: "user:installer",
    principalKind: "human_session",
    permissions: ["workspace:read", "capabilities:manage"],
    ...overrides,
  };
  return accessGrantAuthorizationFromContext(
    {
      mode: "managed",
      subjectId: contextSubject ?? grant.subjectId,
      accountGrants: [{ accountId, subjectId: contextSubject ?? grant.subjectId, permissions: [] }],
      workspaceGrants: [grant],
      defaultAccountId: accountId,
      defaultWorkspaceId: workspaceId,
    },
    grant,
  );
}

test("Skill installer derives a human actor only from a matching resolved human request", () => {
  expect(skillInstallerActor(authorization())).toEqual({
    kind: "human",
    principalKind: "human_session",
    subjectId: "user:installer",
  });
  expect(() => skillInstallerActor(authorization({}, "user:someone-else"))).toThrow();
});

test("Skill installer carries exact signed attempt identity instead of attributing the write to its human initiator", () => {
  const attempt = {
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 2,
  };
  expect(skillInstallerActor(authorization({ metadata: attempt }))).toEqual({
    kind: "agent",
    ...attempt,
  });
  expect(() =>
    skillInstallerActor(authorization({ metadata: { sessionId: attempt.sessionId } })),
  ).toThrow();
  expect(() => skillInstallerActor(authorization({ principalKind: "agent_attempt" }))).toThrow();
});

test("service and key principals cannot acquire human Skill authority", () => {
  for (const principalKind of ["service", "api_key", "configured_key"] as const) {
    expect(() => skillInstallerActor(authorization({ principalKind }))).toThrow();
  }
  expect(() => skillInstallerActor(authorization({ subjectId: "api_key:example" }))).toThrow();
  expect(() =>
    skillInstallerActor(
      authorization({
        serviceInitiator: { kind: "service", subjectId: "service:embed", label: "Embedding host" },
      }),
    ),
  ).toThrow();
});
