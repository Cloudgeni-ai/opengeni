import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FORCE_RLS_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_FULL_DML_TABLES,
} from "../src/runtime-posture";

const migration = await readFile(
  new URL("../drizzle/0492_codex_accepted_source_authority.sql", import.meta.url),
  "utf8",
);
const db = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const api = await readFile(
  new URL("../../../apps/api/src/routes/codex.ts", import.meta.url),
  "utf8",
);

describe("accepted Codex source authority rollout contract", () => {
  test("legacy source is insert-only, scoped, and separate from turn history", () => {
    expect(migration).toStartWith("-- deployment-mode: maintenance");
    expect(migration.match(/SELECT pg_temp.assert_codex_source_runtime_drain\(\);/g)).toHaveLength(2);
    expect(migration).toContain("pg_stat_activity");
    expect(migration).toContain("opengeni.migration_application_roles");
    expect(migration).toContain("ALTER TABLE codex_turn_source_bindings FORCE ROW LEVEL SECURITY");
    expect(FORCE_RLS_TABLES).toContain("codex_turn_source_bindings");
    expect(RUNTIME_READ_INSERT_TABLES).toContain("codex_turn_source_bindings");
    expect(RUNTIME_FULL_DML_TABLES).not.toContain("codex_turn_source_bindings");
    expect(migration).not.toContain("UPDATE session_turns");
    expect(db).toMatch(
      /sourceBefore = await getWorkspaceCodexSubscriptionSourceScoped[\s\S]*?captureLegacyCodexTurnSources[\s\S]*?await mutate\(tx\)/u,
    );
  });

  test("exact-turn helper scopes source to tenant and actual credential ownership", () => {
    expect(migration).toContain(
      "p_account_id IS DISTINCT FROM opengeni_private.current_account_id()",
    );
    expect(migration).toContain(
      "p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()",
    );
    expect(migration).toContain("credential.workspace_id = p_workspace_id");
    expect(migration).toContain("credential.organization_id = p_account_id");
    expect(migration).toContain("NEW.credential_id, NEW.turn_id");
    expect(migration).toContain("codex_organization_scope_visible(p_account_id)");
    expect(migration).toContain("0492 organization lease count prerequisite drift");
    expect(migration).toContain("0492 session credential guard prerequisite drift");
  });

  test("ordinary materialization stays current-source; accepted model use proves exact live lease", () => {
    expect(db).toContain(
      "if (!authority) return (await effectiveCodexCredentialPoolCondition(tx, workspaceId)).condition",
    );
    expect(db).toContain("lease.holder_id = ${authority.holderId}");
    expect(db).toContain("lease.generation = ${authority.generation}");
    expect(db).toContain("lease.leased_until > clock_timestamp()");
    expect(db).toContain("session.active_turn_id = accepted.id");
    expect(api).toContain("mode: sourceBeforeConnect.mode");
  });
});
