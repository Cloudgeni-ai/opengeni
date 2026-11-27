import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  createConnection,
  createDb,
  createMemorySlackPublicationConfiguration,
  createSession,
  dispatchBrowserSessionOperation,
  enqueueMemorySlackPublication,
  enqueueSlackAppHomeRefresh,
  enqueueSlackInteractionInbox,
  prepareBrowserSessionCreate,
  prepareBrowserSessionSuspend,
  type DbClient,
} from "../src";

// Six SECURITY DEFINER maintenance routines read and update every tenant's
// rows. Under the owner posture docs/deployment.md describes (NOSUPERUSER
// NOBYPASSRLS, FORCE RLS) they found nothing before 1681-1692, because they
// opened no maintenance capability. Each now opens its own claim for its own
// call. These tests call them as the restricted runtime role, under that owner
// and under one that bypasses row security (production's), and require the
// same answer and side effects from both. The claim must not outlive the call,
// on success or error, and the runtime role must see nothing more.

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;

const OPERATIONS = [
  "browser_artifact_cleanup",
  "browser_upload_cleanup",
  "memory_slack_delivery",
  "slack_app_home",
  "slack_inbox",
] as const;

// Every table a claimer reads or writes, and the new owner policies on it.
const POLICIES = [
  ["browser_state_artifacts", "maintenance_browser_artifact_cleanup_select"],
  ["browser_state_artifacts", "maintenance_browser_artifact_cleanup_update"],
  ["browser_state_uploads", "maintenance_browser_upload_cleanup_select"],
  ["browser_state_uploads", "maintenance_browser_upload_cleanup_update"],
  ["interaction_operations", "maintenance_browser_upload_cleanup_select"],
  ["interaction_operations", "maintenance_browser_upload_cleanup_update"],
  ["browser_sessions", "maintenance_browser_upload_cleanup_select"],
  ["browser_sessions", "maintenance_browser_upload_cleanup_update"],
  ["workspace_interaction_revisions", "maintenance_browser_upload_cleanup_select"],
  ["workspace_interaction_revisions", "maintenance_browser_upload_cleanup_update"],
  ["memory_slack_publications", "maintenance_memory_slack_delivery_select"],
  ["memory_slack_publications", "maintenance_memory_slack_delivery_update"],
  ["memory_slack_publication_receipts", "maintenance_memory_slack_delivery_insert"],
  ["memory_slack_publication_receipts", "maintenance_memory_slack_delivery_select"],
  ["sessions", "maintenance_memory_slack_delivery_select"],
  ["slack_app_home_refreshes", "maintenance_slack_app_home_select"],
  ["slack_app_home_refreshes", "maintenance_slack_app_home_update"],
  ["slack_interaction_inbox", "maintenance_slack_inbox_select"],
  ["slack_interaction_inbox", "maintenance_slack_inbox_update"],
] as const;
const TABLES = [...new Set([...POLICIES.map(([table]) => table), "sandbox_leases"])];

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase(
    "maintenance-claimers-owner-rls",
    "claimer_rls_data",
  );
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
}, 300_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

class Rollback extends Error {}

