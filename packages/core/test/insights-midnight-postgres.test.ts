import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  createDb,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { getWorkspaceInsights } from "../src/domain/insights";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-insights-midnight");
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("Workspace Insights exact UTC boundary", () => {
  test("returns empty today, month, and YTD snapshots through the real app role", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const userId = `insights-midnight-${suffix}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Insights midnight owner",
    });
    const workspaceId = access.workspaceGrants[0]!.workspaceId!;
    const current = new Date();
    const year = current.getUTCFullYear();
    const cases = [
      {
        range: "today" as const,
        now: new Date(Date.UTC(year, current.getUTCMonth(), current.getUTCDate())),
      },
      { range: "month" as const, now: new Date(Date.UTC(year, current.getUTCMonth(), 1)) },
      { range: "ytd" as const, now: new Date(Date.UTC(year, 0, 1)) },
    ];

    for (const { range, now } of cases) {
      const { snapshot } = await withSessionRlsActorContext({ subjectId }, () =>
        getWorkspaceInsights(client!.db, testSettings({ sandboxSelfhostedEnabled: false }), {
          workspaceId,
          range,
          now,
        }),
      );
      expect(snapshot.windowStart).toBe(now.toISOString());
      expect(snapshot.windowEnd).toBe(now.toISOString());
      expect(snapshot.series).toEqual([]);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.recentCalls).toEqual([]);
      expect(snapshot.workspaceCreditUsd).toBe(0);
      expect(snapshot.creditUsd).toBe(0);
    }
  });
});
