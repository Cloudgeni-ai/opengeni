/**
 * Static analysis for migration-time backfills that silently no-op
 * under OpenGeni's production migration principal.
 *
 * `FORCE ROW LEVEL SECURITY` binds the TABLE OWNER, not merely ordinary roles;
 * only a genuine `SUPERUSER` (or `BYPASSRLS`) escapes it. OpenGeni's documented
 * deployment posture (`docs/deployment.md`) runs migrations as a NON-superuser
 * owner without `BYPASSRLS`. During a migration no `opengeni.account_id` /
 * `opengeni.workspace_id` GUC is set, so a GUC-gated `workspace_isolation`
 * policy evaluates false for every row and a top-level `UPDATE` / `DELETE` /
 * `INSERT ... SELECT` / `DO $$ ... $$` backfill loop touches ZERO rows and
 * reports success.
 *
 * One mitigation is the owner-only posture window already used by
 * `0009_goal_sessions_first_party_goals_manage.sql` and
 * `0120_durable_goal_wake.sql`:
 *
 *   ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
 *   -- ... the backfill ...
 *   ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
 *
 * `NO FORCE` relaxes only the owner; the application role stays policy-bound,
 * and the migration runner executes each file in one implicit transaction so a
 * failure rolls back the posture change with the data repair.
 *
 * Alternatives this analyzer also accepts: setting the tenant GUC around the
 * statement, disabling RLS on the table for the window, or activating a policy
 * that is pinned to the exact table owner and a transaction-local capability.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = "packages/db/drizzle";

/**
 * Migrations that shipped before this class was identified. Their bytes are
 * frozen by the release schema-contract hash ladder and cannot be rewritten, so
 * they are recorded here instead. `0296_force_rls_backfill_noop_repair.sql`
 * repairs the instances that genuinely lost data; the rest are classified in
 * `docs/force-rls-migration-backfills.md`.
 *
 * DO NOT add to this list. A new migration that needs a backfill over a
 * FORCE-RLS table must open the `NO FORCE` window instead.
 */
export const GRANDFATHERED_MIGRATIONS: readonly string[] = [
  "0014_repair_orphaned_function_call_results.sql",
  "0018_sandbox_os.sql",
  "0045_workspace_memory_v1.sql",
  "0057_durable_queue_control.sql",
  "0058_turn_admission_usage_enrollment.sql",
  "0061_session_workflow_wake_outbox.sql",
  "0063_session_control_mega_foundation.sql",
  "0064_rotation_strategy_sharded_backfill.sql",
  "0065_session_attempt_quiescence.sql",
  "0068_workspace_control_event_bounds.sql",
  "0069_session_event_history_backfill.sql",
  "0094_quarantine_credential_bearing_catalog_urls.sql",
  "0104_host_export_root_session_backfill.sql",
  "0111_nested_agent_depth_backfill.sql",
  "0117_sandbox_recovery_generations.sql",
  "0122_codex_capacity_same_turn.sql",
  "0126_document_access_constraints.sql",
  "0132_connection_subject_isolation.sql",
  "0135_durable_machine_input_batches.sql",
  "0136_unified_session_tool_policy.sql",
  "0138_sandbox_checkpoint_artifacts_and_deadlines.sql",
  "0143_session_codex_compaction_mode.sql",
  "0148_session_turn_latency_mode.sql",
  "0149_workspace_artifacts.sql",
  "0152_hierarchical_memory_foundation.sql",
  "0157_session_policy_role_snapshots.sql",
  "0170_session_control_wake_revision.sql",
  "0172_retire_model_visible_github_token.sql",
  "0175_resumable_transcription_provider_deadline.sql",
  "0180_retained_screenshot_lifecycle_fences.sql",
  "0184_sandbox_drain_teardown_fence.sql",
  "0186_sandbox_capture_provider_contract.sql",
  "0197_knowledge_source_sync_schedules.sql",
  "0201_company_profile_authority.sql",
  "0202_document_index_checkpoints.sql",
  "0212_browser_state_transfer_hardening.sql",
  "0212_slack_installation_bindings.sql",
  "0213_browser_interaction_authority.sql",
  "0215_browser_controller_host.sql",
  "0216_browser_auth_health_evidence.sql",
  "0219_organization_tenancy_managed_human_provisioning.sql",
  "0222_session_visibility_authority_epochs.sql",
  "0224_slack_post_outcome_reconciliation.sql",
  "0225_session_visibility_fork_activation.sql",
  "0226_personal_codex_authority_foundation.sql",
  "0231_integration_definition_identity_cutover.sql",
  "0232_integration_facet_authority_cutover.sql",
  "0233_skill_and_integration_authority_cutover.sql",
  "0234_xai_subscription_authority.sql",
  "0235_canonical_human_login_bindings.sql",
  "0238_goal_persistence_policy.sql",
  "0238_recover_unclaimed_session_turns.sql",
  "0240_model_context_user_messages.sql",
  "0241_atomic_personal_resource_delegation.sql",
  "0247_terraform_stacks_provenance_repair.sql",
  "0249_personal_resource_delegation_authority_correction.sql",
  "0252_scheduled_personal_resource_delegation.sql",
  "0253_common_user_resource_authority_lifecycle.sql",
  "0254_scoped_variable_set_authority.sql",
  "0256_connection_authority_delegation.sql",
  "0258_three_scope_document_knowledge_authority.sql",
  "0262_scoped_connected_machines_and_rigs.sql",
  "0263_organization_membership_lifecycle.sql",
  "0264_connection_authority_runtime_activation.sql",
  "0275_scheduled_connection_authority.sql",
  "0277_workspace_writer_authority_attribution.sql",
  "0280_connection_and_variable_set_audit_attribution.sql",
  "0289_session_composer_policy_authority.sql",
];

