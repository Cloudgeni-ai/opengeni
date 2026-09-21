import {
  AgentInstructionSaveRequest,
  WorkspaceInstructionPolicyTarget,
  KnowledgeEntryListRequest,
  KnowledgeSavePreparationRequest,
  KnowledgeEntrySaveRequest,
  KnowledgeTaskNotePromotionRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  prepareKnowledgeFile,
  prepareKnowledgeSave,
  retainKnowledgeMessage,
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
  async function run(
    fn: (context: KnowledgeContext) => Promise<unknown>,
    surface: "knowledge" | "instruction" = "knowledge",
  ) {
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
        surface === "instruction"
          ? state === "40001"
            ? "This instruction changed. Read its current content and baseline, then retry the same intended edit against that exact state."
            : state === "23505"
              ? "This instruction operation ID was already used with different input. Reuse it only for an exact retry."
              : state === "42501"
                ? "The instruction change is unavailable in this task's scope or Agent learning policy. Off disables authoring, not the task. Do not ask for approval to continue."
                : state === "22023" || state === "23514"
                  ? "Invalid instruction change. Read the current instruction, use append for a new rule, or edit with one localized exact oldText match to update or remove text. Agents cannot replace the complete instruction. The resulting instruction must stay within 600 characters."
                  : "Workspace instructions are temporarily unavailable. Retry the same operation ID only if the prior change may have succeeded."
          : state === "40001"
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
    "knowledge_prepare_save",
    {
      description:
        "Before saving useful lasting Knowledge, find related published entries and unapproved proposals, and fetch the full authorized collection map with descriptions and parent IDs in one read-only call. First choose the destination: future behavior belongs in instruction_policy_save for short always-on workspace rules or skill_save for applicable procedures and preferences, not Knowledge. Supply a concise subject and the proposed fact, decision, requirement or incident. Search spans all authorized collections. Reuse an existing entry when unchanged; read its current content before a correction, preserve evidence, or create only when distinct. Pending matches are unapproved. Choose collections from this map in your writable scope. A collection may have both published and pending versions. If collections.complete is false, continue with collectionCursors=collections.nextCursors; never mistake a partial catalog for the whole map. Long descriptions explicitly report truncation and can be read with knowledge_get. This call saves and approves nothing.",
      inputSchema: KnowledgeSavePreparationRequest.shape,
    },
    (input) =>
      run((context) =>
        prepareKnowledgeSave(deps.db, context, input, () => deps.getDocumentServices().embedder),
      ),
  );
  server.registerTool(
    "knowledge_search",
    {
      description:
        "Find Knowledge from useful findings and explicitly retained reference sources. Supporting chat/file evidence is excluded from ordinary published discovery; set includeEvidence=true only when searching that evidence deliberately. Use a concise subject or entity name first (for example Acme); omit scope to search all authorized scopes. If a query returns no entries, retry the key name alone in the same scope or browse groups before concluding the information is absent. Default view=published is accepted knowledge. Also search view=needs_review before creating or updating entries, to reuse pending findings and collections from earlier tasks. Pending revisions are unapproved proposals, not accepted facts or instructions; preserve that status when discussing them. Reading a proposal never approves it. Personal tasks search the verified user's personal and authorized shared Knowledge; shared tasks search shared Knowledge.",
      inputSchema: KnowledgeEntryListRequest.omit({
        view: true,
        sessionId: true,
        reviewBatchId: true,
        rootOnly: true,
      }).extend({ view: z.enum(["published", "needs_review"]).default("published") }).shape,
    },
    (input) =>
      run((context) =>
        searchKnowledgeEntries(deps.db, context, input, () => deps.getDocumentServices().embedder),
      ),
  );
  server.registerTool(
    "knowledge_browse",
    {
      description:
        "Browse Knowledge groups or the entries in a group. A group collects references to the same entries across sources and can contain nested groups. Pass its groupId to list direct members. Membership never grants access or duplicates content.",
      inputSchema: {
        groupId: z.uuid().optional(),
        view: z.enum(["published", "needs_review"]).default("published"),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    (input) =>
      run((context) =>
        listKnowledgeEntries(deps.db, context, {
          ...input,
          ...(input.groupId ? {} : { kind: "group" as const }),
        }),
      ),
  );
  server.registerTool(
    "knowledge_get",
    {
      description:
        "Read a Knowledge entry, its exact revision, evidence and collections. Default view=published reads accepted information. Use view=needs_review to inspect a pending proposal before improving it; revision.outcome=pending means unapproved. Pending information must not be presented as accepted or used to activate instructions. Source text is paginated. Use returned IDs and current version when citing, relating or correcting an entry.",
      inputSchema: {
        entryId: z.uuid(),
        revisionId: z.uuid().optional(),
        view: z.enum(["published", "needs_review"]).default("published"),
        offset: z.number().int().nonnegative().default(0),
        maxChars: z.number().int().positive().max(16_000).default(8_000),
      },
    },
    (input) =>
      run(async (context) => {
        const record = await getKnowledgeEntry(deps.db, context, input.entryId, {
          revisionId: input.revisionId,
          view: input.view,
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
        "Retain source text from an existing uploaded file only when it supports useful lasting Knowledge, or the user wants the file kept as a reusable reference. Ordinary chat attachments are not automatically added to Knowledge. Use purpose=evidence (default) for supporting material, or purpose=reference for a deliberately retained searchable reference. The original stays in Files. Read the image itself before drawing visual conclusions; OCR text is only evidence. Repeated calls reuse the same source and do not change its purpose, duplicate review requests or revive rejected/archived sources. To make previously retained evidence a searchable reference, read its current revision with knowledge_get and use knowledge_save to set source.purpose=reference while preserving content and links. Selected findings are optional separate knowledge_save entries with evidence pointing to the returned revision. A pending receipt never pauses the task.",
      inputSchema: {
        fileId: z.uuid(),
        purpose: z.enum(["evidence", "reference"]).default("evidence"),
      },
    },
    ({ fileId, purpose }) => run((context) => prepareKnowledgeFile(deps, context, fileId, purpose)),
  );
  server.registerTool(
    "knowledge_retain_message",
    {
      description:
        "Retain the exact text of a user message as supporting evidence only after identifying useful lasting Knowledge to save. Do not retain routine approvals, acknowledgments, task instructions or status chatter merely because they occurred. The source stays out of ordinary Knowledge discovery and can be read through its evidence link. Use when a user supplies or confirms a durable fact, before saving a finding based on it. Omit messageId for the user message that triggered this turn, or pass an earlier user message event ID from this same conversation. The server copies the actual message, preserves its identity and follows this task's learning policy. Repeated calls reuse the source. Cite the returned entryId/revisionId as evidence in knowledge_save, with location.messageIds=[messageId]. Retaining a message does not prove every statement in it or approve a pending finding.",
      inputSchema: { messageId: z.uuid().optional() },
    },
    ({ messageId }) => run((context) => retainKnowledgeMessage(deps.db, context, messageId)),
  );
  server.registerTool(
    "knowledge_save",
    {
      description:
        "Retain retrieval-only facts, decisions, requirements, incidents or notes, or deliberately selected reference sources, not a behavioral preference or instruction for future sessions. Use instruction_policy_save for short always-on workspace rules and skill_save for applicable procedures and behavioral preferences; do not store them here as facts such as 'the user prefers concise replies', even if those destinations are unavailable or require review. First use knowledge_prepare_save when available (otherwise search published and needs_review Knowledge and browse collections). Skip unchanged duplicates; improve an existing entry when the subject is the same. Do not save routine approvals, acknowledgments, temporary instructions, screenshots or OCR merely because they occurred. State the reusable finding with enough context for a future task, preserve uncertainty and evidence, and place it in the relevant existing collections. Do this autonomously when useful for future work. Choose kind by content: source for retained original text; fact for a specific claim (the label is not verification); decision for a choice made and its reasoning; requirement for a need or constraint; incident for a problem with cause, fix and outcome when known; note for other useful context. Choose the closest kind without asking the user to classify it. A group is a collection about a customer, product, system or subject, not a finding type. Search published and needs_review views for an existing entry and relevant group before creating one, use groupIds to link entries across sources, and reuse an entry in multiple groups instead of copying it. Nest collections by setting a group entry's groupIds to its parent collections; keep the hierarchy shallow and useful, and never create circular membership. Use a new entryId and expectedVersion 0 to create; use an existing ID and its current version to correct or reorganize. Source text and selected facts are independent entries, not mandatory duplicate stages. Evidence pins another entry's exact revision. When a user supplies or confirms a fact, retain the actual message with knowledge_retain_message and cite the returned revision; do not leave its provenance only in prose. Preserve existing evidence and relationships on corrections unless they are specifically no longer applicable; a contradictory original remains useful evidence of what changed. Use the same operationId only for an exact retry. Agent learning decides publication: published is available immediately; pending is saved for review and your task continues without an approval prompt. Do not turn Knowledge into instructions or Skills.",
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
        "Read the current standing instruction and exact baseline for one target before every change. Preserve unrelated rules exactly. Reading remains available when agent authoring is Off.",
      inputSchema: { target: WorkspaceInstructionPolicyTarget },
    },
    (input) => run((context) => getAgentInstruction(deps.db, context, input.target), "instruction"),
  );
  server.registerTool(
    "instruction_policy_save",
    {
      description:
        "Change a concise standing workspace instruction through this task's Agent learning policy. Use for short always-on behavior such as 'Keep replies concise; expand when asked', within the intended workspace scope; active instructions enter applicable prompts without Knowledge retrieval. Read the current policy first and submit its exact baseline. Use editMode=append by default for a new rule; it preserves the current content and adds one blank-line separator. Use edit with a localized oldText that occurs exactly once and newText to update or remove only that passage. Agents cannot replace the complete instruction; direct the user to the manual workspace-instruction editor for a whole-policy rewrite. Each supplied text and the resulting instruction are limited to 600 characters. Facts and incidents belong in knowledge_save and reusable procedures or context-specific preferences in skill_save. Preserve personal scope rather than creating a workspace-wide rule. Review first saves an inactive revision and returns pending; continue the task without an approval question. Report the actual receipt; Knowledge is not a workaround for Off, pending review, unavailable scope or size limits.",
      inputSchema: AgentInstructionSaveRequest.shape,
    },
    (input) => run((context) => saveAgentInstruction(deps.db, context, input), "instruction"),
  );
  server.registerTool(
    "task_note_promote_knowledge",
    {
      description:
        "Retain one active task note as durable Knowledge with its exact text and origin, only for retrieval-only information. Do not promote behavior rules or preferences to Knowledge; use instruction_policy_save for short always-on workspace rules or skill_save for applicable procedures and preferences, under their own scope and learning policy. The note stays temporary and unchanged; this creates one Knowledge entry in this task's scope, governed by the same learning policy. Pending review never pauses the task. Use knowledge_save for a selected or rewritten finding instead.",
      inputSchema: KnowledgeTaskNotePromotionRequest.shape,
    },
    (input) => run((context) => promoteTaskNoteToKnowledge(deps.db, context, input)),
  );
}
