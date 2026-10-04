import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../drizzle/0626_modal_native_live_origin.sql", import.meta.url),
  "utf8",
);
const moduleSource = readFileSync(
  new URL("../src/modal-native-live-origin.ts", import.meta.url),
  "utf8",
);

describe("0626 inert original-origin capability contract", () => {
  test("rolling exact SELECT capability, not a lifecycle/subject GUC or blanket owner window", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("organization_memberships FOR SELECT");
    expect(migration).toContain("current_user=%3$L");
    expect(migration).toContain("c.transaction_id=pg_current_xact_id_if_assigned()");
    expect(migration).toContain("c.data_schema=%2$s::oid");
    expect(migration).toContain("c.initiating_human_subject_id=p_subject");
    expect(migration).not.toContain("set_config(");
    expect(migration).not.toContain("NO FORCE ROW LEVEL SECURITY");
    expect(migration).not.toContain("row_security=off");
    expect(migration).not.toContain("RAISE NOTICE");
  });
  test("canonical lock order and genuine current authority floor remain explicit", () => {
    const body = migration.slice(migration.indexOf("PERFORM pg_advisory_xact_lock(member_key)"));
    const fragments = [
      "PERFORM pg_advisory_xact_lock(member_key)",
      "PERFORM acquire_session_tenancy_fence",
      "workspace-control:",
      "FROM workspace_inference_controls",
      "FROM workspaces",
      "FROM sessions WHERE id=session_value",
      "FROM session_event_cursors",
      "FROM session_turns WHERE id=turn_value",
      "FROM session_turn_attempts WHERE id=attempt_value",
    ];
    const offsets = fragments.map((fragment) => body.indexOf(fragment));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(migration).toContain(
      "a.authority_epoch NOT BETWEEN s.execution_authority_epoch AND s.authority_epoch",
    );
    expect(migration).toContain("a.closed_at IS NOT NULL OR a.quiesced_at IS NOT NULL");
    expect(migration).toContain("s.active_sandbox_id IS NOT NULL OR s.active_epoch<>route_value");
  });
  test("no provider/grant/custody mutations, counts remain source-derived and errors propagate", () => {
    for (const name of [
      "sandbox_leases",
      "sandbox_lease_holders",
      "sandbox_retained_processes",
      "workflow_wake",
    ])
      expect(migration).not.toContain(name);
    expect(migration).toContain("t.metadata ? 'providerRecoveryCount'");
    expect(migration).toContain("count_json::numeric NOT BETWEEN 0 AND 5");
    expect(migration).toContain("'providerRecoveryCount',count_value");
    expect(migration).toContain("close_session_tenancy_fenced_access(fenced_cap)");
    expect(moduleSource).toContain("requires an existing transaction");
    expect(moduleSource).toContain("NOT host authentication or a grant");
    expect(moduleSource).not.toContain("withWorkspaceSubjectRls");
  });
});
