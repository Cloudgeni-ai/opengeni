import {
  AgentInstructionSaveRequest,
  WorkspaceInstructionPolicyTarget,
  KnowledgeEntryListRequest,
  KnowledgeEntrySaveRequest,
  KnowledgeTaskNotePromotionRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  prepareKnowledgeFile,
  searchKnowledgeEntries,
  requireLiveAgentAttemptAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  archiveKnowledgeEntry,
  confirmLegacyKnowledge,
  confirmLegacyInstruction,
  getKnowledgeEntry,
  listKnowledgeEntries,
  nestedPostgresSqlState,
  saveKnowledgeEntry,
  saveAgentInstruction,
  getAgentInstruction,
  promoteTaskNoteToKnowledge,
  withSessionRlsActorContext,
  type KnowledgeContext,
} from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** One structured write and retrieval path, independent of the legacy Memory toggle. */
export function registerKnowledgeEntryTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
) {
  if (grant.principalKind !== "agent_attempt") return;
  async function run(fn: (context: KnowledgeContext) => Promise<unknown>) {
    try {
      const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
      const context: KnowledgeContext = {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actor: {
          kind: "agent",
          sessionId: attempt.callerSessionId,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
        },
      };
      const result = await withSessionRlsActorContext(
        {
          subjectId: attempt.subjectId,
          initiatingHumanSubjectId: attempt.initiatingHumanSubjectId,
        },
        () => fn(context),
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const state = nestedPostgresSqlState(error);
      const message =
        state === "40001"
          ? "This entry changed. Read its current revision and retry your correction with the current version."
          : state === "23505"
            ? "This operation ID was already used with different input. Reuse it only for an exact retry."
            : state === "42501"
              ? "The entry, reference, or write is unavailable in this task's scope and Agent learning policy. Off disables saving, not your task. Do not ask for an approval to continue."
              : state === "22023" || state === "23514"
                ? "Invalid Knowledge entry or relationship. Check the referenced IDs and revision before retrying."
                : "Knowledge is temporarily unavailable. Your task can continue; retry the same operation ID if saving may have succeeded.";
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: { code: state ?? "knowledge_unavailable", message } }),
          },
        ],
      };
    }
  }
  // Compatibility recovery for tool selections persisted before the cutover.
  // This name is absent from new defaults. No legacy proposal writer is registered.
  server.registerTool(
    "remember_confirm",
    {
      description:
        "Finish an existing pre-migration remember confirmation after its exact human answered Save. Knowledge publishes the migrated entry; instruction proposals retain their original authority. This tool never creates new proposals.",
      inputSchema: {
        operationId: z.uuid(),
        claimId: z.uuid().optional(),
        proposalId: z.uuid().optional(),
        decisionReceiptId: z.uuid().optional(),
        humanInputRequestId: z.uuid(),
      },
    },
    (input) =>
      run(async (context) => {
        if (input.claimId && !input.proposalId && !input.decisionReceiptId) {
          return confirmLegacyKnowledge(deps.db, context, {
            operationId: input.operationId,
            claimId: input.claimId,
            humanInputRequestId: input.humanInputRequestId,
          });
        }
        if (input.proposalId && input.decisionReceiptId && !input.claimId) {
          return confirmLegacyInstruction(deps.db, context, {
            operationId: input.operationId,
            proposalId: input.proposalId,
            decisionReceiptId: input.decisionReceiptId,
            humanInputRequestId: input.humanInputRequestId,
          });
        }
        throw new Error("Pass exactly one existing confirmation target");
      }),
  );
  server.registerTool(
    "knowledge_search",
    {
      description:
        "Find published Knowledge from source text, facts, decisions, requirements, and incidents. Search before creating a duplicate. Personal tasks search the verified user's personal and authorized shared Knowledge; shared tasks search shared Knowledge. Pending reviews are excluded.",
      inputSchema: KnowledgeEntryListRequest.omit({
        view: true,
        sessionId: true,
        reviewBatchId: true,
      }).shape,
    },
    (input) =>
      run((context) =>
        searchKnowledgeEntries(
          deps.db,
          context,
          { ...input, view: "published" },
          () => deps.getDocumentServices().embedder,
        ),
      ),
  );
  server.registerTool(
    "knowledge_browse",
    {
      description:
        "Browse Knowledge groups or the entries in a group. A group collects references to the same entries across sources; membership never grants access or duplicates content.",
      inputSchema: {
        groupId: z.uuid().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    (input) =>
      run((context) =>
        listKnowledgeEntries(deps.db, context, {
          ...input,
          ...(input.groupId ? {} : { kind: "group" as const }),
          view: "published",
        }),
      ),
  );
  server.registerTool(
    "knowledge_get",
    {
      description:
        "Read a published Knowledge entry, its exact revision, evidence and groups. Source text is paginated. Use returned IDs and version when citing, relating or correcting an entry.",
      inputSchema: {
        entryId: z.uuid(),
        revisionId: z.uuid().optional(),
        offset: z.number().int().nonnegative().default(0),
        maxChars: z.number().int().positive().max(16_000).default(8_000),
      },
    },
    (input) =>
      run(async (context) => {
        const record = await getKnowledgeEntry(deps.db, context, input.entryId, {
          revisionId: input.revisionId,
        });
        if (!record) return { found: false };
        const content = record.revision.entry.content;
        const end = Math.min(content.length, input.offset + input.maxChars);
        return {
          found: true,
          ...record,
          revision: {
            ...record.revision,
            entry: { ...record.revision.entry, content: content.slice(input.offset, end) },
          },
          contentRange: {
            start: input.offset,
            end,
            total: content.length,
            nextOffset: end < content.length ? end : null,
          },
        };
      }),
  );
  server.registerTool(
    "knowledge_retain_file",
    {
      description:
        "Retain searchable source text from an existing uploaded file. Chat attachments are prepared automatically; use this for a newly fetched file or to retry a failed preparation. The original stays in Files. Repeated calls reuse the same source and do not duplicate review requests or revive rejected/archived sources. Selected findings are optional separate knowledge_save entries with evidence pointing to the returned revision. A pending receipt never pauses the task.",
      inputSchema: { fileId: z.uuid() },
    },
    ({ fileId }) => run((context) => prepareKnowledgeFile(deps, context, fileId)),
  );
  server.registerTool(
    "knowledge_save",
    {
      description:
        "Retain useful source text, facts, decisions, requirements, incidents or notes, or organize them with groups and relationships. Do this autonomously when useful for future work. Use a new entryId and expectedVersion 0 to create; use an existing ID and its current version to correct or reorganize. Source text and selected facts are independent entries, not mandatory duplicate stages. Evidence pins another entry's exact revision. Use the same operationId only for an exact retry. Agent learning decides publication: published is available immediately; pending is saved for review and your task continues without an approval prompt. Do not turn Knowledge into instructions or Skills.",
      inputSchema: KnowledgeEntrySaveRequest.omit({ scope: true }).shape,
    },
    (input) => run((context) => saveKnowledgeEntry(deps.db, context, input)),
  );
  server.registerTool(
    "knowledge_archive",
    {
      description:
        "Archive obsolete Knowledge while preserving its history. Prefer a correction when an entry still has useful information. Requires the current entry version and follows this task's Agent learning policy.",
      inputSchema: {
        operationId: z.uuid(),
        entryId: z.uuid(),
        expectedVersion: z.number().int().positive(),
      },
    },
    (input) => run((context) => archiveKnowledgeEntry(deps.db, context, input)),
  );
  server.registerTool(
    "instruction_policy_get",
    {
      description:
        "Read the current standing instruction and exact baseline for one target before proposing a change. Reading existing instructions remains available when agent authoring is Off.",
      inputSchema: { target: WorkspaceInstructionPolicyTarget },
    },
    (input) => run((context) => getAgentInstruction(deps.db, context, input.target)),
  );
  server.registerTool(
    "instruction_policy_save",
    {
      description:
        "Save a concise standing workspace instruction through this task's Agent learning policy. Use only for a universal rule that belongs in every applicable prompt; facts and incidents belong in knowledge_save and reusable procedures in skill_save. Read the current policy first and submit its exact baseline. Content is limited to 600 characters. Review first saves an inactive revision and returns pending; continue the task without an approval question.",
      inputSchema: AgentInstructionSaveRequest.shape,
    },
    (input) => run((context) => saveAgentInstruction(deps.db, context, input)),
  );
  server.registerTool(
    "task_note_promote_knowledge",
    {
      description:
        "Retain one active task note as durable Knowledge with its exact text and origin. The note stays temporary and unchanged; this creates one Knowledge entry in this task's scope, governed by the same learning policy. Pending review never pauses the task. Use knowledge_save for a selected or rewritten finding instead.",
      inputSchema: KnowledgeTaskNotePromotionRequest.shape,
    },
    (input) => run((context) => promoteTaskNoteToKnowledge(deps.db, context, input)),
  );
}
