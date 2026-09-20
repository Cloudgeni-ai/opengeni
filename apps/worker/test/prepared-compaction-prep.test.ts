import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { findCompactionNeededError } from "@opengeni/runtime";
import { runPostAgentCompaction } from "../src/activities/agent-turn/compaction-prep";
import {
  rememberPreparedModelRequest,
  withPreparedCompactionRequest,
} from "../../../packages/runtime/src/prepared-compaction-request";

for (const maintenance of [false, true]) {
  test(`remote compaction waits for real request preparation (maintenance=${maintenance})`, async () => {
    const requested = spyOn(db, "isSessionCompactionRequested").mockResolvedValue(maintenance);
    const settings = testSettings({ contextAutoCompactThresholdTokens: 100 });
    const agent = { instructions: "unprepared" };
    let compactionCalls = 0;
    const remotePrefix = { agent: null };
    try {
      const result = await runPostAgentCompaction({
        input: { workspaceId: "w", sessionId: "s" },
        db: {},
        agent,
        attempt: { triggerType: "user.message" },
        session: { codexCompactionMode: "remote_v2", lastInputTokens: 200 },
        eventing: { modelRunSettings: settings },
        remotePrefix,
        remoteCompactionRequester: async () => {
          compactionCalls++;
        },
        compactionSummarizerFor: () => async () => "summary",
        compactionOnlyTurn: maintenance,
      } as never);
      expect(result).toHaveProperty("ok");
      expect(compactionCalls).toBe(0);
      expect(remotePrefix.agent).toBe(agent);
      let stopped: unknown;
      try {
        withPreparedCompactionRequest(agent, () =>
          rememberPreparedModelRequest({
            systemInstructions: "actual SDK instructions",
            input: [],
            modelSettings: {},
            tools: [],
            handoffs: [],
            outputType: "text",
            tracing: false,
          }),
        );
      } catch (error) {
        stopped = error;
      }
      expect(findCompactionNeededError(stopped)?.trigger).toBe(
        maintenance ? "operator" : "threshold",
      );
    } finally {
      requested.mockRestore();
    }
  });
}
