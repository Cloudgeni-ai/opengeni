import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dequal } from "dequal";
import { ChevronLeftIcon, ChevronRightIcon, ShieldCheckIcon } from "lucide-react";
import {
  OpenGeniApiError,
  toolReviewAction,
  toolReviewFields,
  toolReviewDetails,
  type ToolActionReview,
} from "@opengeni/sdk";
import type { PendingApproval } from "../approvals";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import { toolDisplayName } from "../timeline/tool-display-name";
import {
  ToolActionReviewCard,
  ToolActionReviewDetails,
  ToolReviewFrame,
  DeclineButton,
  UNRECOVERABLE_TEXT,
  type ToolReviewDetailsLoader,
} from "./tool-action-review";

export type ApprovalSurfaceMessages = {
  title: string;
  description: string;
  approve: string;
  reject: string;
  approving: string;
  rejecting: string;
  formatToolName: (name: string) => string;
  showDetails?: string | undefined;
  hideDetails?: string | undefined;
};
export const defaultApprovalSurfaceMessages: ApprovalSurfaceMessages = {
  title: "Approval needed",
  description: "Review the action before it runs.",
  approve: "Approve action",
  reject: "Decline",
  approving: "Approving…",
  rejecting: "Declining…",
  formatToolName: (name) =>
    name.includes("__") || /^[a-f0-9]{64}$/.test(name)
      ? toolDisplayName(name)
      : humanToolName(name.replaceAll("_", " ").replaceAll(".", " › ")),
  showDetails: "View full details",
  hideDetails: "Back to review",
};
/** "batch modify messages" → "Modify messages": how a call is grouped is not what it does. */
function humanToolName(name: string): string {
  const phrase = name.replace(/^batch\s+/i, "").trim();
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : name;
}
export type ApprovalSurfaceProps = {
  approvals: PendingApproval[];
  onApprove: (approval: PendingApproval) => void | Promise<void>;
  onReject: (approval: PendingApproval) => void | Promise<void>;
  responding?: boolean | undefined;
  error?: string | Error | null | undefined;
  messages?: Partial<ApprovalSurfaceMessages> | undefined;
  renderApproval?: ((approval: PendingApproval) => ReactNode) | undefined;
  /** Authenticated server facts; hosts need not import any web-app code. */
  loadReview?: ((approval: PendingApproval) => Promise<ToolActionReview>) | undefined;
  loadDetails?: ToolReviewDetailsLoader | undefined;
  onViewDetails?: ((review: ToolActionReview, path: string) => void) | undefined;
  selectedApprovalId?: string | null | undefined;
  onSelectedApprovalChange?: ((id: string) => void) | undefined;
  className?: string | undefined;
};
export type ApprovalField = { key: string; label: string; value: string };
/** @deprecated Prefer the versioned server review; retained for small custom renderers. */
export function approvalArgumentFields(value: unknown): ApprovalField[] | null {
  const projected = toolReviewFields(value);
  return projected.fields.length
    ? projected.fields.map((field) => ({
        key: field.path.slice(1),
        label: field.label,
        value: field.preview,
      }))
    : null;
}

