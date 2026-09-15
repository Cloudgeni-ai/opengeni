export type {
  AgentLearningMode,
  AgentLearningCategory,
  AgentLearningDefaults,
  AgentLearningOverrides,
  AgentLearningContext,
  AgentLearningOverridePatch,
  AgentLearningSettingsRecord,
  AgentLearningOverrideRecord,
  SaveAgentLearningSettingsRequest,
  KnowledgeFilePreparationResult,
  KnowledgeSavePreparationRequest,
  KnowledgeSavePreparationResponse,
  KnowledgeOriginalFileDownload,
  KnowledgeEntryKind,
  KnowledgeEntryScope,
  KnowledgeEntryContent,
  KnowledgeEntrySource,
  KnowledgeEntryEvidence,
  KnowledgeEntryRelationship,
  KnowledgeEntryRecord,
  KnowledgeEntrySummary,
  KnowledgeEntrySaveRequest,
  KnowledgeEntryReviewRequest,
  KnowledgeEntryBatchReviewRequest,
  KnowledgeEntryRestoreRequest,
  KnowledgeEntryWriteReceipt,
  KnowledgeEntryListRequest,
  KnowledgeEntryListResponse,
  KnowledgeReviewBatch,
  KnowledgeReviewBatchListRequest,
  KnowledgeReviewBatchListResponse,
  AgentInstructionReviewRequest,
  AgentInstructionReceipt,
  AgentInstructionReviewItem,
  AgentInstructionReviewListResponse,
} from "@opengeni/contracts";

import type { OpenGeniClient } from "./client";
import type {
  KnowledgeSavePreparationRequest,
  KnowledgeSavePreparationResponse,
  KnowledgeFilePreparationResult,
} from "@opengeni/contracts";

/** Agent-only source preparation is a focused transport surface, outside the browser client. */
export async function prepareKnowledgeFile(
  client: Pick<OpenGeniClient, "requestJson">,
  workspaceId: string,
  fileId: string,
  purpose?: "evidence" | "reference",
): Promise<KnowledgeFilePreparationResult> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/files/${encodeURIComponent(fileId)}/prepare`,
    purpose ? { purpose } : undefined,
  );
}

/** Read-only collection/duplicate discovery for a live selected agent or human Knowledge reviewer. */
export async function prepareKnowledgeSave(
  client: Pick<OpenGeniClient, "requestJson">,
  workspaceId: string,
  request: KnowledgeSavePreparationRequest,
): Promise<KnowledgeSavePreparationResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/entries/prepare-save`,
    request,
  );
}
