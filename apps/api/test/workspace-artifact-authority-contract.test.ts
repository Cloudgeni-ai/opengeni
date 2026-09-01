import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");
const source = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const workspaceArtifacts = source("packages/db/src/workspace-artifacts.ts");
const sessionSchema = source("packages/db/src/schema.ts");
const authorizationContracts = source("packages/contracts/src/index.ts");
const initiatingHumanMigration = source(
  "packages/db/drizzle/0157_session_policy_role_snapshots.sql",
);
const agents = source("AGENTS.md");
const lifecycle = source("docs/run-lifecycle.md");
const architecture = source("docs/architecture.md");

describe("workspace artifact causal-human authority contract", () => {
  test("keeps artifact publication behind the complete exact-attempt fence", () => {
    for (const required of [
      "turn.initiating_human_subject_id",
      "case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end",
      "session.first_party_mcp_tools @> jsonb_build_array",
      `session.first_party_mcp_permissions @> '["artifacts:publish"]'::jsonb`,
      "turn.active_attempt_id = ${input.sourceAttemptId}::uuid",
      "turn.execution_generation = ${input.sourceExecutionGeneration}",
      "turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')",
      "attempt.state IN ('claimed', 'running')",
      "session_attempt_interruptions interruption",
      "interruption.state IN ('pending', 'delivered', 'acknowledged')",
    ]) {
      expect(workspaceArtifacts).toContain(required);
    }
  });

  test("documents the immutable selector without turning it into standalone authority", () => {
    expect(initiatingHumanMigration).toContain("session_turns_initiating_human_immutable");
    expect(initiatingHumanMigration).toContain(
      "turn initiating human is immutable after acceptance",
    );
    expect(sessionSchema).toContain("It never authorizes by itself");
    expect(authorizationContracts).toContain("Durable causal-human selector");
    expect(authorizationContracts).toContain("authorizes by itself and is null");

    for (const document of [agents, lifecycle, architecture]) {
      expect(document).toContain("initiating_human_subject_id");
      expect(document).toContain("artifacts:publish");
      expect(document.toLowerCase()).toContain("pure service work");
    }
    expect(`${agents}\n${lifecycle}`).not.toContain("solely for personal");
  });
});
