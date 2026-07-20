import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@opengeni/contracts";
import {
  boundScheduledTaskDetailMcp,
  boundScheduledTaskMcpPage,
  SCHEDULED_TASK_MCP_MAX_BYTES,
  scheduledTaskMcpSummary,
} from "../src/mcp/scheduled-task-view";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    name: "Daily analysis",
    status: "active",
    schedule: { type: "interval", everySeconds: 3600 },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Inspect activity",
      resources: [],
      tools: [],
      metadata: {},
    },
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("scheduled-task MCP views", () => {
  test("summaries replace prompts and metadata values with exact byte/count facts", () => {
    const secretMarker = `must-not-echo-${crypto.randomUUID()}`;
    const source = task({
      agentConfig: {
        prompt: `界🙂${secretMarker}`,
        resources: [],
        tools: [],
        metadata: { privateValue: secretMarker },
      },
      metadata: { otherPrivateValue: secretMarker },
    });
    const summary = scheduledTaskMcpSummary(source);
    const serialized = JSON.stringify(summary);

    expect(summary.configuration.promptBytes).toBe(
      Buffer.byteLength(source.agentConfig.prompt, "utf8"),
    );
    expect(serialized).not.toContain(secretMarker);
    expect(summary.configuration.metadataKeyCount).toBe(1);
    expect(summary.configuration.taskMetadataKeyCount).toBe(1);
  });

  test("explicit detail is deterministic and bounded for pathological multibyte input", () => {
    const huge = "界🙂".repeat(20_000);
    const source = task({
      name: huge,
      agentConfig: {
        prompt: `PROMPT-HEAD-${huge}-PROMPT-TAIL`,
        resources: Array.from({ length: 100 }, () => ({
          kind: "repository" as const,
          uri: `https://example.test/${huge}`,
          ref: huge,
        })),
        tools: Array.from({ length: 100 }, (_, index) => ({
          kind: "mcp" as const,
          id: `tool-${index}-${huge}`,
        })),
        metadata: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`key-${index}-${huge}`, huge]),
        ),
        goal: {
          text: `GOAL-HEAD-${huge}`,
          successCriteria: `CRITERIA-HEAD-${huge}`,
        },
      },
      metadata: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`task-key-${index}-${huge}`, huge]),
      ),
    });

    const first = boundScheduledTaskDetailMcp(source);
    const second = boundScheduledTaskDetailMcp(source);
    const serialized = JSON.stringify(first, null, 2);
    expect(first).toEqual(second);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(SCHEDULED_TASK_MCP_MAX_BYTES);
    expect(first.detailProjection.prompt.truncated).toBeTrue();
    expect(first.detailProjection.prompt.originalBytes).toBe(
      Buffer.byteLength(source.agentConfig.prompt, "utf8"),
    );
    expect(first.detailProjection.resources).toMatchObject({
      originalCount: 100,
      deliveredCount: 20,
    });
    expect(first.detailProjection.metadata.valuesIncluded).toBeFalse();
    expect(serialized).not.toContain("PROMPT-TAIL");
    expect(serialized).not.toContain(huge);
    expect(serialized).not.toContain("�");
  });

  test("list pages expose continuation without returning an over-limit row", () => {
    const source = Array.from({ length: 3 }, (_, index) =>
      task({ name: `task-${index}`, createdAt: `2026-07-20T00:00:0${index}.000Z` }),
    );
    const page = boundScheduledTaskMcpPage({
      tasks: source.slice(0, 2),
      limit: 2,
      offset: 10,
      sourceHasMore: true,
    });

    expect(page.tasks).toHaveLength(2);
    expect(page.page).toEqual({ limit: 2, offset: 10, hasMore: true, nextOffset: 12 });
    expect(page.projection.bytes).toBe(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8"));
    expect(page.projection.bytes).toBeLessThanOrEqual(SCHEDULED_TASK_MCP_MAX_BYTES);
  });
});
