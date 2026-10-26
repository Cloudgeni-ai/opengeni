import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dequal } from "dequal";
import { ChevronLeftIcon, ChevronRightIcon, ShieldCheckIcon } from "lucide-react";
import {
  OpenGeniApiError,
  toolReviewFields,
  toolReviewDetails,
  type ToolActionReview,
} from "@opengeni/sdk";
import type { PendingApproval } from "../approvals";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import {
  approvalAnswerLabels,
  approvalToolName,
  formatApprovalToolName,
  pendingApprovalReview,
} from "../approval-review-model";
import {
  ToolActionReviewCard,
  ToolActionReviewDetails,
  ToolReviewFrame,
  DeclineButton,
  UNRECOVERABLE_TEXT,
  type ToolReviewDetailsLoader,
} from "./tool-action-review";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { McpElicitationRequest } from "./mcp-elicitation-request";
import type { McpElicitationContent } from "@opengeni/contracts/mcp-elicitation";

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
export const defaultApprovalSurfaceMessages = (t: OpenGeniText): ApprovalSurfaceMessages => ({
  title: t("approvalSurface.approvalNeeded"),
  description: t("approvalSurface.reviewTheActionBeforeIt"),
  approve: t("approvalSurface.approveAction"),
  reject: t("approvalSurface.decline"),
  approving: t("approvalSurface.approving"),
  rejecting: t("approvalSurface.declining"),
  formatToolName: (name) => formatApprovalToolName(t, name),
  showDetails: t("approvalSurface.viewFullDetails"),
  hideDetails: t("approvalSurface.backToReview"),
});
export type ApprovalSurfaceProps = {
  approvals: PendingApproval[];
  /**
   * `answer` is present when the approval answers its MCP server's questions
   * (`approval.elicitation`); send its `content` with the decision.
   */
  onApprove: (
    approval: PendingApproval,
    answer?: { content: McpElicitationContent },
  ) => void | Promise<void>;
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
  const t = useOpenGeniText();
  const messages = { ...defaultApprovalSurfaceMessages(t), ...overrides };
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
  const decide = async (
    approval: PendingApproval,
    decision: "approve" | "reject",
    answer?: { content: McpElicitationContent },
  ) => {
    if (responding || pendingRef.current) return;
    pendingRef.current = approval.id;
    setPending({ id: approval.id, decision });
    setDecisionError(null);
    try {
      await (decision === "approve"
        ? answer
          ? onApprove(approval, answer)
          : onApprove(approval)
        : onReject(approval));
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
          aria-label={t("approvalSurface.actionsToReview")}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-og-xs text-og-fg-muted"
        >
          <span className="font-medium text-og-status-waiting">
            {t("approvalSurface.lengthActionsAreWaitingFor", { length: approvals.length })}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t("approvalSurface.previousAction")}
              disabled={selectedIndex === 0}
              onClick={() => setSelectedId(approvals[selectedIndex - 1]!.id)}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-og-md hover:bg-og-hover hover:text-og-fg disabled:opacity-40 disabled:hover:bg-transparent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            >
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
            </button>
            <span className="tabular-nums" aria-live="polite">
              {selectedIndex + 1} {t("approvalSurface.ofLength", { length: approvals.length })}
            </span>
            <button
              type="button"
              aria-label={t("approvalSurface.nextAction")}
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
            onAnswer={(content) => void decide(approval, "approve", { content })}
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
  onAnswer,
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
  onAnswer: (content: McpElicitationContent) => void;
  onReject: () => void;
}) {
  const t = useOpenGeniText();
  const [retry, setRetry] = useState(0);
  // A server's question is answered from the approval itself; there is no
  // saved review of a call that has already started.
  const reviewLoader = approval.elicitation ? undefined : loadReview;
  // Event projection recreates the same approval on unrelated timeline updates.
  // Keep one request for equal facts, but never reuse it across changed facts,
  // an explicit retry, or a loader change (the host's client/access boundary).
  const requestRef = useRef({ approval, loadReview: reviewLoader, retry });
  if (
    requestRef.current.loadReview !== reviewLoader ||
    requestRef.current.retry !== retry ||
    !dequal(requestRef.current.approval, approval)
  ) {
    requestRef.current = { approval, loadReview: reviewLoader, retry };
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
  const toolName = approvalToolName(stableApproval);
  const answer = approvalAnswerLabels(t, toolName);
  const fallback = useMemo<ToolActionReview>(
    () => pendingApprovalReview(stableApproval, { formatToolName, approveLabel }),
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
  if (reviewLoader && !loaded && !failed && !legacy)
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
          <span className="sr-only">{t("approvalSurface.loadingActionDetails")}</span>
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
          {t("approvalSurface.youDonTHaveAccess")}
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
              label={answer?.reject ?? messages.reject}
              onClick={actions.onReject}
            />
          </div>
        }
      >
        <p role="alert" className="m-0 text-og-sm text-og-fg">
          {t("approvalSurface.couldnTLoadThisAction")}{" "}
          <button
            type="button"
            className="min-h-8 font-medium underline underline-offset-4 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t("approvalSurface.tryAgain")}
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
                label={answer?.reject ?? messages.reject}
                onClick={actions.onReject}
              />
            </div>
          }
        >
          <p className="m-0 text-og-sm text-og-fg">{UNRECOVERABLE_TEXT(t)}</p>
        </ToolReviewFrame>
      </div>
    );
  const saved = loaded ?? fallback;
  const review = answer ? { ...saved, approveLabel: answer.approve } : saved;
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
  if (stableApproval.elicitation)
    return (
      <div data-approval-id={approval.id} data-review-origin="pending">
        {custom}
        <McpElicitationRequest
          // A new question on the same call starts a fresh answer.
          key={JSON.stringify(stableApproval.elicitation)}
          elicitation={stableApproval.elicitation}
          title={fallback.title}
          subtitle={fallback.accountLabel}
          submitting={actions.submitting}
          disabled={actions.disabled}
          onAnswer={onAnswer}
          onDecline={actions.onReject}
          details={
            fallback.detailsAvailable ? (
              <button
                type="button"
                className="inline-flex min-h-8 items-center rounded-og-sm text-og-sm text-og-fg-muted underline decoration-og-border-strong underline-offset-4 hover:text-og-fg hover:decoration-current [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                data-review-path=""
                onClick={() => setDetailPath("")}
              >
                {t("toolActionReview.details")}
              </button>
            ) : null
          }
        />
      </div>
    );
  return (
    <div data-approval-id={approval.id} data-review-origin="pending">
      {custom}
      <ToolActionReviewCard
        review={review}
        {...actions}
        pendingLabel={messages.title}
        rejectLabel={answer?.reject ?? messages.reject}
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
