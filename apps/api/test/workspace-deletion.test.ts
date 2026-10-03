import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteWorkspaceForRequest } from "../src/workspace-deletion";

function failingDeletion(error: unknown) {
  let scheduleDeletes = 0;
  const deps = {
    db: {
      transaction: async () => {
        throw error;
      },
    },
    workflowClient: {
      deleteScheduledTaskSchedule: async () => {
        scheduleDeletes += 1;
      },
    },
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  app.onError((failure, c) =>
    failure instanceof HTTPException ? failure.getResponse() : c.text("Internal Server Error", 500),
  );
  app.delete("/workspace", async (c) => {
    await deleteWorkspaceForRequest(deps, { accountId: "account", workspaceId: "workspace" });
    return c.body(null, 204);
  });
  return { app, scheduleDeletes: () => scheduleDeletes };
}

describe("workspace deletion failure responses", () => {
  test("a wrapped foreign-key conflict is actionable without exposing database details", async () => {
    const { app, scheduleDeletes } = failingDeletion(
      new Error("query with private values", {
        cause: {
          code: "23503",
          constraint_name: "private_constraint",
          detail: "private audit values",
        },
      }),
    );
    const response = await app.request("http://x/workspace", { method: "DELETE" });
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("retained or linked records");
    expect(body).toContain("revoke access");
    expect(body).toContain("disable scheduled work");
    expect(body).not.toContain("private");
    expect(scheduleDeletes()).toBe(0);
  });

  test.each([
    ["42501", 403],
    ["P0002", 404],
    ["55P03", 409],
    ["23514", 500],
    ["40001", 500],
  ] as const)("preserves the existing %s response (%i)", async (code, status) => {
    const { app, scheduleDeletes } = failingDeletion(new Error("wrapped", { cause: { code } }));
    expect((await app.request("http://x/workspace", { method: "DELETE" })).status).toBe(status);
    expect(scheduleDeletes()).toBe(0);
  });

  test("a parser/observation error is not classified from its message", async () => {
    const { app } = failingDeletion(new SyntaxError("could not parse 23503 response"));
    expect((await app.request("http://x/workspace", { method: "DELETE" })).status).toBe(500);
  });
});
