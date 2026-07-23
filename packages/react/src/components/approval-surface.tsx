import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PendingApproval } from "../approvals";
import { cn } from "../lib/cn";

export type ApprovalSurfaceMessages = {
  title: string;
  description: string;
  approve: string;
  reject: string;
  approving: string;
  rejecting: string;
  formatToolName: (name: string) => string;
};

export const defaultApprovalSurfaceMessages: ApprovalSurfaceMessages = {
  title: "Approval required",
  description: "Review the requested action before the agent continues.",
  approve: "Approve",
  reject: "Reject",
  approving: "Approving…",
  rejecting: "Rejecting…",
  formatToolName: (name) => name.replaceAll("_", " ").replaceAll(".", " › "),
};

export type ApprovalSurfaceProps = {
  approvals: PendingApproval[];
  onApprove: (approval: PendingApproval) => void | Promise<void>;
  onReject: (approval: PendingApproval) => void | Promise<void>;
  responding?: boolean | undefined;
  error?: string | Error | null | undefined;
  messages?: Partial<ApprovalSurfaceMessages> | undefined;
  renderApproval?: ((approval: PendingApproval) => ReactNode) | undefined;
  className?: string | undefined;
};

const APPROVAL_ARGUMENT_PREVIEW_CHARACTERS = 4_000;

function approvalArgumentsPreview(value: unknown): string | null {
  if (value === undefined) return null;
  let serialized: string;
  try {
    serialized =
      typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    serialized = "[Arguments unavailable]";
  }
  const characters = Array.from(serialized);
  if (characters.length <= APPROVAL_ARGUMENT_PREVIEW_CHARACTERS) return serialized;
  return `${characters.slice(0, APPROVAL_ARGUMENT_PREVIEW_CHARACTERS).join("")}\n… ${characters.length - APPROVAL_ARGUMENT_PREVIEW_CHARACTERS} characters omitted`;
}

function approvalOwnershipKey(approval: PendingApproval): string {
  return `${approval.id}\u0000${approval.name}\u0000${approvalArgumentsPreview(approval.arguments) ?? ""}`;
}

/**
 * Host-neutral approval presentation backed by the native pending-approval
 * projection and control callbacks. It owns only presentation and duplicate
 * click fencing; OpenGeni remains the authority for approval state.
 */
export function ApprovalSurface({
  approvals,
  onApprove,
  onReject,
  responding = false,
  error,
  messages: overrides,
  renderApproval,
  className,
}: ApprovalSurfaceProps) {
  const titleId = useId();
  const messages = { ...defaultApprovalSurfaceMessages, ...overrides };
  const [pending, setPending] = useState<{
    approvalKey: string;
    decision: "approve" | "reject";
    token: symbol;
  } | null>(null);
  const pendingRef = useRef<{ approvalKey: string; token: symbol } | null>(null);
  const [decisionError, setDecisionError] = useState<Error | null>(null);

  useEffect(() => {
    if (
      pending &&
      !approvals.some((approval) => approvalOwnershipKey(approval) === pending.approvalKey)
    ) {
      if (pendingRef.current?.token === pending.token) {
        pendingRef.current = null;
      }
      setPending((current) => (current?.token === pending.token ? null : current));
    }
  }, [approvals, pending]);

  if (approvals.length === 0) return null;
  const busy = responding || pendingRef.current !== null;
  const decide = async (
    approval: PendingApproval,
    decision: "approve" | "reject",
  ): Promise<void> => {
    if (responding || pendingRef.current !== null) return;
    const approvalKey = approvalOwnershipKey(approval);
    const token = Symbol(approvalKey);
    pendingRef.current = { approvalKey, token };
    setPending({ approvalKey, decision, token });
    setDecisionError(null);
    try {
      await (decision === "approve" ? onApprove(approval) : onReject(approval));
      // Keep the decision fenced until the authoritative projection removes or
      // replaces this exact approval. A successful callback is transport
      // acceptance, not settlement.
    } catch (cause) {
      if (pendingRef.current?.token === token) {
        pendingRef.current = null;
        setPending((current) => (current?.token === token ? null : current));
        setDecisionError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
  };
  const errorMessage = decisionError?.message ?? (error instanceof Error ? error.message : error);

  return (
    <section
      className={cn(
        "og-root flex w-full flex-col gap-3 rounded-og-lg border border-og-status-waiting/35 bg-og-status-waiting/5 p-4 shadow-og-sm",
        className,
      )}
      aria-labelledby={titleId}
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-og-md bg-og-status-waiting/12 text-og-status-waiting">
          <ShieldCheckIcon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-og-md font-semibold text-og-fg">
            {messages.title}
          </h2>
          <p className="mt-0.5 text-og-sm text-og-fg-muted">{messages.description}</p>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        {approvals.map((approval) => {
          const approvalKey = approvalOwnershipKey(approval);
          const active = pending?.approvalKey === approvalKey ? pending.decision : null;
          const argumentsPreview = approvalArgumentsPreview(approval.arguments);
          return (
            <article
              key={approval.id}
              data-approval-id={approval.id}
              className="rounded-og-md border border-og-border bg-og-surface-1 p-3"
            >
              {renderApproval ? (
                renderApproval(approval)
              ) : (
                <>
                  <p className="text-og-sm font-medium text-og-fg">
                    {messages.formatToolName(approval.name)}
                  </p>
                  {argumentsPreview !== null ? (
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-og-sm bg-og-surface-2 p-2 font-mono text-og-xs text-og-fg-muted">
                      {argumentsPreview}
                    </pre>
                  ) : null}
                </>
              )}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(approval, "reject")}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-og-md border border-og-border px-3 py-1.5 text-og-sm font-medium text-og-fg-muted transition-colors hover:bg-og-surface-2 hover:text-og-fg disabled:opacity-50"
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                  {active === "reject" ? messages.rejecting : messages.reject}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(approval, "approve")}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-og-md bg-og-accent px-3 py-1.5 text-og-sm font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong disabled:opacity-50"
                >
                  <CheckIcon aria-hidden="true" className="size-3.5" />
                  {active === "approve" ? messages.approving : messages.approve}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {errorMessage ? (
        <p role="alert" className="text-og-sm text-og-status-failed">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
