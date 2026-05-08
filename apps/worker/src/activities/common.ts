import type { ResourceRef, ToolRef } from "@infra-agents/contracts";

export {
  mergeResourceRefs,
  mergeToolRefs,
  reasoningEffortForMetadata as reasoningEffortForSession,
} from "@infra-agents/contracts";

export function scheduledUserMessagePayload(prompt: string, resources: ResourceRef[], tools: ToolRef[], taskId: string, runId: string): Record<string, unknown> {
  return {
    text: prompt,
    scheduledTaskId: taskId,
    scheduledTaskRunId: runId,
    ...(resources.length ? { resources } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}