/**
 * Run `body` in one transaction that the restricted runtime role starts, then
 * roll it back so each owner posture claims the same fixtures. The body may
 * RESET ROLE to read the transaction's own effects as the superuser.
 */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await shared.admin
    .begin(async (tx) => {
      // The runtime's own protocol marker (lossless-json.ts); session reads need it.
      await tx`set local application_name = 'opengeni-lossless-v1-session-variable-sets-v1'`;
      await tx`set local role opengeni_app`;
      result = await body(tx);
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}

/** What the runtime and the owner see, and the open capabilities, mid-transaction. */
async function leftovers(tx: postgres.TransactionSql) {
  const counts = async () => {
    const seen: Record<string, number> = {};
    for (const table of TABLES) {
      const [row] = await tx<{ count: number }[]>`select count(*)::int as count from ${tx(table)}`;
      seen[table] = row!.count;
    }
    return seen;
  };
  await tx`reset role`;
  const [claims] = await tx<{ maintenance: number; modal: number }[]>`
    select
      (select count(*)::int from opengeni_private.maintenance_claim_capabilities) as maintenance,
      (select count(*)::int from opengeni_private.modal_inventory_read_capabilities) as modal`;
  await tx`set local role opengeni_app`;
  const runtime = await counts();
  await tx.unsafe(`set local role "${shared.ownerRole}"`);
  const owner = await counts();
  await tx`reset role`;
  const [posture] = await tx<{ bypass: boolean }[]>`
    select rolbypassrls as bypass from pg_roles where rolname = ${shared.ownerRole}`;
  await tx`set local role opengeni_app`;
  return { claims, runtime, owner: posture!.bypass ? "bypasses" : owner };
}

const nothingVisible = Object.fromEntries(TABLES.map((table) => [table, 0]));
const noLeftovers = {
  claims: { maintenance: 0, modal: 0 },
  runtime: nothingVisible,
  owner: expect.anything(),
};

async function seed() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "maintenance-claimers",
    accountExternalId: `account-${suffix}`,
    accountName: "Maintenance claimers",
    workspaceExternalSource: "maintenance-claimers",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Maintenance claimers",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });

  // A live browser session whose dispatched suspension's upload authority
  // expired: cleanup marks the operation outcome_unknown, the session lost,
  // and advances the workspace interaction revision.
  const createOperationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    accountId,
    workspaceId,
    operationId: createOperationId,
    associatedSessionId: session.id,
    actorSubjectId: grant.subjectId,
    name: "Cleanup browser",
    initialUrl: "https://example.com/",
    placement: { kind: "sandbox_group", sandboxGroupId: session.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const browserSessionId = prepared.session.id;
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    accountId,
    workspaceId,
    operationId: createOperationId,
    browserSessionId,
    controllerGeneration,
  });
  await activateBrowserSession(client.db, {
    accountId,
    workspaceId,
    operationId: createOperationId,
    browserSessionId,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.7922.108",
  });
  const suspendOperationId = crypto.randomUUID();
  await prepareBrowserSessionSuspend(client.db, {
    accountId,
    workspaceId,
    browserSessionId,
    operationId: suspendOperationId,
    actorSubjectId: grant.subjectId,
  });
  const uploadKey = `workspaces/${workspaceId}/browser-state/checkpoints/${suspendOperationId}.ogbp`;
  await dispatchBrowserSessionOperation(client.db, {
    accountId,
    workspaceId,
    operationId: suspendOperationId,
    browserSessionId,
    controllerGeneration,
    stateUpload: { objectKey: uploadKey, cleanupAfter: new Date(Date.now() + 100) },
  });

  // A retired private checkpoint past its retention.
  const artifactId = crypto.randomUUID();
  const artifactKey = `workspaces/${workspaceId}/browser-state/checkpoints/${artifactId}.ogbp`;
  await shared.admin`
    insert into browser_state_artifacts (
      id, account_id, workspace_id, source_browser_session_id, purpose, kind,
      format, artifact_digest, content_digest, manifest_digest, object_key,
      encrypted_data_key, size_bytes, materialization, state, retained_until
    ) values (
      ${artifactId}, ${accountId}, ${workspaceId}, ${browserSessionId},
      'private_checkpoint', 'chromium_profile',
      'application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm',
      ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${artifactKey},
      ${`wrapped-data-key-${artifactId}`}, 4096, ${shared.admin.json({
        portability: "portable",
        reason: null,
        platform: "linux",
        architecture: "x64",
        engine: "chromium",
        engineVersion: "151.0.7922.108",
        driverId: "opengeni.cdp.v1",
        driverSchemaVersion: 1,
        profileCrypto: "chromium_basic",
        providerId: null,
        placement: null,
      })}, 'delete_pending', now() - interval '1 minute'
    )`;

  // Slack: one queued Memory publication from an agent in the session (so the
  // restrictive session visibility policy applies), one App Home refresh and
  // one inbox entry.
  const teamId = `T_CLAIMERS_${suffix.slice(0, 8)}`;
  const connection = await createConnection(client.db, {
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: ["fixture", "ciphertext"].join("-"),
    grantedScopes: ["app_mentions:read", "chat:write", "commands", "im:history"],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: teamId,
      slackTeamName: "Maintenance claimers",
      botId: `B_${suffix.slice(0, 8)}`,
      botUserId: `U_${suffix.slice(0, 8)}`,
      botDisplayName: "Opengeni",
      verifiedAt: new Date().toISOString(),
    },
  });
  await createMemorySlackPublicationConfiguration(client.db, {
    accountId,
    workspaceId,
    expectedRevision: 0,
    enabled: true,
    connectionId: connection.id,
    slackTeamId: teamId,
    slackChannelId: "C_CLAIMERS",
    slackChannelName: "general",
    autoImportances: ["major"],
    reviewImportances: ["normal"],
    subjectId: grant.subjectId,
  });
  const enqueued = await enqueueMemorySlackPublication(client.db, {
    accountId,
    workspaceId,
    sourceType: "workspace_memory",
    sourceId: suffix,
    sourceVersion: "1",
    sourceIdempotencyKey: `claimers:${suffix}`,
    projection: { summary: "Claimed under either owner posture.", changeKind: "created" },
    importance: "major",
    deliveryMode: "auto",
    actor: { kind: "agent", subjectId: `agent:${suffix}`, sessionId: session.id },
  });
  if (enqueued.kind !== "enqueued") throw new Error("expected a newly enqueued publication");
  const refresh = await enqueueSlackAppHomeRefresh(client.db, {
    accountId,
    workspaceId,
    connectionId: connection.id,
    slackTeamId: teamId,
    slackUserId: "U_CLAIMERS_VIEWER",
    providerEventId: `E_${suffix}`,
    providerViewHash: "hash-1",
  });
  const inbox = await enqueueSlackInteractionInbox(client.db, {
    accountId,
    workspaceId,
    connectionId: connection.id,
    providerEventId: `E_INBOX_${suffix}`,
    providerMessageId: `M_${suffix}`,
    slackTeamId: teamId,
    slackUserId: "U_CLAIMERS",
    slackChannelId: "D_CLAIMERS",
    slackMessageTs: "1710000000.000001",
    slackThreadTs: null,
    triggerKind: "dm",
    text: "Start a private task",
    hasFiles: false,
  });

  // A warm Modal lease whose current checkpoint is still an inline archive.
  const leaseId = crypto.randomUUID();
  const sandboxGroupId = crypto.randomUUID();
  const descriptor = { version: 2, provider: "modal_snapshot_filesystem", snapshotId: "im-1" };
  await shared.admin`
    insert into sandbox_leases (id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, workspace_generation, archive_generation, provider_created_at,
      provider_deadline_at)
    values (${leaseId}, ${accountId}, ${workspaceId}, ${sandboxGroupId}, 'warm', 0, 0, 0,
      'box-claimers', 'modal', 1, 'modal',
      ${JSON.stringify({
        backendId: "modal",
        sessionState: { workspaceArchive: "YXJjaGl2ZQ==", workspaceArchiveMeta: descriptor },
      })}::text::jsonb,
      now() + interval '10 minutes', 1, 1, now(), now() + interval '1 hour')`;

  await Bun.sleep(150);
  const [interaction] = await shared.admin<{ revision: number }[]>`
    select revision::int from workspace_interaction_revisions where workspace_id = ${workspaceId}`;
  return {
    accountId,
    workspaceId,
    sessionId: session.id,
    browserSessionId,
    suspendOperationId,
    uploadKey,
    artifactId,
    artifactKey,
    publicationId: enqueued.publication.id,
    refreshId: refresh.id,
    inboxId: inbox.entry.id,
    leaseId,
    sandboxGroupId,
    descriptor,
    interactionRevision: interaction!.revision,
  };
}

