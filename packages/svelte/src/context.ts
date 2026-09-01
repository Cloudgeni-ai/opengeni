import type {
  FileAttachmentClientLike,
  GoalClientLike,
  HumanInputSessionClientLike,
  SessionClientLike,
  SessionLineageClientLike,
  SessionMcpApprovalPolicyClientLike,
  SessionReadClientLike,
} from "@opengeni/sdk/session";
import { getContext, setContext } from "svelte";

const CONTEXT_KEY = Symbol.for("@opengeni/svelte/context");

export type OpenGeniSvelteContext = Readonly<{
  client: SessionClientLike;
  workspaceId: string;
  sessionClient?: SessionReadClientLike | undefined;
  goalClient?: GoalClientLike | undefined;
  lineageClient?: SessionLineageClientLike | undefined;
  humanInputClient?: HumanInputSessionClientLike | undefined;
  mcpApprovalPolicyClient?: SessionMcpApprovalPolicyClientLike | undefined;
  fileAttachmentClient?: FileAttachmentClientLike | undefined;
}>;

/** Install one immutable authority snapshot for the current component subtree. */
export function setOpenGeniContext(context: OpenGeniSvelteContext): OpenGeniSvelteContext {
  setContext(CONTEXT_KEY, context);
  return context;
}

export function getOpenGeniContext(): OpenGeniSvelteContext {
  const context = getContext<OpenGeniSvelteContext | undefined>(CONTEXT_KEY);
  if (!context) throw new Error("@opengeni/svelte: OpenGeni context is not available");
  return context;
}
