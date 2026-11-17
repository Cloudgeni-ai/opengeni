// The control worker's reaper pass publishes the turns parked waiting for
// subscription capacity under the production database setup (non-superuser
// owner, FORCE ROW LEVEL SECURITY) as the runtime role, with only the grants
// migrations give it: a normal deploy emits the gauge, no extra grant needed.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { refreshIdleSandboxReaperProjections } from "../src/activities/sandbox-lease";

setDefaultTimeout(120_000);
let fixture: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("capacity-waiting-gauge");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  fixture = acquired;
  app = createDb(fixture.appUrl, { searchPath: fixture.schema });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await fixture?.release();
}, 60_000);

test("the reaper pass publishes a parked turn by provider as the runtime role", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Capacity",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Capacity",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    initialMessage: "hello",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  // The state a turn parked on Codex capacity is in (see the db package's
  // capacity-waiting-turns test for every case that does not count).
  await fixture.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const [turn] = await tx<{ id: string; execution_generation: number }[]>`
      update session_turns set status = 'waiting_capacity'
      where session_id = ${session.id}::uuid returning id, execution_generation`;
    await tx`update sessions set status = 'waiting_capacity', active_turn_id = ${turn!.id}::uuid
      where id = ${session.id}::uuid`;
    await tx`insert into subscription_capacity_waiters (
        account_id, workspace_id, session_id, turn_id, provider, wait_reason,
        blocked_turn_generation, updated_at)
      values (${grant.accountId}::uuid, ${grant.workspaceId!}::uuid, ${session.id}::uuid,
        ${turn!.id}::uuid, 'codex', 'no_eligible_capacity', ${turn!.execution_generation},
        now() - interval '10 minutes')`;
  });

  const observability = createObservability(testSettings(), { component: "worker-control" });
  await refreshIdleSandboxReaperProjections({
    db: app.db,
    settings: testSettings(),
    observability,
    inspectOpenSandboxInventory: async () => {
      throw new Error("OpenSandbox is not configured in this test");
    },
  });
  const metrics = await observability.prometheusMetrics();
  const sample = (name: string, provider: string) =>
    Number(new RegExp(`^${name}\\{provider="${provider}"[^}]*\\} (\\S+)$`, "m").exec(metrics)?.[1]);
  expect(sample("opengeni_turns_waiting_capacity", "codex")).toBe(1);
  expect(sample("opengeni_turns_waiting_capacity", "claude")).toBe(0);
  expect(sample("opengeni_turns_waiting_capacity", "xai")).toBe(0);
  expect(sample("opengeni_turns_waiting_capacity_oldest_age_seconds", "codex")).toBeGreaterThanOrEqual(
    600,
  );
});
