import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0284_truthful_human_confirmed_review_reason.sql",
  import.meta.url,
);

describe("migration 0284 truthful human-confirmed review reason", () => {
  test("adds a reason-carrying review overload and truthful human-confirmed callers", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    // The reason-carrying overload validates its reason and writes it verbatim.
    expect(sql).toContain("p_reason text");
    expect(sql).toContain("OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4096");
    expect(sql).toContain("btrim(p_reason),");
    // The 9-arg signature stays the guard-resolved capability writer and keeps
    // the exact legacy wording for automatic activation and undo.
    expect(sql).toContain(
      "CASE p_state WHEN 'approved' THEN 'Automatic governed-learning activation.'",
    );
    expect(sql).toContain("ELSE 'Exact governed-learning activation undo.' END");
    // Both human-confirmed callers now record truthful reasons.
    expect(sql).toContain(
      "'Approved by the exact initiating human through the bound remember confirmation.'",
    );
    expect(sql).toContain(
      "'Approved by the exact initiating human through human-confirmed learning activation.'",
    );
    // Hardening: revoke both overloads and re-pin every replaced function.
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION governed_learning_apply_knowledge_review(\n  uuid, uuid, uuid, uuid, uuid, bigint, text, text, text, text\n) FROM PUBLIC;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION governed_learning_apply_knowledge_review(\n  uuid, uuid, uuid, uuid, uuid, bigint, text, text, text\n) FROM PUBLIC;",
    );
    expect(sql).toContain("'ALTER FUNCTION %I.governed_learning_apply_knowledge_review('");
    expect(sql).toContain("|| 'uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,text) '");
    expect(sql).toContain("|| 'uuid,uuid,uuid,uuid,uuid,bigint,text,text,text) '");
    expect(sql).toContain(
      "'ALTER FUNCTION %I.confirm_remember_knowledge_claim(uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) '",
    );
    expect(sql).toContain(
      "'ALTER FUNCTION %I.activate_human_confirmed_learning_decision(uuid,uuid,uuid,uuid,uuid) '",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
    // The 10-arg overload must share the guard-resolved 9-arg owner even when
    // the 0284 migration role differs from the 0269 role.
    expect(sql).toContain("|| 'uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,text) OWNER TO %I'");
  });
});
