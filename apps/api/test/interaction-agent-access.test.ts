import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import {
  filterInteractionSessionsForGrant,
  INTERACTION_SOURCE_AUTHORIZATION_CONCURRENCY,
} from "../src/interaction-agent-access";

afterEach(() => mock.restore());

const deps = {} as Pick<core.ApiRouteDeps, "db" | "sessionAuthorization">;
const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "alice",
  permissions: ["sessions:read"],
};
const interaction = (id: string, source: string, related?: string) => ({
  id,
  associations: [
    { sessionId: source, relationship: "created" },
    ...(related ? [{ sessionId: related, relationship: "observing" }] : []),
  ],
});

describe("interaction inventory visibility", () => {
  for (const principalKind of ["human_session", "api_key", "service", "agent_attempt"] as const) {
    test(`${principalKind} cannot list another owner's private browser or desktop`, async () => {
      const authorize = spyOn(core, "requireSessionAuthorization").mockImplementation(
        async (_deps, _grant, input) => {
          if (input.sessionId === "bob-private") {
            throw new core.SessionAuthorizationDeniedError("forbidden");
          }
          return {} as core.ResolvedSessionAuthorization;
        },
      );
      const own = interaction("alice-browser", "alice-private");
      const team = interaction("team-desktop", "shared");
      const caller = { ...grant, principalKind };
      const result = await filterInteractionSessionsForGrant(deps, caller, [
        own,
        interaction("bob-browser", "bob-private", "shared"),
        interaction("bob-desktop", "bob-private"),
        team,
      ]);
      expect(result).toEqual([own, team]);
      expect(authorize).toHaveBeenCalledTimes(3);
      expect(authorize).toHaveBeenCalledWith(deps, caller, {
        sessionId: "bob-private",
        operation: "session.read",
        surface: "http",
      });
    });
  }

  test("a permitted source remains visible without access to a related chat", async () => {
    const authorize = spyOn(core, "requireSessionAuthorization").mockResolvedValue(
      {} as core.ResolvedSessionAuthorization,
    );
    const browser = interaction("browser", "shared", "bob-private");
    expect(await filterInteractionSessionsForGrant(deps, grant, [browser])).toEqual([browser]);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]?.[2].sessionId).toBe("shared");
  });

  test("missing or ambiguous creation associations fail closed", async () => {
    const authorize = spyOn(core, "requireSessionAuthorization");
    expect(
      await filterInteractionSessionsForGrant(deps, grant, [
        { associations: [] },
        { associations: [{ sessionId: "shared", relationship: "using" }] },
        {
          associations: [
            { sessionId: "shared", relationship: "created" },
            { sessionId: "bob-private", relationship: "created" },
          ],
        },
      ]),
    ).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });

  test("authorization outages surface instead of returning a partial inventory", async () => {
    const unavailable = new Error("authorization unavailable");
    spyOn(core, "requireSessionAuthorization").mockRejectedValue(unavailable);
    await expect(
      filterInteractionSessionsForGrant(deps, grant, [interaction("browser", "shared")]),
    ).rejects.toBe(unavailable);
  });

  test("distinct source chats are checked once each, a bounded number at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const authorize = spyOn(core, "requireSessionAuthorization").mockImplementation(
      async (_deps, _grant, input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (input.sessionId.startsWith("private")) {
          throw new core.SessionAuthorizationDeniedError("forbidden");
        }
        return {} as core.ResolvedSessionAuthorization;
      },
    );
    const sessions = Array.from({ length: 40 }, (_, index) =>
      interaction(`browser-${index}`, `${index % 4 === 0 ? "private" : "chat"}-${index % 20}`),
    );
    const result = await filterInteractionSessionsForGrant(deps, grant, sessions);
    expect(authorize).toHaveBeenCalledTimes(20);
    expect(peak).toBe(INTERACTION_SOURCE_AUTHORIZATION_CONCURRENCY);
    expect(result).toEqual(sessions.filter((_, index) => index % 4 !== 0));
  });

  test("an outage stops starting further checks", async () => {
    const unavailable = new Error("authorization unavailable");
    const authorize = spyOn(core, "requireSessionAuthorization").mockRejectedValue(unavailable);
    const sessions = Array.from({ length: 30 }, (_, index) =>
      interaction(`browser-${index}`, `chat-${index}`),
    );
    await expect(filterInteractionSessionsForGrant(deps, grant, sessions)).rejects.toBe(
      unavailable,
    );
    expect(authorize.mock.calls.length).toBeLessThanOrEqual(
      INTERACTION_SOURCE_AUTHORIZATION_CONCURRENCY,
    );
  });
});
