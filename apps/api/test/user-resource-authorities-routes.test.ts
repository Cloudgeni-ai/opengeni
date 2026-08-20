import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerUserResourceAuthorityRoutes } from "../src/routes/user-resource-authorities";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const authorityId = "00000000-0000-4000-8000-000000000002";

describe("user-resource authority routes", () => {
  test("requires explicit user scope before authentication", async () => {
    const app = new Hono();
    registerUserResourceAuthorityRoutes(app, {} as ApiRouteDeps);
    expect(
      (await app.request(`http://x/v1/workspaces/${workspaceId}/user-resource-authorities`)).status,
    ).toBe(422);
  });

  test("rejects workspace_shared issuance without durable acknowledgement", async () => {
    const app = new Hono();
    registerUserResourceAuthorityRoutes(app, {} as ApiRouteDeps);
    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/user-resource-authorities/${authorityId}/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "user",
          action: "rig.use",
          mode: "always",
          context: "workspace_shared",
          workspaceSharedAcknowledged: false,
        }),
      },
    );
    expect(response.status).toBe(422);
  });
});