let fixture: Awaited<ReturnType<typeof seed>> | undefined;
async function fixtures() {
  fixture ??= await seed();
  return fixture;
}

const holder = crypto.randomUUID();

/** Each routine's answer and effects, from one rolled-back runtime transaction each. */
async function claimAll() {
  const scope = await fixtures();
  return {
    artifacts: await rolledBack(async (tx) => {
      const claimed = await tx`
        select artifact_id::text, account_id::text, workspace_id::text, object_key
        from opengeni_private.claim_browser_state_artifact_cleanup(60000, 100)`;
      const after = await leftovers(tx);
      await tx`reset role`;
      const effects = await tx`
        select state, delete_claim_id is not null as claimed
        from browser_state_artifacts where id = ${scope.artifactId}`;
      return { claimed: [...claimed], effects: [...effects], after };
    }),
    uploads: await rolledBack(async (tx) => {
      const claimed = await tx`
        select account_id::text, workspace_id::text, object_key
        from opengeni_private.claim_browser_state_upload_cleanup(60000, 100)`;
      const after = await leftovers(tx);
      await tx`reset role`;
      const effects = await tx`
        select
          (select state from browser_state_uploads
            where workspace_id = ${scope.workspaceId}
              and operation_id = ${scope.suspendOperationId}) as upload,
          (select state || ':' || error_code from interaction_operations
            where workspace_id = ${scope.workspaceId}
              and operation_id = ${scope.suspendOperationId}) as operation,
          (select lifecycle || ':' || failure_code from browser_sessions
            where id = ${scope.browserSessionId}) as browser,
          (select revision::int from workspace_interaction_revisions
            where workspace_id = ${scope.workspaceId}) as revision`;
      return { claimed: [...claimed], effects: [...effects], after };
    }),
    memory: await rolledBack(async (tx) => {
      const claimed = await tx`
        select id::text, session_id::text, state, claim_holder_id::text, attempt_count
        from opengeni_private.claim_memory_slack_publication(${holder}::uuid, 60000)`;
      const after = await leftovers(tx);
      await tx`reset role`;
      const effects = await tx`
        select sequence, kind, state, attempt_number, actor_kind
        from memory_slack_publication_receipts
        where publication_id = ${scope.publicationId} order by sequence`;
      return { claimed: [...claimed], effects: [...effects], after };
    }),
    appHome: await rolledBack(async (tx) => {
      const claimed = await tx`
        select id::text, claim_holder_id::text, attempt_count
        from opengeni_private.claim_slack_app_home_refresh(${holder}::uuid, 60000)`;
      return { claimed: [...claimed], after: await leftovers(tx) };
    }),
    inbox: await rolledBack(async (tx) => {
      const claimed = await tx`
        select id::text, status, claim_holder_id::text, attempt_count
        from opengeni_private.claim_slack_interaction_inbox(${holder}::uuid, 60000)`;
      return { claimed: [...claimed], after: await leftovers(tx) };
    }),
    legacyModal: await rolledBack(async (tx) => {
      const listed = await tx`
        select account_id::text, workspace_id::text, sandbox_group_id::text, lease_id::text,
          lease_epoch, instance_id, workspace_generation, slot, archive_base64, descriptor
        from opengeni_private.list_legacy_modal_checkpoint_slots(100)`;
      return { claimed: [...listed], after: await leftovers(tx) };
    }),
  };
}

