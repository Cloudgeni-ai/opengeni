import { z } from "zod";

export const SLACK_TASK_POLICY_ID_MAX_CHARS = 128;
export const SLACK_TASK_POLICY_REASON_MAX_CHARS = 4_096;
export const SLACK_TASK_POLICY_MAX_IDS = 256;

const SlackOpaqueId = z.string().min(1).max(SLACK_TASK_POLICY_ID_MAX_CHARS);

export const SlackSharedConversationMode = z.enum(["deny", "private_handoff"]);
export type SlackSharedConversationMode = z.infer<typeof SlackSharedConversationMode>;

export const SlackResultPublicationMode = z.enum(["never", "approval_required", "allow"]);
export type SlackResultPublicationMode = z.infer<typeof SlackResultPublicationMode>;

function uniqueSortedIds(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export const SlackTaskPolicyContent = z
  .object({
    allowedTeamIds: z
      .array(SlackOpaqueId)
      .max(SLACK_TASK_POLICY_MAX_IDS)
      .transform(uniqueSortedIds),
    allowedConversationIds: z
      .array(SlackOpaqueId)
      .max(SLACK_TASK_POLICY_MAX_IDS)
      .transform(uniqueSortedIds),
    allowGuestInitiators: z.boolean(),
    allowExternalInitiators: z.boolean(),
    allowMpim: z.boolean(),
    sharedConversationMode: SlackSharedConversationMode,
    resultPublicationMode: SlackResultPublicationMode,
  })
  .strict();
export type SlackTaskPolicyContent = z.infer<typeof SlackTaskPolicyContent>;

export const DEFAULT_SLACK_TASK_POLICY: SlackTaskPolicyContent = Object.freeze({
  allowedTeamIds: [],
  allowedConversationIds: [],
  allowGuestInitiators: false,
  allowExternalInitiators: false,
  allowMpim: false,
  sharedConversationMode: "deny",
  resultPublicationMode: "never",
});

export function canonicalizeSlackTaskPolicy(value: SlackTaskPolicyContent): SlackTaskPolicyContent {
  const parsed = SlackTaskPolicyContent.parse(value);
  return {
    allowedTeamIds: parsed.allowedTeamIds,
    allowedConversationIds: parsed.allowedConversationIds,
    allowGuestInitiators: parsed.allowGuestInitiators,
    allowExternalInitiators: parsed.allowExternalInitiators,
    allowMpim: parsed.allowMpim,
    sharedConversationMode: parsed.sharedConversationMode,
    resultPublicationMode: parsed.resultPublicationMode,
  };
}

export const SlackTaskPolicyRevisionIdentity = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SlackTaskPolicyRevisionIdentity = z.infer<typeof SlackTaskPolicyRevisionIdentity>;

export const SlackTaskPolicyRevision = SlackTaskPolicyRevisionIdentity.extend({
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  policy: SlackTaskPolicyContent,
  supersedesRevisionId: z.string().uuid().nullable(),
  createdBySubjectId: z.string().min(1).max(1_024),
  createdAt: z.string().datetime(),
});
export type SlackTaskPolicyRevision = z.infer<typeof SlackTaskPolicyRevision>;

export const SlackTaskPolicyHead = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  activationVersion: z.number().int().positive(),
  activatedAt: z.string().datetime(),
});
export type SlackTaskPolicyHead = z.infer<typeof SlackTaskPolicyHead>;

export const SlackTaskPolicyActivationEvent = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  activationVersion: z.number().int().positive(),
  oldRevision: SlackTaskPolicyRevisionIdentity.nullable(),
  newRevision: SlackTaskPolicyRevisionIdentity,
  actorSubjectId: z.string().min(1).max(1_024),
  reason: z.string().min(1).max(SLACK_TASK_POLICY_REASON_MAX_CHARS),
  createdAt: z.string().datetime(),
});
export type SlackTaskPolicyActivationEvent = z.infer<typeof SlackTaskPolicyActivationEvent>;

export const SlackTaskPolicyListResponse = z.object({
  current: SlackTaskPolicyHead.nullable(),
  activeRevision: SlackTaskPolicyRevision.nullable(),
  revisions: z.array(SlackTaskPolicyRevision),
  activationEvents: z.array(SlackTaskPolicyActivationEvent),
});
export type SlackTaskPolicyListResponse = z.infer<typeof SlackTaskPolicyListResponse>;

