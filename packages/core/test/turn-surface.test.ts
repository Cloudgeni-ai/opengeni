import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "../src/access";
import { resolveTurnSurface } from "../src/turn-surface";
import { withSiteSessionOrigin } from "../src/site-session-origin";

const base: AccessGrant = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:one",
  permissions: ["sessions:create", "sessions:control"],
};

function authorization(
  grant: AccessGrant,
  flags: Partial<Pick<AccessGrantAuthorization, "canonicalManagedHumanSession">> & {
    canonicalLocalHumanSession?: boolean;
  },
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

describe("resolveTurnSurface", () => {
  test("derives the surface from the access path the grant came from", () => {
    const cookie = { ...base, principalKind: "human_session" as const };
    expect(
      resolveTurnSurface({
        grant: cookie,
        authorization: authorization(cookie, { canonicalManagedHumanSession: true }),
      }),
    ).toBe("web");
    expect(
      resolveTurnSurface({
        grant: cookie,
        authorization: authorization(cookie, { canonicalLocalHumanSession: true }),
      }),
    ).toBe("web");
    expect(
      resolveTurnSurface({
        grant: { ...base, subjectId: "api_key:1", principalKind: "api_key" },
      }),
    ).toBe("api_key");
    expect(
      resolveTurnSurface({
        grant: { ...base, subjectId: "configured:key", principalKind: "configured_key" },
      }),
    ).toBe("api_key");
    expect(
      resolveTurnSurface({
        grant: { ...base, principalKind: "human_session", metadata: { delegated: true } },
      }),
    ).toBe("embedded");
    expect(
      resolveTurnSurface({
        grant: {
          ...base,
          principalKind: "human_session",
          metadata: { externalActor: { source: "host" } },
        },
      }),
    ).toBe("embedded");
    expect(
      resolveTurnSurface({
        grant: { ...base, principalKind: "human_session", metadata: { mcpOAuth: true } },
      }),
    ).toBe("mcp");
    expect(
      resolveTurnSurface({
        grant: {
          ...base,
          subjectId: "user:one",
          principalKind: "agent_attempt",
          metadata: { delegated: true, sessionId: "s", turnId: "t", attemptId: "a" },
        },
      }),
    ).toBe("agent");
    expect(resolveTurnSurface({ grant: { ...base } })).toBeNull();
  });

  test("an entry point's explicit surface wins and a validated Site scope marks site", () => {
    const cookie = { ...base, principalKind: "human_session" as const };
    expect(resolveTurnSurface({ grant: cookie, requested: "slack" })).toBe("slack");
    const inSite = withSiteSessionOrigin({ siteId: "site", title: "Site" }, () =>
      resolveTurnSurface({
        grant: cookie,
        authorization: authorization(cookie, { canonicalManagedHumanSession: true }),
      }),
    );
    expect(inSite).toBe("site");
    expect(resolveTurnSurface({ grant: cookie })).toBe("web");
  });
});