test("the maintenance claimers find the same rows under either owner posture", async () => {
  const [owner] = await shared.admin<{ bypass: boolean }[]>`
    select rolbypassrls as bypass from pg_roles where rolname = ${shared.ownerRole}`;
  expect(owner?.bypass).toBe(false);
  const scope = await fixtures();
  const results: Record<string, Awaited<ReturnType<typeof claimAll>>> = {};
  try {
    for (const posture of ["nobypassrls", "bypassrls"] as const) {
      await shared.admin.unsafe(`alter role "${shared.ownerRole}" ${posture}`);
      results[posture] = await claimAll();
    }
  } finally {
    await shared.admin.unsafe(`alter role "${shared.ownerRole}" nobypassrls`);
  }
  const tenant = { account_id: scope.accountId, workspace_id: scope.workspaceId };
  // Before 1681-1692 every routine returned nothing under the NOBYPASSRLS owner.
  const expected = {
    artifacts: {
      claimed: [{ ...tenant, artifact_id: scope.artifactId, object_key: scope.artifactKey }],
      effects: [{ state: "deleting", claimed: true }],
      after: noLeftovers,
    },
    uploads: {
      claimed: [{ ...tenant, object_key: scope.uploadKey }],
      effects: [
        {
          upload: "deleting",
          operation: "outcome_unknown:browser_state_upload_expired",
          browser: "lost:browser_state_upload_expired",
          // Cleanup advances the workspace interaction revision exactly once.
          revision: scope.interactionRevision + 1,
        },
      ],
      after: noLeftovers,
    },
    memory: {
      claimed: [
        {
          id: scope.publicationId,
          session_id: scope.sessionId,
          state: "delivering",
          claim_holder_id: holder,
          attempt_count: 1,
        },
      ],
      effects: [
        { sequence: 1, kind: "enqueued", state: "queued", attempt_number: 0, actor_kind: "agent" },
        {
          sequence: 2,
          kind: "delivery_claimed",
          state: "delivering",
          attempt_number: 1,
          actor_kind: "service",
        },
      ],
      after: noLeftovers,
    },
    appHome: {
      claimed: [{ id: scope.refreshId, claim_holder_id: holder, attempt_count: 1 }],
      after: noLeftovers,
    },
    inbox: {
      claimed: [
        { id: scope.inboxId, status: "processing", claim_holder_id: holder, attempt_count: 1 },
      ],
      after: noLeftovers,
    },
    legacyModal: {
      claimed: [
        {
          ...tenant,
          sandbox_group_id: scope.sandboxGroupId,
          lease_id: scope.leaseId,
          lease_epoch: 1,
          instance_id: "box-claimers",
          workspace_generation: 1,
          slot: "current",
          archive_base64: "YXJjaGl2ZQ==",
          descriptor: scope.descriptor,
        },
      ],
      after: noLeftovers,
    },
  };
  expect(results.nobypassrls).toMatchObject(expected);
  // Identical answers and effects under production's owner.
  expect(results.bypassrls).toEqual({
    ...results.nobypassrls!,
    ...Object.fromEntries(
      Object.entries(results.nobypassrls!).map(([name, result]) => [
        name,
        { ...result, after: { ...result.after, owner: "bypasses" } },
      ]),
    ),
  });
  // Without BYPASSRLS, the owner outside a call holds no claim and sees no row.
  for (const result of Object.values(results.nobypassrls!)) {
    expect(result.after.owner).toEqual(nothingVisible);
  }
}, 120_000);

