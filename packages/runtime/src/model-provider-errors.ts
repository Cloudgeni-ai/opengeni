export class WorkspaceGatewayUnavailableError extends Error {
  constructor() {
    super(
      "Your Gateway model is unavailable: connect or reconnect the workspace AI Gateway key in Settings, then retry.",
    );
    this.name = "WorkspaceGatewayUnavailableError";
  }
}

export class WorkspaceOpenRouterUnavailableError extends Error {
  constructor() {
    super(
      "Your OpenRouter model is unavailable: connect or reconnect the workspace OpenRouter key in Settings, then retry.",
    );
    this.name = "WorkspaceOpenRouterUnavailableError";
  }
}

export const UNKNOWN_MODEL_FINISH_REASON_CODE = "provider_unknown_finish_reason";

/**
 * A Chat Completions provider emitted a syntactically valid terminal chunk but
 * labelled the stop reason as unknown. Treating that as ordinary completion can
 * commit a truncated answer. The model adapter throws before `response_done`,
 * so tools are not executed and the worker can recover the same accepted turn
 * from durable history instead of accepting ambiguous output as final.
 */
export class UnknownModelFinishReasonError extends Error {
  readonly code = UNKNOWN_MODEL_FINISH_REASON_CODE;

  constructor() {
    super("The model provider ended its response with an unknown finish reason");
    this.name = "UnknownModelFinishReasonError";
  }
}

/**
 * A `codex/<slug>` turn reached the model router but the workspace has no active
 * Codex subscription connected (the worker overlay never injected the synthetic
 * provider, so resolveTurnModel returned nothing). Thrown instead of silently
 * routing the id to the built-in Azure/OpenAI client — that produced an opaque
 * "DeploymentNotFound" 404. The message is user-actionable (connect/reconnect)
 * and carries no status/code, so agentRunFailurePayload surfaces it verbatim as
 * a non-retryable turn.failed the session UI shows.
 */
export class CodexSubscriptionUnavailableError extends Error {
  constructor(modelName: string) {
    super(
      `Codex subscription model "${modelName}" is unavailable: no active Codex subscription is connected for this workspace. ` +
        `Connect (or reconnect) your ChatGPT/Codex subscription in Settings, then retry.`,
    );
    this.name = "CodexSubscriptionUnavailableError";
  }
}

/**
 * A `supergrok/<slug>` turn reached model routing without the workspace's
 * synthetic xAI subscription provider. Refuse the built-in fallback so the
 * internal namespace can never become an Azure/OpenAI deployment name.
 */
export class XaiSubscriptionUnavailableError extends Error {
  constructor(modelName: string) {
    super(
      `SuperGrok subscription model "${modelName}" is unavailable: no active xAI/SuperGrok subscription is connected for this workspace. ` +
        `Connect (or reconnect) a SuperGrok subscription in Settings, then retry.`,
    );
    this.name = "XaiSubscriptionUnavailableError";
  }
}

/**
 * The workspace's model policy blocks the provider/model this turn resolved
 * to. Thrown at the worker's post-resolution gate INSTEAD of running the turn
 * on the blocked provider — a policy-restricted workspace (e.g. fail-closed to
 * the Codex subscription) must never silently remap to, or fall through to,
 * the paid built-in client. Like CodexSubscriptionUnavailableError the message
 * is user-actionable and surfaces verbatim as a non-retryable turn.failed.
 */
export class WorkspaceModelPolicyBlockedError extends Error {
  constructor(modelName: string, providerId: string, reason: "provider" | "model") {
    super(
      reason === "provider"
        ? `Model "${modelName}" is not available in this workspace: its provider ("${providerId}") is not in the workspace's allowed providers. ` +
            `Pick an allowed model, or ask a workspace admin to change the workspace model policy.`
        : `Model "${modelName}" is not in this workspace's allowed models. ` +
            `Pick an allowed model, or ask a workspace admin to change the workspace model policy.`,
    );
    this.name = "WorkspaceModelPolicyBlockedError";
  }
}
