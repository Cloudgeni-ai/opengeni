import type { ConnectorActionPolicyHooks, ConnectorActionToolCall } from "@opengeni/runtime";

export const REPOSITORY_ATTACH_TOOL_NAME = "github_repository_attach";

const FACT_VALUE_LIMIT = 256;

function factValue(value: string): string {
  if (value.length <= FACT_VALUE_LIMIT) return value;
  let cut = "";
  for (const point of value) {
    if (cut.length + point.length > FACT_VALUE_LIMIT - 1) break;
    cut += point;
  }
  return `${cut.trimEnd()}…`;
}

/** The repository and branch a call names, as the card shows them. */
export function repositoryAttachRequest(
  call: Pick<ConnectorActionToolCall, "arguments">,
): { repository: string; ref: string | null } | null {
  const args =
    call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? (call.arguments as Record<string, unknown>)
      : null;
  const repository = typeof args?.repository === "string" ? args.repository.trim() : "";
  if (!repository) return null;
  const ref = typeof args?.ref === "string" && args.ref.trim() ? args.ref.trim() : null;
  return { repository, ref };
}

/**
 * The github.com clone URI of the repository a call names (`owner/name` or a
 * github.com URL), to match it against the chat's removal records; null when
 * it names no repository that way.
 */
export function githubRepositoryAttachUri(repository: string): string | null {
  const fullName = repository
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//iu, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)
    ? `https://github.com/${fullName}.git`
    : null;
}

type Outcome = { kind: "block" } | { kind: "ask"; removedEarlier: boolean };

/**
 * Every `github_repository_attach` call waits for a person's approval in the
 * chat, through the ordinary approval card (in the app, and in a Slack
 * thread for a chat started there). Where nobody can answer (a scheduled or
 * unattended run, or a worker of one), the call is refused instead, so an
 * agent never widens a chat's repositories on its own. Every other call
 * passes through untouched.
 *
 * The card names the repository, the branch and the access it uses, and
 * says when a person removed the repository from this chat earlier: approving
 * attaches it again. One call keeps its first decision within an attempt.
 */
export function withRepositoryAttachApproval(
  policy: ConnectorActionPolicyHooks,
  chat: {
    /** Whether a person can answer here; read at the first attach, once per attempt. */
    interactive: boolean | (() => Promise<boolean>);
    /** Whether a person removed this repository from the chat earlier. A failed read omits the note. */
    removedEarlier: (repository: string) => Promise<boolean>;
  },
): ConnectorActionPolicyHooks {
  let interactive: Promise<boolean> | undefined;
  const hasPerson = () =>
    (interactive ??=
      typeof chat.interactive === "boolean"
        ? Promise.resolve(chat.interactive)
        : chat.interactive().catch(() => true));
  const decided = new Map<string, Promise<Outcome>>();
  const outcome = (call: ConnectorActionToolCall): Promise<Outcome> => {
    let pending = decided.get(call.approvalId);
    if (!pending) {
      pending = (async (): Promise<Outcome> => {
        if (!(await hasPerson())) return { kind: "block" };
        const request = repositoryAttachRequest(call);
        const removedEarlier = request
          ? await chat.removedEarlier(request.repository).catch(() => false)
          : false;
        return { kind: "ask", removedEarlier };
      })();
      decided.set(call.approvalId, pending);
      pending.catch(() => decided.delete(call.approvalId));
    }
    return pending;
  };
  const isAttach = (call: ConnectorActionToolCall) =>
    call.serverId === "opengeni" && call.toolName === REPOSITORY_ATTACH_TOOL_NAME;
  const asking = (call: ConnectorActionToolCall, removedEarlier: boolean) => {
    const { targetFacts: _earlier, ...context } = call.reviewContext ?? {};
    const request = repositoryAttachRequest(call);
    return {
      ...call,
      approvalMode: "session_mcp" as const,
      defaultDecision: "ask" as const,
      reviewContext: {
        kind: "generic" as const,
        ...context,
        title: request
          ? factValue(`Attach ${request.repository} to this chat`)
          : "Attach a repository to this chat",
        ...(request
          ? {
              targetFacts: [
                { label: "Repository", value: factValue(request.repository) },
                { label: "Branch", value: request.ref ? factValue(request.ref) : "Default branch" },
                { label: "Access", value: "Workspace GitHub App" },
                ...(removedEarlier
                  ? [{ label: "Note", value: "Removed from this chat earlier" }]
                  : []),
              ],
            }
          : {}),
      },
    };
  };
  const blocked = { managed: true, decision: "block" } as const;
  const prepareWith =
    (inner: NonNullable<ConnectorActionPolicyHooks["preview"]>) =>
    async (call: ConnectorActionToolCall) => {
      if (!isAttach(call)) return await inner(call);
      const decision = await outcome(call);
      return decision.kind === "block"
        ? blocked
        : await inner(asking(call, decision.removedEarlier));
    };
  return {
    ...(policy.preview ? { preview: prepareWith(policy.preview) } : {}),
    prepare: prepareWith(policy.prepare),
    begin: async (call) => {
      if (!isAttach(call)) return await policy.begin(call);
      const decision = await outcome(call);
      return decision.kind === "block"
        ? { allowed: false, managed: true, requestId: call.approvalId, reason: "blocked" }
        : await policy.begin(asking(call, decision.removedEarlier));
    },
    complete: policy.complete,
  };
}
