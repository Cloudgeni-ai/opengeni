import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
  AGENT_AUTHORED_INSTRUCTION_POLICY_STYLE,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
  AGENT_AUTHORED_SKILL_STYLE,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  WorkspaceInstructionPolicyTarget,
  type CompanyBrainGovernedWriteAttempt,
} from "@opengeni/contracts";
import { createCompanyBrainLearningPolicyRouter } from "@opengeni/core";
import { PreferenceRegistryStableKeyConflictError, type Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

const reason = z.string().trim().min(1).max(4_096);
const evidence = {
  operationId: z.string().uuid(),
  claimId: z.string().uuid(),
  evidenceId: z.string().uuid(),
};
const taskNotePromotion = {
  operationId: z.string().uuid(),
  noteId: z.string().uuid(),
  expectedNoteVersion: z.literal(1),
  entityType: z
    .string()
    .trim()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
  normalizedKey: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(512),
  predicateKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
  confidenceBps: z.number().int().min(0).max(10_000),
  reason,
};

export type RegisterCompanyBrainGovernedWriteToolsInput = {
  server: McpServer;
  db: Database;
  attempt: CompanyBrainGovernedWriteAttempt;
  authorize: () => Promise<void>;
  json: JsonResult;
  router?: Pick<ReturnType<typeof createCompanyBrainLearningPolicyRouter>, "write">;
};

/**
 * Register explicit proposal-only Company Brain tools. The signed host attempt
 * owns tenant/session authority and the exact evidence id owns the learning
 * policy source override. Tool input cannot select scope, active authority, or
 * another policy source.
 */
export function registerCompanyBrainGovernedWriteTools(
  input: RegisterCompanyBrainGovernedWriteToolsInput,
): void {
  const router = input.router ?? createCompanyBrainLearningPolicyRouter({ db: input.db });
  const writeResult = async (write: () => ReturnType<typeof router.write>) => {
    try {
      return input.json(await write());
    } catch (error) {
      if (error instanceof PreferenceRegistryStableKeyConflictError) {
        return input.json({
          status: "not_proposed",
          code: "preference_stable_key_conflict",
          message: error.message,
        });
      }
      throw error;
    }
  };
  input.server.registerTool(
    "knowledge_propose",
    {
      description:
        "Propose one existing evidence-backed workspace Knowledge claim through the frozen learning policy. Off creates nothing; Suggest and Automatic both create a proposal that only the human Knowledge review lifecycle can accept.",
      inputSchema: { ...evidence, reason },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "propose_knowledge", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "knowledge_correct",
    {
      description:
        "Propose an evidence-backed replacement for another workspace Knowledge claim. The old claim remains in immutable history and the correction never widens scope.",
      inputSchema: { ...evidence, replacesClaimId: z.string().uuid(), reason },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "correct_knowledge", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "task_note_promote_knowledge",
    {
      description:
        "Promote one still-active note from this exact root task tree into a normalized workspace Knowledge proposal. The immutable note bytes remain source evidence; this never activates the claim or widens it to personal/organization scope.",
      inputSchema: taskNotePromotion,
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "promote_task_note_knowledge", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "task_note_promote_instruction_policy",
    {
      description:
        "Atomically promote one still-active note from this exact root task tree into a workspace instruction-policy proposal. The note bytes remain exact evidence and draft content. " +
        `Use this only for a universal always-on rule, never for an incident, fact, decision, outcome, or conditional procedure. Once active, those bytes are composed verbatim into the prompt of every session the target applies to, so a note over ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters is rejected here rather than truncated: write a fresh minimal imperative note instead of promoting a long working note. ` +
        "Off creates nothing; Require approval keeps the proposal inactive; Autonomous may activate an eligible proposal through the governed instruction lifecycle with an undoable receipt. This never widens scope.",
      inputSchema: {
        ...taskNotePromotion,
        target: WorkspaceInstructionPolicyTarget,
        expectedCurrentRevisionId: z.string().uuid().nullable(),
        expectedActivationVersion: z.number().int().nonnegative(),
      },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "promote_task_note_instruction_policy", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "task_note_promote_preference",
    {
      description:
        "Atomically promote one still-active note from this exact root task tree into a workspace Skill proposal backed by the structured preference authority. Use this for reusable conditional how-to guidance, never for an incident, fact, decision, outcome, or universal always-on rule. The note bytes remain exact evidence and full proposal content. " +
        `The title and description you supply are what gets composed into every session prompt, so write them as one short imperative statement; the note content is retrieved on demand and a note over ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters is rejected here rather than truncated. ` +
        "Under Suggest the proposal waits for human review; under Automatic an eligible decision is activated through the preference lifecycle and remains undoable. This never widens scope.",
      inputSchema: {
        ...taskNotePromotion,
        stableKey: z.string().trim().min(1).max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
        title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
        description: z
          .string()
          .trim()
          .min(1)
          .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
        precedenceRank: z.number().int().min(-1_000).max(1_000).optional().default(0),
        conflictStrategy: z
          .enum(["override", "merge", "reject", "inform"])
          .optional()
          .default("override"),
        conflictsWith: z.array(z.string().min(1)).max(32).optional().default([]),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
      },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "promote_task_note_preference", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "instruction_policy_propose",
    {
      description:
        "Materialize an evidence-backed workspace instruction-policy proposal. " +
        `Use this only for a minimal universal rule, never for an incident, fact, decision, outcome, or conditional procedure. Once active, this content is composed verbatim into the prompt of every session the target applies to (every session in this workspace for a global charter or policy, every session bound to the role for a role policy), so keep it under ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters. ${AGENT_AUTHORED_INSTRUCTION_POLICY_STYLE} ` +
        "Off creates nothing; Require approval keeps the proposal inactive; Autonomous may activate an eligible proposal through the governed instruction lifecycle with an undoable receipt.",
      inputSchema: {
        ...evidence,
        target: WorkspaceInstructionPolicyTarget,
        content: z
          .string()
          .trim()
          .min(1)
          .max(
            AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
            AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
          ),
        expectedCurrentRevisionId: z.string().uuid().nullable(),
        expectedActivationVersion: z.number().int().nonnegative(),
        reason,
      },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "propose_instruction_policy", ...request },
        }),
      );
    },
  );

  input.server.registerTool(
    "preference_propose",
    {
      description:
        "Materialize an evidence-backed workspace Skill proposal in the structured preference authority. Use this only for reusable conditional how-to guidance, never for an incident, fact, decision, outcome, or universal always-on rule. " +
        `Its short title and description are what get composed into every session prompt; the content is retrieved on demand, so its length is retrieval cost rather than standing prompt cost. Keep the content under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters. ${AGENT_AUTHORED_SKILL_STYLE} ` +
        "Under Suggest it stays inactive for human review; under Automatic an eligible decision is activated through the governed preference lifecycle with an undoable receipt. It never creates mandatory authority.",
      inputSchema: {
        ...evidence,
        stableKey: z.string().trim().min(1).max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
        title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
        description: z
          .string()
          .trim()
          .min(1)
          .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
        content: z
          .string()
          .trim()
          .min(1)
          .max(
            AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
            AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
          ),
        precedenceRank: z.number().int().min(-1_000).max(1_000).optional().default(0),
        conflictStrategy: z
          .enum(["override", "merge", "reject", "inform"])
          .optional()
          .default("override"),
        conflictsWith: z.array(z.string().min(1)).max(32).optional().default([]),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
        reason,
      },
    },
    async (request) => {
      await input.authorize();
      return writeResult(() =>
        router.write({
          attempt: input.attempt,
          request: { kind: "propose_preference", ...request },
        }),
      );
    },
  );
}
