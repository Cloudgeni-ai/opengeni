import type {
  ResourceRef,
  ScheduledTask,
  ScheduledTaskScheduleSpec,
  ToolRef,
} from "@opengeni/contracts";

export const SCHEDULED_TASK_MCP_MAX_BYTES = 64 * 1024;
export const SCHEDULED_TASK_NAME_MAX_BYTES = 512;
export const SCHEDULED_TASK_PROMPT_MAX_BYTES = 8 * 1024;
export const SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES = 256;
const SCHEDULED_TASK_GOAL_FIELD_MAX_BYTES = 2 * 1024;
const SCHEDULED_TASK_MODEL_MAX_BYTES = 512;
const SCHEDULED_TASK_TIMESTAMP_MAX_BYTES = 128;
const SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT = 20;

type Utf8Projection = {
  value: string;
  originalBytes: number;
  deliveredBytes: number;
  truncated: boolean;
};

export type ScheduledTaskUtf8ProjectionFact = Omit<Utf8Projection, "value">;

type ScheduledTaskScheduleProjection =
  | {
      schedule: Extract<ScheduledTaskScheduleSpec, { type: "once" }>;
      projection: {
        type: "once";
        truncated: boolean;
        fields: {
          runAt: ScheduledTaskUtf8ProjectionFact;
          timeZone: ScheduledTaskUtf8ProjectionFact;
        };
      };
    }
  | {
      schedule: Extract<ScheduledTaskScheduleSpec, { type: "interval" }>;
      projection: {
        type: "interval";
        truncated: boolean;
        fields: {
          startAt: ScheduledTaskUtf8ProjectionFact | null;
          endAt: ScheduledTaskUtf8ProjectionFact | null;
        };
      };
    }
  | {
      schedule: Extract<ScheduledTaskScheduleSpec, { type: "calendar" }>;
      projection: {
        type: "calendar";
        truncated: boolean;
        fields: {
          timeZone: ScheduledTaskUtf8ProjectionFact;
        };
      };
    };

type DetailBudget = {
  promptBytes: number;
  goalFieldBytes: number;
  identityPreviewLimit: number;
  resourceUriBytes: number;
  resourceRefBytes: number;
  toolIdBytes: number;
  metadataKeyBytes: number;
};

const DETAIL_BUDGETS: readonly DetailBudget[] = [
  {
    promptBytes: SCHEDULED_TASK_PROMPT_MAX_BYTES,
    goalFieldBytes: SCHEDULED_TASK_GOAL_FIELD_MAX_BYTES,
    identityPreviewLimit: SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT,
    resourceUriBytes: 512,
    resourceRefBytes: 256,
    toolIdBytes: 256,
    metadataKeyBytes: 256,
  },
  {
    promptBytes: 4 * 1024,
    goalFieldBytes: 1024,
    identityPreviewLimit: 10,
    resourceUriBytes: 256,
    resourceRefBytes: 128,
    toolIdBytes: 128,
    metadataKeyBytes: 128,
  },
  {
    promptBytes: 2 * 1024,
    goalFieldBytes: 512,
    identityPreviewLimit: 5,
    resourceUriBytes: 128,
    resourceRefBytes: 96,
    toolIdBytes: 96,
    metadataKeyBytes: 96,
  },
  {
    promptBytes: 1024,
    goalFieldBytes: 256,
    identityPreviewLimit: 2,
    resourceUriBytes: 96,
    resourceRefBytes: 64,
    toolIdBytes: 64,
    metadataKeyBytes: 64,
  },
  {
    promptBytes: 512,
    goalFieldBytes: 128,
    identityPreviewLimit: 0,
    resourceUriBytes: 64,
    resourceRefBytes: 64,
    toolIdBytes: 64,
    metadataKeyBytes: 64,
  },
];

function utf8Prefix(value: string, maxBytes: number): string {
  let index = 0;
  let bytes = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    index += character.length;
  }
  return value.slice(0, index);
}

