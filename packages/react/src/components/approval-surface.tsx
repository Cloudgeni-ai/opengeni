import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { dequal } from "dequal";
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
import { OpenGeniApiError, toolReviewDetails, type ToolActionReview } from "@opengeni/sdk";
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
import { DecisionActions } from "./decision-card";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { toolActionTitle, wordedToolActionReview } from "../tool-action-wording";
import { McpElicitationRequest } from "./mcp-elicitation-request";
import type {
  McpElicitationAnswer,
  McpElicitationContent,
} from "@opengeni/contracts/mcp-elicitation-model";

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
   * (`approval.elicitation`); send it with the decision.
   */
  onApprove: (approval: PendingApproval, answer?: McpElicitationAnswer) => void | Promise<void>;
  onReject: (approval: PendingApproval) => void | Promise<void>;
  responding?: boolean | undefined;
  error?: string | Error | null | undefined;
  messages?: Partial<ApprovalSurfaceMessages> | undefined;
  renderApproval?: ((approval: PendingApproval) => ReactNode) | undefined;
  /**
   * Authenticated server facts, or the host's own review; hosts need not
   * import any web-app code. Resolve `null` to keep the standard card for an
   * approval the host has no review for.
   */
  loadReview?:
    | ((approval: PendingApproval) => Promise<ToolActionReview | null | undefined>)
    | undefined;
  loadDetails?: ToolReviewDetailsLoader | undefined;
  onViewDetails?: ((review: ToolActionReview, path: string) => void) | undefined;
  selectedApprovalId?: string | null | undefined;
  onSelectedApprovalChange?: ((id: string) => void) | undefined;
  className?: string | undefined;
};
export type ApprovalField = { key: string; label: string; value: string };

/** Backoff for re-reading a waiting review that offered no decision. */
const UNDECIDABLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000];

function reviewUndecidable(review: ToolActionReview | undefined): review is ToolActionReview {
  return (
    review?.status === "pending" &&
    !review.availableActions.includes("approve") &&
    !review.availableActions.includes("reject")
  );
}

type ReviewLoader = NonNullable<ApprovalSurfaceProps["loadReview"]>;
/** What one read of an approval's review settled to, as its card shows it. */
type ReviewOutcome =
  | { kind: "review"; review: ToolActionReview }
  | { kind: "legacy" }
  | { kind: "denied" }
  | { kind: "failed" };
type ReviewRead = {
  approval: PendingApproval;
  loader: ReviewLoader;
  promise: Promise<ToolActionReview | null | undefined>;
  /** The card has used this read; its next read (a retry) asks again. */
  consumed: boolean;
};

function reviewOutcome(
  approval: PendingApproval,
  settled: { review: ToolActionReview | null | undefined } | { error: unknown },
): ReviewOutcome {
  if ("error" in settled) {
    const { error } = settled;
    if (error instanceof OpenGeniApiError && error.status === 404) return { kind: "legacy" };
    if (error instanceof OpenGeniApiError && (error.status === 401 || error.status === 403))
      return { kind: "denied" };
    return { kind: "failed" };
  }
  const { review } = settled;
  if (review === null || review === undefined) return { kind: "legacy" };
  return review.id === approval.id ? { kind: "review", review } : { kind: "failed" };
}

/**
 * Which bulk decisions include an approval: exactly the buttons its own card
 * offers without asking for anything more. `outcome` is undefined while its
 * review is still being read, which includes it in neither.
 */
export function bulkApprovalDecisions(
  approval: PendingApproval,
  review: { loader: boolean; outcome?: ReviewOutcome | undefined },
): { approve: boolean; reject: boolean } {
  // A server's question is answered on its own card; it can only be declined in bulk.
  if (approval.elicitation) return { approve: false, reject: true };
  const recoverable = approval.arguments !== undefined;
  if (!review.loader) return { approve: recoverable, reject: true };
  const outcome = review.outcome;
  if (!outcome || outcome.kind === "denied") return { approve: false, reject: false };
  if (outcome.kind === "legacy") return { approve: recoverable, reject: true };
  if (outcome.kind === "failed") return { approve: false, reject: true };
  const saved = outcome.review;
  if (saved.status !== "pending") return { approve: false, reject: false };
  return {
    approve: saved.availableActions.includes("approve"),
    reject: saved.availableActions.includes("reject"),
  };
}

