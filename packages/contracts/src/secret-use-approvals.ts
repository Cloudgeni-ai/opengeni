import { defineSchema } from "./define-schema";
/**
 * Approval for each agent use of chosen secrets (docs/secrets.md, "Approval
 * for each use"). A person marks a vault item, or single fields of it, as
 * needing their approval. Agents still find and reference the item; the
 * resolver refuses an unapproved use before any value is read, records the
 * request and returns a ready `request_human_input` card. The host replaces
 * that card's text with its own description of the stored request, so the
 * person always sees what is really being approved, and only the person the
 * run acts for can answer it. The answer becomes a grant: one use, this chat,
 * or a time window across their chats in the workspace.
 *
 * This module must not import runtime values from `./index` (the index
 * re-exports it); only types cross that edge.
 */
import { z } from "zod";
import type { RequestHumanInputToolInput } from "./index";
import type { SecretUseSurface } from "./secret-resolution";
import { secretUseApprovalQuestionId } from "./secret-use-approval-question";

export {
  SECRET_USE_APPROVAL_QUESTION_PREFIX,
  secretUseApprovalIdFromQuestionId,
  secretUseApprovalQuestionId,
} from "./secret-use-approval-question";

export const SECRET_USE_APPROVAL_DECISIONS = ["once", "session", "window", "deny"] as const;
export type SecretUseApprovalDecision = (typeof SECRET_USE_APPROVAL_DECISIONS)[number];
export type SecretUseGrantScope = Exclude<SecretUseApprovalDecision, "deny">;

/** "Allow for 1 hour" covers the person's chats in the workspace for this long. */
export const SECRET_USE_APPROVAL_WINDOW_MS = 60 * 60 * 1000;
/** An "Allow once" grant must be used this soon after it is given. */
export const SECRET_USE_APPROVAL_ONCE_TTL_MS = 30 * 60 * 1000;

/** One item field a use needs approval for. Names only, never values. */
export type SecretUseApprovalTarget = {
  vaultId: string;
  itemId: string;
  /** The field's name key (`secretNameKey`). */
  fieldKey: string;
  vaultName: string;
  itemName: string;
  fieldName: string;
};

/** What the person is asked to approve. */
export type SecretUseApprovalRequestView = {
  id: string;
  targets: readonly SecretUseApprovalTarget[];
  surface: SecretUseSurface | string;
  toolName: string;
  destination: string | null;
};

const SURFACE_PHRASES: Record<string, (destination: string | null) => string> = {
  shell: () => "in a shell command",
  stdin: () => "as terminal input",
  file_write: () => "in a file it writes",
  secretfile: () => "as a secret file",
  view_image: () => "to view an image",
  run_on: (destination) => (destination ? `in a command on ${destination}` : "on another machine"),
  mcp: (destination) => (destination ? `in a call to ${destination}` : "in a connector call"),
  codemode: (destination) => (destination ? `in a call to ${destination}` : "in a tool call"),
  site: () => "in a Site",
  browser: (destination) => (destination ? `in the browser on ${destination}` : "in the browser"),
  desktop: () => "on the desktop",
  human_reveal: () => "to show it",
};

function targetText(target: SecretUseApprovalTarget): string {
  return target.fieldName ? `${target.itemName} › ${target.fieldName}` : target.itemName;
}

/** "GitHub › password", "GitHub › username and GitHub › password", … */
export function describeSecretUseApprovalTargets(
  targets: readonly SecretUseApprovalTarget[],
): string {
  const named = targets.slice(0, 5).map(targetText);
  const rest = targets.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length <= 1) return named[0] ?? "a secret";
  return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

export function describeSecretUseApprovalWhere(view: SecretUseApprovalRequestView): string {
  const destination = view.destination?.trim() || null;
  return (SURFACE_PHRASES[view.surface] ?? (() => `with ${view.toolName}`))(destination);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The host-owned card for one stored request. The resolver returns it to the
 * agent, and the host writes this exact question in place of whatever the
 * agent submits under the same question id.
 */
export function secretUseApprovalHumanInput(
  view: SecretUseApprovalRequestView,
): RequestHumanInputToolInput {
  const vaults = [...new Set(view.targets.map((target) => target.vaultName))];
  return {
    questions: [
      {
        id: secretUseApprovalQuestionId(view.id),
        kind: "single_select",
        label: "Allow this secret?",
        prompt: clip(
          `Allow the agent to use ${describeSecretUseApprovalTargets(view.targets)} ${describeSecretUseApprovalWhere(view)}?`,
          4096,
        ),
        helpText: clip(
          `From ${vaults.length === 1 ? `the ${vaults[0]} vault` : `the ${vaults.join(", ")} vaults`}, for ${view.toolName}. The value goes only to that use, never to the agent. Approvals can be revoked on the item's page.`,
          2048,
        ),
        skillReview: null,
        options: [
          { id: "once", label: "Allow once" },
          { id: "session", label: "Allow in this chat" },
          {
            id: "window",
            label: "Allow for 1 hour",
            description: "In any of your chats in this workspace",
          },
          { id: "deny", label: "Deny" },
        ],
        secret: null,
        required: true,
        allowOther: false,
        validation: null,
      },
    ],
    allowSkip: false,
    expiresInSeconds: null,
  };
}

/** One active grant, as shown on the item's page. */
export const SecretUseGrant = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    scope: z.enum(["once", "session", "window"]),
    sessionId: z.string().uuid(),
    /** The field names the grant covers on this item. */
    fields: z.array(z.string()),
    surface: z.string(),
    toolName: z.string(),
    destination: z.string().nullable(),
    decidedAt: z.string(),
    decidedBySubjectId: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
);
export type SecretUseGrant = z.infer<typeof SecretUseGrant>;

/** Which uses of an item need approval, and the grants in force for it. */
export const VaultItemApproval = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Every field of the item needs approval. */
    item: z.boolean(),
    /** Field names that need approval on their own. */
    fields: z.array(z.string()),
    grants: z.array(SecretUseGrant),
    /**
     * The caller may change the marks freely and revoke approvals: a signed-in
     * person with secrets:write. Others with secrets:write (agents, API keys)
     * may only add marks; see `canAddMarks`.
     */
    canChange: z.boolean(),
    /** The caller may add marks (secrets:write); only `canChange` callers may lift them. */
    canAddMarks: z.boolean(),
    /**
     * Set on the answer to a change: whether the marks are now different from
     * before it. False when the request matched the marks already in force.
     */
    changed: z.boolean().optional(),
  }),
);
export type VaultItemApproval = z.infer<typeof VaultItemApproval>;

export const SetVaultItemApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      item: z.boolean(),
      fields: z.array(z.string().min(1).max(200)).max(100).default([]),
    })
    .strict(),
);
export type SetVaultItemApprovalRequest = z.infer<typeof SetVaultItemApprovalRequest>;
