import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0272_human_confirmed_learning_activation.sql",
  import.meta.url,
);

describe("migration 0272 human-confirmed learning activation", () => {
  test("adds an authority-kind ledger column and a hardened human-confirmed capability", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain(`ADD COLUMN "authority_kind" text NOT NULL DEFAULT 'automatic'`);
    expect(sql).toContain(`ADD COLUMN "human_input_request_id" uuid`);
    expect(sql).toContain(
      `CHECK (("authority_kind" = 'human_confirmed') = ("human_input_request_id" IS NOT NULL))`,
    );
    expect(sql).toContain("CREATE OR REPLACE FUNCTION activate_human_confirmed_learning_decision(");
    expect(sql).toContain("SECURITY DEFINER");
    // The human answer is bound to the exact proposal, session/turn generation,
    // responder, and the `save` option before any destination write.
    expect(sql).toContain("human_question_id := 'remember:' || decision_row.proposal_id::text;");
    expect(sql).toContain("AND request.turn_generation = decision_row.execution_generation");
    expect(sql).toContain("AND request.status = 'answered'");
    expect(sql).toContain("AND request.responded_by = caller_subject_id");
    expect(sql).toContain("AND answer.value->'values' = to_jsonb(ARRAY['save'])");
    // The question the human saw is reconstructed from the exact Task-note text
    // and proposal lane; prompt, help text, and options must all match.
    expect(sql).toContain("human_question_help := left(task_note_row.text, 2000);");
    expect(sql).toContain("AND question.value->>'prompt' = human_question_prompt");
    expect(sql).toContain("AND question.value->>'helpText' = human_question_help");
    expect(sql).toContain("AND question.value->'options' = human_question_options");
    expect(sql).toContain("human confirmation requires exact Task-note evidence");
    // Confirmable receipts only; policy off still fails closed.
    expect(sql).toContain("AND receipt.outcome IN ('suggest', 'automatic', 'confidence')");
    expect(sql).toContain("IF current_mode = 'off' THEN");
    expect(sql).not.toContain("receipt.automatic_eligible");
    // Hardening mirrors 0269.
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION activate_human_confirmed_learning_decision(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\s+ON\s+TABLE/iu);
  });
});