type BulkFailure = { id: string; title: string; cause: unknown };

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
  // Every read of a waiting approval's review goes through one ledger, so the
  // card and the bulk buttons see the same facts and the card's first read is
  // never repeated. A card's later read (a retry) asks again.
  const readsRef = useRef(new Map<string, ReviewRead>());
  const [outcomes, setOutcomes] = useState<
    Record<
      string,
      {
        approval: PendingApproval;
        loader: ReviewLoader;
        outcome: ReviewOutcome;
      }
    >
  >({});
  const startRead = useCallback((approval: PendingApproval, loader: ReviewLoader) => {
    let promise: Promise<ToolActionReview | null | undefined>;
    try {
      promise = Promise.resolve(loader(approval));
    } catch (cause) {
      promise = Promise.reject(cause);
    }
    const read: ReviewRead = { approval, loader, promise, consumed: false };
    readsRef.current.set(approval.id, read);
    const settle = (settled: Parameters<typeof reviewOutcome>[1]) => {
      // Only the latest read of an approval may answer.
      if (readsRef.current.get(approval.id) !== read) return;
      setOutcomes((current) => ({
        ...current,
        [approval.id]: {
          approval,
          loader,
          outcome: reviewOutcome(approval, settled),
        },
      }));
    };
    promise.then(
      (review) => settle({ review }),
      (cause: unknown) => settle({ error: cause }),
    );
    return read;
  }, []);
  const sharedLoadReview = useMemo<ReviewLoader | undefined>(
    () =>
      loadReview
        ? (approval) => {
            const read = readsRef.current.get(approval.id);
            if (
              read &&
              !read.consumed &&
              read.loader === loadReview &&
              dequal(read.approval, approval)
            ) {
              read.consumed = true;
              return read.promise;
            }
            const fresh = startRead(approval, loadReview);
            fresh.consumed = true;
            return fresh.promise;
          }
        : undefined,
    [loadReview, startRead],
  );
  // With two or more waiting, read every review: the bulk buttons include an
  // action only when its own card would offer that decision. One alone has no
  // bulk buttons, so only its card reads it.
  useEffect(() => {
    const live = new Set(approvals.map((approval) => approval.id));
    for (const id of readsRef.current.keys()) if (!live.has(id)) readsRef.current.delete(id);
    setOutcomes((current) =>
      Object.keys(current).every((id) => live.has(id))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
    );
    if (!loadReview || approvals.length < 2) return;
    for (const approval of approvals) {
      if (approval.elicitation) continue;
      const read = readsRef.current.get(approval.id);
      if (read && read.loader === loadReview && dequal(read.approval, approval)) continue;
      startRead(approval, loadReview);
    }
  }, [approvals, loadReview, startRead]);
  // A read taken between states ("can't be decided yet") or one that failed is
  // read again on the same backoff the selected card uses, so the bulk counts
  // catch up. The selected card re-reads its own.
  const rereadsRef = useRef(new Map<string, number>());
  const visibleId = selectedApprovalId === undefined ? localSelectedId : selectedApprovalId;
  useEffect(() => {
    if (!loadReview || approvals.length < 2) return;
    const shownId = (approvals.find((approval) => approval.id === visibleId) ?? approvals[0])!.id;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const approval of approvals) {
      const settled = outcomes[approval.id];
      if (
        approval.id === shownId ||
        !settled ||
        settled.loader !== loadReview ||
        !dequal(settled.approval, approval)
      )
        continue;
      const again =
        settled.outcome.kind === "failed" ||
        (settled.outcome.kind === "review" && reviewUndecidable(settled.outcome.review));
      if (!again) {
        rereadsRef.current.delete(approval.id);
        continue;
      }
      const attempt = rereadsRef.current.get(approval.id) ?? 0;
      const limit = settled.outcome.kind === "failed" ? 1 : UNDECIDABLE_RETRY_DELAYS_MS.length;
      if (attempt >= limit) continue;
      timers.push(
        setTimeout(() => {
          rereadsRef.current.set(approval.id, attempt + 1);
          startRead(approval, loadReview);
        }, UNDECIDABLE_RETRY_DELAYS_MS[attempt]!),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [approvals, loadReview, outcomes, startRead, visibleId]);
  const [bulk, setBulk] = useState<{
    decision: "approve" | "reject";
    index: number;
    length: number;
  } | null>(null);
  const bulkRef = useRef(false);
  const bulkProgress = useRef<HTMLSpanElement>(null);
  // Decided by a run and not yet gone from the list: never offered again, and
  // their cards wait, as a single card's decision waits for its removal.
  const [bulkDecided, setBulkDecided] = useState<
    Record<string, { approval: PendingApproval; decision: "approve" | "reject" }>
  >({});
  useEffect(() => {
    setBulkDecided((current) => {
      const kept = Object.entries(current).filter(([id, entry]) =>
        approvals.some((approval) => approval.id === id && dequal(approval, entry.approval)),
      );
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [approvals]);
  const [bulkFailures, setBulkFailures] = useState<{
    decision: "approve" | "reject";
    items: BulkFailure[];
  } | null>(null);
  // The bulk run reads the latest waiting list between decisions.
  const approvalsRef = useRef(approvals);
  useLayoutEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (pending && !approvals.some((approval) => approval.id === pending.id)) {
      pendingRef.current = null;
      setPending(null);
      // Hand focus to the next card without moving the view: a reader at the
      // bottom already sees it, and one who scrolled up keeps their place.
      requestAnimationFrame(() =>
        surface.current?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true }),
      );
    }
  }, [approvals, pending]);
  if (!approvals.length) return null;
  const selectedIndex = Math.max(
    0,
    approvals.findIndex((approval) => approval.id === selectedId),
  );
  const selected = approvals[selectedIndex]!;
  const decidedBy = (approval: PendingApproval) => {
    const entry = bulkDecided[approval.id];
    return entry && dequal(entry.approval, approval) ? entry.decision : null;
  };
  const decide = async (
    approval: PendingApproval,
    decision: "approve" | "reject",
    answer?: McpElicitationAnswer,
  ) => {
    if (responding || pendingRef.current || bulkRef.current || decidedBy(approval)) return;
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
  const bulkEligible = {
    approve: [] as PendingApproval[],
    reject: [] as PendingApproval[],
  };
  for (const approval of approvals) {
    if (decidedBy(approval)) continue;
    const read = outcomes[approval.id];
    const outcome =
      read && read.loader === loadReview && dequal(read.approval, approval)
        ? read.outcome
        : undefined;
    const decisions = bulkApprovalDecisions(approval, {
      loader: Boolean(loadReview),
      outcome,
    });
    if (decisions.approve) bulkEligible.approve.push(approval);
    if (decisions.reject) bulkEligible.reject.push(approval);
  }
  const titleOf = (approval: PendingApproval) => {
    const read = outcomes[approval.id];
    const review =
      read?.outcome.kind === "review" && dequal(read.approval, approval)
        ? read.outcome.review
        : pendingApprovalReview(approval, {
            formatToolName: messages.formatToolName,
            approveLabel: messages.approve,
          });
    return toolActionTitle(t, review.toolName) ?? review.title;
  };
  const decideAll = async (decision: "approve" | "reject") => {
    if (responding || pendingRef.current || bulkRef.current) return;
    // The actions the person saw, as they saw them. One that arrives meanwhile
    // waits for its own decision; one that changes or goes is skipped.
    const snapshot = bulkEligible[decision].map((approval) => ({
      approval,
      title: titleOf(approval),
    }));
    if (snapshot.length < 2) return;
    bulkRef.current = true;
    setDecisionError(null);
    setBulkFailures(null);
    // Keep keyboard focus in the stack once the progress replaces the buttons.
    const refocus = surface.current?.contains(document.activeElement) ?? false;
    let focused = false;
    const failures: BulkFailure[] = [];
    for (const [index, { approval, title }] of snapshot.entries()) {
      if (!mountedRef.current) break;
      const current = approvalsRef.current.find((candidate) => candidate.id === approval.id);
      if (!current || !dequal(current, approval)) continue;
      setBulk({ decision, index, length: snapshot.length });
      if (refocus && !focused) {
        focused = true;
        requestAnimationFrame(() => bulkProgress.current?.focus({ preventScroll: true }));
      }
      try {
        // Each action is its own decision through the host's ordinary path.
        await (decision === "approve" ? onApprove(current) : onReject(current));
      } catch (cause) {
        // Already decided elsewhere: nothing is left to do for it.
        if (!(cause instanceof OpenGeniApiError && cause.status === 409)) {
          failures.push({ id: approval.id, title, cause });
          continue;
        }
      }
      if (mountedRef.current)
        setBulkDecided((decided) => ({ ...decided, [approval.id]: { approval, decision } }));
    }
    bulkRef.current = false;
    if (!mountedRef.current) return;
    setBulk(null);
    if (failures.length) {
      setBulkFailures({ decision, items: failures });
      setSelectedId(failures[0]!.id);
    }
    // Only take focus back if it was in the stack and has been lost since;
    // never from wherever the person moved during the run.
    if (refocus)
      requestAnimationFrame(() => {
        const root = surface.current;
        const active = document.activeElement;
        if (root && (!active || active === document.body))
          root.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
      });
  };
  const waitingIds = new Set(approvals.map((approval) => approval.id));
  const shownFailures = bulkFailures?.items.filter((item) => waitingIds.has(item.id)) ?? [];
  const bulkBusy = Boolean(responding || pending || bulk);
  // The failure list names each failed action; the host's own error for the
  // last of them would only repeat one line of it.
  const errorText = decisionError
    ? formatError(decisionError.cause)
    : shownFailures.length
      ? null
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
      {/* The run's progress stays while its last action is decided. */}
      {(approvals.length > 1 || bulk) && (
        <nav
          aria-label={t("approvalSurface.actionsToReview")}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-og-xs text-og-fg-muted"
        >
          {approvals.length > 1 ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-og-fg">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-og-status-waiting" />
              {t("approvalSurface.lengthActionsAreWaitingFor", {
                length: approvals.length,
              })}
            </span>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {bulk ? (
              <span
                ref={bulkProgress}
                tabIndex={-1}
                role="status"
                className="inline-flex min-h-8 items-center gap-1.5 outline-hidden [@media(pointer:coarse)]:min-h-11"
                data-og-approval-bulk-progress=""
              >
                <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
                {t(
                  bulk.decision === "approve"
                    ? "approvalSurface.approvingIndexOfLength"
                    : "approvalSurface.decliningIndexOfLength",
                  { index: bulk.index + 1, length: bulk.length },
                )}
              </span>
            ) : bulkEligible.approve.length > 1 || bulkEligible.reject.length > 1 ? (
              <div className="flex items-center gap-1" data-og-approval-bulk="">
                {bulkEligible.reject.length > 1 && (
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void decideAll("reject")}
                    className="inline-flex min-h-8 items-center rounded-og-md px-2 font-medium hover:bg-og-hover hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                  >
                    {t("approvalSurface.declineAll")}
                  </button>
                )}
                {bulkEligible.approve.length > 1 && (
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void decideAll("approve")}
                    className="inline-flex min-h-8 items-center rounded-og-md border border-og-border bg-og-surface-1 px-2.5 font-medium text-og-fg hover:border-og-border-strong hover:bg-og-hover disabled:cursor-not-allowed disabled:opacity-55 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                  >
                    {t("approvalSurface.approveAll", {
                      length: bulkEligible.approve.length,
                    })}
                  </button>
                )}
              </div>
            ) : null}
            {approvals.length > 1 && (
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
            )}
          </div>
        </nav>
      )}
      <div>
        {[selected].map((approval) => (
          <ApprovalRequest
            key={approval.id}
            approval={approval}
            loadReview={sharedLoadReview}
            loadDetails={loadDetails}
            messages={messages}
            custom={renderApproval?.(approval)}
            onViewDetails={onViewDetails}
            submitting={pending?.id === approval.id ? pending.decision : decidedBy(approval)}
            disabled={bulkBusy || decidedBy(approval) !== null}
            onApprove={() => void decide(approval, "approve")}
            onAnswer={(content) =>
              approval.elicitation
                ? void decide(approval, "approve", {
                    content,
                    elicitationRound: approval.elicitation.round,
                  })
                : undefined
            }
            onReject={() => void decide(approval, "reject")}
          />
        ))}
      </div>
      {shownFailures.length > 0 && bulkFailures && (
        <ul
          role="alert"
          className="m-0 list-none space-y-1 p-0 px-1 text-og-sm text-og-status-failed"
        >
          {shownFailures.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-current={item.id === selected.id || undefined}
                onClick={() => setSelectedId(item.id)}
                className="min-h-8 text-left underline-offset-4 hover:underline [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
              >
                {t(
                  bulkFailures.decision === "approve"
                    ? "approvalSurface.couldnTApproveTitle"
                    : "approvalSurface.couldnTDeclineTitle",
                  { title: item.title, error: formatError(item.cause) },
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
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
  // Hide stale facts during render, before passive effect cleanup can run. A
  // re-read of the same undecided action (same facts, same loader) keeps its
  // notice up meanwhile.
  const current =
    result?.request === request ||
    (result !== null &&
      result.request.loadReview === request.loadReview &&
      reviewUndecidable(result.review) &&
      dequal(result.request.approval, request.approval))
      ? result
      : null;
  const loaded = current?.review;
  const failed = current?.failed;
  const legacy = current?.legacy;
  const denied = current?.denied;
  // Still waiting, yet the saved review offers no decision: it was read while
  // the chat was between states. Never a silent footer: say so, offer a retry,
  // and re-read it on its own a few times.
  const undecidable = reviewUndecidable(loaded);
  const undecidableRetries = useRef(0);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (request.loadReview)
      void request.loadReview(request.approval).then(
        (review) => {
          if (active) {
            setResult(
              review === null || review === undefined
                ? { request, legacy: true }
                : review.id !== request.approval.id
                  ? { request, failed: true }
                  : { request, review },
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
  // Each automatic re-read waits from when the previous read answered.
  const readSettled = result?.request === request;
  useEffect(() => {
    if (
      !undecidable ||
      !readSettled ||
      undecidableRetries.current >= UNDECIDABLE_RETRY_DELAYS_MS.length
    )
      return;
    const delay = UNDECIDABLE_RETRY_DELAYS_MS[undecidableRetries.current]!;
    const timer = setTimeout(() => {
      undecidableRetries.current += 1;
      setRetry((value) => value + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [undecidable, readSettled, request]);
  const stableApproval = request.approval;
  const { formatToolName, approve: approveLabel } = messages;
  const toolName = approvalToolName(stableApproval);
  const answer = approvalAnswerLabels(t, toolName);
  const fallback = useMemo<ToolActionReview>(
    () =>
      wordedToolActionReview(
        pendingApprovalReview(stableApproval, { formatToolName, approveLabel }),
        t,
      ),
    [stableApproval, formatToolName, approveLabel, t],
  );
  const loadLegacyDetails = useCallback<ToolReviewDetailsLoader>(
    async (value, path, offset) => ({
      version: 1,
      id: value.id,
      actionDigest: value.actionDigest,
      ...toolReviewDetails(stableApproval.arguments, undefined, path, offset, 25, toolName),
    }),
    [stableApproval, toolName],
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
          <DecisionActions>
            <DeclineButton
              busy={Boolean(actions.disabled || actions.submitting)}
              submitting={actions.submitting === "reject"}
              label={answer?.reject ?? messages.reject}
              onClick={actions.onReject}
            />
          </DecisionActions>
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
  if (undecidable)
    return (
      <div data-approval-id={approval.id} data-review-origin="pending">
        {custom}
        <ToolReviewFrame
          tone="waiting"
          icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}
          eyebrow={messages.title}
          title={loaded.title}
          subtitle={loaded.accountLabel}
          data-og-tool-review=""
          data-og-tool-review-undecidable=""
        >
          <p className="m-0 text-og-sm text-og-fg">
            <span role="status">{t("approvalSurface.thisActionCanTBeDecided")}</span>{" "}
            <button
              type="button"
              className="min-h-8 font-medium underline underline-offset-4 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
              onClick={() => {
                // Asking again starts a fresh round of automatic re-reads.
                undecidableRetries.current = 0;
                setRetry((value) => value + 1);
              }}
            >
              {t("approvalSurface.tryAgain")}
            </button>
          </p>
        </ToolReviewFrame>
      </div>
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
            <DecisionActions>
              <DeclineButton
                busy={Boolean(actions.disabled || actions.submitting)}
                submitting={actions.submitting === "reject"}
                label={answer?.reject ?? messages.reject}
                onClick={actions.onReject}
              />
            </DecisionActions>
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
          key={`${stableApproval.elicitation.round}:${JSON.stringify(stableApproval.elicitation)}`}
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
