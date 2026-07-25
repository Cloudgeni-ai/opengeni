import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { assertWorkspaceMainSessionExists } from "../src/routes/workspaces";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("workspace main-session settings validation", () => {
  test("passes the exact workspace and session to the tenant-scoped lookup", async () => {
    const calls: Array<[string, string]> = [];
    await assertWorkspaceMainSessionExists(
      async (workspace, session) => {
        calls.push([workspace, session]);
        return { id: session };
      },
      workspaceId,
      sessionId,
    );
    expect(calls).toEqual([[workspaceId, sessionId]]);
  });

  test("rejects a missing or cross-workspace session without persisting it", async () => {
    try {
      await assertWorkspaceMainSessionExists(async () => null, workspaceId, sessionId);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(404);
      expect((error as HTTPException).message).toBe("workspace main session not found");
    }
  });
});
