import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { findCompactionNeededError } from "@opengeni/runtime";
import {
  portableCompactionUsesAgentPrefix,
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

test("Claude compaction defers to the prepared prefix only under the cache-reuse experiment", async () => {
  expect(
    portableCompactionUsesAgentPrefix({
      settings: { experimentCompactionCacheReuse: false },
      providerApi: "anthropic-messages",
      remoteV2: false,
    }),
  ).toBe(false);
  expect(
    portableCompactionUsesAgentPrefix({
      settings: { experimentCompactionCacheReuse: true },
      providerApi: "chat",
      remoteV2: false,
    }),
  ).toBe(false);
  expect(
    portableCompactionUsesAgentPrefix({
      settings: { experimentCompactionCacheReuse: false },
      providerApi: "responses",
      remoteV2: false,
    }),
  ).toBe(true);
  expect(
    portableCompactionUsesAgentPrefix({
      settings: { experimentCompactionCacheReuse: false },
      providerApi: "responses",
      remoteV2: true,
    }),
  ).toBe(false);

  for (const reuse of [false, true]) {
    const requested = spyOn(db, "isSessionCompactionRequested").mockResolvedValue(false);
    const settings = {
      ...testSettings({ contextAutoCompactThresholdTokens: 100 }),
      experimentCompactionCacheReuse: reuse,
    };
    const agent = { instructions: "agent" };
    const remotePrefix = { agent: null };
    const run = () =>
      runPostAgentCompaction({
        input: { workspaceId: "w", sessionId: "s" },
        settings,
        db: {},
        agent,
        attempt: { triggerType: "system.update.delivered" },
        resolvedModel: { provider: { api: "anthropic-messages" } },
        session: { lastInputTokens: 200 },
        eventing: { modelRunSettings: settings },
        remotePrefix,
        compactionSummarizerFor: () => async () => "summary",
        compactionOnlyTurn: false,
      } as never);
    try {
      if (!reuse) {
        // Without the experiment the standalone pre-turn compaction runs
        // immediately (and fails on this stub database); no prefix is awaited.
        await run().catch(() => undefined);
        expect(remotePrefix.agent).toBeNull();
        continue;
      }
      expect(await run()).toHaveProperty("ok");
      expect(remotePrefix.agent).toBe(agent);
      let stopped: unknown;
      try {
        withPreparedCompactionRequest(agent, () =>
          rememberPreparedModelRequest({
            systemInstructions: "agent",
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
  }
});
