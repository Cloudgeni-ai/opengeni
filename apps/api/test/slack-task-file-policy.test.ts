import { expect, test } from "bun:test";
import {
  assertSlackTaskUploadFile,
  SLACK_TASK_FILE_UPLOAD_MAX_BYTES,
} from "../src/integrations/slack-task-file-upload";

const readyFile = { status: "ready", scope: "workspace", sizeBytes: 100, sha256: "a".repeat(64) };

test("explicit Slack delivery requires ready, nonempty, immutable retained bytes", () => {
  expect(() => assertSlackTaskUploadFile(readyFile, "shared")).not.toThrow();
  for (const file of [
    { ...readyFile, status: "pending" },
    { ...readyFile, status: "deleted" },
    { ...readyFile, sha256: null },
    { ...readyFile, sha256: "invalid" },
    { ...readyFile, sizeBytes: 0 },
    { ...readyFile, sizeBytes: SLACK_TASK_FILE_UPLOAD_MAX_BYTES + 1 },
  ])
    expect(() => assertSlackTaskUploadFile(file, "shared")).toThrow();
});

test("personal files remain in private Slack task threads", () => {
  expect(() =>
    assertSlackTaskUploadFile({ ...readyFile, scope: "personal" }, "private"),
  ).not.toThrow();
  expect(() => assertSlackTaskUploadFile({ ...readyFile, scope: "personal" }, "shared")).toThrow(
    "Personal files cannot be uploaded",
  );
});
