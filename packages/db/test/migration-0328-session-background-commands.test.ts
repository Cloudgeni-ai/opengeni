import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationUrl = new URL("../drizzle/0328_session_background_commands.sql", import.meta.url);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0328-session-background-commands");
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0328 session background commands", () => {
  test("declares provider-neutral identity, active indexes, RLS, and reaper eligibility", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain("CREATE TABLE session_background_commands");
    expect(sql).toContain("session_background_commands_provider_identity_check");
    expect(sql).toContain("session_background_commands_process_uq");
    expect(sql).toContain("session_background_commands_connected_op_uq");
    expect(sql).toContain("session_background_commands_active_session_idx");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("session_visibility_isolation");
    expect(sql).toContain("settle_background_command_from_retained_process");
    expect(sql).toContain("prepare_workspace_background_command_deletion");
    expect(sql).toContain("prune_settled_cross_workspace_background_commands");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.settle_background_command_from_retained_process()",
    );
    expect(sql).toContain("claim_connected_machine_background_commands");
    expect(sql).toContain("reconcile_proof_outcome");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("command.state = 'stopping'");
    expect(sql).toContain("'background_stopping'");
    expect(sql).toContain("direct_owner.live IS NULL");
    expect(sql).not.toMatch(/\bUPDATE\s+session_background_commands\b/iu);
    expect(FORCE_RLS_TABLES).toContain("session_background_commands");
    expect(RUNTIME_FULL_DML_TABLES).toContain("session_background_commands");
  });

  test("installs the table, checks, indexes, policies, and command-aware claim function", async () => {
    if (!shared) return;
    const [table] = await shared.admin<Array<{ force_rls: boolean }>>`
      select relforcerowsecurity as force_rls
      from pg_class
      where oid = 'session_background_commands'::regclass`;
    expect(table?.force_rls).toBe(true);

    const constraints = await shared.admin<Array<{ conname: string }>>`
      select conname from pg_constraint
      where conrelid = 'session_background_commands'::regclass`;
    const names = new Set(constraints.map((row) => row.conname));
    expect(names).toContain("session_background_commands_provider_identity_check");
    expect(names).toContain("session_background_commands_lifecycle_check");
    expect(names).toContain("session_background_commands_reconcile_check");

    const indexes = await shared.admin<Array<{ indexname: string }>>`
      select indexname from pg_indexes where tablename = 'session_background_commands'`;
    const indexNames = new Set(indexes.map((row) => row.indexname));
    expect(indexNames).toContain("session_background_commands_process_uq");
    expect(indexNames).toContain("session_background_commands_connected_op_uq");
    expect(indexNames).toContain("session_background_commands_active_session_idx");

    const [visibilityPolicy] = await shared.admin<Array<{ restrictive: boolean }>>`
      select not polpermissive as restrictive
      from pg_policy
      where polrelid = 'session_background_commands'::regclass
        and polname = 'session_visibility_isolation'`;
    expect(visibilityPolicy?.restrictive).toBe(true);

    const [trigger] = await shared.admin<Array<{ trigger_name: string }>>`
      select tgname as trigger_name
      from pg_trigger
      where tgrelid = 'sandbox_retained_processes'::regclass
        and tgname = 'settle_background_command_from_retained_process'
        and not tgisinternal`;
    expect(trigger?.trigger_name).toBe("settle_background_command_from_retained_process");

    const [claim] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_functiondef(
        'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)'::regprocedure
      ) as definition`;
    expect(claim?.definition).toContain("session_background_commands");
    expect(claim?.definition).toContain("background_stopping");
    expect(claim?.definition).toContain("direct_owner.live IS NULL");

    const [connectedClaim] = await shared.admin<
      Array<{ security_definer: boolean; definition: string }>
    >`
      select prosecdef as security_definer, pg_get_functiondef(oid) as definition
      from pg_proc
      where oid = 'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint)'::regprocedure`;
    expect(connectedClaim?.security_definer).toBe(true);
    expect(connectedClaim?.definition).toContain("FOR UPDATE OF command SKIP LOCKED");
    expect(connectedClaim?.definition).toContain("connection_instance_id");
    expect(connectedClaim?.definition).toContain("reconcile_proof_observed_at");

    const [workspaceDelete] = await shared.admin<
      Array<{ security_definer: boolean; definition: string }>
    >`
      select prosecdef as security_definer, pg_get_functiondef(oid) as definition
      from pg_proc
      where oid = 'opengeni_private.prepare_workspace_background_command_deletion(uuid,uuid)'::regprocedure`;
    expect(workspaceDelete?.security_definer).toBe(true);
    expect(workspaceDelete?.definition).toContain("control_workspace_id");
    expect(workspaceDelete?.definition).toContain("FOR UPDATE NOWAIT");
    expect(workspaceDelete?.definition).not.toContain("DELETE FROM");

    const [workspacePrune] = await shared.admin<
      Array<{ security_definer: boolean; definition: string }>
    >`
      select prosecdef as security_definer, pg_get_functiondef(oid) as definition
      from pg_proc
      where oid = 'opengeni_private.prune_settled_cross_workspace_background_commands(uuid,uuid)'::regprocedure`;
    expect(workspacePrune?.security_definer).toBe(true);
    expect(workspacePrune?.definition).toContain("control_workspace_id");
    expect(workspacePrune?.definition).toContain("DELETE FROM");

    const [publicPrivilege] = await shared.admin<Array<{ allowed: boolean }>>`
      select has_function_privilege(
        'public',
        'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint)',
        'EXECUTE'
      ) as allowed`;
    expect(publicPrivilege?.allowed).toBe(false);

    const [triggerPublicPrivilege] = await shared.admin<Array<{ allowed: boolean }>>`
      select has_function_privilege(
        'public',
        'opengeni_private.settle_background_command_from_retained_process()',
        'EXECUTE'
      ) as allowed`;
    expect(triggerPublicPrivilege?.allowed).toBe(false);

    const [workspaceDeletePublicPrivilege] = await shared.admin<Array<{ allowed: boolean }>>`
      select has_function_privilege(
        'public',
        'opengeni_private.prepare_workspace_background_command_deletion(uuid,uuid)',
        'EXECUTE'
      ) as allowed`;
    expect(workspaceDeletePublicPrivilege?.allowed).toBe(false);

    const [workspacePrunePublicPrivilege] = await shared.admin<Array<{ allowed: boolean }>>`
      select has_function_privilege(
        'public',
        'opengeni_private.prune_settled_cross_workspace_background_commands(uuid,uuid)',
        'EXECUTE'
      ) as allowed`;
    expect(workspacePrunePublicPrivilege?.allowed).toBe(false);
  });
});
