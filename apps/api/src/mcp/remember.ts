import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_REMEMBER_CONTENT_TOO_LONG_MESSAGE,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  REMEMBER_CONTENT_MAX_CHARS,
  WorkspaceInstructionPolicyTarget,
  agentAuthoredDurableTextTooLongMessage,
  type CompanyBrainGovernedWriteAttempt,
  type RememberLane,
} from "@opengeni/contracts";
import { RememberError, createRememberRouter } from "@opengeni/core";
import { PreferenceRegistryStableKeyConflictError, type Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

export type RegisterRememberToolsInput = {
  server: McpServer;
  db: Database;
  attempt: CompanyBrainGovernedWriteAttempt;
  authorize: () => Promise<void>;
  json: JsonResult;
  router?: Pick<ReturnType<typeof createRememberRouter>, "remember" | "confirm">;
};

/**
 * Per-lane budgets. The flat MCP input schema cannot vary `content` by lane, so
 * it carries the widest lane (Knowledge) and the handler rejects an over-budget
 * prompt-composed lane with the actionable message before anything durable is
 * written. The contract enforces the same bounds for every other caller.
 */
const laneContentMaxChars: Record<RememberLane, number> = {
  instruction_policy: AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  preference: AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  knowledge: REMEMBER_CONTENT_MAX_CHARS,
};

const laneFields = {
  operationId: z.string().uuid(),
  content: z
    .string()
    .trim()
    .min(1)
    // The widest lane, because one flat schema serves all three. Carry the
    // lane-aware guidance in the message so an over-long rule is not refused
    // with a generic bound that points at the wrong number.
    .max(REMEMBER_CONTENT_MAX_CHARS, AGENT_AUTHORED_REMEMBER_CONTENT_TOO_LONG_MESSAGE)
    .describe(
      `The exact thing to remember, in the user's words. Budgets by lane: instruction_policy at most ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters because it is composed into the prompt of every session it applies to, preference at most ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} (its short descriptor is what is composed; the content is retrieved on demand), knowledge at most ${REMEMBER_CONTENT_MAX_CHARS}.`,
    ),
  reason: z.string().trim().min(1).max(4_096),
};

/**
 * Explicit user-directed remember. Content becomes exact task-note evidence,
 * promotion runs through the frozen workspace learning policy, and activation
 * is either automatic (Skill or instruction under Automatic mode) or requires exactly one
 * bound human confirmation through the built-in `request_human_input` tool.
 * Tool input cannot select scope beyond the workspace, active authority, or
 * another learning-policy source.
 */
export function registerRememberTools(input: RegisterRememberToolsInput): void {
  const router = input.router ?? createRememberRouter({ db: input.db });
  input.server.registerTool(
    "remember",
    {
      description:
        "Create governed durable knowledge, a Skill, or a mandatory workspace instruction. When the agent-only memory_save tool is available, use it instead for ordinary durable facts, decisions, incidents, bug fixes, and confirmed outcomes; those Memory writes are autonomous and independent of Learning mode. Use lane=knowledge only when memory_save is unavailable and the user explicitly requests reviewed workspace knowledge; lane=preference creates a Skill for reusable conditional how-to guidance; lane=instruction_policy is only for a universal always/never rule that should apply to nearly every task. " +
        `Write the instruction lane as the shortest complete rule, at most ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters and normally 1-3 imperative sentences, with no numbered steps, examples, rationale, or restated defaults. Keep a Skill under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters with one clear trigger and outcome, only the necessary steps, checks, and exceptions, and a one-sentence descriptor. Do not copy one item into multiple lanes. ` +
        "Under Autonomous learning, an eligible Skill or workspace instruction may activate immediately through its governed lifecycle. Under Require approval, it remains inactive and the receipt returns status=confirmation_required with the exact `humanInput` payload: call `request_human_input` with it verbatim, then call `remember_confirm` with the returned requestId. Off creates no governed change. Reviewed Knowledge always needs confirmation. Do not use lane=knowledge for facts you merely inferred; use memory_save when available, otherwise knowledge_propose or task notes. Confirmed lane=knowledge content keeps its reviewed claim provenance and materializes its exact approved text into Memory for later `memory_search` retrieval.",
      inputSchema: {
        lane: z.enum(["preference", "instruction_policy", "knowledge"]),
        ...laneFields,
        stableKey: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/)
          .optional(),
        title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS).optional(),
        description: z
          .string()
          .trim()
          .min(1)
          .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS)
          .optional(),
        target: WorkspaceInstructionPolicyTarget.optional(),
        subject: z.string().trim().min(1).max(512).optional(),
      },
    },
    async (request) => {
      await input.authorize();
      const { lane, operationId, content, reason } = request;
      if (lane !== "knowledge" && content.length > laneContentMaxChars[lane]) {
        return input.json({
          status: "not_remembered",
          code: "content_too_long",
          message: agentAuthoredDurableTextTooLongMessage({
            kind: lane,
            actualChars: content.length,
          }),
        });
      }
      const base = { operationId, content, reason, scope: "workspace" as const };
      const rememberRequest =
        lane === "preference"
          ? {
              ...base,
              lane,
              stableKey: request.stableKey ?? `remember.${operationId.replaceAll("-", "")}`,
              title: request.title ?? content.slice(0, 80),
              description: request.description ?? content.slice(0, 200),
            }
          : lane === "instruction_policy"
            ? { ...base, lane, target: request.target }
            : { ...base, lane, subject: request.subject ?? content.slice(0, 80) };
      try {
        return input.json(
          await router.remember({ attempt: input.attempt, request: rememberRequest }),
        );
      } catch (error) {
        if (error instanceof PreferenceRegistryStableKeyConflictError) {
          return input.json({
            status: "not_remembered",
            code: "preference_stable_key_conflict",
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  input.server.registerTool(
    "remember_confirm",
    {
      description:
        "Complete a `remember` that returned status=confirmation_required after the human answered the bound `request_human_input` question. For preference/instruction_policy pass proposalId and learning.receiptId (as decisionReceiptId) from that receipt; for knowledge pass claimId. Always pass the requestId returned by request_human_input. Activation only succeeds when the exact initiating human answered Save on this turn; confirmed knowledge is materialized into searchable Memory from the exact approved text.",
      inputSchema: {
        operationId: z.string().uuid(),
        proposalId: z.string().uuid().optional(),
        decisionReceiptId: z.string().uuid().optional(),
        claimId: z.string().uuid().optional(),
        humanInputRequestId: z.string().uuid(),
      },
    },
    async (request) => {
      await input.authorize();
      const confirmRequest =
        request.proposalId && request.decisionReceiptId
          ? {
              target: "proposal" as const,
              operationId: request.operationId,
              proposalId: request.proposalId,
              decisionReceiptId: request.decisionReceiptId,
              humanInputRequestId: request.humanInputRequestId,
            }
          : request.claimId
            ? {
                target: "knowledge_claim" as const,
                operationId: request.operationId,
                claimId: request.claimId,
                humanInputRequestId: request.humanInputRequestId,
              }
            : null;
      if (!confirmRequest) {
        return input.json({
          status: "not_confirmed",
          code: "invalid_target",
          message:
            "Pass proposalId + decisionReceiptId (preference/instruction_policy) or claimId (knowledge).",
        });
      }
      try {
        return input.json(
          await router.confirm({ attempt: input.attempt, request: confirmRequest }),
        );
      } catch (error) {
        if (error instanceof RememberError) {
          return input.json({ status: "not_confirmed", code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
