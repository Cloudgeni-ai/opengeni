import type { SendMessageInput } from "../client";
import type {
  DraftTimelineAnnotation,
  McpConnectionAuthoritySelection,
  PersonalResourceAttachmentIntent,
  ResourceRef,
  SessionEvent,
  SessionMcpCredentialUpdateInput,
} from "../types";

export const FILE_ONLY_MESSAGE_TEXT = "(see attached context)";

/** Legacy presentation policy retained for pure keyboard-routing compatibility. */
export type ComposerPolicy = Readonly<{
  canSend: boolean;
  canSteer: boolean;
  blockedReason: string | null;
  waitingForDecision: boolean;
}>;

/** Legacy durable-submit extras retained as a source-compatible public type. */
export type ComposerSendExtras = Readonly<{
  annotations?: DraftTimelineAnnotation[] | undefined;
  resources?: ResourceRef[] | undefined;
  modelContext?: string | undefined;
  mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[] | undefined;
  connectionAuthorities?: McpConnectionAuthoritySelection[] | undefined;
  personalResourceAttachment?: PersonalResourceAttachmentIntent | undefined;
  controlEtag?: string | undefined;
}>;

/** Exact non-authoritative extras accepted by the React-compatible message composer. */
export type SessionComposerSendExtras = Omit<
  SendMessageInput,
  "text" | "clientEventId" | "annotations" | "model" | "reasoningEffort" | "latencyMode"
>;

export function composeSendInput(text: string, resources: readonly ResourceRef[]): string {
  return text.trim() || (resources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
}

export function shouldSubmitOnKey(event: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function shouldSteerOnKey(
  event: { key: string; shiftKey?: boolean; isComposing?: boolean },
  policy: ComposerPolicy,
): boolean {
  return shouldSubmitOnKey(event) && policy.canSteer && !policy.canSend;
}

/** Events that can atomically replace or clear an actor's durable composer draft. */
export function isComposerDraftEvent(event: Pick<SessionEvent, "type">): boolean {
  return event.type === "user.message" || event.type === "session.queue.changed";
}

/** Resolve possibly deferred React-compatible send extras at the moment of submission. */
export function resolveSessionComposerSendExtras(
  extras: SessionComposerSendExtras | (() => SessionComposerSendExtras) | undefined,
): SessionComposerSendExtras {
  return (typeof extras === "function" ? extras() : extras) ?? {};
}

/** Merge host extras under composer-owned wire fields and the exact idempotency key. */
export function composeSessionMessageInput(
  text: string,
  clientEventId: string,
  extras: SessionComposerSendExtras | (() => SessionComposerSendExtras) | undefined,
  bound: Partial<SendMessageInput> = {},
): SendMessageInput {
  return {
    ...resolveSessionComposerSendExtras(extras),
    ...bound,
    text,
    clientEventId,
  };
}

/** Plain Enter submits; Shift+Enter and IME composition remain editing operations. */
export function shouldSubmitSessionComposerOnKey(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return event.key === "Enter" && !event.shiftKey && event.nativeEvent?.isComposing !== true;
}

/** Cmd/Ctrl+Enter selects Steer; ordinary Enter retains queue/send placement. */
export function shouldSteerSessionComposerOnKey(event: {
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return event.metaKey === true || event.ctrlKey === true;
}
