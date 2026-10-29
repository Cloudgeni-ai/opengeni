import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  withBillingOriginOverride,
  withCreditDebitAttribution,
  type Database,
} from "@opengeni/db";
import type { AccessGrantAuthorization } from "../src/access";
import {
  billingOriginForGrant,
  requestBillingOrigin,
  resolveTurnBillingOrigin,
  stampRequestBillingOrigin,
} from "../src/billing-origin";
import { withSiteSessionOrigin } from "../src/site-session-origin";

const base: AccessGrant = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:one",
  permissions: ["sessions:create", "sessions:control"],
};
const turnId = "00000000-0000-4000-8000-000000000003";

function authorization(
  grant: AccessGrant,
  flags: { canonicalManagedHumanSession?: boolean; canonicalLocalHumanSession?: boolean },
): AccessGrantAuthorization {
  return {
    grant,
    accountGrant: null,
    authenticatedSubjectId: grant.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: flags.canonicalManagedHumanSession ?? false,
    canonicalLocalHumanSession: flags.canonicalLocalHumanSession ?? false,
  };
}

/** Any query fails: paths that must not touch the database prove it. */
const noDb = new Proxy({} as Database, {
  get() {
    throw new Error("database not expected");
  },
});

describe("billingOriginForGrant", () => {
  const human = { ...base, principalKind: "human_session" as const };

  test("a person signed in to Opengeni's own apps is app", () => {
    expect(
      billingOriginForGrant(human, authorization(human, { canonicalManagedHumanSession: true })),
    ).toBe("app");
    expect(
      billingOriginForGrant(human, authorization(human, { canonicalLocalHumanSession: true })),
    ).toBe("app");
  });

  test("keys, products acting for people, outside agents and services are api", () => {
    const cases: AccessGrant[] = [
      { ...base, subjectId: "api_key:1", principalKind: "api_key" },
      { ...base, subjectId: "configured:key", principalKind: "configured_key" },
      // A personal API key and a product on the SDK act as a delegated person.
      { ...human, metadata: { delegated: true } },
      { ...human, metadata: { mcpOAuth: true } },
      { ...human, metadata: { externalActor: { kind: "linked" } } },
      { ...human, serviceInitiator: { kind: "service" } } as unknown as AccessGrant,
    ];
    for (const grant of cases) {
      // Even a canonical flag cannot turn an API credential into app use.
      expect(
        billingOriginForGrant(grant, authorization(grant, { canonicalManagedHumanSession: true })),
      ).toBe("api");
      expect(billingOriginForGrant(grant)).toBe("api");
    }
  });

  test("an unverified person credential is api; a published Site's viewer is app", async () => {
    expect(billingOriginForGrant(human)).toBe("api");
    expect(
      await withSiteSessionOrigin(
        { siteId: "site", ownerSubjectId: "user:owner" } as never,
        async () => billingOriginForGrant(human),
      ),
    ).toBe("app");
  });
});

describe("resolveTurnBillingOrigin", () => {
  const human = { ...base, principalKind: "human_session" as const };

  test("an explicit entry-point origin wins, then a trusted override", async () => {
    expect(await resolveTurnBillingOrigin(noDb, { grant: human, requestedOrigin: "app" })).toBe(
      "app",
    );
    expect(
      await withBillingOriginOverride("api", () =>
        resolveTurnBillingOrigin(noDb, {
          grant: human,
          authorization: authorization(human, { canonicalManagedHumanSession: true }),
        }),
      ),
    ).toBe("api");
  });

  test("app entry points (Slack, schedules, Sites) are app; SDK and MCP surfaces are api", async () => {
    for (const surface of ["slack", "scheduled", "automation", "site", "voice"] as const) {
      expect(
        await resolveTurnBillingOrigin(noDb, { grant: human, requestedSurface: surface }),
      ).toBe("app");
    }
    for (const surface of ["api_key", "embedded", "mcp"] as const) {
      expect(
        await resolveTurnBillingOrigin(noDb, {
          grant: human,
          authorization: authorization(human, { canonicalManagedHumanSession: true }),
          requestedSurface: surface,
        }),
      ).toBe("api");
    }
    expect(
      await resolveTurnBillingOrigin(noDb, {
        grant: human,
        authorization: authorization(human, { canonicalManagedHumanSession: true }),
      }),
    ).toBe("app");
  });

  test("a sub-agent or tool inherits the origin of the chat it runs in", async () => {
    const agent: AccessGrant = {
      ...base,
      subjectId: "agent:x",
      principalKind: "agent_attempt",
      metadata: { turnId },
    };
    for (const billingOrigin of ["app", "api"] as const) {
      expect(
        await withCreditDebitAttribution(
          {
            kind: "turn",
            turnId,
            initiatingHumanSubjectId: null,
            billingOrigin,
          },
          () => resolveTurnBillingOrigin(noDb, { grant: agent, requestedSurface: "web" }),
        ),
      ).toBe(billingOrigin);
    }
    // Plan credit never pays for an agent whose chat cannot be found.
    expect(await resolveTurnBillingOrigin(noDb, { grant: agent, requestedSurface: "web" })).toBe(
      "api",
    );
  });
});

test("request stamps are bound to the exact Request object", () => {
  const request = new Request("https://example.test/");
  expect(requestBillingOrigin(request)).toBeNull();
  stampRequestBillingOrigin(request, "app");
  expect(requestBillingOrigin(request)).toBe("app");
  expect(requestBillingOrigin(new Request("https://example.test/"))).toBeNull();
});
