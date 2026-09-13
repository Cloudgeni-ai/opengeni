import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../drizzle/0466_agent_instruction_activation_preservation.sql", import.meta.url),
  "utf8",
);

test("0466 is a rolling, fail-closed agent instruction repair", () => {
  expect(source).toStartWith("-- deployment-mode: rolling\n");
  expect(source).toContain("RENAME TO agent_instruction_apply_0462_unsafe");
  expect(source).toContain("edit_mode NOT IN ('append','edit')");
  expect(source).toContain("old_text IS NOT DISTINCT FROM current_content");
  expect(source).toContain("strpos(requested_content,current_content)=0");
  expect(source).toContain("'_instructionPreservation',preservation");
});

test("0466 fences activation as the final overwrite authority", () => {
  expect(source).toContain("CREATE FUNCTION agent_instruction_activation_preserves_baseline()");
  expect(source).toContain("proposed.provenance_source<>'agent_learning'");
  expect(source).toContain("strpos(proposed.content,baseline_content)>0");
  expect(source).toContain(
    "preservation:=proposed.agent_learning_context#>'{actor,_instructionPreservation}'",
  );
  expect(source).toContain("preservation->>'baselineContentHash'=baseline_hash");
  expect(source).toContain("preservation->>'resultContentHash'=proposed_hash");
  expect(source).toContain("BEFORE INSERT ON workspace_instruction_policy_activation_events");
  expect(source).toContain("Unsafe whole-instruction agent replacement cannot be activated");
});

test("0466 exposes only the hardened gateway to runtime roles", () => {
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) FROM PUBLIC",
  );
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION agent_instruction_activation_preserves_baseline() FROM PUBLIC",
  );
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION %I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) FROM %I",
  );
  expect(source).toContain(
    "LATERAL aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl",
  );
  expect(source).toContain("acl.grantee<>proc.proowner");
  expect(source).toContain(
    "GRANT EXECUTE ON FUNCTION %I.agent_instruction_apply(uuid,uuid,jsonb,jsonb) TO %I",
  );
  expect(source).not.toMatch(/GRANT EXECUTE ON FUNCTION [^\n]*0462_unsafe[^\n]* TO %I/);
});