/** Hosts provide decisions; this surface never mutates the approved payload. */
export function ApprovalSurface({
  approvals,
  onApprove,
  onReject,
  responding,
  error,
  messages: overrides,
  renderApproval,
  loadReview,
  loadDetails,
  onViewDetails,
  selectedApprovalId,
  onSelectedApprovalChange,
  className,
}: ApprovalSurfaceProps) {
  const messages = { ...defaultApprovalSurfaceMessages, ...overrides };
  const formatError = useErrorMessage();
  const [pending, setPending] = useState<{
    id: string;
    decision: "approve" | "reject";
  } | null>(null);
  const pendingRef = useRef<string | null>(null);
  const [decisionError, setDecisionError] = useState<{ cause: unknown } | null>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = selectedApprovalId === undefined ? localSelectedId : selectedApprovalId;
  const setSelectedId = (id: string) => {
    setLocalSelectedId(id);
    onSelectedApprovalChange?.(id);
  };
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pending && !approvals.some((approval) => approval.id === pending.id)) {
      pendingRef.current = null;
      setPending(null);
      requestAnimationFrame(() => surface.current?.querySelector<HTMLElement>("h3")?.focus());
    }
  }, [approvals, pending]);
  if (!approvals.length) return null;
  const selectedIndex = Math.max(
    0,
    approvals.findIndex((approval) => approval.id === selectedId),
  );
  const selected = approvals[selectedIndex]!;
  const decide = async (approval: PendingApproval, decision: "approve" | "reject") => {
    if (responding || pendingRef.current) return;
    pendingRef.current = approval.id;
    setPending({ id: approval.id, decision });
    setDecisionError(null);
    try {
      await (decision === "approve" ? onApprove(approval) : onReject(approval));
    } catch (cause) {
      if (pendingRef.current === approval.id) {
        pendingRef.current = null;
        setPending(null);
        setDecisionError({ cause });
      }
    }
  };
  const errorText = decisionError
    ? formatError(decisionError.cause)
    : error instanceof Error
      ? formatError(error)
      : error;
  return (
    <section
      ref={surface}
      aria-label={messages.title}
      className={cn("og-root box-border w-full min-w-0 space-y-2 py-2", className)}
      data-og-approval-surface=""
    >
      {approvals.length > 1 && (
        <nav
          aria-label="Actions to review"
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-og-xs text-og-fg-muted"
        >
          <span className="font-medium text-og-status-waiting">
            {approvals.length} actions are waiting for you
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous action"
              disabled={selectedIndex === 0}
              onClick={() => setSelectedId(approvals[selectedIndex - 1]!.id)}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-og-md hover:bg-og-hover hover:text-og-fg disabled:opacity-40 disabled:hover:bg-transparent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            >
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
            </button>
            <span className="tabular-nums" aria-live="polite">
              {selectedIndex + 1} of {approvals.length}
            </span>
            <button
              type="button"
              aria-label="Next action"
              disabled={selectedIndex === approvals.length - 1}
              onClick={() => setSelectedId(approvals[selectedIndex + 1]!.id)}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-og-md hover:bg-og-hover hover:text-og-fg disabled:opacity-40 disabled:hover:bg-transparent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            >
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
        </nav>
      )}
      <div>
        {[selected].map((approval) => (
          <ApprovalRequest
            key={approval.id}
            approval={approval}
            loadReview={loadReview}
            loadDetails={loadDetails}
            messages={messages}
            custom={renderApproval?.(approval)}
            onViewDetails={onViewDetails}
            submitting={pending?.id === approval.id ? pending.decision : null}
            disabled={Boolean(responding || pending)}
            onApprove={() => void decide(approval, "approve")}
            onReject={() => void decide(approval, "reject")}
          />
        ))}
      </div>
      {errorText && (
        <p role="alert" className="m-0 px-1 text-og-sm text-og-status-failed">
          {errorText}
        </p>
      )}
    </section>
  );
}

