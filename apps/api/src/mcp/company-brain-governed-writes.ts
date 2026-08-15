import {
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  WorkspaceInstructionPolicyTarget,
  type CompanyBrainGovernedWriteAttempt,
} from "@opengeni/contracts";
import { createCompanyBrainLearningPolicyRouter } from "@opengeni/core";
import type { Database } from "@opengeni/db";
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
  input.server.registerTool(
    "knowledge_propose",
    {
      description:
        "Propose one existing evidence-backed workspace Knowledge claim through the frozen learning policy. Off creates nothing; Review creates an inactive proposal; Automatic requests destination-owned activation without bypassing review authority.",
      inputSchema: { ...evidence, reason },
    },
    async (request) => {
      await input.authorize();
      return input.json(
        await router.write({
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
      return input.json(
        await router.write({
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
      return input.json(
        await router.write({
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
        "Atomically promote one still-active note from this exact root task tree into an inactive workspace instruction-policy draft. The note bytes remain exact evidence and draft content; this never activates mandatory behavior or widens scope.",
      inputSchema: {
        ...taskNotePromotion,
        target: WorkspaceInstructionPolicyTarget,
        expectedCurrentRevisionId: z.string().uuid().nullable(),
        expectedActivationVersion: z.number().int().nonnegative(),
      },
    },
    async (request) => {
      await input.authorize();
      return input.json(
        await router.write({
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
        "Atomically promote one still-active note from this exact root task tree into an inactive workspace preference proposal. The note bytes remain exact evidence and full proposal content; this never activates behavior or widens scope.",
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
      return input.json(
        await router.write({
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
        "Materialize an evidence-backed inactive workspace instruction-policy draft. This tool cannot activate mandatory behavior, including when learning mode is Automatic.",
      inputSchema: {
        ...evidence,
        target: WorkspaceInstructionPolicyTarget,
        content: z.string().trim().min(1).max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS),
        expectedCurrentRevisionId: z.string().uuid().nullable(),
        expectedActivationVersion: z.number().int().nonnegative(),
        reason,
      },
    },
    async (request) => {
      await input.authorize();
      return input.json(
        await router.write({
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
        "Materialize an evidence-backed inactive workspace preference proposal. This tool cannot silently create active behavioral authority.",
      inputSchema: {
        ...evidence,
        stableKey: z.string().trim().min(1).max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
        title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
        description: z
          .string()
          .trim()
          .min(1)
          .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
        content: z.string().trim().min(1).max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS),
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
      return input.json(
        await router.write({
          attempt: input.attempt,
          request: { kind: "propose_preference", ...request },
        }),
      );
    },
  );
}