test("no claim outlives a failed call, and the transaction can claim again", async () => {
  const scope = await fixtures();
  await shared.admin.unsafe(`
    create function claimer_rls_forced_failure() returns trigger language plpgsql as $$
    begin
      if current_setting('claimer_rls.fail', true) = 'on' then
        raise exception 'forced claimer failure';
      end if;
      return new;
    end $$;
    create trigger claimer_rls_forced_failure before update on slack_app_home_refreshes
      for each row execute function claimer_rls_forced_failure();`);
  try {
    const outcome = await rolledBack(async (tx) => {
      const claim = `select id::text from opengeni_private.claim_slack_app_home_refresh('${holder}'::uuid, 60000)`;
      // An argument error raises before any claim is written.
      await expect(
        tx.savepoint(
          (sp) =>
            sp`select * from opengeni_private.claim_slack_app_home_refresh(${holder}::uuid, 1)`,
        ),
      ).rejects.toThrow("invalid Slack App Home claim lease");
      await expect(
        tx.savepoint(
          (sp) => sp`select * from opengeni_private.list_legacy_modal_checkpoint_slots(0)`,
        ),
      ).rejects.toThrow("legacy checkpoint slot limit");
      const argumentErrors = await leftovers(tx);
      // A failure after the claim is written, rolled back to a savepoint.
      await tx`select set_config('claimer_rls.fail', 'on', true)`;
      await expect(tx.savepoint((sp) => sp.unsafe(claim))).rejects.toThrow(
        "forced claimer failure",
      );
      const savepoint = await leftovers(tx);
      // The same failure caught by a PL/pgSQL exception block.
      await tx.unsafe(`do $$ begin
          perform opengeni_private.claim_slack_app_home_refresh('${holder}'::uuid, 60000);
        exception when raise_exception then null;
        end $$`);
      const exceptionBlock = await leftovers(tx);
      await tx`select set_config('claimer_rls.fail', 'off', true)`;
      const claimed = await tx.unsafe<{ id: string }[]>(claim);
      return {
        argumentErrors,
        savepoint,
        exceptionBlock,
        claimed: [...claimed],
        after: await leftovers(tx),
      };
    });
    expect(outcome).toEqual({
      argumentErrors: { ...noLeftovers, owner: nothingVisible },
      savepoint: { ...noLeftovers, owner: nothingVisible },
      exceptionBlock: { ...noLeftovers, owner: nothingVisible },
      claimed: [{ id: scope.refreshId }],
      after: { ...noLeftovers, owner: nothingVisible },
    });
  } finally {
    await shared.admin.unsafe(`
      drop trigger claimer_rls_forced_failure on slack_app_home_refreshes;
      drop function claimer_rls_forced_failure();`);
  }
}, 60_000);

