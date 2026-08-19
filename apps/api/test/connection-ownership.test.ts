import { describe, expect, test } from "bun:test";
import type { AccessGrantAuthorization } from "@opengeni/core";

import {
  assertConnectionOwnershipAllowedForPrincipal,
  assertPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerSubject,
  personalOwnerStateAccepted,
  personalOwnerVerifiedInState,
  PERSONAL_CONNECTION_PRINCIPAL_MESSAGE,
  PERSONAL_OWNER_VERIFIED_STATE_CLAIM,
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
    // `docs/embedding.md`: subjectId "remains opaque to OpenGeni" and hosts must
    // not have the kind inferred from a prefix, so a trusted embedding host's
    // opaque human subject must still be able to own a personal Connection.
    expect(
      isPersonalConnectionOwnerPrincipal(
        access({
          authenticatedSubjectId: "acme-employee-4471",
          grant: { ...access().grant, subjectId: "acme-employee-4471" },
        }),
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

  test("requires contextIntegrity, matching requireConnectionAuthorityOwner", () => {
    // The anti-substitution invariant. Without it, a grant whose account has no
    // matching account grant (a surviving membership row in an organization
    // where the membership is no longer active) could mint a personal
    // Connection that the sibling helper one file away refuses.
    expect(isPersonalConnectionOwnerPrincipal(access({ contextIntegrity: false }))).toBe(false);
  });

  test("refuses a machine subject even under a forged human claim, and any substitution", () => {
    expect(isPersonalConnectionOwnerPrincipal(withGrant({ subjectId: "api_key:abc" }))).toBe(false);
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

  // Enumerates every subject OpenGeni itself mints for a machine principal. A
  // new machine namespace must be added to RESERVED_MACHINE_SUBJECT_NAMESPACES
  // or this test fails - that is what keeps the reserved list from going stale,
  // since an allow-list of human subjects is not available to us (the embedding
  // contract makes the subject namespace host-owned and opaque).
  test("rejects every machine subject OpenGeni mints", () => {
    const openGeniMintedMachineSubjects = [
      // packages/core/src/access/index.ts — `api_key:${apiKey.id}`
      `api_key:${id("9")}`,
      // packages/core/src/access/index.ts — configuredSubject()
      "configured:key",
      "configured:some-operator-supplied-header",
      // packages/runtime/src/index.ts — signFirstPartyDelegatedBearer default
      "worker:first-party-mcp",
    ];
    for (const subjectId of openGeniMintedMachineSubjects) {
      expect(isPersonalConnectionOwnerSubject(subjectId)).toBe(false);
      expect(isPersonalConnectionOwnerPrincipal(withGrant({ subjectId }))).toBe(false);
    }
  });

  test("subject-shape check accepts human and host-opaque subjects", () => {
    expect(isPersonalConnectionOwnerSubject("user:alice")).toBe(true);
    expect(isPersonalConnectionOwnerSubject("dev")).toBe(true);
    expect(isPersonalConnectionOwnerSubject("acme-employee-4471")).toBe(true);
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

describe("personal owner signed-state claim", () => {
  test("reads only an exact boolean true", () => {
    expect(personalOwnerVerifiedInState({ [PERSONAL_OWNER_VERIFIED_STATE_CLAIM]: true })).toBe(
      true,
    );
    for (const value of [false, "true", 1, null, undefined, {}]) {
      expect(personalOwnerVerifiedInState({ [PERSONAL_OWNER_VERIFIED_STATE_CLAIM]: value })).toBe(
        false,
      );
    }
    // A state minted before the claim existed (rolling deploy) has none.
    expect(personalOwnerVerifiedInState({ ownership: "personal" })).toBe(false);
  });

  test("gates only personal ownership, and needs both signals", () => {
    // Workspace ownership never needs the claim.
    expect(
      personalOwnerStateAccepted({
        ownership: "workspace",
        subjectId: "api_key:x",
        personalOwnerVerified: false,
      }),
    ).toBe(true);
    expect(
      personalOwnerStateAccepted({
        ownership: "personal",
        subjectId: "user:alice",
        personalOwnerVerified: true,
      }),
    ).toBe(true);
    // Legacy state: no claim.
    expect(
      personalOwnerStateAccepted({
        ownership: "personal",
        subjectId: "user:alice",
        personalOwnerVerified: false,
      }),
    ).toBe(false);
    // Claim present but the subject is an OpenGeni-minted machine.
    expect(
      personalOwnerStateAccepted({
        ownership: "personal",
        subjectId: "api_key:x",
        personalOwnerVerified: true,
      }),
    ).toBe(false);
  });
});
