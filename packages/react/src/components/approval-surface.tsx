import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PendingApproval } from "../approvals";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import { toolDisplayName } from "../timeline/tool-display-name";

export type ApprovalSurfaceMessages = {
  title: string;
  /** Screen-reader context for the decision; not shown visually. */
  description: string;
  approve: string;
  reject: string;
  approving: string;
  rejecting: string;
  formatToolName: (name: string) => string;
  /** Toggle for the exact arguments when they are shown as readable fields. */
  showDetails?: string | undefined;
  hideDetails?: string | undefined;
};

export const defaultApprovalSurfaceMessages: ApprovalSurfaceMessages = {
  title: "Approval needed",
  description: "Review the requested action before the agent continues.",
  approve: "Approve",
  reject: "Reject",
  approving: "Approving…",
  rejecting: "Rejecting…",
  formatToolName: (name) =>
    name.includes("__") || /^[a-f0-9]{64}$/.test(name)
      ? toolDisplayName(name)
      : name.replaceAll("_", " ").replaceAll(".", " › "),
  showDetails: "Show exact arguments",
  hideDetails: "Hide exact arguments",
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
const APPROVAL_FIELD_LIMIT = 12;
const APPROVAL_LIST_LIMIT = 10;

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

export type ApprovalField = { key: string; label: string; value: string };

const ACRONYMS = new Set(["id", "ids", "url", "uri", "api", "ip", "sku", "utc", "iban", "vat"]);

/** "paymentId" / "payment_id" → "Payment ID". */
function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  const label = words.join(" ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null) return "None";
  return null;
}

/**
 * Readable fields for a flat argument object (scalars and short scalar lists).
 * Returns null when the arguments are nested, large, or not an object, so the
 * caller shows the exact JSON instead of a lossy summary.
 */
export function approvalArgumentFields(value: unknown): ApprovalField[] | null {
  let record = value;
  if (typeof record === "string") {
    try {
      record = JSON.parse(record) as unknown;
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const entries = Object.entries(record as Record<string, unknown>);
  if (entries.length === 0 || entries.length > APPROVAL_FIELD_LIMIT) return null;
  const fields: ApprovalField[] = [];
  for (const [key, entry] of entries) {
    let text = scalarText(entry);
    if (text === null && Array.isArray(entry) && entry.length <= APPROVAL_LIST_LIMIT) {
      const items = entry.map(scalarText);
      if (items.every((item): item is string => item !== null)) text = items.join(", ");
    }
    if (text === null || text.length > APPROVAL_ARGUMENT_PREVIEW_CHARACTERS) return null;
    fields.push({ key, label: fieldLabel(key), value: text });
  }
  return fields;
}

function isEmptyArguments(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
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
  const formatError = useErrorMessage();
  const descriptionId = useId();
  const messages = { ...defaultApprovalSurfaceMessages, ...overrides };
  const [pending, setPending] = useState<{
    approvalKey: string;
    decision: "approve" | "reject";
    token: symbol;
  } | null>(null);
  const pendingRef = useRef<{ approvalKey: string; token: symbol } | null>(null);
  const [decisionError, setDecisionError] = useState<{ cause: unknown } | null>(null);

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
        setDecisionError({ cause });
      }
    }
  };
  const errorMessage = decisionError
    ? formatError(decisionError.cause)
    : error instanceof Error
      ? formatError(error)
      : error;

  return (
    <section
      className={cn(
        "og-root box-border flex w-full flex-col rounded-og-lg border border-og-status-waiting/35 bg-og-status-waiting/5 shadow-og-sm",
        className,
      )}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-og-approval-surface=""
    >
      <h2 id={titleId} className="sr-only">
        {messages.title}
      </h2>
      <p id={descriptionId} className="sr-only">
        {messages.description}
      </p>
      <div className="flex flex-col divide-y divide-og-status-waiting/20">
        {approvals.map((approval) => {
          const approvalKey = approvalOwnershipKey(approval);
          const active = pending?.approvalKey === approvalKey ? pending.decision : null;
          return (
            <article
              key={approval.id}
              data-approval-id={approval.id}
              className="flex flex-col gap-3 p-4"
            >
              {renderApproval ? (
                <div className="min-w-0">
                  <p className="mb-1 text-og-xs font-medium text-og-status-waiting" aria-hidden>
                    {messages.title}
                  </p>
                  {renderApproval(approval)}
                </div>
              ) : (
                <ApprovalDetails approval={approval} messages={messages} />
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(approval, "reject")}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1 text-og-sm font-medium text-og-fg transition-colors hover:border-og-border-strong disabled:opacity-50"
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                  {active === "reject" ? messages.rejecting : messages.reject}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(approval, "approve")}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-og-md border border-og-primary-border bg-og-primary px-3 py-1 text-og-sm font-medium text-og-primary-fg transition-colors hover:bg-og-primary-hover disabled:opacity-50"
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
        <p role="alert" className="px-4 pb-3 text-og-sm text-og-status-failed">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}

function ApprovalDetails({
  approval,
  messages,
}: {
  approval: PendingApproval;
  messages: ApprovalSurfaceMessages;
}) {
  const [showExact, setShowExact] = useState(false);
  const fields = approvalArgumentFields(approval.arguments);
  const exact = isEmptyArguments(approval.arguments)
    ? null
    : approvalArgumentsPreview(approval.arguments);
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-og-md bg-og-status-waiting/12 text-og-status-waiting">
        <ShieldCheckIcon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-og-xs font-medium text-og-status-waiting">{messages.title}</p>
        <p className="mt-0.5 break-words text-og-md font-semibold text-og-fg">
          {approval.display?.title ??
            messages.formatToolName(approval.display?.toolName ?? approval.name)}
        </p>
        {approval.display?.accountLabel ? (
          <p className="mt-0.5 break-words text-og-xs text-og-fg-muted">
            {approval.display.accountLabel}
          </p>
        ) : null}
        {fields ? (
          <dl className="m-0 mt-3 grid grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-og-sm">
            {fields.map((field) => (
              <Fragment key={field.key}>
                <dt className="m-0 text-og-fg-muted">{field.label}</dt>
                <dd className="m-0 max-h-32 min-w-0 overflow-auto whitespace-pre-wrap break-words text-og-fg">
                  {field.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
        {exact !== null && (!fields || showExact) ? (
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-og-sm bg-og-fg/5 p-2.5 font-mono text-og-xs text-og-fg-muted">
            {exact}
          </pre>
        ) : null}
        {fields && exact !== null ? (
          <button
            type="button"
            aria-expanded={showExact}
            onClick={() => setShowExact((value) => !value)}
            className="mt-2 text-og-xs text-og-fg-muted underline-offset-2 hover:text-og-fg hover:underline"
          >
            {showExact
              ? (messages.hideDetails ?? defaultApprovalSurfaceMessages.hideDetails)
              : (messages.showDetails ?? defaultApprovalSurfaceMessages.showDetails)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
