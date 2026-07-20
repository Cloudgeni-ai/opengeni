import type { ResourceRef, ScheduledTask, ToolRef } from "@opengeni/contracts";

export const SCHEDULED_TASK_MCP_MAX_BYTES = 64 * 1024;
export const SCHEDULED_TASK_NAME_MAX_BYTES = 512;
export const SCHEDULED_TASK_PROMPT_MAX_BYTES = 8 * 1024;
const SCHEDULED_TASK_GOAL_FIELD_MAX_BYTES = 2 * 1024;
const SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT = 20;

type Utf8Projection = {
  value: string;
  originalBytes: number;
  deliveredBytes: number;
  truncated: boolean;
};

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
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return { value, originalBytes, deliveredBytes: originalBytes, truncated: false };
  }
  let marker = "";
  let prefix = "";
  let omittedBytes = originalBytes;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `…[${omittedBytes} UTF-8 bytes omitted]`;
    prefix = utf8Prefix(value, Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")));
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

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function mcpJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function resourceIdentity(resource: ResourceRef): Record<string, unknown> {
  if (resource.kind === "repository") {
    return {
      kind: resource.kind,
      uri: projectScheduledTaskUtf8(resource.uri, 512).value,
      ...(resource.ref ? { ref: projectScheduledTaskUtf8(resource.ref, 256).value } : {}),
    };
  }
  return { kind: resource.kind, fileId: resource.fileId };
}

function toolIdentity(tool: ToolRef): Record<string, unknown> {
  return {
    kind: tool.kind,
    id: projectScheduledTaskUtf8(tool.id, 256).value,
    ...(tool.optional !== undefined ? { optional: tool.optional } : {}),
  };
}

export function scheduledTaskMcpSummary(task: ScheduledTask) {
  const name = projectScheduledTaskUtf8(task.name, SCHEDULED_TASK_NAME_MAX_BYTES);
  return {
    id: task.id,
    name: name.value,
    status: task.status,
    schedule: task.schedule,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
    reusableSessionId: task.reusableSessionId,
    variableSetId: task.variableSetId,
    rigId: task.rigId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    configuration: {
      model: task.agentConfig.model ?? null,
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
      name: {
        originalBytes: name.originalBytes,
        deliveredBytes: name.deliveredBytes,
        truncated: name.truncated,
      },
    },
  };
}

export function boundScheduledTaskDetailMcp(task: ScheduledTask) {
  const prompt = projectScheduledTaskUtf8(task.agentConfig.prompt, SCHEDULED_TASK_PROMPT_MAX_BYTES);
  const goalText = task.agentConfig.goal
    ? projectScheduledTaskUtf8(task.agentConfig.goal.text, SCHEDULED_TASK_GOAL_FIELD_MAX_BYTES)
    : null;
  const goalCriteria = task.agentConfig.goal?.successCriteria
    ? projectScheduledTaskUtf8(
        task.agentConfig.goal.successCriteria,
        SCHEDULED_TASK_GOAL_FIELD_MAX_BYTES,
      )
    : null;
  const resources = task.agentConfig.resources
    .slice(0, SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT)
    .map(resourceIdentity);
  const tools = task.agentConfig.tools
    .slice(0, SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT)
    .map(toolIdentity);
  const metadataKeys = Object.keys(task.agentConfig.metadata)
    .sort()
    .slice(0, SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT)
    .map((key) => projectScheduledTaskUtf8(key, 256).value);
  const taskMetadataKeys = Object.keys(task.metadata)
    .sort()
    .slice(0, SCHEDULED_TASK_IDENTITY_PREVIEW_LIMIT)
    .map((key) => projectScheduledTaskUtf8(key, 256).value);

  const result = {
    ...scheduledTaskMcpSummary(task),
    entity: {
      agentConfig: {
        prompt: prompt.value,
        resources,
        tools,
        metadataKeys,
        model: task.agentConfig.model ?? null,
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
      prompt: {
        originalBytes: prompt.originalBytes,
        deliveredBytes: prompt.deliveredBytes,
        truncated: prompt.truncated,
      },
      goalText: goalText
        ? {
            originalBytes: goalText.originalBytes,
            deliveredBytes: goalText.deliveredBytes,
            truncated: goalText.truncated,
          }
        : null,
      goalSuccessCriteria: goalCriteria
        ? {
            originalBytes: goalCriteria.originalBytes,
            deliveredBytes: goalCriteria.deliveredBytes,
            truncated: goalCriteria.truncated,
          }
        : null,
      resources: {
        originalCount: task.agentConfig.resources.length,
        deliveredCount: resources.length,
        originalBytes: jsonBytes(task.agentConfig.resources),
      },
      tools: {
        originalCount: task.agentConfig.tools.length,
        deliveredCount: tools.length,
        originalBytes: jsonBytes(task.agentConfig.tools),
      },
      metadata: {
        originalKeyCount: Object.keys(task.agentConfig.metadata).length,
        deliveredKeyCount: metadataKeys.length,
        originalBytes: jsonBytes(task.agentConfig.metadata),
        valuesIncluded: false,
      },
      taskMetadata: {
        originalKeyCount: Object.keys(task.metadata).length,
        deliveredKeyCount: taskMetadataKeys.length,
        originalBytes: jsonBytes(task.metadata),
        valuesIncluded: false,
      },
    },
  };
  if (mcpJsonBytes(result) > SCHEDULED_TASK_MCP_MAX_BYTES) {
    throw new RangeError(
      `Scheduled-task detail projection exceeds ${SCHEDULED_TASK_MCP_MAX_BYTES} bytes`,
    );
  }
  return result;
}

export function boundScheduledTaskMcpPage(input: {
  tasks: ScheduledTask[];
  limit: number;
  offset: number;
  sourceHasMore: boolean;
}) {
  let summaries = input.tasks.map(scheduledTaskMcpSummary);
  let modelRowsDropped = false;
  const build = () => ({
    tasks: summaries,
    page: {
      limit: input.limit,
      offset: input.offset,
      hasMore: input.sourceHasMore || modelRowsDropped,
      nextOffset: input.sourceHasMore || modelRowsDropped ? input.offset + summaries.length : null,
    },
    projection: {
      bounded: true,
      rowsDroppedForBytes: modelRowsDropped,
      bytes: 0,
      maxBytes: SCHEDULED_TASK_MCP_MAX_BYTES,
    },
  });
  let page = build();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    page.projection.bytes = mcpJsonBytes(page);
  }
  while (page.projection.bytes > SCHEDULED_TASK_MCP_MAX_BYTES && summaries.length > 0) {
    summaries = summaries.slice(0, -1);
    modelRowsDropped = true;
    page = build();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      page.projection.bytes = mcpJsonBytes(page);
    }
  }
  if (page.projection.bytes > SCHEDULED_TASK_MCP_MAX_BYTES) {
    throw new RangeError(
      `Scheduled-task list metadata exceeds ${SCHEDULED_TASK_MCP_MAX_BYTES} bytes`,
    );
  }
  return page;
}
