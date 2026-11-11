import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  scrubSessionSecretHistory,
  secretRedactionMarker,
  type SecretRedactionMatcher,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// The secret history scrub on machine inputs (docs/secrets.md, "Removing
// secrets from stored history"). An accepted scheduled occurrence is
// immutable (0275, 0717); 1091 lets only its own cell writer replace the
// summary and payload, and every other change stays refused. Values are
// obviously fake.

const FAKE_TOKEN = "ghp_MACHINEFAKEMACHINEFAKEMACHINE2222";
const IMMUTABLE = /scheduled occurrence accepted content is immutable/u;

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-secret-redaction-machine-inputs");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function literalMatcher(value: string, label: string): SecretRedactionMatcher {
  const marker = secretRedactionMarker(label);
  return { marker, redact: (text) => text.split(value).join(marker) };
}

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scrub-machine-account-${suffix}`,
    accountName: "Machine input scrub",
    workspaceExternalSource: "test",
    workspaceExternalId: `scrub-machine-workspace-${suffix}`,
    workspaceName: "Machine input scrub",
    subjectId: `user:scrub-machine-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal scrub fixture') returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return { ...grant, workspaceId: grant.workspaceId! };
}

/** A scheduled run fired through the real dispatcher, with the token in its prompt. */
async function scheduledOccurrence(grant: Awaited<ReturnType<typeof workspace>>) {
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Nightly push",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scrub-machine-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: `Push the release with token ${FAKE_TOKEN}`,
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
  });
  const scheduler = createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
  const dispatched = await scheduler.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `scrub-machine:${crypto.randomUUID()}`,
  });
  if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
  const [occurrence] = await shared.admin<{ id: string }[]>`
    select occurrence.id::text as id
    from scheduled_task_runs run
    join session_system_updates occurrence on occurrence.scheduled_task_run_id = run.id
    where run.task_id = ${task.id}::uuid and run.session_id = ${dispatched.sessionId}::uuid`;
  return { sessionId: dispatched.sessionId, occurrenceId: occurrence!.id };
}

/** The machine-input rows of the session that still hold `value`, read as the owner. */
async function machineInputsHolding(sessionId: string, value: string) {
  const rows = await shared.admin<{ id: string }[]>`
    select id::text as id from session_system_updates t
    where t.session_id = ${sessionId}::uuid and strpos(row_to_json(t)::text, ${value}) > 0`;
  return rows.map((row) => row.id).sort();
}

describe("secret history scrub of machine inputs", () => {
  test("plain and accepted scheduled machine inputs are rewritten, and the occurrence fences still hold", async () => {
    const grant = await workspace();
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
    const { sessionId, occurrenceId } = await scheduledOccurrence(grant);
    const plain = await addSessionSystemUpdate(client.db, {
      ...scope,
      sessionId,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `scrub-machine-${crypto.randomUUID()}`,
      summary: `Use ${FAKE_TOKEN} for the push`,
      payload: {
        type: "agent_message",
        text: `The token is ${FAKE_TOKEN}, keep it safe`,
        operationId: crypto.randomUUID(),
      },
    });
    if (!plain.added) throw new Error("machine input was not inserted");
    const plainId = plain.update.id;
    expect(await machineInputsHolding(sessionId, FAKE_TOKEN)).toEqual(
      [occurrenceId, plainId].sort(),
    );
    // The dispatched run's turn has not started here; the scrub leaves busy
    // sessions alone, so rest the session as the worker would after the run.
    await shared.admin`
      update sessions set status = 'idle', active_turn_id = null where id = ${sessionId}::uuid`;

    const report = await scrubSessionSecretHistory(client.db, scope, {
      sessionIds: [sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/machine")],
      dryRun: false,
    });
    expect(report.failures).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.tables.session_system_updates!.rowsMatched).toBe(2);
    expect(report.tables.session_system_updates!.rowsChanged).toBe(2);
    expect(await machineInputsHolding(sessionId, FAKE_TOKEN)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(FAKE_TOKEN);

    const [rewritten] = await shared.admin<{ summary: string; text: string }[]>`
      select summary, payload->>'text' as text from session_system_updates
      where id = ${plainId}::uuid`;
    expect(rewritten!.summary).toBe("Use [redacted: test/machine] for the push");
    expect(rewritten!.text).toBe("The token is [redacted: test/machine], keep it safe");
    const [scheduled] = await shared.admin<{ row: string }[]>`
      select row_to_json(t)::text as row from session_system_updates t
      where id = ${occurrenceId}::uuid`;
    expect(scheduled!.row).toContain("[redacted: test/machine]");

    // Outside the cell writer the accepted occurrence stays immutable, even
    // to the table owner.
    // The transaction-local marker alone lets nothing through: only the cell
    // writer's capability row does.
    const ownerUpdate = async (assignment: string, withMarker = false) => {
      try {
        await shared.admin.begin(async (tx) => {
          if (withMarker) {
            await tx`select set_config('opengeni.session_secret_redaction', 'v1', true)`;
          }
          await tx.unsafe(`update session_system_updates set ${assignment} where id = $1::uuid`, [
            occurrenceId,
          ]);
        });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(await ownerUpdate(`subscription_authority = '{"forged": true}'::jsonb`)).toMatch(
      IMMUTABLE,
    );
    expect(
      await ownerUpdate(`claude_provider_account_authority_snapshot = '{"forged": true}'::jsonb`),
    ).toMatch(IMMUTABLE);
    expect(await ownerUpdate(`summary = 'edited outside the scrub'`)).toMatch(IMMUTABLE);
    expect(await ownerUpdate(`summary = '[redacted: forged]'`, true)).toMatch(IMMUTABLE);

    const again = await scrubSessionSecretHistory(client.db, scope, {
      sessionIds: [sessionId],
      matchers: [literalMatcher(FAKE_TOKEN, "test/machine")],
      dryRun: false,
    });
    expect(again.failures).toEqual([]);
    expect(again.tables.session_system_updates!.rowsMatched).toBe(0);
  }, 180_000);
});
