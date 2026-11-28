import { describe, expect, mock, test } from "bun:test";
import * as temporalWorkflow from "@temporalio/workflow";

// The workflow's activities, as the workflow sandbox would proxy them.
const calls: Array<{ name: string; args: unknown[] }> = [];
const proxyActivities = () =>
  new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args: unknown[]) => {
          calls.push({ name: String(name), args });
        },
    },
  );
mock.module("@temporalio/workflow", () => ({ ...temporalWorkflow, proxyActivities }));

const { recordingImportedSummaryWorkflow, recordingImportedSummaryWorkflowId } =
  await import("../src/workflows/recordings");

describe("recordingImportedSummaryWorkflow", () => {
  test("starts the imported version's summary once", async () => {
    const input = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      recordingId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      ownerSubjectId: "user:owner",
    };
    await recordingImportedSummaryWorkflow(input);
    expect(calls).toEqual([{ name: "summarizeImportedRecording", args: [input] }]);
  });

  test("has one id per transcript version, the one the API starts it with", () => {
    const versionId = crypto.randomUUID();
    expect(recordingImportedSummaryWorkflowId(versionId)).toBe(
      `recording-imported-summary:${versionId}`,
    );
    expect(recordingImportedSummaryWorkflowId(versionId)).toBe(
      recordingImportedSummaryWorkflowId(versionId),
    );
    expect(recordingImportedSummaryWorkflowId(crypto.randomUUID())).not.toBe(
      recordingImportedSummaryWorkflowId(versionId),
    );
  });
});
