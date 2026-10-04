import { useEffect, useRef, useState, type ReactNode } from "react";
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
      : name.replaceAll("_", " ").replaceAll(".", " › "),
  showDetails: "View full details",
  hideDetails: "Back to review",
};
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
  const [pending, setPending] = useState<{ id: string; decision: "approve" | "reject" } | null>(
    null,
  );
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
      className={cn("og-root box-border w-full min-w-0 border-t border-og-border", className)}
      data-og-approval-surface=""
    >
      {approvals.length > 1 && (
        <nav
          aria-label="Actions to review"
          className="flex flex-wrap items-center justify-between gap-2 pt-3 text-og-xs text-og-fg-muted"
        >
          <span>{approvals.length} actions need review</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={selectedIndex === 0}
              onClick={() => setSelectedId(approvals[selectedIndex - 1]!.id)}
              className="min-h-11 disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              {selectedIndex + 1} of {approvals.length}
            </span>
            <button
              type="button"
              disabled={selectedIndex === approvals.length - 1}
              onClick={() => setSelectedId(approvals[selectedIndex + 1]!.id)}
              className="min-h-11 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </nav>
      )}
      <div className="divide-y divide-og-border">
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
        <p role="alert" className="m-0 pb-3 text-og-sm text-og-status-failed">
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
  const [loaded, setLoaded] = useState<ToolActionReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setFailed(false);
    setLegacy(false);
    if (loadReview)
      void loadReview(approval).then(
        (review) => {
          if (active) {
            if (review.id !== approval.id) setFailed(true);
            else setLoaded(review);
          }
        },
        (error) => {
          if (active) {
            if (
              error instanceof OpenGeniApiError &&
              error.status === 404 &&
              approval.arguments !== undefined
            )
              setLegacy(true);
            else setFailed(true);
          }
        },
      );
    return () => {
      active = false;
    };
  }, [approval, retry, loadReview]);
  if (loadReview && !loaded && !failed && !legacy)
    return (
      <div className="py-5 text-og-sm text-og-fg-muted" role="status">
        Loading action details…
      </div>
    );
  if (failed)
    return (
      <div className="py-4 text-og-sm text-og-fg" role="alert">
        Action details could not be loaded.{" "}
        <button
          type="button"
          className="min-h-11 underline underline-offset-4"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  const fallback: ToolActionReview = {
    version: 1,
    id: approval.id,
    actionDigest: "",
    revision: "legacy",
    status: "pending",
    ...toolReviewAction(approval.name, approval.arguments, {
      kind: "generic",
      title:
        approval.display?.title ??
        messages.formatToolName(approval.display?.toolName ?? approval.name),
    }),
    ...(approval.display?.accountLabel ? { accountLabel: approval.display.accountLabel } : {}),
    ...toolReviewFields(approval.arguments),
    reason: "This action requires your approval.",
    createdAt: "",
    updatedAt: "",
    approveLabel: messages.approve,
    availableActions: approval.arguments === undefined ? [] : ["approve", "reject"],
    detailsAvailable: approval.arguments !== undefined,
  };
  const review = loaded ?? fallback;
  if (detailPath !== null)
    return (
      <ToolActionReviewDetails
        review={review}
        path={detailPath}
        load={
          loaded && loadDetails
            ? loadDetails
            : async (value, path, offset) => ({
                version: 1,
                id: value.id,
                actionDigest: value.actionDigest,
                ...toolReviewDetails(approval.arguments, undefined, path, offset),
              })
        }
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
      {!loaded && approval.arguments === undefined && (
        <p className="pb-3 text-og-sm text-og-fg-muted">
          Open the task with a compatible client to review this action.
        </p>
      )}
    </div>
  );
}
