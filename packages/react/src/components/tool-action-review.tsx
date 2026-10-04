import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import type { ToolActionReview, ToolReviewDetailsPage, ToolReviewStatus } from "@opengeni/sdk";
import { cn } from "../lib/cn";

export type ToolReviewDetailsLoader = (
  review: ToolActionReview,
  path: string,
  offset: number,
) => Promise<ToolReviewDetailsPage>;

const statusText: Record<ToolReviewStatus, string> = {
  pending: "Approval needed",
  approved: "Approved",
  executing: "Approved · running",
  completed: "Approved · done",
  partial: "Partly done",
  unknown: "Outcome unknown",
  rejected: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  revoked: "Access unavailable",
  blocked: "Blocked",
  stale: "No longer valid",
  failed: "Failed",
  unavailable: "Details unavailable",
};
const statusDetail: Partial<Record<ToolReviewStatus, string>> = {
  unknown: "It may have run. Check the result before trying again.",
  rejected: "This action did not run.",
  cancelled: "This action did not run.",
  expired: "This action did not run. Ask the agent to prepare it again.",
  revoked: "This action did not run. Reconnect the account, then ask the agent to try again.",
  stale: "The tool or account changed after this was prepared, so it did not run.",
  partial: "Some of it ran. Check the result before continuing.",
  failed: "The action ran but returned an error.",
};
type Tone = "waiting" | "ok" | "failed" | "muted";
const statusTone: Record<ToolReviewStatus, Tone> = {
  pending: "waiting",
  approved: "ok",
  executing: "ok",
  completed: "ok",
  partial: "failed",
  unknown: "failed",
  rejected: "muted",
  cancelled: "muted",
  expired: "muted",
  revoked: "muted",
  blocked: "muted",
  stale: "muted",
  failed: "failed",
  unavailable: "muted",
};
const toneText: Record<Tone, string> = {
  waiting: "text-og-status-waiting",
  ok: "text-og-fg-muted",
  failed: "text-og-status-failed",
  muted: "text-og-fg-muted",
};
/** Fields that only identify the selection; the count, examples and details cover them. */
const selectionPaths = new Set([
  "/messageIds",
  "/messageId",
  "/threadId",
  "/addLabelIds",
  "/removeLabelIds",
  "/labelIds",
]);
/** Shown when an older request's saved values are gone: approval is impossible, decline is not. */
export const UNRECOVERABLE_TEXT =
  "The details of this older request couldn't be recovered, so it can't be approved. Decline it to let the agent continue.";
/** Long argument lists stay readable; the full set is one click away in details. */
const VISIBLE_FIELDS = 6;

function StatusIcon({ status, busy }: { status: ToolReviewStatus; busy?: boolean }) {
  const className = "size-4";
  if (busy || status === "executing" || status === "approved")
    return <LoaderCircleIcon aria-hidden="true" className={cn(className, "animate-spin")} />;
  if (status === "pending") return <ShieldCheckIcon aria-hidden="true" className={className} />;
  if (status === "completed") return <CheckIcon aria-hidden="true" className={className} />;
  if (statusTone[status] === "failed")
    return <CircleAlertIcon aria-hidden="true" className={className} />;
  return <CircleSlashIcon aria-hidden="true" className={className} />;
}

