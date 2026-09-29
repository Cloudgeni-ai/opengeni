import { expect, test } from "bun:test";
import {
  assertSlackTaskUploadFile,
  assertSlackTaskUploadTarget,
  slackTaskRequesterCanReceiveFile,
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

const privateTarget = {
  visibility: "private" as const,
  slackChannelId: "DTASK",
  slackThreadTs: "1710000000.000010",
  routeKey: "DTASK:1710000000.000010",
  ackSlackMessageTs: null,
};

test("private file delivery refuses a source conversation until bot-DM rekey commits", () => {
  for (const target of [
    {
      ...privateTarget,
      slackChannelId: "CSOURCE",
      routeKey: "CSOURCE:1710000000.000010:shortcut-user:UOWNER",
    },
    {
      ...privateTarget,
      slackChannelId: "CSOURCE",
      routeKey: "CSOURCE:1710000000.000010",
    },
    { ...privateTarget, routeKey: "DTASK:1710000000.000010:shortcut-user:UOWNER" },
    { ...privateTarget, ackSlackMessageTs: "1710000000.000020" },
  ]) {
    expect(() => assertSlackTaskUploadTarget(target)).toThrow("committed bot-DM thread");
  }
});

test("private uploads allow ordinary bot-DM threads and durably rekeyed shortcuts", () => {
  expect(() => assertSlackTaskUploadTarget(privateTarget)).not.toThrow();
  expect(() =>
    assertSlackTaskUploadTarget({
      ...privateTarget,
      ackSlackMessageTs: privateTarget.slackThreadTs,
    }),
  ).not.toThrow();
});

test("workspace task file delivery keeps the invoking channel destination", () => {
  expect(() =>
    assertSlackTaskUploadTarget({
      ...privateTarget,
      visibility: "workspace",
      slackChannelId: "CTASK",
      routeKey: "CTASK:1710000000.000010",
    }),
  ).not.toThrow();
});

test("requester access respects canonical workspace administration permissions", () => {
  expect(slackTaskRequesterCanReceiveFile(["workspace:admin"])).toBe(true);
  expect(slackTaskRequesterCanReceiveFile(["files:read", "sessions:read"])).toBe(true);
  expect(slackTaskRequesterCanReceiveFile(["files:read"])).toBe(false);
  expect(slackTaskRequesterCanReceiveFile(["sessions:read"])).toBe(false);
});
