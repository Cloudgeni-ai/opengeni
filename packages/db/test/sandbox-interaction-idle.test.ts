import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { countInteractionOnlyWarmLeasesByIdle, createDb, interactionOnlyIdleBucket } from "../src";
import { migrate } from "../src/migrate";
import { seedBrowserDeadlineCheckpoint } from "../../../test/fixtures/browser-deadline-checkpoint";

let owned: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireOwnerMigratedTestDatabase("sandbox-interaction-idle");
  if (!database) throw new Error("real database required for interaction idle inventory");
  owned = database;
  await migrate(owned.ownerUrl);
  client = createDb(owned.ownerUrl, { max: 3 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 120_000);

async function ageInteraction(
  target: Awaited<ReturnType<typeof seedBrowserDeadlineCheckpoint>>,
  minutes: number,
) {
  const at = new Date(Date.now() - minutes * 60_000);
  await owned.admin`update browser_sessions
    set controller_heartbeat_at = ${at}, last_used_at = ${at}
    where id = ${target.browserSessionId}`;
  await owned.admin`update sandbox_lease_holders set last_heartbeat_at = ${at}
    where lease_id = ${target.leaseId}`;
}

test("idle buckets are monotone in idle time", () => {
  expect(interactionOnlyIdleBucket(0)).toBe("lt_30m");
  expect(interactionOnlyIdleBucket(45 * 60_000)).toBe("30m_2h");
  expect(interactionOnlyIdleBucket(3 * 3_600_000)).toBe("2h_6h");
  expect(interactionOnlyIdleBucket(Infinity)).toBe("gte_6h");
});

test("counts warm leases held only by interaction sessions, by newest interaction activity", async () => {
  const idle = await seedBrowserDeadlineCheckpoint(owned);
  await ageInteraction(idle, 3 * 60);
  const fresh = await seedBrowserDeadlineCheckpoint(owned);
  await ageInteraction(fresh, 5);
  // A box that also has another holder kind is not interaction-only.
  const shared = await seedBrowserDeadlineCheckpoint(owned);
  await ageInteraction(shared, 8 * 60);
  await owned.admin`insert into sandbox_lease_holders (
      account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
    ) values (${shared.accountId}, ${shared.workspaceId}, ${shared.leaseId}, 'viewer',
      'viewer:fixture', now())`;
  // A draining lease is already on the normal idle path.
  const draining = await seedBrowserDeadlineCheckpoint(owned);
  await ageInteraction(draining, 8 * 60);
  await owned.admin`update sandbox_leases set liveness = 'draining' where id = ${draining.leaseId}`;

  // Candidates normally come from the sanctioned cross-workspace warm-lease
  // list; a stale candidate (lease no longer warm) must contribute nothing.
  const counts = await countInteractionOnlyWarmLeasesByIdle(
    client.db,
    [idle, fresh, shared, draining].map(({ accountId, workspaceId, sandboxGroupId }) => ({
      accountId,
      workspaceId,
      sandboxGroupId,
    })),
  );
  expect(counts).toEqual({ lt_30m: 1, "30m_2h": 0, "2h_6h": 1, gte_6h: 0 });
}, 180_000);
