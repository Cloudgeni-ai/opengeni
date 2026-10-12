import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { findCompactionNeededError } from "@opengeni/runtime";
import {
  portableCompactionUsesPreparedPrefix,
  runPostAgentCompaction,
} from "../src/activities/agent-turn/compaction-prep";
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

// Claude caches tools → system → messages. Portable Claude compaction must wait
// for the ordinary request preparation, exactly like Responses, so the
// checkpoint call reuses that warm prefix instead of a tool-less request.
test("only Chat Completions providers keep the standalone checkpoint request", () => {
  expect(portableCompactionUsesPreparedPrefix("anthropic-messages")).toBe(true);
  expect(portableCompactionUsesPreparedPrefix("responses")).toBe(true);
  expect(portableCompactionUsesPreparedPrefix("chat")).toBe(false);
});

for (const api of ["anthropic-messages", "responses"] as const) {
  test(`portable ${api} compaction waits for the prepared request`, async () => {
    const requested = spyOn(db, "isSessionCompactionRequested").mockResolvedValue(false);
    const settings = testSettings({ contextAutoCompactThresholdTokens: 100 });
    const agent = { instructions: "unprepared" };
    let summarized = 0;
    const remotePrefix = { agent: null };
    try {
      const result = await runPostAgentCompaction({
        input: { workspaceId: "w", sessionId: "s" },
        db: {},
        agent,
        attempt: { triggerType: "user.message" },
        session: { lastInputTokens: 200 },
        eventing: { modelRunSettings: settings },
        resolvedModel: { provider: { api } },
        remotePrefix,
        remoteCompactionRequester: undefined,
        compactionSummarizerFor: () => async () => {
          summarized++;
          return "summary";
        },
        compactionOnlyTurn: false,
      } as never);
      expect(result).toHaveProperty("ok");
      expect(summarized).toBe(0);
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
      expect(findCompactionNeededError(stopped)?.trigger).toBe("threshold");
    } finally {
      requested.mockRestore();
    }
  });
}
