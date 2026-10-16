import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPException } from "hono/http-exception";
import { alongsideAuthorization, withAccessGrantSessionRlsContext } from "../src/access-grant-rls";
import { ApiHttpError } from "../src/http/api-error";
import { httpRejectionFactsFromEnvelope } from "../src/http/rejection-telemetry";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";

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
      async () => {
        expect(db.currentCreditDebitAttribution()).toEqual({
          kind: "human",
          initiatingHumanSubjectId: "user:access-grant-rls-test",
        });
        return "ok";
      },
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
    spyOn(db, "freezeAgentLearningPolicy").mockResolvedValue({
      defaultScope: "personal",
      subjectId: "user:owner",
    } as never);
    const liveAttempt = spyOn(core, "requireLiveAgentAttemptAuthorization").mockResolvedValue({
      subjectId: "worker:first-party-mcp",
      turnId,
      initiatingHumanSubjectId: "user:owner",
    } as never);
    const access = grant({
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      metadata: { sessionId },
    });

    await expect(
      withAccessGrantSessionRlsContext({ db: {} } as never, access, async () => {
        expect(db.currentCreditDebitAttribution()).toEqual({
          kind: "turn",
          turnId,
          initiatingHumanSubjectId: "user:owner",
        });
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(liveAttempt).toHaveBeenCalledWith({}, access, sessionId);
    expect(actors).toEqual([
      {
        subjectId: "worker:first-party-mcp",
        initiatingHumanSubjectId: "user:owner",
        privateFileOwnerSubjectId: "user:owner",
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
    expect((caught as ApiHttpError).details).toEqual({ code: "agent_attempt_malformed" });
    expect(context).not.toHaveBeenCalled();
  });

  test("names an ended attempt when its credential is reused after the turn", async () => {
    const context = spyOn(db, "withSessionRlsActorContext");
    spyOn(core, "requireLiveAgentAttemptAuthorization").mockRejectedValue(
      new core.SessionAuthorizationDeniedError("caller_stale"),
    );
    let caught: unknown;
    try {
      await withAccessGrantSessionRlsContext(
        { db: {} } as never,
        grant({ principalKind: "agent_attempt", metadata: { sessionId } }),
        async () => "unreachable",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiHttpError);
    const error = caught as ApiHttpError;
    expect(error.status).toBe(403);
    expect(error.message).toBe("agent attempt authority is invalid");
    expect(error.details).toEqual({ code: "agent_attempt_caller_stale" });
    expect(
      httpRejectionFactsFromEnvelope(
        { error: { code: error.code, message: error.message, details: error.details } },
        "forbidden",
      ).reason,
    ).toBe("agent_attempt_caller_stale");
    expect(context).not.toHaveBeenCalled();
  });
  test("reads the claimed attempt's learning policy while the liveness check runs", async () => {
    spyOn(db, "withSessionRlsActorContext").mockImplementation(async (_actor, fn) => fn());
    const attemptId = "55555555-5555-4555-8555-555555555555";
    let settleLiveness!: (actor: unknown) => void;
    spyOn(core, "requireLiveAgentAttemptAuthorization").mockReturnValue(
      new Promise((settle) => {
        settleLiveness = settle;
      }) as never,
    );
    const policyReads: unknown[] = [];
    spyOn(db, "freezeAgentLearningPolicy").mockImplementation(async (_db, context) => {
      policyReads.push(context.actor);
      return { defaultScope: "workspace", subjectId: null } as never;
    });
    const access = grant({
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      metadata: { sessionId, turnId, attemptId, executionGeneration: 3 },
    });

    const result = withAccessGrantSessionRlsContext({ db: {} } as never, access, async () => "ok");
    await Bun.sleep(0);
    const claimed = { kind: "agent", sessionId, turnId, attemptId, executionGeneration: 3 };
    expect(policyReads).toEqual([claimed]);
    settleLiveness({
      subjectId: "worker:first-party-mcp",
      callerSessionId: sessionId,
      turnId,
      attemptId,
      executionGeneration: 3,
      initiatingHumanSubjectId: null,
    });
    await expect(result).resolves.toBe("ok");
    // The verified attempt is the claimed one, so the policy is not read again.
    expect(policyReads).toEqual([claimed]);
  });

  test("a refused liveness check is the answer even when the policy read also fails", async () => {
    const context = spyOn(db, "withSessionRlsActorContext");
    spyOn(core, "requireLiveAgentAttemptAuthorization").mockRejectedValue(
      new core.SessionAuthorizationDeniedError("caller_stale"),
    );
    spyOn(db, "freezeAgentLearningPolicy").mockRejectedValue(new Error("policy unavailable"));
    let caught: unknown;
    try {
      await withAccessGrantSessionRlsContext(
        { db: {} } as never,
        grant({
          principalKind: "agent_attempt",
          metadata: { sessionId, turnId, attemptId: turnId, executionGeneration: 1 },
        }),
        async () => "unreachable",
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as ApiHttpError).details).toEqual({ code: "agent_attempt_caller_stale" });
    expect(context).not.toHaveBeenCalled();
  });

  test("work started alongside a gate is dropped when the gate refuses", async () => {
    const refused = new Error("refused");
    await expect(
      alongsideAuthorization(Promise.reject(refused), async () => {
        throw new Error("work failed");
      }),
    ).rejects.toBe(refused);
    await expect(
      alongsideAuthorization(Promise.resolve("allowed"), async () => "read"),
    ).resolves.toEqual(["allowed", "read"]);
    const failed = new Error("work failed");
    await expect(
      alongsideAuthorization(Promise.resolve("allowed"), async () => {
        throw failed;
      }),
    ).rejects.toBe(failed);
  });

  test("API-key grants retain pure-service billing attribution, not a human subject", async () => {
    spyOn(db, "withSessionRlsActorContext").mockImplementation(async (_actor, fn) => fn());
    await withAccessGrantSessionRlsContext(
      { db: {} } as never,
      grant({ principalKind: "api_key", subjectId: "key:opaque" }),
      async () => {
        expect(db.currentCreditDebitAttribution()).toEqual({ kind: "service" });
      },
    );
    expect(db.currentCreditDebitAttribution()).toEqual({ kind: "unknown" });
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
