import { describe, expect, test } from "bun:test";
import type { AccessGrantAuthorization } from "@opengeni/core";

import {
  assertConnectionOwnershipAllowedForPrincipal,
  assertPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerSubject,
  PERSONAL_CONNECTION_PRINCIPAL_MESSAGE,
} from "../src/connection-ownership";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

function access(overrides: Partial<AccessGrantAuthorization> = {}): AccessGrantAuthorization {
  return {
    authenticatedSubjectId: "user:alice",
    contextIntegrity: true,
    accountGrant: null,
    grant: {
      accountId: id("1"),
      workspaceId: id("2"),
      subjectId: "user:alice",
      permissions: ["connections:write"],
      principalKind: "human_session",
    },
    ...overrides,
  } as AccessGrantAuthorization;
}

function withGrant(overrides: Record<string, unknown>): AccessGrantAuthorization {
  const base = access();
  return access({ grant: { ...base.grant, ...overrides } as never });
}

describe("personal Connection owner principal", () => {
  test("accepts a managed human session, including the local dev bootstrap subject", () => {
    expect(isPersonalConnectionOwnerPrincipal(access())).toBe(true);
    // `local` product access mode bootstraps the sole operator as bare `dev`
    // with a human_session principal kind; it is a person, not a machine.
    expect(
      isPersonalConnectionOwnerPrincipal(
        access({ authenticatedSubjectId: "dev", grant: { ...access().grant, subjectId: "dev" } }),
      ),
    ).toBe(true);
  });

  test("refuses every non-human principal kind", () => {
    for (const principalKind of [
      "api_key",
      "configured_key",
      "agent_attempt",
      "service",
    ] as const) {
      expect(isPersonalConnectionOwnerPrincipal(withGrant({ principalKind }))).toBe(false);
    }
    // Unknown provenance fails closed rather than being read as a human.
    expect(isPersonalConnectionOwnerPrincipal(withGrant({ principalKind: undefined }))).toBe(false);
  });

  test("refuses a machine subject even under a forged human claim, and any substitution", () => {
    expect(isPersonalConnectionOwnerPrincipal(withGrant({ subjectId: "api_key:abc" }))).toBe(false);
    expect(isPersonalConnectionOwnerPrincipal(withGrant({ subjectId: "configured:key" }))).toBe(
      false,
    );
    expect(
      isPersonalConnectionOwnerPrincipal(access({ authenticatedSubjectId: "user:mallory" })),
    ).toBe(false);
  });

  test("refuses a service-initiated grant", () => {
    expect(
      isPersonalConnectionOwnerPrincipal(
        withGrant({ serviceInitiator: { kind: "service", subjectId: "host" } }),
      ),
    ).toBe(false);
  });

  test("subject-shape check covers a callback that has only signed state", () => {
    expect(isPersonalConnectionOwnerSubject("user:alice")).toBe(true);
    expect(isPersonalConnectionOwnerSubject("dev")).toBe(true);
    expect(isPersonalConnectionOwnerSubject("api_key:abc")).toBe(false);
    expect(isPersonalConnectionOwnerSubject("configured:key")).toBe(false);
  });

  test("assertions are 422 and never downgrade ownership silently", () => {
    expect(() => assertPersonalConnectionOwnerPrincipal(access())).not.toThrow();
    let thrown: unknown;
    try {
      assertPersonalConnectionOwnerPrincipal(withGrant({ principalKind: "api_key" }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { status?: number } | undefined)?.status).toBe(422);
    expect((thrown as { message?: string } | undefined)?.message).toBe(
      PERSONAL_CONNECTION_PRINCIPAL_MESSAGE,
    );

    let personalOnly: unknown;
    try {
      assertPersonalConnectionOwnerPrincipal(withGrant({ principalKind: "api_key" }), "Atlassian");
    } catch (error) {
      personalOnly = error;
    }
    expect((personalOnly as { status?: number } | undefined)?.status).toBe(422);
    expect((personalOnly as { message?: string } | undefined)?.message).toContain("Atlassian");

    expect(() => assertConnectionOwnershipAllowedForPrincipal("workspace", false)).not.toThrow();
    expect(() => assertConnectionOwnershipAllowedForPrincipal("personal", true)).not.toThrow();
    expect(() => assertConnectionOwnershipAllowedForPrincipal("personal", false)).toThrow(
      PERSONAL_CONNECTION_PRINCIPAL_MESSAGE,
    );
  });
});
