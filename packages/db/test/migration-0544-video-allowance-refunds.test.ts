import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("0543 debit recording patches compose with current 0542 declaration and settlement boundaries", async () => {
  const initial = await readFile(
    new URL("../drizzle/0542_usage_allowances.sql", import.meta.url),
    "utf8",
  );
  const recording = await readFile(
    new URL("../drizzle/0543_non_model_debit_attribution.sql", import.meta.url),
    "utf8",
  );
  const functionBody = initial
    .split("CREATE FUNCTION count_workspace_allowance_debit()")[1]!
    .split("CREATE TRIGGER credit_ledger_allowance_debit")[0]!;
  expect(functionBody).toBeDefined();
  const anchors = [
    "attribution jsonb; billing_workspace uuid;",
    "grant_used := grant_used+least(pending,g.remaining);",
    "CASE WHEN attribution->>'kind'='turn' THEN attribution->>'turnId'\n    WHEN attribution IS NOT NULL THEN NULL",
    "PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());",
  ];
  for (const anchor of anchors) {
    expect(recording).toContain(anchor);
    expect(functionBody.split(anchor)).toHaveLength(2);
  }
  expect(functionBody).toContain("IF attribution->>'kind' IN ('human','turn')");
});

test("video refund correction binds original ledger, keeps exact allocations and opens owner SELECT", async () => {
  const source = await readFile(
    new URL("../drizzle/0544_video_allowance_refunds.sql", import.meta.url),
    "utf8",
  );
  expect(source).toStartWith("-- deployment-mode: rolling");
  expect(source).not.toMatch(/CREATE (?:TABLE|TRIGGER)/u);
  expect(source).toContain("FOREIGN KEY (ledger_id) REFERENCES credit_ledger_entries(id)");
  expect(source).toContain("ON workspace_video_allowance_allocations(reversed_by_ledger_id)");
  expect(source).toContain("FOR SELECT USING(current_user=%L");
  expect(source).toContain("usage_allowance_capability_active(account_id,workspace_id)");
  expect(source).toContain(
    "SELECT * INTO debit FROM credit_ledger_entries WHERE id=allocation.ledger_id;",
  );
  expect(source).toContain("debit.type IS DISTINCT FROM 'video_generation_debit'");
  expect(source).toContain("debit.source_id IS DISTINCT FROM NEW.source_id");
  expect(source).toContain("'credit:video_generation_debit:'||NEW.source_id");
  expect(source).toContain("NEW.amount_micros IS DISTINCT FROM allocation.amount");
  expect(source).toContain("allocation.reversed_by_ledger_id IS DISTINCT FROM NEW.id");
  expect(source).toContain("period_key=allocation.period_key");
  expect(source).toContain("remaining=remaining+(grant_allocation->>'credits')::bigint");
  expect(source).toContain("SELECT coalesce(end_at,updated_at) INTO snapshot_boundary");
  expect(source).toContain("restored<>allocation.grants_used");
  expect(source).toContain("SET search_path=pg_catalog,%I,pg_temp");
  expect(source).not.toMatch(/sum\s*\([^)]*\)\s*FROM\s+usage_events/iu);
});
