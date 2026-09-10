import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { workspaceArtifactErrorResponse } from "../src/routes/workspace-artifacts";

describe("workspace artifact route errors", () => {
  test("maps a Drizzle-wrapped unique violation to the public conflict response", async () => {
    const app = new Hono();
    app.get("/", (context) =>
      workspaceArtifactErrorResponse(context, {
        name: "DrizzleQueryError",
        cause: {
          name: "PostgresError",
          code: "23505",
          constraint_name: "workspace_artifacts_workspace_slug_uq",
        },
      }),
    );

    const response = await app.request("/");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "WORKSPACE_ARTIFACT_CONFLICT",
      message: "Artifact slug or operation already exists",
    });
  });
});