export const UpdateSlackTaskPolicyRequest = z.object({
  operationId: z.string().uuid().optional(),
  policy: SlackTaskPolicyContent,
  expectedCurrentRevisionId: z.string().uuid().nullable(),
  expectedActivationVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(SLACK_TASK_POLICY_REASON_MAX_CHARS),
});
export type UpdateSlackTaskPolicyRequest = z.infer<typeof UpdateSlackTaskPolicyRequest>;

export const SlackTaskPolicyMutationResponse = z.object({
  revision: SlackTaskPolicyRevision,
  head: SlackTaskPolicyHead,
  event: SlackTaskPolicyActivationEvent,
});
export type SlackTaskPolicyMutationResponse = z.infer<typeof SlackTaskPolicyMutationResponse>;

export type SlackTaskPolicyConversationFacts = Readonly<{
  installationTeamId: string;
  conversationId: string;
  contextTeamId: string | null;
  connectedTeamIds: readonly string[] | null;
  sharedTeamIds: readonly string[] | null;
  isShared: boolean;
  isExternallyShared: boolean;
  isOrgShared: boolean;
  isPendingExternallyShared: boolean;
  isMpim: boolean;
}>;

export type SlackTaskPolicyInitiatorFacts = Readonly<{
  teamId: string | null;
  isGuest: boolean | null;
  isExternal: boolean | null;
}>;

export type SlackTaskPolicyDecision = Readonly<{
  disposition: "ordinary" | "deny" | "private_handoff";
  publication: SlackResultPublicationMode;
  reason:
    | "ordinary_conversation"
    | "policy_missing"
    | "conversation_not_allowed"
    | "team_not_allowed"
    | "ambiguous_shared_facts"
    | "mpim_not_allowed"
    | "guest_not_allowed"
    | "external_not_allowed"
    | "allowed";
}>;

export function evaluateSlackTaskPolicy(input: {
  policy: SlackTaskPolicyContent | null;
  conversation: SlackTaskPolicyConversationFacts;
  initiator: SlackTaskPolicyInitiatorFacts;
}): SlackTaskPolicyDecision {
  const { conversation, initiator } = input;
  const governed =
    conversation.isShared ||
    conversation.isExternallyShared ||
    conversation.isOrgShared ||
    conversation.isPendingExternallyShared ||
    conversation.isMpim;
  if (!governed) {
    return { disposition: "ordinary", publication: "allow", reason: "ordinary_conversation" };
  }
  if (!input.policy) return { disposition: "deny", publication: "never", reason: "policy_missing" };
  const policy = canonicalizeSlackTaskPolicy(input.policy);
  if (!policy.allowedConversationIds.includes(conversation.conversationId)) {
    return { disposition: "deny", publication: "never", reason: "conversation_not_allowed" };
  }
  if (conversation.isMpim && !policy.allowMpim) {
    return { disposition: "deny", publication: "never", reason: "mpim_not_allowed" };
  }
  if (initiator.isGuest === null || initiator.isExternal === null || initiator.teamId === null) {
    return { disposition: "deny", publication: "never", reason: "ambiguous_shared_facts" };
  }
  if (initiator.isGuest && !policy.allowGuestInitiators) {
    return { disposition: "deny", publication: "never", reason: "guest_not_allowed" };
  }
  if (initiator.isExternal && !policy.allowExternalInitiators) {
    return { disposition: "deny", publication: "never", reason: "external_not_allowed" };
  }
  const teams = [
    conversation.installationTeamId,
    conversation.contextTeamId,
    initiator.teamId,
    ...(conversation.connectedTeamIds ?? []),
    ...(conversation.sharedTeamIds ?? []),
  ];
  if (conversation.connectedTeamIds === null || conversation.sharedTeamIds === null) {
    return { disposition: "deny", publication: "never", reason: "ambiguous_shared_facts" };
  }
  if (teams.some((teamId) => teamId === null || !policy.allowedTeamIds.includes(teamId))) {
    return { disposition: "deny", publication: "never", reason: "team_not_allowed" };
  }
  if (policy.sharedConversationMode === "deny") {
    return { disposition: "deny", publication: "never", reason: "allowed" };
  }
  return {
    disposition: "private_handoff",
    publication: policy.resultPublicationMode,
    reason: "allowed",
  };
}