test("the claim policies bind only the owner and the migrations replay without change", async () => {
  const catalog = async () => ({
    policies: [
      ...(await shared.admin<{ table: string; policy: string; command: string; roles: string[] }[]>`
        select c.relname as table, p.polname as policy, p.polcmd::text as command,
          array(select pg_get_userbyid(role) from unnest(p.polroles) role order by 1) as roles
        from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = ${shared.schema}::regnamespace
          and p.polname = any(${POLICIES.map(([, policy]) => policy)})
        order by 1, 2`),
    ],
    check: (
      await shared.admin<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'maintenance_claim_capabilities_operation_check'`
    )[0]!.definition,
    routines: [
      ...(await shared.admin<{ name: string; owner: string; body: string }[]>`
        select proname as name, pg_get_userbyid(proowner) as owner, prosrc as body
        from pg_proc where pronamespace = 'opengeni_private'::regnamespace
          and proname = any(${[
            "claim_browser_state_artifact_cleanup",
            "claim_browser_state_upload_cleanup",
            "claim_memory_slack_publication",
            "claim_slack_app_home_refresh",
            "claim_slack_interaction_inbox",
            "list_legacy_modal_checkpoint_slots",
          ]})
        order by 1`),
    ],
  });
  const before = await catalog();
  expect(before.policies.map(({ table, policy }) => [table, policy])).toEqual(
    POLICIES.map(([table, policy]) => [table, policy]).sort((a, b) =>
      a.join(".").localeCompare(b.join(".")),
    ),
  );
  for (const policy of before.policies) {
    expect(policy.roles).toEqual([shared.ownerRole]);
    const command = policy.policy.slice(policy.policy.lastIndexOf("_") + 1);
    const commands: Record<string, string> = { select: "r", update: "w", insert: "a" };
    expect(policy.command).toBe(commands[command]!);
  }
  for (const operation of OPERATIONS) expect(before.check).toContain(`'${operation}'::text`);
  // The operations already allowed stay allowed.
  for (const operation of ["wakes", "titles", "schedule_cleanup"]) {
    expect(before.check).toContain(`'${operation}'::text`);
  }
  expect(before.routines).toHaveLength(6);
  for (const routine of before.routines) expect(routine.owner).toBe(shared.ownerRole);
  // The runtime role cannot open a claim itself.
  const [runtime] = await shared.admin<{ insert: boolean }[]>`
    select has_table_privilege('opengeni_app',
      'opengeni_private.maintenance_claim_capabilities', 'insert') as insert`;
  expect(runtime?.insert).toBe(false);

  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^(168[1-9]|169[0-2])_.*\.sql$/.test(name))
    .sort();
  expect(files).toHaveLength(12);
  const owner = postgres(shared.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: { search_path: shared.schema },
  });
  try {
    for (let replay = 0; replay < 2; replay++) {
      for (const file of files)
        await owner.unsafe(await readFile(new URL(file, directory), "utf8"));
    }
  } finally {
    await owner.end();
  }
  expect(await catalog()).toEqual(before);
}, 60_000);
