import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessGrant } from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import { viewerInteractionAgeFor } from "../src/sandbox/viewer";

// Interaction a viewer reports may keep a viewer-only box past the idle window
// (docs/run-lifecycle.md, "Boxes held only by viewers"). Only a person's own
// signed-in session can report it. A viewer kept alive through an API key
// (workspace, organization or personal), a delegated or service principal
// reports nothing a person did: its report is dropped, so the reaper bounds
// the box by the activity the server observes, as for an old client.

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:viewer-interaction-test",
    permissions: ["workspace:read"],
    principalKind: "human_session",
    ...overrides,
  };
}

const request = () => new Request("http://opengeni.test/v1/viewers/heartbeat", { method: "POST" });

describe("viewer interaction reports by credential", () => {
  test("a person's signed-in session reports interaction", () => {
    expect(viewerInteractionAgeFor(request(), grant(), 4_000)).toEqual({
      interactionAgeMs: 4_000,
    });
    // Old clients send nothing: nothing is recorded.
    expect(viewerInteractionAgeFor(request(), grant(), undefined)).toEqual({});
  });

  test("workspace and organization API keys report no interaction", () => {
    expect(
      viewerInteractionAgeFor(
        request(),
        grant({ principalKind: "api_key", subjectId: "api_key:k" }),
        0,
      ),
    ).toEqual({});
  });

  test("a personal API key acting as its owner reports no interaction", () => {
    // A personal key resolves to the owner's human_session grant through a
    // verified delegated-human stamp on the request.
    const keyed = request();
    stampDelegatedHumanAuthorization(keyed, {
      organizationId: accountId,
      subjectId: "user:viewer-interaction-test",
      permissions: ["workspace:read"] as never,
      workspaceScope: { kind: "all" },
    });
    expect(viewerInteractionAgeFor(keyed, grant(), 0)).toEqual({});
  });

  test("delegated and service-initiated grants report no interaction", () => {
    expect(
      viewerInteractionAgeFor(request(), grant({ metadata: { delegated: true } } as never), 0),
    ).toEqual({});
    expect(
      viewerInteractionAgeFor(
        request(),
        grant({ serviceInitiator: { kind: "service" } } as never),
        0,
      ),
    ).toEqual({});
  });

  test("both viewer routes pass reported interaction through the credential filter", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sessionsRoute = readFileSync(resolve(here, "..", "src", "routes", "sessions.ts"), "utf8");
    expect(
      sessionsRoute.match(
        /viewerInteractionAgeFor\(c\.req\.raw, grant, parsed\.lastInteractionAgeMs\)/g,
      )?.length,
    ).toBe(2);
    expect(sessionsRoute).not.toContain("interactionAgeMs: parsed.lastInteractionAgeMs");
  });
});
