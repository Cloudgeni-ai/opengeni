import { describe, expect, test } from "bun:test";
import { missingPermissionOf, stampDelegatedHumanAuthorization } from "@opengeni/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentActingAsPerson } from "../src/http/acting-person";

const organizationId = "2d0c3c0e-6a8c-4c43-9a4f-1d6a3b3a9e51";
const subjectId = "user:5b8f0b6e-8d0e-4c1c-9d2a-6e1f0a2b3c4d";

/** An agent acting as a person who gave it `account:read` only. */
async function act(organization: string, permission: "account:read" | "account:admin") {
  const app = new Hono();
  app.get("/act", (c) => c.json(agentActingAsPerson(c, organization, permission)));
  app.onError((error, c) =>
    c.json(
      { message: error.message, permission: missingPermissionOf(error) },
      error instanceof HTTPException ? error.status : 500,
    ),
  );
  const request = new Request("http://x/act");
  stampDelegatedHumanAuthorization(request, {
    organizationId,
    subjectId,
    permissions: ["account:read"],
    workspaceScope: { kind: "all" },
  });
  const response = await app.request(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("an agent acting as a person", () => {
  test("acts within the access the person gave it", async () => {
    expect(await act(organizationId, "account:read")).toEqual({
      status: 200,
      body: { subjectId },
    });
  });

  test("a permission outside that access is refused in a plain sentence, typed", async () => {
    const refused = await act(organizationId, "account:admin");
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      message: "This connection's access doesn't cover this action.",
      permission: "account:admin",
    });
  });

  test("another organization reads as not found", async () => {
    const other = await act("0f7a1c2d-3e4b-4f5a-8b6c-7d8e9f0a1b2c", "account:read");
    expect(other.status).toBe(404);
  });
});