/**
 * Migrations whose `DO $$ ... IF EXISTS (SELECT ... FROM <FORCE-RLS table>)
 * ... RAISE EXCEPTION` preflight guard reads zero rows for the same reason, so
 * the guard passes vacuously and never fires. These predate the guard.
 * The safety of those cutovers came from `VALIDATE CONSTRAINT` / `SET NOT NULL`
 * / unique-index builds, which are internal scans and DO bypass RLS - never
 * from the `DO` block.
 *
 * DO NOT add to this list. A new preflight guard over a FORCE-RLS table must
 * open the `NO FORCE` window too, or it is decoration.
 */
export const GRANDFATHERED_VACUOUS_GUARDS: readonly string[] = [
  "0057_durable_queue_control.sql",
  "0063_session_control_mega_foundation.sql",
  "0106_session_attempt_mcp_approval_policies.sql",
  "0107_host_export_lineage_contract.sql",
  "0110_nested_agent_depth_boundary.sql",
  "0122_codex_capacity_same_turn.sql",
  "0135_durable_machine_input_batches.sql",
  "0137_preference_registry.sql",
  "0157_session_policy_role_snapshots.sql",
  "0197_knowledge_source_sync_schedules.sql",
  "0199_workspace_learning_policy.sql",
  "0225_session_visibility_fork_activation.sql",
  "0231_integration_definition_identity_cutover.sql",
  "0232_integration_facet_authority_cutover.sql",
  "0233_skill_and_integration_authority_cutover.sql",
  "0240_model_context_user_messages.sql",
  "0247_terraform_stacks_provenance_repair.sql",
  "0248_terraform_stacks_component_resolution_fence.sql",
  "0264_connection_authority_runtime_activation.sql",
  "0275_scheduled_connection_authority.sql",
];

