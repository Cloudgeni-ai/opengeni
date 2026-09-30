import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("non-model attribution freezes jobs/documents and admits no creator-based legacy backfill", async () => {
  const source = await readFile(
    new URL("../drizzle/0550_non_model_debit_attribution.sql", import.meta.url),
    "utf8",
  );
  expect(source).toContain('NOT NULL DEFAULT \'{"kind":"unknown"}\'::jsonb');
  expect(source).toContain("attribution:=causal_turn.attribution");
  expect(source).toContain("IF billing_workspace IS NOT NULL THEN");
  expect(source).toContain("FROM opengeni_private.usage_allowance_attribution_receipts");
  expect(source).not.toMatch(/FROM\s+(?:session_turns|scheduled_task_runs)\b/iu);
  expect(source).toContain("attribution:=coalesce(accepted");
  expect(source).toContain("document_billing_attribution_immutable");
  expect(source).toContain("sandbox_warm_attribution_immutable");
  expect(source).toContain("knowledge_query_billing_receipt_immutable");
  expect(source).toContain("workspace_video_allowance_allocations");
  expect(source).toContain("reverse_video_allowance_refund");
  expect(source).toContain("period_key=allocation.period_key");
  expect(source).toContain("remaining=remaining+(grant_allocation->>'credits')::bigint");
  expect(source).toContain("'billingAttribution',billing_attribution");
  expect(source).not.toMatch(
    /UPDATE\s+(?:knowledge_index_jobs|documents)\s+SET\s+billing_attribution/iu,
  );
  expect(source).not.toMatch(/(?:sessions|scheduled_tasks)\.(?:created_by|createdBy)/u);
});
