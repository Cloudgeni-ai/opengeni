import { expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { requireSessionAuthorization } from "../src/session-authorization";

test("session authorization never overlaps RLS savepoints on a transaction handle", async () => {
  let active = 0;
  let maxActive = 0;
  const db = {
    transaction: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active > 1) throw new Error("overlapping savepoints");
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      throw new Error("first scoped read stopped");
    },
  } as unknown as Database;
  const grant = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    principalKind: "service",
    metadata: {},
  } as AccessGrant;

  await expect(
    requireSessionAuthorization({ db, sessionAuthorization: undefined }, grant, {
      sessionId: crypto.randomUUID(),
      operation: "session.mcp.credentials.rotate",
      surface: "http",
    }),
  ).rejects.toThrow("first scoped read stopped");
  expect(maxActive).toBe(1);
});
