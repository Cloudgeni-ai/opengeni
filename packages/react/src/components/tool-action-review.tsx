import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ToolActionReview, ToolReviewDetailsPage, ToolReviewStatus } from "@opengeni/sdk";

export type ToolReviewDetailsLoader = (
  review: ToolActionReview,
  path: string,
  offset: number,
) => Promise<ToolReviewDetailsPage>;
const statusText: Record<ToolReviewStatus, string> = {
  pending: "Needs your approval",
  approved: "Approved · waiting to run",
  executing: "In progress",
  completed: "Completed",
  partial: "Partially completed",
  unknown: "Outcome uncertain",
  rejected: "Declined",
  cancelled: "Cancelled",
  expired: "Review expired",
  revoked: "Access unavailable",
  stale: "Action changed",
  failed: "Action failed",
  unavailable: "Details unavailable",
};
const statusDetail: Partial<Record<ToolReviewStatus, string>> = {
  unknown: "Execution may have happened. Check the result before trying again.",
  rejected: "This action was not run.",
  cancelled: "This action will not run.",
  expired: "Prepare a new action to continue.",
  revoked: "Restore access before preparing a new action.",
  stale: "The tool or account changed. A new review is needed.",
  partial: "Some work completed. Review the results before continuing.",
};

/** One host-neutral review. All callbacks refer to the immutable action; none can edit it. */
export function ToolActionReviewCard({
  review,
  onApprove,
  onReject,
  submitting,
  disabled,
  onViewDetails,
  pendingLabel,
  rejectLabel,
}: {
  review: ToolActionReview;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  submitting?: "approve" | "reject" | null | undefined;
  disabled?: boolean | undefined;
  onViewDetails?: ((path: string) => void) | undefined;
  pendingLabel?: string | undefined;
  rejectLabel?: string | undefined;
}) {
  const titleId = useId();
  const actionable = review.status === "pending" && review.availableActions.includes("approve");
  const quiet =
    review.status === "completed" || review.status === "rejected" || review.status === "cancelled";
  const busy = Boolean(disabled || submitting);
  const selection =
    review.selectionCount === undefined
      ? undefined
      : review.fields.find(
          (field) =>
            field.path === "/messageIds" ||
            field.path === "/messageId" ||
            field.path === "/threadId",
        );
  const fields = selection
    ? review.fields.filter(
        (field) =>
          ![selection.path, "/addLabelIds", "/removeLabelIds", "/labelIds"].includes(field.path),
      )
    : review.fields;
  const extraEffects = review.effects.filter((effect) => effect !== review.approveLabel);
  return (
    <article
      aria-labelledby={titleId}
      aria-busy={Boolean(submitting)}
      className="min-w-0 py-4"
      data-og-tool-review=""
      data-review-status={review.status}
    >
      <div className="flex min-w-0 items-center gap-2 text-og-xs text-og-fg-muted" role="status">
        {review.status === "completed" ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        )}
        <span>
          {submitting
            ? submitting === "approve"
              ? "Approving…"
              : "Declining…"
            : review.status === "pending"
              ? (pendingLabel ?? statusText.pending)
              : statusText[review.status]}
        </span>
      </div>
      <h3
        tabIndex={-1}
        id={titleId}
        className="m-0 mt-1.5 outline-none break-words text-og-md font-semibold leading-snug text-og-fg"
      >
        {review.title}
      </h3>
      {review.accountLabel && (
        <p className="m-0 mt-1 break-words text-og-sm text-og-fg-muted">{review.accountLabel}</p>
      )}
      {(statusDetail[review.status] || review.consequence) && (
        <p className="m-0 mt-3 text-og-sm leading-relaxed text-og-fg-muted">
          {statusDetail[review.status] ?? review.consequence}
        </p>
      )}
      {!quiet && (
        <>
          {extraEffects.length > 0 && (
            <ul className="m-0 mt-3 list-none space-y-1 p-0 text-og-sm text-og-fg">
              {extraEffects.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
            </ul>
          )}
          {selection && (
            <div className="mt-4">
              {review.samples && review.samples.length > 0 && (
                <>
                  <p className="m-0 mb-1 text-og-xs text-og-fg-muted">
                    Examples from this selection
                  </p>
                  <ul className="m-0 list-none divide-y divide-og-border p-0">
                    {review.samples.map((sample) => (
                      <li key={sample.id} className="py-2">
                        <p className="m-0 break-words text-og-sm text-og-fg">{sample.title}</p>
                        {sample.subtitle && (
                          <p className="m-0 mt-0.5 break-words text-og-xs text-og-fg-muted">
                            {sample.subtitle}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {onViewDetails && review.detailsAvailable && (
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center gap-1 text-og-sm text-og-fg underline decoration-og-border-strong underline-offset-4 hover:decoration-current"
                  data-review-path={selection.path}
                  onClick={() => onViewDetails(selection.path)}
                >
                  View all {review.selectionCount?.toLocaleString()}{" "}
                  {review.selectionKind ?? "messages"}
                  <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <dl className="m-0 mt-3 divide-y divide-og-border text-og-sm">
            {fields.map((field) => (
              <div
                key={field.path}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 py-2"
              >
                <dt className="m-0 break-words text-og-fg-muted">{field.label}</dt>
                <dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-og-fg [overflow-wrap:anywhere]">
                  {field.truncated &&
                  !field.protected &&
                  onViewDetails &&
                  review.detailsAvailable ? (
                    <button
                      type="button"
                      data-review-path={field.path}
                      onClick={() => onViewDetails(field.path)}
                      className="inline-flex min-h-8 max-w-full items-center gap-1 text-left underline decoration-og-border-strong underline-offset-4 hover:decoration-current [@media(pointer:coarse)]:min-h-11"
                    >
                      <span className="min-w-0 break-words">{field.preview}</span>
                      <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  ) : (
                    field.preview
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {review.moreFields > 0 && (
            <p className="m-0 mt-2 text-og-xs text-og-fg-muted">
              {review.moreFields} more fields in the full details
            </p>
          )}
        </>
      )}
      {review.detailsAvailable && onViewDetails && (
        <button
          type="button"
          className="mt-1 min-h-8 text-og-xs text-og-fg-muted underline underline-offset-4 hover:text-og-fg [@media(pointer:coarse)]:min-h-11"
          data-review-path=""
          onClick={() => onViewDetails("")}
        >
          View full details
        </button>
      )}
      {actionable && (
        <>
          <p className="m-0 mt-3 text-og-xs leading-relaxed text-og-fg-muted">{review.reason}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onApprove}
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-og-md border border-og-primary-border bg-og-primary px-4 py-2 text-og-sm font-medium text-og-primary-fg transition-colors hover:bg-og-primary-hover disabled:opacity-60 [@media(pointer:coarse)]:min-h-11"
            >
              {submitting === "approve" && (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
              )}
              {submitting === "approve" ? "Approving…" : review.approveLabel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onReject}
              className="min-h-9 rounded-og-md px-3 py-2 text-og-sm text-og-fg-muted transition-colors hover:bg-og-fg/5 hover:text-og-fg disabled:opacity-60 [@media(pointer:coarse)]:min-h-11"
            >
              {submitting === "reject" ? "Declining…" : (rejectLabel ?? "Decline")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/** Full-page detail content: hosts choose navigation, never a nested scrolling panel. */
export function ToolActionReviewDetails({
  review,
  path: initialPath = "",
  load,
  onBack,
}: {
  review: ToolActionReview;
  path?: string;
  load: ToolReviewDetailsLoader;
  onBack: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ToolReviewDetailsPage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (page) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: "start" });
    }
  }, [page]);
  useEffect(() => {
    let active = true;
    setPage(null);
    setError(false);
    void load(review, path, offset).then(
      (value) => {
        if (!active) return;
        if (
          value.actionDigest !== review.actionDigest ||
          value.id !== review.id ||
          value.path !== path
        ) {
          setError(true);
          return;
        }
        setPage(value);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [review, path, offset, load, retry]);
  return (
    <section className="og-root mx-auto w-full max-w-3xl p-6 text-og-fg" data-og-review-details="">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 inline-flex min-h-11 items-center gap-2 text-og-sm text-og-fg-muted hover:text-og-fg"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to review
      </button>
      <h2
        ref={heading}
        tabIndex={-1}
        className="m-0 break-words text-og-lg font-semibold outline-none"
      >
        {review.title}
      </h2>
      {review.accountLabel && <p className="text-og-sm text-og-fg-muted">{review.accountLabel}</p>}
      <p className="text-og-sm text-og-fg-muted">
        Exact saved selection and values. Protected credentials stay hidden.
      </p>
      {path !== initialPath && (
        <button
          type="button"
          className="min-h-11 text-og-sm underline"
          onClick={() => {
            setPath(initialPath);
            setOffset(0);
          }}
        >
          Back to all fields
        </button>
      )}
      {error ? (
        <div role="alert" className="py-6 text-og-sm">
          Details could not be loaded.{" "}
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="min-h-11 underline"
          >
            Try again
          </button>
        </div>
      ) : !page ? (
        <p role="status" className="py-6 text-og-sm text-og-fg-muted">
          Loading details…
        </p>
      ) : (
        <>
          <dl className="m-0 divide-y divide-og-border">
            {page.items.map((item) => (
              <div key={`${page.path}:${item.label}`} className="py-4">
                <dt className="m-0 text-og-xs text-og-fg-muted">{item.label}</dt>
                <dd className="m-0 mt-1 whitespace-pre-wrap break-words text-og-sm leading-relaxed [overflow-wrap:anywhere]">
                  {item.value}
                  {item.truncated && item.path && (
                    <button
                      type="button"
                      aria-label={`Open complete ${item.label}`}
                      className="mt-2 block min-h-11 text-og-sm underline underline-offset-4"
                      onClick={() => {
                        setPath(item.path!);
                        setOffset(0);
                      }}
                    >
                      Open complete field
                    </button>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <nav
            aria-label="Review detail pages"
            className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-og-border pt-4 text-og-sm"
          >
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
              className="min-h-11 rounded-og-md border border-og-border px-3 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-og-fg-muted">
              {page.total === 0
                ? "No items"
                : `${offset + 1}–${offset + page.items.length} of ${page.total.toLocaleString()}`}
            </span>
            <button
              type="button"
              disabled={page.nextOffset === null}
              onClick={() => setOffset(page.nextOffset ?? offset)}
              className="min-h-11 rounded-og-md border border-og-border px-3 disabled:opacity-40"
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
