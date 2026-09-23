import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  freezeAgentLearningPolicy,
  getScheduledTaskRunAcceptedExecution,
  readScheduledKnowledgeSource,
  type Database,
  type KnowledgeContext,
} from "@opengeni/db";
import type { RunKnowledgeSourceSyncBatchInput, RunKnowledgeSourceSyncBatchResult } from "../types";

/** This tool exists only in an ordinary run with a frozen connector selection. */
export async function createKnowledgeSourceAttemptTools(input: {
  db: Database;
  context: KnowledgeContext;
  fetch: (input: RunKnowledgeSourceSyncBatchInput) => Promise<RunKnowledgeSourceSyncBatchResult>;
}): Promise<AttemptToolDefinition[]> {
  if (input.context.actor.kind !== "agent") return [];
  const policy = await freezeAgentLearningPolicy(input.db, input.context);
  if (typeof policy.scheduledTaskRunId !== "string") return [];
  const runId = policy.scheduledTaskRunId;
  const accepted = await getScheduledTaskRunAcceptedExecution(input.db, {
    workspaceId: input.context.workspaceId,
    runId,
  });
  const source = accepted?.task.agentConfig.knowledgeSource;
  if (!accepted || !source || accepted.task.action.kind !== "agent_turn") return [];
  const actor = input.context.actor;
  const authorize = async () => {
    const current = await freezeAgentLearningPolicy(input.db, input.context);
    if (current.scheduledTaskRunId !== runId) throw new Error("Source run authority changed");
  };
  const definition = (
    name: string,
    title: string,
    description: string,
    inputSchema: AttemptToolDefinition["inputSchema"],
    execute: (args: Record<string, unknown>) => Promise<unknown>,
    readOnly: boolean,
  ): AttemptToolDefinition => ({
    identity: { serverId: "opengeni", toolName: name },
    modelName: name,
    codemodePath: ["opengeni", name],
    title,
    description,
    inputSchema,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: !readOnly,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await authorize();
      const output = await execute(args);
      return { isError: false, content: [{ type: "text", text: JSON.stringify(output) }] };
    },
  });
  return [
    definition(
      "knowledge_source_fetch",
      "Fetch selected source",
      "Fetch a checkpointed batch from this scheduled task's selected source. Retains original files and searchable source content under the run's Knowledge policy. It does not create findings. Use knowledge_source_read to inspect content, then knowledge_save for useful findings with evidence. Call again if action is continue. Review first stages content without interrupting this task; Off keeps Knowledge disabled.",
      { type: "object", properties: {}, additionalProperties: false },
      async () =>
        (await freezeAgentLearningPolicy(input.db, input.context)).effective.knowledge === "off"
          ? { action: "disabled", reason: "Knowledge is Off for this run" }
          : input.fetch({
              accountId: input.context.accountId,
              workspaceId: input.context.workspaceId,
              taskId: accepted.task.id,
              scheduledTaskRunId: runId,
              sourceId: source.sourceId,
              overlapPolicy: accepted.task.overlapPolicy === "skip" ? "skip" : "buffer_one",
              agent: actor,
            }),
      false,
    ),
    definition(
      "knowledge_source_read",
      "Read selected source content",
      "List source entries retained or updated in this run. Pass entryId to read up to 16,000 characters, following nextOffset for more. Follow nextCursor with afterId for subsequent list pages. Includes this run's pending source content so you can prepare findings in the same review batch; pending knowledge stays out of ordinary search. Use entryId and revisionId as evidence when saving findings.",
      {
        type: "object",
        properties: {
          entryId: { type: "string", format: "uuid" },
          afterId: { type: "string", format: "uuid" },
          offset: { type: "integer", minimum: 0, maximum: 100000000 },
        },
        additionalProperties: false,
      },
      async (args) => readScheduledKnowledgeSource(input.db, input.context, args),
      true,
    ),
  ];
}
