import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migrationUrl = new URL(
  "../drizzle/0316_human_confirmed_activation_resumed_generation.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0315-resumed-generation");
});

afterAll(async () => {
  await shared?.release();
});

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0316 human-confirmed activation across the resume generation", () => {
  test("accepts later generations of the same logical turn for the live attempt and the answered row", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);

    // Human-confirmed governed-learning activation: the live turn and its
    // active attempt may be a later generation of the same logical turn.
    const activation = functionBody(sql, "activate_human_confirmed_learning_decision");
    expect(activation).toContain(
      "AND turn.execution_generation >= decision_row.execution_generation",
    );
    expect(activation).toContain(
      "AND attempt.execution_generation >= decision_row.execution_generation",
    );
    expect(activation).not.toContain(
      "AND turn.execution_generation = decision_row.execution_generation",
    );
    expect(activation).not.toContain(
      "AND attempt.execution_generation = decision_row.execution_generation",
    );
    // Same logical turn only: session active turn, turn id, live attempt with
    // no pending interruption.
    expect(activation).toContain("AND session.active_turn_id = decision_row.turn_id");
    expect(activation).toContain("AND turn.id = decision_row.turn_id");
    expect(activation).toContain("AND attempt.id = turn.active_attempt_id");
    expect(activation).toContain("AND attempt.state IN ('claimed', 'running')");
    expect(activation).toContain(
      "AND interruption.state IN ('pending', 'delivered', 'acknowledged')",
    );
    // The human-input binding stays on the same turn and exact proposal; the
    // answered row may carry a later generation of that turn.
    expect(activation).toContain(
      "human_question_id := 'remember:' || decision_row.proposal_id::text;",
    );
    expect(activation).toContain(
      "AND request.turn_generation >= decision_row.execution_generation",
    );
    expect(activation).not.toContain(
      "AND request.turn_generation = decision_row.execution_generation",
    );
    expect(activation).toContain("AND request.session_id = decision_row.session_id");
    expect(activation).toContain("AND request.turn_id = decision_row.turn_id");
    expect(activation).toContain("AND request.status = 'answered'");
    expect(activation).toContain("AND request.responded_by = caller_subject_id");
    expect(activation).toContain("AND answer.value->'values' = to_jsonb(ARRAY['save'])");
    expect(activation).toContain("AND question.value->>'prompt' = human_question_prompt");
    expect(activation).toContain("AND question.value->>'helpText' = human_question_help");
    expect(activation).toContain("AND question.value->'options' = human_question_options");

    // Knowledge-claim confirmation: the caller's live generation stays exact
    // for the turn/attempt; the human-input row binds to the asked generation.
    const confirmation = functionBody(sql, "confirm_remember_knowledge_claim");
    expect(confirmation).toContain("AND turn.execution_generation = p_execution_generation");
    expect(confirmation).toContain("AND attempt.execution_generation = p_execution_generation");
    expect(confirmation).toContain("AND request.turn_generation <= p_execution_generation");
    expect(confirmation).not.toContain("AND request.turn_generation = p_execution_generation");
    expect(confirmation).toContain("AND session.active_turn_id = p_turn_id");
    expect(confirmation).toContain(
      "AND request.session_id = p_session_id AND request.turn_id = p_turn_id",
    );
    expect(confirmation).toContain("AND request.status = 'answered'");
    expect(confirmation).toContain("AND request.responded_by = caller_subject_id");
    expect(confirmation).toContain("AND answer.value->'values' = to_jsonb(ARRAY['save'])");

    // Hardening: revoke both replaced functions and re-pin their search_path.
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION activate_human_confirmed_learning_decision(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION confirm_remember_knowledge_claim(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid) FROM PUBLIC;",
    );
    expect(sql).toContain(
      "'ALTER FUNCTION %I.activate_human_confirmed_learning_decision(uuid,uuid,uuid,uuid,uuid) '",
    );
    expect(sql).toContain(
      "'ALTER FUNCTION %I.confirm_remember_knowledge_claim(uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) '",
    );
    expect(sql).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\s+ON\s+TABLE/iu);
  });

  test("keeps both seams SECURITY DEFINER with a pinned search_path", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{ name: string; secdef: boolean; config: string[] | null }>
    >`
      select proname as name, prosecdef as secdef, proconfig as config
      from pg_proc
      where proname in ('activate_human_confirmed_learning_decision', 'confirm_remember_knowledge_claim')
      order by proname`;
    expect(rows.map((row) => row.name)).toEqual([
      "activate_human_confirmed_learning_decision",
      "confirm_remember_knowledge_claim",
    ]);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(
        (row.config ?? []).some(
          (entry) => entry.startsWith("search_path=") && entry.includes("pg_catalog"),
        ),
      ).toBe(true);
    }
  });
});
