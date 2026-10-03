import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { slackFileUploadOperations } from "../src/schema";
import { SLACK_FILE_UPLOAD_OPERATIONS_TABLE } from "../src/runtime-posture";

const migration = new URL("../drizzle/0535_slack_file_upload_operations.sql", import.meta.url);

test("Slack upload rolling migration has immutable source bindings and ordinary session RLS", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("CREATE TABLE opengeni_private.slack_file_upload_operations");
  expect(source).toContain("FORCE ROW LEVEL SECURITY");
  expect(source).toContain("SECURITY INVOKER");
  expect(source).not.toMatch(/\bSECURITY DEFINER\b(?! bypass)/);
  expect(source).toContain("s.id = slack_file_upload_operations.session_id");
  expect(source).toContain("i.session_id = NEW.session_id");
  expect(source).toContain("i.connection_id = NEW.connection_id");
  expect(source).toContain("f.status = 'ready'");
  expect(source).toContain(
    "ON opengeni_private.slack_file_upload_operations(workspace_id, operation_id)",
  );
  expect(source).toContain("REFERENCES connections(id)");
  expect(source).not.toContain("REFERENCES connections(workspace_id");
  expect(source).toContain("Slack file upload binding is immutable");
  expect(source).toContain("Slack file upload allocation is immutable");
  expect(source).toContain("OLD.phase = 'outcome_unknown' AND NEW.phase = 'completed'");
  expect(source).toContain(
    "GRANT SELECT, INSERT, UPDATE ON TABLE opengeni_private.slack_file_upload_operations",
  );
  expect(source).not.toMatch(/GRANT[^;]*(?:DELETE|TRUNCATE)/);
  const config = getTableConfig(slackFileUploadOperations);
  expect(config.schema).toBe("opengeni_private");
  expect(config.name).toBe(SLACK_FILE_UPLOAD_OPERATIONS_TABLE);
  expect(config.columns.map((column) => column.name).sort()).toEqual([
    "account_id",
    "claim_expires_at",
    "claim_holder_id",
    "connection_id",
    "created_at",
    "file_id",
    "id",
    "interaction_id",
    "operation_id",
    "phase",
    "request_digest",
    "session_id",
    "slack_file_id",
    "subject_id",
    "updated_at",
    "workspace_id",
  ]);
  expect(config.checks.map((check) => check.name).sort()).toEqual([
    "slack_file_upload_operations_bounds_check",
    "slack_file_upload_operations_state_check",
  ]);
});
