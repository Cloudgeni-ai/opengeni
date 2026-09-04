import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AutomationAcceptedExecution,
  AutomationSessionTemplate,
  CapabilityPack,
  type FirstPartyMcpToolName,
  NewSessionDraftOptions,
  ScheduledTaskAgentConfig,
  ScheduledTaskRunAcceptedExecution,
  WorkspaceSettingsSchema,
  stableJson,
} from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0402_session_input_wait_and_background_command_results.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function applyBelow(url: string, upperBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file >= upperBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${upperBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0402-session-input-wait");
  if (!owned && requireRealDatabase) {
    throw new Error("migration 0402 owner-migrated PostgreSQL unavailable");
  }
}, 600_000);

afterAll(async () => {
  await owned?.release();
}, 120_000);

describe("migration 0402 session input wait and background command results", () => {
  test("is a drained clean-break migration with the new durable contracts", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: maintenance\n")).toBeTrue();
    expect(sql).toContain("opengeni.migration_application_roles");
    expect(sql).toContain("pg_stat_activity");
    expect(sql).toContain("USING ERRCODE = '55000'");
    expect(sql.indexOf("pg_stat_activity")).toBeLessThan(sql.indexOf('ALTER TABLE "sessions"'));

    expect(sql).toContain('ADD COLUMN "input_wait_turn_id" uuid');
    expect(sql).toContain('ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "session_goals" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "new_session_drafts" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "automation_trigger_revisions" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "automation_runs" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "scheduled_task_runs" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "workspace_packs" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "pack_installations" NO FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("PERFORM acquire_session_tenancy_fence(workspace_id_value)");
    expect(sql.indexOf("acquire_session_tenancy_fence")).toBeLessThan(
      sql.indexOf('UPDATE "sessions" AS session SET'),
    );
    expect(sql).toContain(`WHERE session."first_party_mcp_tools" @> '["goal_wait"]'::jsonb`);
    expect(sql).toContain("WHEN 'goal_wait' THEN 'wait_for_input'");
    expect(sql).toContain("ranked.tool <> 'wait_for_input' OR ranked.tool_ordinality = 1");
    expect(sql).toContain("session_wait_rewrite_scheduled_execution");
    expect(sql).toContain("session_wait_rewrite_scheduled_agent_config");
    expect(sql).toContain("session_wait_rewrite_automation_template");
    expect(sql).toContain("session_wait_rewrite_pack");
    expect(sql).toContain("session_wait_canonical_json");
    expect(sql).toContain(
      "DISABLE TRIGGER scheduled_task_run_connection_session_identity_immutable",
    );
    expect(sql).toContain("DISABLE TRIGGER scheduled_task_connection_authority_execution_revision");
    expect(sql).toContain("DISABLE TRIGGER scheduled_task_personal_resource_execution_revision");
    expect(sql).toContain("operation.status IN ('pending', 'running')");
    expect(sql).not.toContain("DELETE FROM capability_operations");
    expect(sql.indexOf("SET CONSTRAINTS ALL IMMEDIATE")).toBeLessThan(
      sql.indexOf('ALTER TABLE "session_goals" FORCE ROW LEVEL SECURITY'),
    );
    expect(sql).toContain('ALTER TABLE "session_goals" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ADD CONSTRAINT "sessions_input_wait_check"');
    expect(sql).toContain('DROP COLUMN "continuation_hold_turn_id"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "session_command_receipts_wait_for_input_operation_uq"',
    );
    expect(sql).toContain("'session_wait_timeout'");
    expect(sql).toContain("'background_command_result'");
    expect(sql).toContain("there is no compatibility");
    expect(sql).toContain("alias for `goal_wait`");
  });

  test("copies an active hold as a NOSUPERUSER NOBYPASSRLS owner and restores FORCE RLS", async () => {
    if (!owned) return;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const automationSourceId = crypto.randomUUID();
    const automationTriggerId = crypto.randomUUID();
    const automationEventId = crypto.randomUUID();
    const automationRunId = crypto.randomUUID();
    const scheduledTaskId = crypto.randomUUID();
    const scheduledRunId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const packInstallationId = crypto.randomUUID();
    const packOperationId = crypto.randomUUID();
    const deadline = new Date(Date.now() + 3_600_000);
    const setAt = new Date();
    const historicalTools = [
      "session_wait",
      "goal_wait",
      "wait_for_input",
      "goal_wait",
      "goal_complete",
    ];
    const migratedTools: FirstPartyMcpToolName[] = [
      "session_wait",
      "wait_for_input",
      "goal_complete",
    ];
    const scheduledAgentConfig = {
      prompt: "Run the historical selection",
      resources: [],
      tools: [],
      metadata: {},
      executionClass: "incident_telemetry",
      incidentTelemetryPreflight: {
        requiredResources: [],
        requiredMcpServerIds: [],
        requiredFirstPartyMcpTools: historicalTools,
        requiredFirstPartyMcpPermissions: [],
        requiredRig: null,
        requiredVariableSetNames: [],
        requiredVariableNames: [],
        dataSource: {
          kind: "prometheus",
          queryPath: "/api/v1/query",
          workspaceLabel: "workspace_id",
          alertSelectorLabels: ["alert_id"],
          route: { kind: "first_party", tool: "goal_wait" },
          requiredSeries: [{ metric: "up", labels: ["workspace_id", "alert_id"] }],
          availableSeries: [{ metric: "up", labels: ["workspace_id", "alert_id"] }],
        },
      },
    };
    const automationTemplate = {
      prompt: "Investigate the accepted event",
      instructions: null,
      resources: [],
      skills: [],
      tools: [],
      firstPartyMcpTools: historicalTools,
      firstPartyMcpPermissions: [],
      model: null,
      reasoningEffort: null,
      sandboxBackend: null,
      policyRole: null,
      metadata: {},
    };
    const pack = {
      id: "session-wait-migration-pack",
      name: "Session wait migration Pack",
      description: "Proves registered and installed automation templates migrate together.",
      role: "engineering",
      category: "automation",
      version: "1.0.0",
      skills: [],
      components: [],
      tools: [],
      connectors: [],
      knowledge: [],
      scheduledTaskTemplates: [],
      automationTemplates: [
        {
          id: "investigate",
          name: "Investigate",
          description: "Investigate one event",
          adapterId: "signed-json.v1",
          eventTypes: ["migration.test"],
          sessionTemplate: automationTemplate,
          configuration: {},
          connectionRequirement: null,
        },
      ],
      metadata: {},
    };
    const previousPackDigest = createHash("sha256").update(stableJson(pack)).digest("hex");
    const scheduledAcceptedExecution = {
      version: 1,
      task: {
        id: scheduledTaskId,
        accountId,
        workspaceId,
        name: "0402 accepted execution",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `0401-${scheduledTaskId}`,
        runMode: "existing_session",
        overlapPolicy: "allow_concurrent",
        action: { kind: "agent_turn" },
        agentConfig: scheduledAgentConfig,
        createdBy: { kind: "service", subjectId: "scheduler" },
        createdByContext: {},
        personalConnections: [],
        authorityRevision: 1,
        executionDigest: "a".repeat(64),
        reusableSessionId: null,
        targetSessionId: sessionId,
        variableSetId: null,
        environmentId: null,
        rigId: null,
        metadata: {},
        createdAt: setAt.toISOString(),
        updatedAt: setAt.toISOString(),
      },
      resolvedModel: "test-model",
      resolvedReasoningEffort: "medium",
      resolvedLatencyMode: "standard",
      resolvedSandboxBackend: "none",
      resolvedSandboxOs: "linux",
      resolvedTools: [],
      resolvedFirstPartyMcpTools: historicalTools,
      resolvedFirstPartyMcpPermissions: [],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution: {
        sessionId,
        visibility: "workspace_shared",
        authorityEpoch: 1,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        tools: [],
        sandboxBackend: "none",
        sandboxOs: "linux",
        firstPartyMcpTools: historicalTools,
        firstPartyMcpPermissions: null,
        toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
        mcpServerIds: [],
        effectiveMcpServerIds: [],
        toolPolicyVersion: 1,
        variableSets: [],
        variableSetId: null,
        variableSetGeneration: null,
        rigId: null,
        rigVersionId: null,
        rigDefaultVariableSets: [],
        maxNestedAgentDepthOverride: null,
        effectiveMaxNestedAgentDepth: 1,
      },
      generatedSessionBinding: null,
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId: null,
      causalHumanSubjectId: null,
      causalHumanAuthority: null,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    };
    const automationAcceptedExecution = {
      version: 1,
      accountId,
      workspaceId,
      sourceId: automationSourceId,
      sourceVersion: 1,
      triggerId: automationTriggerId,
      triggerRevision: 1,
      eventId: automationEventId,
      adapterId: "signed-json.v1",
      occurrenceKey: "migration-0401",
      initialMessage: "Investigate the accepted event",
      sessionTemplate: automationTemplate,
      serviceSubjectId: `automation:${automationTriggerId}`,
      serviceLabel: "0402 automation",
      provenance: {},
    };

    await applyBelow(owned.ownerUrl, migrationName);
    await owned.admin`
      insert into managed_accounts (id, name) values (${accountId}, '0402 account')`;
    await owned.admin`
      insert into workspaces (id, account_id, name, settings)
      values (
        ${workspaceId}, ${accountId}, '0402 workspace',
        ${owned.admin.json({
          memoryEnabled: true,
          sessionToolDefaults: {
            mcpServerIds: [],
            firstPartyMcpTools: historicalTools,
          },
        })}::jsonb
      )`;
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}, ${accountId})`;
    await owned.admin`
      insert into organization_memberships (
        id, account_id, subject_id, status, personal_workspace_id,
        authorization_revision
      ) values (
        ${membershipId}, ${accountId}, 'user:0402', 'active', ${workspaceId}, 1
      )
    `;

    await owned.admin.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await sql`select set_config('opengeni.subject_id', 'user:0402', true)`;
      await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
      await sql`select acquire_session_tenancy_fence(${workspaceId})`;
      await sql`select set_config('opengeni.session_activity_gate_state', 'open', true)`;
      await sql`
        select set_config('opengeni.session_activity_gate_workspace_id', ${workspaceId}, true)
      `;
      await sql`
        insert into sessions (
          id, account_id, workspace_id, sandbox_group_id, status,
          created_by_kind, created_by_subject_id, initial_message, model,
          sandbox_backend, resources, tools, metadata, tool_policy,
          reasoning_effort, latency_mode, temporal_workflow_id,
          first_party_mcp_tools
        ) values (
          ${sessionId}, ${accountId}, ${workspaceId}, ${sessionId}, 'idle',
          'subject', 'user:0402', 'wait migration fixture', 'test-model',
          'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          '{"mode":"workspace_default","inheritedFromSessionId":null}'::jsonb,
          'medium', 'standard', ${`session-${sessionId}`},
          '["session_wait","goal_wait","wait_for_input","goal_wait","goal_complete"]'::jsonb
        )
      `;
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, latency_mode, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id, finished_at
        ) values (
          ${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()},
          ${`session-${sessionId}`}, 'completed', 'user', 1, 'wait', 'test-model',
          'medium', 'standard', 'none', 1, 'subject', 'user:0402', '{}'::jsonb,
          'user:0402', clock_timestamp()
        )
      `;
      await sql`
        insert into session_goals (
          account_id, workspace_id, session_id, text,
          continuation_hold_turn_id, continuation_hold_until,
          continuation_hold_reason, continuation_hold_set_at
        ) values (
          ${accountId}, ${workspaceId}, ${sessionId}, 'finish the migration',
          ${turnId}, ${deadline}, 'waiting before cutover', ${setAt}
        )
      `;
      await sql`
        insert into new_session_drafts (
          id, account_id, workspace_id, subject_id, text, resources, tools,
          model, reasoning_effort, latency_mode, session_options
        ) values (
          ${draftId}, ${accountId}, ${workspaceId}, 'user:0402', 'historical draft',
          '[]'::jsonb, '[]'::jsonb, 'test-model', 'medium', 'standard',
          ${sql.json({
            firstPartyMcpTools: historicalTools,
            toolsProvided: false,
            selectionHistory: { projects: [] },
          })}::jsonb
        )
      `;
      await sql`
        insert into automation_sources (
          id, account_id, workspace_id, name, adapter_id, configuration,
          webhook_secret_encrypted, created_by_subject_id
        ) values (
          ${automationSourceId}, ${accountId}, ${workspaceId}, '0402 source',
          'signed-json.v1', '{}'::jsonb, 'ciphertext', 'user:0402'
        )
      `;
      await sql`
        insert into automation_triggers (
          id, account_id, workspace_id, source_id, name, created_by_subject_id
        ) values (
          ${automationTriggerId}, ${accountId}, ${workspaceId}, ${automationSourceId},
          '0402 trigger', 'user:0402'
        )
      `;
      await sql`
        insert into automation_trigger_revisions (
          trigger_id, revision, account_id, workspace_id, adapter_id, event_types,
          configuration, parameters, session_template, created_by_subject_id
        ) values (
          ${automationTriggerId}, 1, ${accountId}, ${workspaceId}, 'signed-json.v1',
          '["migration.test"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
          ${sql.json(automationTemplate)}::jsonb, 'user:0402'
        )
      `;
      await sql`
        insert into automation_trigger_events (
          id, account_id, workspace_id, source_id, source_version,
          source_configuration, matched_trigger_revisions, delivery_key,
          request_digest, adapter_id, event_type, occurrence_key, normalized_event
        ) values (
          ${automationEventId}, ${accountId}, ${workspaceId}, ${automationSourceId}, 1,
          '{}'::jsonb,
          ${sql.json([{ triggerId: automationTriggerId, revision: 1 }])}::jsonb,
          '0401-delivery', ${"b".repeat(64)}, 'signed-json.v1', 'migration.test',
          'migration-0401',
          ${sql.json({
            adapterId: "signed-json.v1",
            eventType: "migration.test",
            occurrenceKey: "migration-0401",
            occurredAt: null,
            subject: null,
            resource: null,
            payload: {},
          })}::jsonb
        )
      `;
      await sql`
        insert into automation_runs (
          id, account_id, workspace_id, source_id, trigger_id, trigger_revision,
          event_id, occurrence_key, accepted_execution
        ) values (
          ${automationRunId}, ${accountId}, ${workspaceId}, ${automationSourceId},
          ${automationTriggerId}, 1, ${automationEventId}, 'migration-0401',
          ${sql.json(automationAcceptedExecution)}::jsonb
        )
      `;
      await sql`
        insert into workspace_packs (
          account_id, workspace_id, pack_id, manifest
        ) values (
          ${accountId}, ${workspaceId}, ${pack.id}, ${sql.json(pack)}::jsonb
        )
      `;
      await sql`
        insert into pack_installations (
          id, account_id, workspace_id, pack_id, status, version,
          manifest_snapshot, manifest_digest, installed_by_subject_id
        ) values (
          ${packInstallationId}, ${accountId}, ${workspaceId}, ${pack.id}, 'active', 1,
          ${sql.json(pack)}::jsonb, ${previousPackDigest}, 'user:0402'
        )
      `;
      await sql`
        insert into capability_operations (
          id, account_id, workspace_id, idempotency_key, request_digest, kind,
          target_kind, target_id, status, phase, result, created_by_subject_id
        ) values (
          ${packOperationId}, ${accountId}, ${workspaceId}, ${crypto.randomUUID()},
          ${"c".repeat(64)}, 'install', 'pack', ${pack.id}, 'outcome_unknown',
          'provider_requested',
          ${sql.json({ manifestDigest: previousPackDigest })}::jsonb,
          'user:0402'
        )
      `;
      await sql`select set_config('opengeni.session_activity_gate_state', 'preparing', true)`;
      await sql`set constraints all immediate`;
      await sql`
        set constraints sessions_activity_insert_commit_guard,
          sessions_activity_update_commit_guard deferred
      `;
      await sql`select set_config('opengeni.session_activity_gate_state', 'finalizing', true)`;
      await sql`
        with advanced as (
          update workspace_session_activity_revisions as counter
          set revision = counter.revision + 1
          where counter.workspace_id = ${workspaceId}
          returning counter.revision
        )
        update sessions as session
        set activity_revision = advanced.revision,
            activity_revision_pending_xid = null
        from advanced
        where session.workspace_id = ${workspaceId}
          and session.activity_revision_pending_xid = pg_current_xact_id()::text::bigint
      `;
      await sql`select set_config('opengeni.session_activity_gate_state', 'finalized', true)`;
    });

    await owned.admin`
      insert into scheduled_tasks (
        id, account_id, workspace_id, name, status, schedule,
        temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
        created_by_kind, created_by_subject_id, created_by_context,
        authority_revision, execution_digest, reusable_session_id, metadata
      ) values (
        ${scheduledTaskId}, ${accountId}, ${workspaceId}, '0402 scheduled task',
        'active', '{"type":"manual"}'::jsonb, ${`0401-${scheduledTaskId}`},
        'existing_session', 'allow_concurrent', '{"kind":"agent_turn"}'::jsonb,
        ${owned.admin.json(scheduledAgentConfig)}::jsonb,
        'subject', 'user:0402', '{}'::jsonb, 1, '', ${sessionId}, '{}'::jsonb
      )
    `;
    const [previousScheduledTask] = await owned.admin<
      Array<{ digest: string; authorityRevision: number }>
    >`
      select execution_digest as digest, authority_revision::int as "authorityRevision"
      from scheduled_tasks where id = ${scheduledTaskId}
    `;
    await owned.admin`
      insert into scheduled_task_revision_authorities (
        task_id, task_authority_revision, account_id, workspace_id, subject_id,
        organization_membership_id, membership_authorization_revision,
        execution_digest
      ) values (
        ${scheduledTaskId}, ${previousScheduledTask!.authorityRevision},
        ${accountId}, ${workspaceId}, 'user:0402', ${membershipId}, 1,
        ${previousScheduledTask!.digest}
      )
    `;
    await owned.admin`alter table scheduled_task_runs disable trigger user`;
    try {
      await owned.admin`
        insert into scheduled_task_runs (
          id, account_id, workspace_id, task_id, task_authority_revision,
          task_execution_digest, status, trigger_type, action_kind,
          accepted_execution_snapshot, accepted_execution_digest, completed_at
        ) values (
          ${scheduledRunId}, ${accountId}, ${workspaceId}, ${scheduledTaskId}, 1,
          ${"a".repeat(64)}, 'failed', 'manual', 'agent_turn',
          ${owned.admin.json(scheduledAcceptedExecution)}::jsonb,
          encode(
            digest(
              convert_to(${owned.admin.json(scheduledAcceptedExecution)}::jsonb::text, 'UTF8'),
              'sha256'
            ),
            'hex'
          ),
          clock_timestamp()
        )
      `;
    } finally {
      await owned.admin`alter table scheduled_task_runs enable trigger user`;
    }

    await migrate(owned.ownerUrl, undefined, {
      applicationDatabaseRoles: [owned.ownerRole],
    });

    const [wait] = await owned.admin<
      Array<{
        turnId: string | null;
        until: Date | null;
        reason: string | null;
        setAt: Date | null;
      }>
    >`
      select input_wait_turn_id as "turnId", input_wait_until as until,
        input_wait_reason as reason, input_wait_set_at as "setAt"
      from sessions where id = ${sessionId}`;
    expect(wait).toEqual({
      turnId,
      until: deadline,
      reason: "waiting before cutover",
      setAt,
    });
    const [selection] = await owned.admin<Array<{ tools: string[] }>>`
      select first_party_mcp_tools as tools from sessions where id = ${sessionId}`;
    expect(selection?.tools).toEqual(migratedTools);
    const [persistedSelections] = await owned.admin<
      Array<{
        workspaceTools: string[];
        draftTools: string[];
        revisionTools: string[];
        automationRunTools: string[];
        scheduledTools: string[];
        scheduledTargetTools: string[];
        scheduledTaskAgentConfig: unknown;
        scheduledTaskDigest: string;
        scheduledTaskAuthorityRevision: number;
        scheduledTaskRevisionAuthorityDigest: string;
        automationAcceptedExecution: unknown;
        registeredPack: unknown;
        installedPack: unknown;
        installedPackDigest: string;
        scheduledSnapshot: unknown;
        scheduledDigest: string;
      }>
    >`
      select
        workspace.settings #> '{sessionToolDefaults,firstPartyMcpTools}' as "workspaceTools",
        draft.session_options -> 'firstPartyMcpTools' as "draftTools",
        revision.session_template -> 'firstPartyMcpTools' as "revisionTools",
        automation_run.accepted_execution #> '{sessionTemplate,firstPartyMcpTools}'
          as "automationRunTools",
        scheduled.accepted_execution_snapshot -> 'resolvedFirstPartyMcpTools'
          as "scheduledTools",
        scheduled.accepted_execution_snapshot
          #> '{targetSessionExecution,firstPartyMcpTools}' as "scheduledTargetTools",
        task.agent_config as "scheduledTaskAgentConfig",
        task.execution_digest as "scheduledTaskDigest",
        task.authority_revision::int as "scheduledTaskAuthorityRevision",
        task_authority.execution_digest as "scheduledTaskRevisionAuthorityDigest",
        automation_run.accepted_execution as "automationAcceptedExecution",
        registered.manifest as "registeredPack",
        installation.manifest_snapshot as "installedPack",
        installation.manifest_digest as "installedPackDigest",
        scheduled.accepted_execution_snapshot as "scheduledSnapshot",
        scheduled.accepted_execution_digest as "scheduledDigest"
      from workspaces workspace
      join new_session_drafts draft on draft.workspace_id = workspace.id
      join automation_trigger_revisions revision on revision.workspace_id = workspace.id
      join automation_runs automation_run on automation_run.workspace_id = workspace.id
      join scheduled_tasks task on task.workspace_id = workspace.id
      join scheduled_task_revision_authorities task_authority
        on task_authority.task_id = task.id
       and task_authority.task_authority_revision = task.authority_revision
      join scheduled_task_runs scheduled on scheduled.workspace_id = workspace.id
      join workspace_packs registered on registered.workspace_id = workspace.id
      join pack_installations installation on installation.workspace_id = workspace.id
      where workspace.id = ${workspaceId}
        and draft.id = ${draftId}
        and revision.trigger_id = ${automationTriggerId}
        and automation_run.id = ${automationRunId}
        and task.id = ${scheduledTaskId}
        and scheduled.id = ${scheduledRunId}
        and registered.pack_id = ${pack.id}
        and installation.id = ${packInstallationId}
    `;
    expect(persistedSelections?.workspaceTools).toEqual(migratedTools);
    expect(persistedSelections?.draftTools).toEqual(migratedTools);
    expect(persistedSelections?.revisionTools).toEqual(migratedTools);
    expect(persistedSelections?.automationRunTools).toEqual(migratedTools);
    expect(persistedSelections?.scheduledTools).toEqual(migratedTools);
    expect(persistedSelections?.scheduledTargetTools).toEqual(migratedTools);
    const parsedTaskAgentConfig = ScheduledTaskAgentConfig.parse(
      persistedSelections?.scheduledTaskAgentConfig,
    );
    expect(parsedTaskAgentConfig.incidentTelemetryPreflight?.requiredFirstPartyMcpTools).toEqual(
      migratedTools,
    );
    expect(parsedTaskAgentConfig.incidentTelemetryPreflight?.dataSource.route).toEqual({
      kind: "first_party",
      tool: "wait_for_input",
    });
    expect(persistedSelections?.scheduledTaskAuthorityRevision).toBe(
      previousScheduledTask?.authorityRevision,
    );
    expect(persistedSelections?.scheduledTaskDigest).not.toBe(previousScheduledTask?.digest);
    expect(persistedSelections?.scheduledTaskRevisionAuthorityDigest).toBe(
      persistedSelections?.scheduledTaskDigest,
    );

    const parsedSettings = WorkspaceSettingsSchema.parse({
      memoryEnabled: true,
      sessionToolDefaults: {
        mcpServerIds: [],
        firstPartyMcpTools: persistedSelections?.workspaceTools,
      },
    });
    expect(parsedSettings.memoryEnabled).toBeTrue();
    expect(
      NewSessionDraftOptions.parse({
        firstPartyMcpTools: persistedSelections?.draftTools,
      }).firstPartyMcpTools,
    ).toEqual(migratedTools);
    expect(
      AutomationSessionTemplate.parse({
        ...automationTemplate,
        firstPartyMcpTools: persistedSelections?.revisionTools,
      }).firstPartyMcpTools,
    ).toEqual(migratedTools);
    expect(
      AutomationAcceptedExecution.parse(persistedSelections?.automationAcceptedExecution)
        .sessionTemplate.firstPartyMcpTools,
    ).toEqual(migratedTools);
    const parsedRegisteredPack = CapabilityPack.parse(persistedSelections?.registeredPack);
    const parsedInstalledPack = CapabilityPack.parse(persistedSelections?.installedPack);
    expect(
      parsedRegisteredPack.automationTemplates?.[0]?.sessionTemplate.firstPartyMcpTools,
    ).toEqual(migratedTools);
    expect(
      parsedInstalledPack.automationTemplates?.[0]?.sessionTemplate.firstPartyMcpTools,
    ).toEqual(migratedTools);
    expect(persistedSelections?.installedPackDigest).toBe(
      createHash("sha256").update(stableJson(parsedInstalledPack)).digest("hex"),
    );
    const parsedScheduledSnapshot = ScheduledTaskRunAcceptedExecution.parse(
      persistedSelections?.scheduledSnapshot,
    );
    expect(parsedScheduledSnapshot.resolvedFirstPartyMcpTools).toEqual(migratedTools);
    expect(
      parsedScheduledSnapshot.task.agentConfig.incidentTelemetryPreflight
        ?.requiredFirstPartyMcpTools,
    ).toEqual(migratedTools);
    expect(
      parsedScheduledSnapshot.task.agentConfig.incidentTelemetryPreflight?.dataSource.route,
    ).toEqual({ kind: "first_party", tool: "wait_for_input" });
    const [scheduledTaskDigest] = await owned.admin<Array<{ digest: string }>>`
      select scheduled_task_execution_digest(task) as digest
      from scheduled_tasks task where task.id = ${scheduledTaskId}
    `;
    expect(persistedSelections?.scheduledTaskDigest).toBe(scheduledTaskDigest?.digest);
    const [databaseDigest] = await owned.admin<Array<{ digest: string }>>`
      select encode(
        digest(
          convert_to(
            ${owned.admin.json(persistedSelections?.scheduledSnapshot as postgres.JSONValue)}::jsonb::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) as digest
    `;
    expect(persistedSelections?.scheduledDigest).toBe(databaseDigest?.digest);
    const [preservedOutcomeUnknown] = await owned.admin<Array<{ result: unknown }>>`
      select result from capability_operations where id = ${packOperationId}`;
    expect(preservedOutcomeUnknown?.result).toEqual({
      manifestDigest: previousPackDigest,
    });
    const oldColumns = await owned.admin<Array<{ name: string }>>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'session_goals'
        and column_name like 'continuation_hold_%'`;
    expect([...oldColumns]).toEqual([]);
    const posture = await owned.admin<Array<{ table: string; forced: boolean }>>`
      select relname as "table", relforcerowsecurity as forced
      from pg_class
      where relname in (
        'automation_runs',
        'automation_trigger_revisions',
        'capability_operations',
        'new_session_drafts',
        'pack_installations',
        'scheduled_task_connection_authority_snapshots',
        'scheduled_task_personal_resource_authorities',
        'scheduled_task_revision_authorities',
        'scheduled_task_runs',
        'scheduled_tasks',
        'session_goals',
        'sessions',
        'workspace_packs'
      )
      order by relname`;
    expect([...posture]).toEqual([
      { table: "automation_runs", forced: true },
      { table: "automation_trigger_revisions", forced: true },
      { table: "capability_operations", forced: true },
      { table: "new_session_drafts", forced: true },
      { table: "pack_installations", forced: true },
      { table: "scheduled_task_connection_authority_snapshots", forced: true },
      { table: "scheduled_task_personal_resource_authorities", forced: true },
      { table: "scheduled_task_revision_authorities", forced: true },
      { table: "scheduled_task_runs", forced: true },
      { table: "scheduled_tasks", forced: true },
      { table: "session_goals", forced: true },
      { table: "sessions", forced: true },
      { table: "workspace_packs", forced: true },
    ]);
  }, 900_000);
});