export type BackfillFinding = {
  /** Migration file name, e.g. `0296_...sql`. */
  file: string;
  /** 1-based index of the offending top-level statement within the file. */
  statement: number;
  /**
   * `write` - a backfill that matches zero rows and reports success.
   * `vacuous-guard` - a `RAISE EXCEPTION` preflight that can never fire.
   */
  kind: "write" | "vacuous-guard";
  /** FORCE-RLS tables the statement touches. */
  tables: string[];
  /** Leading text of the statement, whitespace-collapsed. */
  snippet: string;
};

/** Split a migration file into top-level statements, honouring dollar quoting. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const stop = newline === -1 ? sql.length : newline + 1;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const stop = close === -1 ? sql.length : close + 2;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === char && sql[cursor + 1] === char) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, index + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        current += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (char === ";") {
      current += ";";
      if (current.trim()) out.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const stripComments = (text: string) =>
  text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const TABLE_REF = (table: string) => `(?:"${table}"|${table})`;
const NOT_IDENT = String.raw`(?![A-Za-z0-9_"])`;

/** Does `statement` write rows of `table` at the top level? */
export function writesTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return (
    new RegExp(String.raw`\b(?:UPDATE|MERGE\s+INTO)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
      statement,
    ) ||
    new RegExp(String.raw`\bINSERT\s+INTO\s+${ref}${NOT_IDENT}`, "i").test(statement) ||
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(statement)
  );
}

/** Does `statement` read rows of `table`? */
export function readsTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
    statement,
  );
}

const ROUTINE_START = /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/gi;
const ROUTINE_AS_DOLLAR = /\bAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i;

/**
 * Drop CREATE FUNCTION/PROCEDURE bodies so a DO block that *defines* a
 * later-running trigger/lifecycle routine is not treated as a migration-time
 * backfill. `EXECUTE format($ddl$ UPDATE ... $ddl$)` still looks like a write.
 */
export function stripRoutineBodies(statement: string): string {
  let out = "";
  let index = 0;
  while (index < statement.length) {
    ROUTINE_START.lastIndex = index;
    const match = ROUTINE_START.exec(statement);
    if (!match || match.index === undefined) {
      out += statement.slice(index);
      break;
    }
    out += statement.slice(index, match.index);
    const asTag = ROUTINE_AS_DOLLAR.exec(statement.slice(match.index));
    if (!asTag || asTag.index === undefined || asTag[1] === undefined) {
      out += statement.slice(match.index, match.index + match[0].length);
      index = match.index + match[0].length;
      continue;
    }
    const tag = asTag[1];
    const bodyStart = match.index + asTag.index + asTag[0].length;
    const close = statement.indexOf(tag, bodyStart);
    if (close === -1) {
      out += statement.slice(match.index);
      break;
    }
    out += `${statement.slice(match.index, bodyStart)} /* routine body omitted */ `;
    index = close + tag.length;
  }
  return out;
}

const DDL_ONLY =
  /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|MATERIALIZED|TRIGGER|INDEX|UNIQUE|POLICY|SCHEMA|TYPE|EXTENSION|SEQUENCE|ROLE|TABLE)/i;
const NON_DML =
  /^(DROP|ALTER|GRANT|REVOKE|COMMENT|SET|RESET|LOCK|ANALYZE|VACUUM|REASSIGN|SECURITY)\b/i;

type OwnerCapabilityPolicy = { guc: string; table: string };

function ownerCapabilityPolicy(statement: string): OwnerCapabilityPolicy | null {
  const target =
    /^CREATE\s+POLICY\s+(?:"[^"]+"|[a-z0-9_]+)\s+ON\s+(?:(?:"[^"]+"|[a-z0-9_]+)\.)?"?([a-z0-9_]+)"?/i.exec(
      statement.trim(),
    );
  const guc = /current_setting\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*true\s*\)/i.exec(statement);
  if (
    !target ||
    !guc ||
    !/\bFOR\s+ALL\b/i.test(statement) ||
    !/\bWITH\s+CHECK\b/i.test(statement)
  ) {
    return null;
  }

  const table = target[1]!;
  const exactOwner = new RegExp(
    String.raw`current_user\s*=\s*\(\s*SELECT\s+pg_catalog\.pg_get_userbyid\s*\(\s*[a-z0-9_]+\.relowner\s*\)\s+FROM\s+pg_catalog\.pg_class\s+[a-z0-9_]+\s+WHERE\s+[a-z0-9_]+\.oid\s*=\s*'${table}'::regclass\s*\)`,
    "gi",
  );
  const exactOwnerChecks = statement.match(exactOwner)?.length ?? 0;
  const capabilityChecks = statement.match(
    new RegExp(
      String.raw`current_setting\s*\(\s*'opengeni\.${guc[1]}'\s*,\s*true\s*\)\s*=\s*'1'`,
      "gi",
    ),
  )?.length;
  if (exactOwnerChecks < 2 || (capabilityChecks ?? 0) < 2) return null;
  return { guc: guc[1]!, table };
}

function activatedOwnerCapabilityTables(
  statement: string,
  policies: ReadonlyMap<string, OwnerCapabilityPolicy>,
): Set<string> {
  const activeGucs = new Set<string>();
  for (const match of statement.matchAll(
    /set_config\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*'1'\s*,\s*true\s*\)/gi,
  )) {
    activeGucs.add(match[1]!);
  }
  return new Set(
    [...policies.values()]
      .filter((policy) => activeGucs.has(policy.guc))
      .map((policy) => policy.table),
  );
}

/**
 * Walk the whole ordered migration ledger, tracking which tables have RLS
 * enabled + forced at each point, and report top-level writes that would match
 * zero rows for a non-superuser owner.
 */
export function analyzeMigrationRlsBackfills(migrationsDir: string): BackfillFinding[] {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const forced = new Set<string>();
  const enabled = new Set<string>();
  const ownerCapabilityPolicies = new Map<string, OwnerCapabilityPolicy>();
  const findings: BackfillFinding[] = [];

  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), "utf8");
    // Owner-only posture window and tenant GUC state are per-file: the runner
    // executes one file as one implicit transaction.
    const unforced = new Set<string>();
    let tenantGuc = false;
    let statementNumber = 0;

    for (const rawStatement of splitStatements(raw)) {
      statementNumber += 1;
      const statement = stripComments(rawStatement);
      const head = statement.trim().replace(/\s+/g, " ");

      const createdPolicy = ownerCapabilityPolicy(statement);
      if (createdPolicy) {
        const policyName =
          /^CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z0-9_]+))/i.exec(head)?.slice(1).find(Boolean) ?? "";
        ownerCapabilityPolicies.set(policyName.toLowerCase(), createdPolicy);
      }
      const droppedPolicy =
        /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\b/i.exec(head);
      if (droppedPolicy) {
        ownerCapabilityPolicies.delete((droppedPolicy[1] ?? droppedPolicy[2]!).toLowerCase());
      }

      // A DDL statement that merely *defines* a routine whose body mentions
      // set_config must not latch this: the GUC is set when that routine is
      // called, not when it is created. Latching here silently suppressed
      // every later candidate in the file - and "CREATE FUNCTION ... then
      // backfill" is exactly the shape this repo's authority migrations take.
      if (
        !DDL_ONLY.test(head) &&
        /set_config\s*\(\s*'opengeni\.(account_id|workspace_id)'/i.test(statement)
      ) {
        tenantGuc = true;
      }

      // ---- posture tracking -------------------------------------------------
      const dynamicPosture =
        /^DO\b/i.test(head) &&
        /EXECUTE\s+format\(\s*'ALTER TABLE %I (ENABLE|FORCE) ROW LEVEL SECURITY/i.test(statement);
      if (dynamicPosture) {
        const array = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(statement);
        for (const quoted of array?.[1]?.matchAll(/'([a-z0-9_]+)'/gi) ?? []) {
          if (/ENABLE ROW LEVEL SECURITY/i.test(statement)) enabled.add(quoted[1]!);
          if (/FORCE ROW LEVEL SECURITY/i.test(statement)) forced.add(quoted[1]!);
        }
        continue;
      }
      const posture =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:[a-z0-9_]+\.)?"?([a-z0-9_]+)"?\s+(NO\s+FORCE|FORCE|ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i.exec(
          head,
        );
      if (posture) {
        const table = posture[1]!;
        const operation = posture[2]!.toUpperCase().replace(/\s+/g, " ");
        if (operation === "FORCE") {
          forced.add(table);
          unforced.delete(table);
        } else if (operation === "NO FORCE") {
          forced.delete(table);
          unforced.add(table);
        } else if (operation === "ENABLE") {
          enabled.add(table);
        } else if (operation === "DISABLE") {
          enabled.delete(table);
          unforced.add(table);
        }
        continue;
      }
      const rename =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/i.exec(
          head,
        );
      if (rename) {
        if (forced.delete(rename[1]!)) forced.add(rename[2]!);
        if (enabled.delete(rename[1]!)) enabled.add(rename[2]!);
        continue;
      }
      const dropped = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(head);
      if (dropped) {
        forced.delete(dropped[1]!);
        enabled.delete(dropped[1]!);
        continue;
      }

      // ---- candidate statements --------------------------------------------
      if (DDL_ONLY.test(head) || NON_DML.test(head)) continue;
      const isBlock = /^DO\b/i.test(head);
      if (!isBlock && !/^(INSERT|UPDATE|DELETE|MERGE|WITH|SELECT|COPY|CALL)\b/i.test(head))
        continue;
      if (tenantGuc) continue;

      const executable = isBlock ? stripRoutineBodies(statement) : statement;
      const ownerVisible = activatedOwnerCapabilityTables(executable, ownerCapabilityPolicies);
      const opaque = [...forced].filter(
        (table) =>
          enabled.has(table) &&
          !unforced.has(table) &&
          !ownerVisible.has(table) &&
          // A DO block that relaxes the posture itself is protected.
          !new RegExp(
            String.raw`ALTER TABLE\s+${TABLE_REF(table)}\s+(NO FORCE|DISABLE) ROW LEVEL SECURITY`,
            "i",
          ).test(executable),
      );

      const written = opaque.filter((table) => writesTable(executable, table)).sort();
      if (written.length > 0) {
        findings.push({
          file,
          statement: statementNumber,
          kind: "write",
          tables: written,
          snippet: head.slice(0, 160),
        });
        continue;
      }

      // A `DO $$ ... IF EXISTS (SELECT ... FROM <forced table>) ... RAISE
      // EXCEPTION` preflight sees zero rows for the same reason a backfill
      // writes zero rows, so it certifies success instead of guarding.
      if (!isBlock || !/RAISE\s+EXCEPTION/i.test(executable)) continue;
      const read = opaque.filter((table) => readsTable(executable, table)).sort();
      if (read.length === 0) continue;
      findings.push({
        file,
        statement: statementNumber,
        kind: "vacuous-guard",
        tables: read,
        snippet: head.slice(0, 160),
      });
    }
  }
  return findings;
}

/** Findings in migrations that are not grandfathered - i.e. real violations. */
export function unreviewedFindings(findings: readonly BackfillFinding[]): BackfillFinding[] {
  const allowedWrites = new Set(GRANDFATHERED_MIGRATIONS);
  const allowedGuards = new Set(GRANDFATHERED_VACUOUS_GUARDS);
  return findings.filter((finding) =>
    finding.kind === "write" ? !allowedWrites.has(finding.file) : !allowedGuards.has(finding.file),
  );
}

/** Grandfathered entries that no longer match any file (a stale allowlist). */
export function staleAllowlistEntries(migrationsDir: string): string[] {
  const files = new Set(readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")));
  return [...GRANDFATHERED_MIGRATIONS, ...GRANDFATHERED_VACUOUS_GUARDS].filter(
    (entry) => !files.has(entry),
  );
}
