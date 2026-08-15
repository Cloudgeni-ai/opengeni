import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerConnectionAuthorityRoutes } from "../src/routes/connection-authorities";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const authorityId = "00000000-0000-4000-8000-000000000002";

describe("connection authority routes", () => {
  test("requires explicit user scope before authentication", async () => {
    const app = new Hono();
    registerConnectionAuthorityRoutes(app, {} as ApiRouteDeps);
    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/connection-authorities`,
    );
    expect(response.status).toBe(422);
  });

  test("rejects workspace_shared issuance without durable acknowledgement", async () => {
    const app = new Hono();
    registerConnectionAuthorityRoutes(app, {} as ApiRouteDeps);
    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/connection-authorities/${authorityId}/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "user",
          mode: "always",
          context: "workspace_shared",
          workspaceSharedAcknowledged: false,
        }),
      },
    );
    expect(response.status).toBe(422);
  });

  test("rejects caller-supplied owner and action fields", async () => {
    const app = new Hono();
    registerConnectionAuthorityRoutes(app, {} as ApiRouteDeps);
    const response = await app.request(
      `http://x/v1/workspaces/${workspaceId}/connection-authorities/${authorityId}/grants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "user",
          mode: "always",
          context: "user_private",
          workspaceSharedAcknowledged: false,
          ownerSubjectId: "user:mallory",
          action: "provider.admin",
        }),
      },
    );
    expect(response.status).toBe(422);
  });
});
