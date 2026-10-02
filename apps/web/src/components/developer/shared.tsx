import type { IntegrationWorkspaceFilter } from "@opengeni/sdk";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CopyField } from "@/components/ui/copy-field";
import { ErrorMessage } from "@/components/ui/error-message";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { apiErrorAdvice, apiErrorDetails, isPermissionDenied } from "@/lib/api-error";

/**
 * Data for one part of a page: loading, ready, refused for this viewer (a
 * permission they lack, never an error), or failed.
 */
export type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "denied" }
  | { kind: "failed"; error: unknown };

export function useLoad<T>(
  read: () => Promise<T>,
): [Load<T>, () => Promise<void>, (value: T) => void] {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const value = await read();
      if (mine === sequence.current) setState({ kind: "ready", value });
    } catch (error) {
      if (mine !== sequence.current) return;
      setState(isPermissionDenied(error) ? { kind: "denied" } : { kind: "failed", error });
    }
  }, [read]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);
  const set = useCallback((value: T) => {
    sequence.current += 1;
    setState({ kind: "ready", value });
  }, []);
  return [state, load, set];
}

/** A failed action: what happened as the title, what to do under it. */
export function actionFailed(what: string, error: unknown) {
  toast.error(what, { description: apiErrorAdvice(error) });
}

/** A section's rows failed to load: one row with Try again, the reference in Technical details. */
export function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <ErrorMessage
      className="py-4"
      title={title}
      action={<RowButton onClick={onRetry}>Try again</RowButton>}
      {...apiErrorDetails(error)}
    >
      {apiErrorAdvice(error)}
    </ErrorMessage>
  );
}

/** The viewer can't manage this: say who can, calmly. */
export function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Notice tone="muted" title={title}>
      {children}
    </Notice>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/55"
    >
      {children}
      <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/** What a receiver needs next to its secret: the id it maps to its own tenant, and the guide. */
export function IdLine({
  label,
  value,
  guideHref,
}: {
  label: "Workspace ID" | "Organization ID";
  value: string;
  guideHref: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-xs leading-4.5 text-fg-muted">
      <span className="inline-flex max-w-full min-w-0 items-center gap-2">
        <span className="shrink-0">{label}</span>
        <CopyField value={value} label={label.toLowerCase()} truncate="middle" />
      </span>
      <ExternalLink href={guideHref}>Developer guide</ExternalLink>
    </div>
  );
}

/** "https://product.example/opengeni/events" -> "product.example/opengeni/events". */
export function displayUrl(url: string): string {
  return url.replace(/^https:\/\//i, "").replace(/\/$/, "");
}

/** The host, for a page title. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Which workspaces an organization registration reaches, in words. */
export function workspaceFilterLabel(
  filter: IntegrationWorkspaceFilter | null | undefined,
): string {
  return filter ? `Shared workspaces from ${filter.externalSource}` : "Every shared workspace";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct 2026", the same form as API key dates. */
export function dateLabel(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "in 4 min", for a time that is coming. */
export function untilLabel(date: string, now = Date.now()): string {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  if (seconds <= 30) return "now";
  if (seconds < 90) return "in a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}