function ApprovalRequest({
  approval,
  loadReview,
  loadDetails,
  messages,
  custom,
  onViewDetails,
  ...actions
}: {
  approval: PendingApproval;
  loadReview: ApprovalSurfaceProps["loadReview"];
  messages: ApprovalSurfaceMessages;
  loadDetails: ToolReviewDetailsLoader | undefined;
  custom: ReactNode;
  onViewDetails: ApprovalSurfaceProps["onViewDetails"];
  submitting: "approve" | "reject" | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [retry, setRetry] = useState(0);
  // Event projection recreates the same approval on unrelated timeline updates.
  // Keep one request for equal facts, but never reuse it across changed facts,
  // an explicit retry, or a loader change (the host's client/access boundary).
  const requestRef = useRef({ approval, loadReview, retry });
  if (
    requestRef.current.loadReview !== loadReview ||
    requestRef.current.retry !== retry ||
    !dequal(requestRef.current.approval, approval)
  ) {
    requestRef.current = { approval, loadReview, retry };
  }
  const request = requestRef.current;
  const [result, setResult] = useState<{
    request: typeof request;
    review?: ToolActionReview;
    failed?: boolean;
    legacy?: boolean;
    denied?: boolean;
  } | null>(null);
  // Hide stale facts during render, before passive effect cleanup can run.
  const current = result?.request === request ? result : null;
  const loaded = current?.review;
  const failed = current?.failed;
  const legacy = current?.legacy;
  const denied = current?.denied;
  const [detailPath, setDetailPath] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (request.loadReview)
      void request.loadReview(request.approval).then(
        (review) => {
          if (active) {
            setResult(
              review.id !== request.approval.id ? { request, failed: true } : { request, review },
            );
          }
        },
        (error) => {
          if (active) {
            // 404: no saved review (older or non-connector actions); use the
            // approval's own arguments. 401/403: this person cannot review it.
            if (error instanceof OpenGeniApiError && error.status === 404)
              setResult({ request, legacy: true });
            else if (
              error instanceof OpenGeniApiError &&
              (error.status === 401 || error.status === 403)
            )
              setResult({ request, failed: true, denied: true });
            else setResult({ request, failed: true });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [request]);
  const stableApproval = request.approval;
  const { formatToolName, approve: approveLabel } = messages;
  const fallback = useMemo<ToolActionReview>(
    () => ({
      version: 1,
      id: stableApproval.id,
      actionDigest: "",
      revision: "legacy",
      status: "pending",
      ...toolReviewAction(stableApproval.name, stableApproval.arguments, {
        kind: "generic",
        title:
          stableApproval.display?.title ??
          formatToolName(stableApproval.display?.toolName ?? stableApproval.name),
      }),
      ...(stableApproval.display?.accountLabel
        ? { accountLabel: stableApproval.display.accountLabel }
        : {}),
      ...toolReviewFields(stableApproval.arguments),
      reason: "",
      createdAt: "",
      updatedAt: "",
      approveLabel,
      availableActions: stableApproval.arguments === undefined ? [] : ["approve", "reject"],
      detailsAvailable: stableApproval.arguments !== undefined,
    }),
    [stableApproval, formatToolName, approveLabel],
  );
  const loadLegacyDetails = useCallback<ToolReviewDetailsLoader>(
    async (value, path, offset) => ({
      version: 1,
      id: value.id,
      actionDigest: value.actionDigest,
      ...toolReviewDetails(stableApproval.arguments, undefined, path, offset),
    }),
    [stableApproval],
  );
  if (loadReview && !loaded && !failed && !legacy)
    return (
      <ToolReviewFrame
        tone="waiting"
        icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}
        eyebrow={messages.title}
        title={fallback.title}
        subtitle={fallback.accountLabel}
        aria-busy
        data-og-tool-review-loading=""
      >
        <div role="status" className="space-y-2">
          <span className="sr-only">Loading action details…</span>
          <div className="h-3 w-3/4 animate-pulse rounded-og-sm bg-og-fg/8" aria-hidden="true" />
          <div className="h-3 w-1/2 animate-pulse rounded-og-sm bg-og-fg/8" aria-hidden="true" />
        </div>
      </ToolReviewFrame>
    );
  if (denied)
    return (
      <ToolReviewFrame
        tone="waiting"
        icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}
        eyebrow={messages.title}
        title={fallback.title}
        subtitle={fallback.accountLabel}
      >
        <p role="alert" className="m-0 text-og-sm text-og-fg">
          You don't have access to review this action. Ask someone with access to this chat to
          decide.
        </p>
      </ToolReviewFrame>
    );
  if (failed)
    return (
      <ToolReviewFrame
        tone="waiting"
        icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}
        eyebrow={messages.title}
        title={fallback.title}
        subtitle={fallback.accountLabel}
        footer={
          <div className="ml-auto">
            <DeclineButton
              busy={Boolean(actions.disabled || actions.submitting)}
              submitting={actions.submitting === "reject"}
              label={messages.reject}
              onClick={actions.onReject}
            />
          </div>
        }
      >
        <p role="alert" className="m-0 text-og-sm text-og-fg">
          Couldn't load this action, so it can't be approved yet. You can still decline it.{" "}
          <button
            type="button"
            className="min-h-8 font-medium underline underline-offset-4 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </p>
      </ToolReviewFrame>
    );
  if (!loaded && stableApproval.arguments === undefined)
    return (
      <div data-approval-id={approval.id} data-review-origin="pending">
        {custom}
        <ToolReviewFrame
          tone="waiting"
          icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}
          eyebrow={messages.title}
          title={fallback.title}
          subtitle={fallback.accountLabel}
          data-og-tool-review=""
          footer={
            <div className="ml-auto">
              <DeclineButton
                busy={Boolean(actions.disabled || actions.submitting)}
                submitting={actions.submitting === "reject"}
                label={messages.reject}
                onClick={actions.onReject}
              />
            </div>
          }
        >
          <p className="m-0 text-og-sm text-og-fg">{UNRECOVERABLE_TEXT}</p>
        </ToolReviewFrame>
      </div>
    );
  const review = loaded ?? fallback;
  if (detailPath !== null)
    return (
      <ToolActionReviewDetails
        review={review}
        path={detailPath}
        load={loaded && loadDetails ? loadDetails : loadLegacyDetails}
        onBack={() => {
          const path = detailPath;
          setDetailPath(null);
          requestAnimationFrame(() => {
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                "[data-approval-id] button[data-review-path]",
              ),
            ]
              .find(
                (button) =>
                  button.closest("[data-approval-id]")?.getAttribute("data-approval-id") ===
                    approval.id && button.dataset.reviewPath === path,
              )
              ?.focus();
          });
        }}
      />
    );
  return (
    <div data-approval-id={approval.id} data-review-origin="pending">
      {custom}
      <ToolActionReviewCard
        review={review}
        {...actions}
        pendingLabel={messages.title}
        rejectLabel={messages.reject}
        onViewDetails={
          loaded && onViewDetails
            ? (path) => onViewDetails(review, path)
            : loadDetails || !loaded
              ? setDetailPath
              : undefined
        }
      />
    </div>
  );
}
