import { describe, expect, test } from "bun:test";
import type { ScheduledTask, ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import {
  boundScheduledTaskDetailMcp,
  boundScheduledTaskMcpPage,
  projectScheduledTaskSchedule,
  SCHEDULED_TASK_MCP_MAX_BYTES,
  SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES,
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
    targetSessionId: null,
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

function prettyBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function expectNoInvalidUtf8(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain("�");
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
    expect(summary.projection.bytes).toBe(prettyBytes(summary));
    expect(summary.projection.bytes).toBeLessThanOrEqual(SCHEDULED_TASK_MCP_MAX_BYTES);
  });

  test("every request-controlled schedule string has a typed exact UTF-8 projection", () => {
    const huge = "界".repeat(100_000);
    const schedules: ScheduledTaskScheduleSpec[] = [
      { type: "once", runAt: huge, timeZone: huge },
      { type: "interval", everySeconds: 60, startAt: huge, endAt: huge },
      { type: "calendar", timeZone: huge, hour: 1, minute: 2, daysOfWeek: ["MONDAY"] },
    ];

    for (const schedule of schedules) {
      const projected = projectScheduledTaskSchedule(schedule);
      expect(projected.projection.type).toBe(schedule.type);
      expect(projected.projection.truncated).toBeTrue();
      for (const fact of Object.values(projected.projection.fields)) {
        if (!fact) continue;
        expect(fact.originalBytes).toBe(Buffer.byteLength(huge, "utf8"));
        expect(fact.deliveredBytes).toBeLessThanOrEqual(SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES);
        expect(fact.truncated).toBeTrue();
      }
      expectNoInvalidUtf8(projected);
    }
  });

  test("default summary, list, and explicit detail stay deterministic under pathological schedule strings", () => {
    const fixtures = [
      { label: "100k ASCII", value: "x".repeat(100_000) },
      { label: "100k multibyte", value: "界".repeat(100_000) },
      { label: "JSON escape expansion", value: '"\\\u0000\n\t'.repeat(20_000) },
    ];

    for (const fixture of fixtures) {
      const source = task({
        schedule: {
          type: "once",
          runAt: "2026-08-06T00:00:00.000Z",
          timeZone: fixture.value,
        },
      });

      const summary = scheduledTaskMcpSummary(source);
      const repeatedSummary = scheduledTaskMcpSummary(source);
      expect(summary, fixture.label).toEqual(repeatedSummary);
      expect(summary.projection.bytes, fixture.label).toBe(prettyBytes(summary));
      expect(summary.projection.bytes, fixture.label).toBeLessThanOrEqual(
        SCHEDULED_TASK_MCP_MAX_BYTES,
      );
      expect(summary.schedule.type).toBe("once");
      if (summary.schedule.type !== "once" || summary.projection.schedule.type !== "once") {
        throw new Error(`unexpected projected schedule for ${fixture.label}`);
      }
      expect(summary.schedule.timeZone, fixture.label).not.toBe(fixture.value);
      expect(summary.projection.schedule.fields.timeZone, fixture.label).toMatchObject({
        originalBytes: Buffer.byteLength(fixture.value, "utf8"),
        deliveredBytes: Buffer.byteLength(summary.schedule.timeZone, "utf8"),
        truncated: true,
      });

      const page = boundScheduledTaskMcpPage({
        tasks: [source],
        limit: 25,
        offset: 0,
        sourceHasMore: false,
      });
      expect(page.tasks, fixture.label).toHaveLength(1);
      expect(page.projection.bytes, fixture.label).toBe(prettyBytes(page));
      expect(page.projection.bytes, fixture.label).toBeLessThanOrEqual(
        SCHEDULED_TASK_MCP_MAX_BYTES,
      );

      const detail = boundScheduledTaskDetailMcp(source);
      const repeatedDetail = boundScheduledTaskDetailMcp(source);
      expect(detail, fixture.label).toEqual(repeatedDetail);
      expect(detail.detailProjection.terminal, fixture.label).toBeFalse();
      expect(detail.detailProjection.bytes, fixture.label).toBe(prettyBytes(detail));
      expect(detail.detailProjection.bytes, fixture.label).toBeLessThanOrEqual(
        SCHEDULED_TASK_MCP_MAX_BYTES,
      );
      expectNoInvalidUtf8(summary);
      expectNoInvalidUtf8(page);
      expectNoInvalidUtf8(detail);
    }
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
    expect(first.detailProjection.bytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(first.detailProjection.bytes).toBeLessThanOrEqual(SCHEDULED_TASK_MCP_MAX_BYTES);
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
    expectNoInvalidUtf8(first);
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
    expect(page.projection).toMatchObject({
      rowsDroppedForBytes: false,
      droppedRowCount: 0,
      sourceRowsConsumed: 2,
      rowsReturned: 2,
    });
    expect(page.projection.bytes).toBe(prettyBytes(page));
    expect(page.projection.bytes).toBeLessThanOrEqual(SCHEDULED_TASK_MCP_MAX_BYTES);
  });

  test("a sole byte-dropped row advances past the consumed source row", () => {
    const escaped = "\u0000".repeat(100_000);
    const source = task({
      name: escaped,
      schedule: {
        type: "calendar",
        timeZone: escaped,
        hour: 0,
        minute: 0,
      },
      agentConfig: {
        prompt: "inspect",
        resources: [],
        tools: [],
        metadata: {},
        model: escaped,
      },
      createdAt: escaped,
      updatedAt: escaped,
    });
    const page = boundScheduledTaskMcpPage({
      tasks: [source],
      limit: 1,
      offset: 41,
      sourceHasMore: false,
      maxBytes: 8 * 1024,
    });

    expect(page.tasks).toHaveLength(0);
    expect(page.page).toEqual({ limit: 1, offset: 41, hasMore: true, nextOffset: 42 });
    expect(page.projection).toMatchObject({
      rowsDroppedForBytes: true,
      droppedRowCount: 1,
      sourceRowsConsumed: 1,
      rowsReturned: 0,
      terminal: false,
      droppedRows: [
        {
          id: source.id,
          nextAction: {
            tool: "scheduled_tasks_get",
            arguments: { id: source.id, includeEntity: false },
          },
        },
      ],
    });
    expect(page.projection.bytes).toBe(prettyBytes(page));
    expect(page.projection.bytes).toBeLessThanOrEqual(8 * 1024);
    expectNoInvalidUtf8(page);

    const next = boundScheduledTaskMcpPage({
      tasks: [],
      limit: 1,
      offset: page.page.nextOffset!,
      sourceHasMore: false,
      maxBytes: 8 * 1024,
    });
    expect(next.page).toEqual({ limit: 1, offset: 42, hasMore: false, nextOffset: null });
  });
});
