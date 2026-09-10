import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import { withAccessGrantSessionRlsContext } from "../src/access-grant-rls";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:access-grant-rls-test",
    permissions: ["workspace:read"],
    principalKind: "human_session",
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("access-grant session RLS context", () => {
  test("uses the authenticated subject for an ordinary grant", async () => {
    const actors: unknown[] = [];
    const context = spyOn(db, "withSessionRlsActorContext").mockImplementation(
      async (actor, fn) => {
        actors.push(actor);
        return await fn();
      },
    );
    const liveAttempt = spyOn(core, "requireLiveAgentAttemptAuthorization");

    const result = await withAccessGrantSessionRlsContext(
      { db: {} } as never,
      grant(),
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(actors).toEqual([{ subjectId: "user:access-grant-rls-test" }]);
    expect(context).toHaveBeenCalledTimes(1);
    expect(liveAttempt).not.toHaveBeenCalled();
  });

  test("revalidates an agent attempt and preserves its frozen human", async () => {
    const actors: unknown[] = [];
    spyOn(db, "withSessionRlsActorContext").mockImplementation(async (actor, fn) => {
      actors.push(actor);
      return await fn();
    });
    const liveAttempt = spyOn(core, "requireLiveAgentAttemptAuthorization").mockResolvedValue({
      subjectId: "worker:first-party-mcp",
      initiatingHumanSubjectId: "user:owner",
    } as never);
    const access = grant({
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      metadata: { sessionId },
    });

    await expect(
      withAccessGrantSessionRlsContext({ db: {} } as never, access, async () => "ok"),
    ).resolves.toBe("ok");
    expect(liveAttempt).toHaveBeenCalledWith({}, access, sessionId);
    expect(actors).toEqual([
      {
        subjectId: "worker:first-party-mcp",
        initiatingHumanSubjectId: "user:owner",
      },
    ]);
  });

  test("fails a malformed agent grant before entering an RLS context", async () => {
    const context = spyOn(db, "withSessionRlsActorContext");
    let caught: unknown;
    try {
      await withAccessGrantSessionRlsContext(
        { db: {} } as never,
        grant({ principalKind: "agent_attempt" }),
        async () => "unreachable",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HTTPException);
    expect((caught as HTTPException).status).toBe(403);
    expect(context).not.toHaveBeenCalled();
  });
});

const here = dirname(fileURLToPath(import.meta.url));

function routeHandler(source: string, route: string): string {
  const start = source.indexOf(`app.all("${route}"`);
  expect(start, `route not found: ${route}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced handler braces: ${route}`);
}

describe("MCP route RLS discipline", () => {
  for (const [filename, route] of [
    ["documents.ts", "/v1/workspaces/:workspaceId/mcp/docs"],
    ["files.ts", "/v1/workspaces/:workspaceId/mcp/files"],
  ] as const) {
    test(`${route} enters the grant RLS context for OAuth and ordinary grants`, () => {
      const source = readFileSync(resolve(here, "..", "src", "routes", filename), "utf8");
      const handler = routeHandler(source, route);
      expect(handler.match(/withAccessGrantSessionRlsContext\(/g)).toHaveLength(2);
      expect(handler).toContain("withAccessGrantSessionRlsContext(deps, oauthAccess.grant");
      expect(handler).toContain("withAccessGrantSessionRlsContext(deps, grant");
    });
  }
});
