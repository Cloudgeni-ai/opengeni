import { expect, test } from "bun:test";
import { ConnectController } from "@opengeni/connect";
import { z } from "zod";
import { OpenGeniClient } from "../src/index";

/**
 * A server from before popup endings: its strict begin schema has no
 * `finishInPopup`, and it answers an unknown field the way the API's request
 * validation does (400 `validation_failed`, naming the field).
 */
const olderBeginRequest = z
  .object({
    providerId: z.string(),
    ownership: z.enum(["personal", "workspace"]),
    returnUrl: z.string(),
    idempotencyKey: z.string(),
    reconnectAccountId: z.string().optional(),
    installationTarget: z.unknown().optional(),
    mcpSetup: z.unknown().optional(),
  })
  .strict();

function olderServer() {
  const begins: Record<string, unknown>[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://older.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v1/workspaces/workspace/connect/attempts");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      begins.push(body);
      const parsed = olderBeginRequest.safeParse(body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        }));
        return Response.json(
          {
            error: {
              code: "validation_failed",
              message: `Invalid request body: ${issues
                .map((issue) => `${issue.path || "request"}: ${issue.message}`)
                .join("; ")}`,
              retryable: false,
              details: { code: "invalid_request_body", issues, omittedIssueCount: 0 },
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        id: "attempt",
        workspaceId: "workspace",
        providerId: body.providerId,
        ownership: body.ownership,
        revision: 1,
        state: "requires_user_action",
        credentialsCommitted: false,
        integrationInstalled: false,
        completionRequirement: "connection",
        expiresAt: "2030-01-01T00:00:00Z",
        nextAction: { type: "authorize", url: "https://provider.example/authorize" },
      });
    },
  });
  return { transport: client.connectTransport(), begins };
}

test("a popup sign-in still begins against a server that predates popup endings", async () => {
  const { transport, begins } = olderServer();
  const controller = new ConnectController(transport, "workspace");
  const attempt = await controller.begin({
    providerId: "mcp-oauth",
    ownership: "personal",
    returnUrl: "https://host.example/chat",
    finishInPopup: true,
    idempotencyKey: "begin-once",
  });
  expect(attempt.nextAction).toEqual({
    type: "authorize",
    url: "https://provider.example/authorize",
  });
  // Refused by name, then begun the earlier way: the provider returns to the
  // host page, as before, with the same idempotency key.
  expect(begins).toHaveLength(2);
  expect(begins[0]).toMatchObject({ finishInPopup: true });
  expect(begins[1]).toEqual({
    providerId: "mcp-oauth",
    ownership: "personal",
    returnUrl: "https://host.example/chat",
    idempotencyKey: "begin-once",
  });
  expect(controller.getSnapshot().error).toBeNull();
});

test("other validation failures are not retried", async () => {
  const { transport, begins } = olderServer();
  const controller = new ConnectController(transport, "workspace");
  await expect(
    controller.begin({
      providerId: "mcp-oauth",
      ownership: "personal",
      returnUrl: "https://host.example/chat",
      idempotencyKey: "begin-once",
      reconnectAccountId: 7 as unknown as string,
    }),
  ).rejects.toThrow();
  expect(begins).toHaveLength(1);
});
