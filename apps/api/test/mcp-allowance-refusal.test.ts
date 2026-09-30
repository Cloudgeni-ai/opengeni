import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../src/http/api-error";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

describe("actual MCP orchestration handler allowance refusals", () => {
  for (const tool of ["session_create", "session_send_message", "session_steer"] as const) {
    for (const scope of ["workspace", "member"] as const) {
      test(`${tool} retains ${scope} fields on first call and repeat`, async () => {
        const refusal = {
          code: "allowance_exhausted" as const,
          scope,
          resetsAt: scope === "workspace" ? "2026-10-01T00:00:00Z" : null,
          ...(scope === "member" ? { subjectId: "user:member" } : {}),
          message: "PRIVATE_SQL buy credits",
        };
        let touches = 0;
        const grant: AccessGrant = {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          subjectId: "worker:fixture",
          principalKind: "agent_attempt",
          permissions: ["sessions:create", "sessions:control"],
          metadata: {
            sessionId: crypto.randomUUID(),
            turnId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
            firstPartyMcpTools: [tool],
            executionGeneration: 1,
            nestedAgentDepth: 1,
            effectiveMaxNestedAgentDepth: 3,
          },
        };
        const deps = {
          settings: testSettings({ sandboxBackend: "none" }),
          bus: new MemoryEventBus(),
          db: new Proxy(
            {},
            {
              get() {
                touches += 1;
                throw scope === "workspace"
                  ? new HTTPException(402, {
                      message: "PRIVATE_WRAPPER",
                      cause: { ...refusal, allowed: false, sql: "PRIVATE_SQL" },
                    })
                  : new ApiHttpError(402, {
                      code: refusal.code,
                      message: refusal.message,
                      details: { ...refusal, sql: "PRIVATE_SQL" },
                    });
              },
            },
          ),
          workflowClient: {},
        } as unknown as ApiRouteDeps;
        const server = buildOpenGeniMcpServer(deps, grant);
        const handler = (
          server as unknown as {
            _registeredTools: Record<
              string,
              {
                handler: (
                  args: Record<string, unknown>,
                  extra: unknown,
                ) => Promise<{
                  isError?: boolean;
                  content: { text?: string }[];
                  structuredContent?: { error?: unknown };
                }>;
              }
            >;
          }
        )._registeredTools[tool]!.handler;
        const args = {
          initialMessage: "work",
          sessionId: crypto.randomUUID(),
          text: "work",
          instruction: "work",
          idempotencyKey: crypto.randomUUID(),
        };
        for (let call = 0; call < 2; call += 1) {
          const result = await handler(args, {});
          expect(result.isError).toBe(true);
          expect(result.structuredContent?.error).toMatchObject({
            code: refusal.code,
            scope,
            resetsAt: refusal.resetsAt,
            ...(scope === "member" ? { subjectId: refusal.subjectId } : {}),
          });
          expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
          expect(JSON.stringify(result)).not.toMatch(/PRIVATE|allowed|buy credits|subscription/i);
        }
        expect(touches).toBeGreaterThanOrEqual(2);
      });
    }
  }
});
