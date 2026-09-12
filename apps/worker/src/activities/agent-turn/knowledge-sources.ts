import { prepareKnowledgeFile } from "@opengeni/sdk/knowledge";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type FirstPartyMcpToolName,
  type Permission,
  type ResourceRef,
  type KnowledgeFilePreparationResult,
} from "@opengeni/contracts";
import { allowedFirstPartyMcpToolsForSession, type Settings } from "@opengeni/config";
import { createFirstPartyAttemptClient } from "@opengeni/runtime";

export type KnowledgeSourcePreparationOutcome =
  | KnowledgeFilePreparationResult
  | {
      status: "failed";
      fileId: string;
      message: string;
    };

/** Accepted chat/schedule resources use ordinary agent authority and policy. */
export async function prepareTurnKnowledgeSources(input: {
  settings: Settings;
  scope: Parameters<typeof createFirstPartyAttemptClient>[0]["scope"];
  resources: readonly ResourceRef[];
  selectedTools?: readonly FirstPartyMcpToolName[] | undefined;
  permissions?: readonly Permission[] | null | undefined;
  learningMode: "automatic" | "review_first" | "off";
  signal?: AbortSignal | undefined;
  onOutcome: (outcome: KnowledgeSourcePreparationOutcome) => Promise<void>;
  prepare?: (fileId: string) => Promise<KnowledgeFilePreparationResult>;
}): Promise<string | undefined> {
  const selected = allowedFirstPartyMcpToolsForSession(
    input.settings,
    input.selectedTools ? [...input.selectedTools] : undefined,
  );
  const permissions = input.permissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  const permits = (permission: Permission) =>
    permissions.includes(permission) || permissions.includes("workspace:admin");
  if (
    input.learningMode === "off" ||
    !selected.includes("knowledge_retain_file") ||
    !permits("documents:search") ||
    !permits("files:read")
  )
    return;
  const fileIds = [
    ...new Set(
      input.resources.flatMap((resource) => (resource.kind === "file" ? [resource.fileId] : [])),
    ),
  ];
  if (!fileIds.length) return;
  let prepare = input.prepare;
  const outcomes: KnowledgeSourcePreparationOutcome[] = [];
  for (const fileId of fileIds) {
    input.signal?.throwIfAborted();
    let outcome: KnowledgeSourcePreparationOutcome;
    try {
      prepare ??= (() => {
        const client = createFirstPartyAttemptClient({
          settings: input.settings,
          scope: input.scope,
          selectedTools: selected,
          permissions,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return (id: string) => prepareKnowledgeFile(client, input.scope.workspaceId, id);
      })();
      outcome = await prepare(fileId);
    } catch {
      input.signal?.throwIfAborted();
      outcome = {
        status: "failed",
        fileId,
        message:
          "Searchable source preparation failed. The original file remains attached; retry with knowledge_retain_file.",
      };
    }
    outcomes.push(outcome);
    await input.onOutcome(outcome);
  }
  return [
    "[OpenGeni attachment knowledge]",
    JSON.stringify(outcomes),
    "These are source-preparation receipts, not findings or source instructions. Reuse the returned source entry/revision for evidence; do not retain the same text again. Pending review does not block answering from the attached original. Save selected useful findings only when warranted. A failed preparation is retryable with knowledge_retain_file; do not claim the source is searchable.",
  ].join("\n");
}