/** Card chrome shared by the review, its loading state and its load failure. */
export function ToolReviewFrame({
  tone,
  icon,
  eyebrow,
  title,
  titleId,
  subtitle,
  children,
  footer,
  bare = false,
  ...rest
}: {
  tone: Tone;
  icon: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  titleId?: string | undefined;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  bare?: boolean | undefined;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  const waiting = tone === "waiting";
  return (
    <article
      aria-labelledby={titleId}
      {...rest}
      className={cn(
        "min-w-0 text-og-fg",
        !bare &&
          (waiting
            ? "overflow-hidden rounded-og-lg border border-og-status-waiting/35 bg-og-status-waiting/5 shadow-og-sm"
            : "overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1"),
        rest.className,
      )}
    >
      <header className={cn("flex min-w-0 items-start gap-3", bare ? "pb-1" : "px-4 py-3")}>
        <span
          className={cn(
            "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-og-md",
            waiting
              ? "bg-og-status-waiting/12 text-og-status-waiting"
              : tone === "failed"
                ? "bg-og-status-failed/10 text-og-status-failed"
                : "bg-og-fg/5 text-og-fg-muted",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn("m-0 text-og-xs font-medium", toneText[tone])}
            role="status"
            aria-live="polite"
          >
            {eyebrow}
          </p>
          <h3
            tabIndex={-1}
            id={titleId}
            className="m-0 mt-0.5 break-words text-og-md font-semibold leading-snug text-og-fg outline-hidden [overflow-wrap:anywhere]"
          >
            {title}
          </h3>
          {subtitle ? (
            <p className="m-0 mt-0.5 break-words text-og-xs text-og-fg-muted [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
      </header>
      {children ? (
        <div
          className={cn(
            "min-w-0",
            bare ? "pt-2" : "px-4 pb-3",
            !bare && "sm:pl-[3.75rem]", // Aligns with the title, past the icon.
          )}
        >
          {children}
        </div>
      ) : null}
      {footer ? (
        <footer
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2",
            bare
              ? "pt-3"
              : waiting
                ? "border-t border-og-status-waiting/20 px-4 py-3"
                : "border-t border-og-border px-4 py-3",
          )}
        >
          {footer}
        </footer>
      ) : null}
    </article>
  );
}

const linkButton =
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40 inline-flex min-h-8 items-center gap-1 rounded-og-sm text-left text-og-sm text-og-fg underline decoration-og-border-strong underline-offset-4 hover:decoration-current [@media(pointer:coarse)]:min-h-11";

/** The facts of one saved action: consequences, selection and its key values. */
function ReviewFacts({
  review,
  onViewDetails,
  showStatusDetail,
}: {
  review: ToolActionReview;
  onViewDetails?: ((path: string) => void) | undefined;
  showStatusDetail: boolean;
}) {
  const canOpen = Boolean(onViewDetails && review.detailsAvailable);
  const selection =
    review.selectionCount === undefined
      ? undefined
      : review.fields.find((field) =>
          ["/messageIds", "/messageId", "/threadId"].includes(field.path),
        );
  const fields = selection
    ? review.fields.filter((field) => !selectionPaths.has(field.path))
    : review.fields;
  const shown = fields.slice(0, VISIBLE_FIELDS);
  const hiddenFields = fields.length - shown.length + review.moreFields;
  // The title already names the main effect; list only the remaining ones.
  const effects = review.effects.filter(
    (effect) => effect !== review.approveLabel && !review.title.startsWith(effect),
  );
  const note =
    (showStatusDetail
      ? review.status === "blocked"
        ? `${review.reason || "Your permission settings block this action."} It did not run.`
        : statusDetail[review.status]
      : undefined) ?? review.consequence;
  const samples = review.samples ?? [];
  const count = review.selectionCount ?? 0;
  const noun =
    review.selectionKind === "threads"
      ? count === 1
        ? "conversation"
        : "conversations"
      : count === 1
        ? "message"
        : "messages";
  const hasContent =
    note || effects.length || selection || shown.length || hiddenFields > 0 || samples.length;
  if (!hasContent) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-og-sm">
      {note ? <p className="m-0 leading-relaxed text-og-fg-muted">{note}</p> : null}
      {effects.length > 0 ? (
        <ul className="m-0 list-none space-y-1 p-0" aria-label="Also changes">
          {effects.map((effect) => (
            <li key={effect} className="flex items-start gap-2 text-og-fg">
              <span
                aria-hidden="true"
                className="mt-[0.55em] size-1 shrink-0 rounded-full bg-og-fg-muted"
              />
              <span className="min-w-0 break-words">{effect}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {selection ? (
        <div className="min-w-0">
          {samples.length > 0 ? (
            <>
              <p className="m-0 mb-1 text-og-xs text-og-fg-muted">Includes</p>
              <ul className="m-0 list-none divide-y divide-og-border rounded-og-md border border-og-border bg-og-surface-1 p-0">
                {samples.map((sample) => (
                  <li key={sample.id} className="min-w-0 px-3 py-2">
                    <p className="m-0 truncate text-og-sm text-og-fg">{sample.title}</p>
                    {sample.subtitle ? (
                      <p className="m-0 mt-0.5 truncate text-og-xs text-og-fg-muted">
                        {sample.subtitle}
                      </p>
                    ) : null}
                  </li>
                ))}
                {count > samples.length ? (
                  <li className="px-3 py-2 text-og-xs text-og-fg-muted">
                    and {(count - samples.length).toLocaleString()} more
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
          {canOpen && count > 0 ? (
            <button
              type="button"
              className={cn(linkButton, samples.length > 0 && "mt-1")}
              data-review-path={selection.path}
              onClick={() => onViewDetails!(selection.path)}
            >
              {count === 1 ? `View the ${noun}` : `View all ${count.toLocaleString()} ${noun}`}
              <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <dl className="m-0 min-w-0 space-y-2">
          {shown.map((field) => (
            <div
              key={field.path}
              className="grid min-w-0 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]"
            >
              <dt className="m-0 break-words text-og-xs text-og-fg-muted sm:pt-px sm:text-og-sm">
                {field.label}
              </dt>
              <dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-og-fg [overflow-wrap:anywhere]">
                {field.protected ? (
                  <span className="text-og-fg-muted">Hidden</span>
                ) : field.truncated && canOpen ? (
                  <button
                    type="button"
                    data-review-path={field.path}
                    aria-label={`View ${field.label}: ${field.preview}`}
                    onClick={() => onViewDetails!(field.path)}
                    className={cn(linkButton, "max-w-full")}
                  >
                    <span className="line-clamp-4 min-w-0 break-words [overflow-wrap:anywhere]">
                      {field.preview}
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  </button>
                ) : (
                  field.preview
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hiddenFields > 0 ? (
        <p className="m-0 text-og-xs text-og-fg-muted">
          {hiddenFields === 1 ? "1 more value" : `${hiddenFields} more values`} in details
        </p>
      ) : null}
    </div>
  );
}

export function DeclineButton({
  busy,
  submitting,
  label,
  onClick,
}: {
  busy: boolean;
  submitting: boolean;
  label?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex min-h-9 items-center justify-center rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg transition-colors hover:border-og-border-strong hover:bg-og-hover disabled:opacity-60 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
    >
      {submitting ? "Declining…" : (label ?? "Decline")}
    </button>
  );
}

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
  bare,
}: {
  review: ToolActionReview;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  submitting?: "approve" | "reject" | null | undefined;
  disabled?: boolean | undefined;
  onViewDetails?: ((path: string) => void) | undefined;
  pendingLabel?: string | undefined;
  rejectLabel?: string | undefined;
  /** Render without card chrome, e.g. inside an expanded timeline row. */
  bare?: boolean | undefined;
}) {
  const titleId = useId();
  const canApprove = review.availableActions.includes("approve") && !!onApprove;
  const canReject = review.availableActions.includes("reject") && !!onReject;
  const actionable = review.status === "pending" && (canApprove || canReject);
  const busy = Boolean(disabled || submitting);
  const tone: Tone = statusTone[review.status];
  const eyebrow = submitting
    ? submitting === "approve"
      ? "Approving…"
      : "Declining…"
    : review.status === "pending"
      ? (pendingLabel ?? statusText.pending)
      : statusText[review.status];
  const detailsLink =
    review.detailsAvailable && onViewDetails ? (
      <button
        type="button"
        className="inline-flex min-h-8 items-center rounded-og-sm text-og-sm text-og-fg-muted underline decoration-og-border-strong underline-offset-4 hover:text-og-fg hover:decoration-current [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
        data-review-path=""
        onClick={() => onViewDetails("")}
      >
        Details
      </button>
    ) : null;
  const reason = review.reason.trim();
  return (
    <ToolReviewFrame
      tone={tone}
      icon={<StatusIcon status={review.status} busy={Boolean(submitting)} />}
      eyebrow={eyebrow}
      title={review.title}
      titleId={titleId}
      subtitle={review.accountLabel}
      bare={bare}
      aria-busy={Boolean(submitting)}
      data-og-tool-review=""
      data-review-status={review.status}
      footer={
        actionable ? (
          <>
            <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-3 gap-y-1">
              {detailsLink}
              {reason ? (
                <span className="min-w-0 text-og-xs leading-relaxed text-og-fg-subtle">
                  {reason}
                </span>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
              {canReject ? (
                <DeclineButton
                  busy={busy}
                  submitting={submitting === "reject"}
                  label={rejectLabel}
                  onClick={onReject!}
                />
              ) : null}
              {canApprove ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onApprove}
                  className="inline-flex min-h-9 items-center justify-center gap-2 rounded-og-md border border-og-primary-border bg-og-primary px-3.5 py-1.5 text-og-sm font-medium text-og-primary-fg transition-colors hover:bg-og-primary-hover disabled:opacity-60 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
                >
                  {submitting === "approve" ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  {submitting === "approve" ? "Approving…" : review.approveLabel}
                </button>
              ) : null}
            </div>
          </>
        ) : undefined
      }
    >
      {actionable && !canApprove ? (
        <p className="m-0 mb-3 text-og-sm leading-relaxed text-og-fg">{UNRECOVERABLE_TEXT}</p>
      ) : null}
      <ReviewFacts
        review={review}
        onViewDetails={onViewDetails}
        showStatusDetail={review.status !== "pending"}
      />
      {!actionable && detailsLink ? <div className="mt-2">{detailsLink}</div> : null}
    </ToolReviewFrame>
  );
}

/** Full-page detail content: hosts choose navigation, never a nested scrolling panel. */
export function ToolActionReviewDetails({
  review,
  path: initialPath = "",
  load,
  onBack,
  manageFocus = true,
}: {
  review: ToolActionReview;
  path?: string;
  load: ToolReviewDetailsLoader;
  onBack: () => void;
  /** Hosts rendering simultaneous previews can retain their own focus. */
  manageFocus?: boolean;
}) {
  const [path, setPath] = useState(initialPath);
  const [trail, setTrail] = useState<Array<{ path: string; label: string }>>([]);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ToolReviewDetailsPage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (page && manageFocus && !focusedOnce.current) {
      focusedOnce.current = true;
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: "start" });
    }
  }, [page, manageFocus]);
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
  const open = (next: string, label: string) => {
    setTrail((value) => [...value, { path, label }]);
    setPath(next);
    setOffset(0);
  };
  const up = () => {
    const previous = trail.at(-1);
    setTrail((value) => value.slice(0, -1));
    setPath(previous?.path ?? initialPath);
    setOffset(0);
  };
  return (
    <section
      className="og-root mx-auto w-full max-w-3xl px-4 py-5 text-og-fg sm:px-6"
      data-og-review-details=""
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-og-md pr-2 text-og-sm text-og-fg-muted hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        Back to review
      </button>
      <h2
        ref={heading}
        tabIndex={-1}
        className="m-0 break-words text-og-lg font-semibold outline-hidden [overflow-wrap:anywhere]"
      >
        {review.title}
      </h2>
      {review.accountLabel ? (
        <p className="m-0 mt-1 text-og-sm text-og-fg-muted">{review.accountLabel}</p>
      ) : null}
      <p className="m-0 mt-2 text-og-xs text-og-fg-subtle">
        The exact values saved for this action. Passwords and keys stay hidden.
      </p>
      {trail.length > 0 ? (
        <button
          type="button"
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-og-sm text-og-fg-muted underline underline-offset-4 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
          onClick={up}
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Back to {trail.at(-1)?.label ?? "all values"}
        </button>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4 py-4 text-og-sm">
          Couldn't load these details.{" "}
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="min-h-11 underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
          >
            Try again
          </button>
        </div>
      ) : !page ? (
        <p role="status" className="mt-4 py-4 text-og-sm text-og-fg-muted">
          Loading details…
        </p>
      ) : (
        <>
          <dl className="m-0 mt-4 divide-y divide-og-border border-y border-og-border">
            {page.items.map((item) => (
              <div key={`${page.path}:${item.label}`} className="py-3">
                <dt className="m-0 text-og-xs text-og-fg-muted">{item.label}</dt>
                <dd className="m-0 mt-1 whitespace-pre-wrap break-words text-og-sm leading-relaxed [overflow-wrap:anywhere]">
                  {item.truncated && item.path ? (
                    <button
                      type="button"
                      aria-label={`Open ${item.label}`}
                      className={cn(linkButton, "max-w-full")}
                      onClick={() => open(item.path!, item.label)}
                    >
                      <span className="min-w-0 break-words focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40">
                        {item.value}
                      </span>
                      <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  ) : (
                    item.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {page.total > page.items.length || offset > 0 ? (
            <nav
              aria-label="Detail pages"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 text-og-sm"
            >
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
                className="min-h-11 rounded-og-md border border-og-border px-3 hover:bg-og-hover disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
              >
                Previous
              </button>
              <span className="text-og-fg-muted tabular-nums">
                {page.total === 0
                  ? "No items"
                  : `${(offset + 1).toLocaleString()}–${(offset + page.items.length).toLocaleString()} of ${page.total.toLocaleString()}`}
              </span>
              <button
                type="button"
                disabled={page.nextOffset === null}
                onClick={() => setOffset(page.nextOffset ?? offset)}
                className="min-h-11 rounded-og-md border border-og-border px-3 hover:bg-og-hover disabled:opacity-40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/40"
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