export function projectScheduledTaskUtf8(value: string, maxBytes: number): Utf8Projection {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= byteLimit) {
    return { value, originalBytes, deliveredBytes: originalBytes, truncated: false };
  }
  let marker = "";
  let prefix = "";
  let omittedBytes = originalBytes;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `…[${omittedBytes} UTF-8 bytes omitted]`;
    if (Buffer.byteLength(marker, "utf8") > byteLimit) {
      marker = utf8Prefix(marker, byteLimit);
      prefix = "";
      break;
    }
    prefix = utf8Prefix(value, byteLimit - Buffer.byteLength(marker, "utf8"));
    const nextOmitted = originalBytes - Buffer.byteLength(prefix, "utf8");
    if (nextOmitted === omittedBytes) break;
    omittedBytes = nextOmitted;
  }
  const projected = `${prefix}${marker}`;
  return {
    value: projected,
    originalBytes,
    deliveredBytes: Buffer.byteLength(projected, "utf8"),
    truncated: true,
  };
}

function projectionFact(projection: Utf8Projection): ScheduledTaskUtf8ProjectionFact {
  return {
    originalBytes: projection.originalBytes,
    deliveredBytes: projection.deliveredBytes,
    truncated: projection.truncated,
  };
}

export function projectScheduledTaskSchedule(
  schedule: ScheduledTaskScheduleSpec,
): ScheduledTaskScheduleProjection {
  switch (schedule.type) {
    case "once": {
      const runAt = projectScheduledTaskUtf8(
        schedule.runAt,
        SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES,
      );
      const timeZone = projectScheduledTaskUtf8(
        schedule.timeZone,
        SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES,
      );
      return {
        schedule: { type: "once", runAt: runAt.value, timeZone: timeZone.value },
        projection: {
          type: "once",
          truncated: runAt.truncated || timeZone.truncated,
          fields: { runAt: projectionFact(runAt), timeZone: projectionFact(timeZone) },
        },
      };
    }
    case "interval": {
      const startAt = schedule.startAt
        ? projectScheduledTaskUtf8(schedule.startAt, SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES)
        : null;
      const endAt = schedule.endAt
        ? projectScheduledTaskUtf8(schedule.endAt, SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES)
        : null;
      return {
        schedule: {
          type: "interval",
          everySeconds: schedule.everySeconds,
          ...(startAt ? { startAt: startAt.value } : {}),
          ...(endAt ? { endAt: endAt.value } : {}),
        },
        projection: {
          type: "interval",
          truncated: Boolean(startAt?.truncated || endAt?.truncated),
          fields: {
            startAt: startAt ? projectionFact(startAt) : null,
            endAt: endAt ? projectionFact(endAt) : null,
          },
        },
      };
    }
    case "calendar": {
      const timeZone = projectScheduledTaskUtf8(
        schedule.timeZone,
        SCHEDULED_TASK_SCHEDULE_FIELD_MAX_BYTES,
      );
      return {
        schedule: {
          type: "calendar",
          timeZone: timeZone.value,
          hour: schedule.hour,
          minute: schedule.minute,
          ...(schedule.daysOfWeek ? { daysOfWeek: schedule.daysOfWeek } : {}),
        },
        projection: {
          type: "calendar",
          truncated: timeZone.truncated,
          fields: { timeZone: projectionFact(timeZone) },
        },
      };
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function mcpJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function settleMeasuredBytes(
  value: unknown,
  read: () => number,
  write: (bytes: number) => void,
): number {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = mcpJsonBytes(value);
    if (bytes === read()) return bytes;
    write(bytes);
  }
  return mcpJsonBytes(value);
}

function resourceIdentity(
  resource: ResourceRef,
  budget: DetailBudget,
): { value: Record<string, unknown>; truncatedFieldCount: number } {
  if (resource.kind === "repository") {
    const uri = projectScheduledTaskUtf8(resource.uri, budget.resourceUriBytes);
    const ref = resource.ref
      ? projectScheduledTaskUtf8(resource.ref, budget.resourceRefBytes)
      : null;
    return {
      value: {
        kind: resource.kind,
        uri: uri.value,
        ...(ref ? { ref: ref.value } : {}),
      },
      truncatedFieldCount: Number(uri.truncated) + Number(ref?.truncated ?? false),
    };
  }
  return { value: { kind: resource.kind, fileId: resource.fileId }, truncatedFieldCount: 0 };
}

function toolIdentity(
  tool: ToolRef,
  budget: DetailBudget,
): { value: Record<string, unknown>; truncatedFieldCount: number } {
  const id = projectScheduledTaskUtf8(tool.id, budget.toolIdBytes);
  return {
    value: {
      kind: tool.kind,
      id: id.value,
      ...(tool.optional !== undefined ? { optional: tool.optional } : {}),
    },
    truncatedFieldCount: Number(id.truncated),
  };
}

export function scheduledTaskMcpSummary(task: ScheduledTask) {
  const name = projectScheduledTaskUtf8(task.name, SCHEDULED_TASK_NAME_MAX_BYTES);
  const schedule = projectScheduledTaskSchedule(task.schedule);
  const model = task.agentConfig.model
    ? projectScheduledTaskUtf8(task.agentConfig.model, SCHEDULED_TASK_MODEL_MAX_BYTES)
    : null;
  const createdAt = projectScheduledTaskUtf8(task.createdAt, SCHEDULED_TASK_TIMESTAMP_MAX_BYTES);
  const updatedAt = projectScheduledTaskUtf8(task.updatedAt, SCHEDULED_TASK_TIMESTAMP_MAX_BYTES);
  const result = {
    id: task.id,
    name: name.value,
    status: task.status,
    schedule: schedule.schedule,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
    reusableSessionId: task.reusableSessionId,
    variableSetId: task.variableSetId,
    rigId: task.rigId,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    configuration: {
      model: model?.value ?? null,
      reasoningEffort: task.agentConfig.reasoningEffort ?? null,
      sandboxBackend: task.agentConfig.sandboxBackend ?? null,
      hasGoal: task.agentConfig.goal !== undefined,
      promptBytes: Buffer.byteLength(task.agentConfig.prompt, "utf8"),
      resourceCount: task.agentConfig.resources.length,
      toolCount: task.agentConfig.tools.length,
      metadataKeyCount: Object.keys(task.agentConfig.metadata).length,
      taskMetadataKeyCount: Object.keys(task.metadata).length,
    },
    projection: {
      bounded: true,
      name: projectionFact(name),
      schedule: schedule.projection,
      model: model ? projectionFact(model) : null,
      createdAt: projectionFact(createdAt),
      updatedAt: projectionFact(updatedAt),
      bytes: 0,
      maxBytes: SCHEDULED_TASK_MCP_MAX_BYTES,
    },
  };
  settleMeasuredBytes(
    result,
    () => result.projection.bytes,
    (bytes) => {
      result.projection.bytes = bytes;
    },
  );
  return result;
}

function buildScheduledTaskDetailMcp(
  task: ScheduledTask,
  budget: DetailBudget,
  reducedForBytes: boolean,
) {
  const prompt = projectScheduledTaskUtf8(task.agentConfig.prompt, budget.promptBytes);
  const goalText = task.agentConfig.goal
    ? projectScheduledTaskUtf8(task.agentConfig.goal.text, budget.goalFieldBytes)
    : null;
  const goalCriteria = task.agentConfig.goal?.successCriteria
    ? projectScheduledTaskUtf8(task.agentConfig.goal.successCriteria, budget.goalFieldBytes)
    : null;
  const resourceProjections = task.agentConfig.resources
    .slice(0, budget.identityPreviewLimit)
    .map((resource) => resourceIdentity(resource, budget));
  const toolProjections = task.agentConfig.tools
    .slice(0, budget.identityPreviewLimit)
    .map((tool) => toolIdentity(tool, budget));
  const resources = resourceProjections.map((projection) => projection.value);
  const tools = toolProjections.map((projection) => projection.value);
  const metadataKeyProjections = Object.keys(task.agentConfig.metadata)
    .sort()
    .slice(0, budget.identityPreviewLimit)
    .map((key) => projectScheduledTaskUtf8(key, budget.metadataKeyBytes));
  const taskMetadataKeyProjections = Object.keys(task.metadata)
    .sort()
    .slice(0, budget.identityPreviewLimit)
    .map((key) => projectScheduledTaskUtf8(key, budget.metadataKeyBytes));
  const metadataKeys = metadataKeyProjections.map((projection) => projection.value);
  const taskMetadataKeys = taskMetadataKeyProjections.map((projection) => projection.value);

  const result = {
    ...scheduledTaskMcpSummary(task),
    entity: {
      agentConfig: {
        prompt: prompt.value,
        resources,
        tools,
        metadataKeys,
        model: task.agentConfig.model
          ? projectScheduledTaskUtf8(task.agentConfig.model, SCHEDULED_TASK_MODEL_MAX_BYTES).value
          : null,
        reasoningEffort: task.agentConfig.reasoningEffort ?? null,
        sandboxBackend: task.agentConfig.sandboxBackend ?? null,
        goal: goalText
          ? {
              text: goalText.value,
              successCriteria: goalCriteria?.value ?? null,
              maxAutoContinuations: task.agentConfig.goal?.maxAutoContinuations ?? null,
            }
          : null,
      },
      taskMetadataKeys,
    },
    detailProjection: {
      bounded: true,
      fullEntityAvailableViaRest: true,
      reducedForBytes,
      terminal: false,
      prompt: projectionFact(prompt),
      goalText: goalText ? projectionFact(goalText) : null,
      goalSuccessCriteria: goalCriteria ? projectionFact(goalCriteria) : null,
      resources: {
        originalCount: task.agentConfig.resources.length,
        deliveredCount: resources.length,
        originalBytes: jsonBytes(task.agentConfig.resources),
        truncatedIdentityFieldCount: resourceProjections.reduce(
          (count, projection) => count + projection.truncatedFieldCount,
          0,
        ),
      },
      tools: {
        originalCount: task.agentConfig.tools.length,
        deliveredCount: tools.length,
        originalBytes: jsonBytes(task.agentConfig.tools),
        truncatedIdentityFieldCount: toolProjections.reduce(
          (count, projection) => count + projection.truncatedFieldCount,
          0,
        ),
      },
      metadata: {
        originalKeyCount: Object.keys(task.agentConfig.metadata).length,
        deliveredKeyCount: metadataKeys.length,
        originalBytes: jsonBytes(task.agentConfig.metadata),
        truncatedKeyCount: metadataKeyProjections.filter((projection) => projection.truncated)
          .length,
        valuesIncluded: false,
      },
      taskMetadata: {
        originalKeyCount: Object.keys(task.metadata).length,
        deliveredKeyCount: taskMetadataKeys.length,
        originalBytes: jsonBytes(task.metadata),
        truncatedKeyCount: taskMetadataKeyProjections.filter((projection) => projection.truncated)
          .length,
        valuesIncluded: false,
      },
      bytes: 0,
      maxBytes: SCHEDULED_TASK_MCP_MAX_BYTES,
    },
  };
  settleMeasuredBytes(
    result,
    () => result.detailProjection.bytes,
    (bytes) => {
      result.detailProjection.bytes = bytes;
    },
  );
  return result;
}

export function boundScheduledTaskDetailMcp(task: ScheduledTask) {
  for (const [index, budget] of DETAIL_BUDGETS.entries()) {
    const result = buildScheduledTaskDetailMcp(task, budget, index > 0);
    if (result.detailProjection.bytes <= SCHEDULED_TASK_MCP_MAX_BYTES) return result;
  }

  const summary = scheduledTaskMcpSummary(task);
  const prompt = projectScheduledTaskUtf8(task.agentConfig.prompt, 128);
  const goalText = task.agentConfig.goal
    ? projectScheduledTaskUtf8(task.agentConfig.goal.text, 64)
    : null;
  const goalCriteria = task.agentConfig.goal?.successCriteria
    ? projectScheduledTaskUtf8(task.agentConfig.goal.successCriteria, 64)
    : null;
  const terminal = {
    ...summary,
    entity: {
      agentConfig: {
        prompt: prompt.value,
        resources: [],
        tools: [],
        metadataKeys: [],
        model: null,
        reasoningEffort: task.agentConfig.reasoningEffort ?? null,
        sandboxBackend: task.agentConfig.sandboxBackend ?? null,
        goal: goalText
          ? {
              text: goalText.value,
              successCriteria: goalCriteria?.value ?? null,
              maxAutoContinuations: task.agentConfig.goal?.maxAutoContinuations ?? null,
            }
          : null,
      },
      taskMetadataKeys: [],
    },
    detailProjection: {
      bounded: true,
      fullEntityAvailableViaRest: true,
      reducedForBytes: true,
      terminal: true,
      reason: "detail_projection_exceeded_model_envelope",
      nextAction: {
        surface: "REST",
        resourceType: "scheduled_task",
        resourceId: task.id,
      },
      prompt: projectionFact(prompt),
      goalText: goalText ? projectionFact(goalText) : null,
      goalSuccessCriteria: goalCriteria ? projectionFact(goalCriteria) : null,
      resources: {
        originalCount: task.agentConfig.resources.length,
        deliveredCount: 0,
        originalBytes: jsonBytes(task.agentConfig.resources),
        truncatedIdentityFieldCount: 0,
      },
      tools: {
        originalCount: task.agentConfig.tools.length,
        deliveredCount: 0,
        originalBytes: jsonBytes(task.agentConfig.tools),
        truncatedIdentityFieldCount: 0,
      },
      metadata: {
        originalKeyCount: Object.keys(task.agentConfig.metadata).length,
        deliveredKeyCount: 0,
        originalBytes: jsonBytes(task.agentConfig.metadata),
        truncatedKeyCount: 0,
        valuesIncluded: false,
      },
      taskMetadata: {
        originalKeyCount: Object.keys(task.metadata).length,
        deliveredKeyCount: 0,
        originalBytes: jsonBytes(task.metadata),
        truncatedKeyCount: 0,
        valuesIncluded: false,
      },
      bytes: 0,
      maxBytes: SCHEDULED_TASK_MCP_MAX_BYTES,
    },
  };
  settleMeasuredBytes(
    terminal,
    () => terminal.detailProjection.bytes,
    (bytes) => {
      terminal.detailProjection.bytes = bytes;
    },
  );
  return terminal;
}

export function boundScheduledTaskMcpPage(input: {
  tasks: ScheduledTask[];
  limit: number;
  offset: number;
  sourceHasMore: boolean;
  maxBytes?: number;
}) {
  const maxBytes = Math.max(8 * 1024, input.maxBytes ?? SCHEDULED_TASK_MCP_MAX_BYTES);
  let summaries = input.tasks.map(scheduledTaskMcpSummary);

  const build = () => {
    const droppedTasks = input.tasks.slice(summaries.length);
    const rowsDroppedForBytes = droppedTasks.length > 0;
    const hasMore = input.sourceHasMore || rowsDroppedForBytes;
    const nextOffset = hasMore && input.tasks.length > 0 ? input.offset + input.tasks.length : null;
    const page = {
      tasks: summaries,
      page: {
        limit: input.limit,
        offset: input.offset,
        hasMore,
        nextOffset,
      },
      projection: {
        bounded: true,
        rowsDroppedForBytes,
        droppedRowCount: droppedTasks.length,
        droppedRows: droppedTasks.map((task) => ({
          id: task.id,
          nextAction: {
            tool: "scheduled_tasks_get",
            arguments: { id: task.id, includeEntity: false },
          },
        })),
        sourceRowsConsumed: input.tasks.length,
        rowsReturned: summaries.length,
        terminal: hasMore && nextOffset === null,
        ...(hasMore && nextOffset === null
          ? { reason: "source_reported_more_rows_without_a_consumed_row" }
          : {}),
        bytes: 0,
        maxBytes,
      },
    };
    settleMeasuredBytes(
      page,
      () => page.projection.bytes,
      (bytes) => {
        page.projection.bytes = bytes;
      },
    );
    return page;
  };

  let page = build();
  while (page.projection.bytes > maxBytes && summaries.length > 0) {
    summaries = summaries.slice(0, -1);
    page = build();
  }
  return page;
}
