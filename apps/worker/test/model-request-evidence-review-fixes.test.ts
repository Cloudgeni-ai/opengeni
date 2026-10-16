import { expect, test } from "bun:test";
import { CODEX_PHYSICAL_REQUEST } from "@opengeni/codex";
import {
  assessModelRequestEvidence,
  type ModelRequestEvidence,
  type SessionEvent,
} from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { withModelRequestEvidence } from "@opengeni/runtime";
import { instrumentedModelFetch } from "../../../packages/runtime/src/model-provider-client";
import { testSettings } from "@opengeni/testing";
import {
  emitModelCallUsage,
  type TurnEventPublisher,
} from "../src/activities/agent-turn/model-usage";

test("actual committed worker usage preserves impossible raw subsets but cannot certify them", async () => {
  const cases: Array<{
    inputTokensDetails: { cached_tokens?: number; cache_write_tokens?: number };
    outputTokensDetails?: { reasoning_tokens: number };
  }> = [
    { inputTokensDetails: { cached_tokens: 101 }, outputTokensDetails: { reasoning_tokens: 31 } },
    { inputTokensDetails: { cache_write_tokens: 101 } },
    { inputTokensDetails: { cached_tokens: 95, cache_write_tokens: 10 } },
  ];
  for (const details of cases) {
    const records: ModelRequestEvidence[] = [];
    const publish: TurnEventPublisher = async (events) => ({
      accepted: true,
      canonicalStartupMilestones: [],
      events: events.map(
        (event, index) =>
          ({
            ...event,
            id: `committed-${index}`,
            sequence: index + 10,
            turnAssociation: "current",
          }) as SessionEvent,
      ),
    });
    await withModelRequestEvidence(
      async (record) => {
        records.push(record);
      },
      async () => {
        const text = `data: ${JSON.stringify({ type: "response.completed", response: { id: "response", status: "completed", output: [] } })}\n\n`;
        const fetcher = instrumentedModelFetch(
          "codex-subscription",
          (async () =>
            new Response(text, {
              headers: { "content-type": "text/event-stream" },
            })) as typeof fetch,
        );
        const request = {
          method: "POST",
          body: "{}",
          [CODEX_PHYSICAL_REQUEST]: { requestId: "physical", transportAttempt: 1 },
        };
        expect(await (await fetcher("https://fixture.invalid/v1/responses", request)).text()).toBe(
          text,
        );
        await emitModelCallUsage({
          observability: createObservability(testSettings(), { component: "worker" }),
          publish,
          accountId: "account",
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          provider: "codex-subscription",
          providerApi: "responses",
          model: "gpt-6.1-sol",
          purpose: "main",
          sourceKey: "response",
          usage: { usage: { inputTokens: 100, outputTokens: 30, ...details } },
        });
      },
    );
    const payload = records.find((r) => r.kind === "usage")!.content as Record<string, unknown>;
    expect(payload.inputTokens).toBe(100);
    expect(payload.outputTokens).toBe(30);
    expect(payload.cachedTokens).toBe(details.inputTokensDetails.cached_tokens ?? null);
    expect(payload.cacheWriteTokens).toBe(details.inputTokensDetails.cache_write_tokens ?? null);
    expect(
      assessModelRequestEvidence(records).issues.some((issue) =>
        issue.endsWith(":token_subsets_exceed_totals"),
      ),
    ).toBe(true);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  }
});
