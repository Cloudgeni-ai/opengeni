// Shared state and small pieces for the Opengeni Console pages.
import type { ChatClient, ConsoleAuditAction, ConsoleEndUser, ConsoleRange } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Link } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from "react";

import { toast } from "sonner";

import { useOptionalBrowserAccounts } from "@opengeni/react/accounts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import {
  apiErrorDetails,
  apiErrorFacts,
  userErrorText,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { onConsoleHost } from "@/lib/console-route";

export type ConsoleClient = ChatClient<OpenGeniBrowserClient>;

export type ConsoleContextValue = {
  client: ConsoleClient;
  organizationId: string;
  organizationLabel: string;
  /** Keeps the organization in Console links: `search={consoleSearch}`. */
  search: { org: string };
  /** A workspace in this organization the person can open in the app, for links there. */
  appWorkspaceId: string | null;
};

export const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("Console context is not ready");
  return value;
}

/* -------------------------------------------------------------- loading */

export type ConsoleQuery<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
};

/** Loads once per dependency change, drops stale answers, and can reload. */
export function useConsoleQuery<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): ConsoleQuery<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [revision, setRevision] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, error: null, loading: true }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, error, loading: false });
      },
    );
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller names the inputs
  }, [...deps, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}

/* --------------------------------------------------------------- errors */

const CONSOLE_FORBIDDEN = /Opengeni Console is for organization owners and admins/iu;
const REVIEW_OFF = /Session review is off/iu;

export function isConsoleForbidden(error: unknown): boolean {
  const { status, serverMessage } = apiErrorFacts(error);
  return status === 403 && CONSOLE_FORBIDDEN.test(serverMessage ?? "");
}

export function isReviewOff(error: unknown): boolean {
  const { status, serverMessage } = apiErrorFacts(error);
  return status === 403 && REVIEW_OFF.test(serverMessage ?? "");
}

/** Signs out of every account in this browser that Console is using. */
export function useConsoleSignOut(): (() => void) | null {
  const context = useAppContext();
  const accounts = useOptionalBrowserAccounts();
  if (context.clientConfig.auth.mode !== "managedSession") return null;
  const browserAccounts = context.clientConfig.managedAuthSessionSetMode !== "legacy";
  return () => {
    const done =
      browserAccounts && accounts ? accounts.logoutAll() : context.handleManagedSignOut();
    void Promise.resolve(done).catch((error: unknown) =>
      toast.error("Couldn't sign out", { description: userErrorText(error) }),
    );
  };
}

/**
 * Console is for owners and admins: say so, with the way back to the app, or
 * on a Console host (where nothing leads into the app) Sign out.
 */
export function ConsoleForbidden() {
  const signOut = useConsoleSignOut();
  const consoleHost = onConsoleHost();
  return (
    <EmptyState
      variant="page"
      icon={<LockIcon />}
      title="Opengeni Console is for organization owners and admins"
      description="Ask an owner of this organization for access."
      action={
        consoleHost ? (
          signOut ? (
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          ) : undefined
        ) : (
          <Button variant="outline" asChild>
            <Link to="/">Back to Opengeni</Link>
          </Button>
        )
      }
    />
  );
}

/** A failed section: the owner/admin refusal, or what happened with Try again. */
export function ConsoleLoadError({
  error,
  onRetry,
  title = "Couldn't load this.",
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
}) {
  if (isConsoleForbidden(error)) return <ConsoleForbidden />;
  return (
    <ErrorMessage
      title={title}
      announce
      {...apiErrorDetails(error)}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {userErrorTextWithoutReference(error)}
    </ErrorMessage>
  );
}

/* ----------------------------------------------------------- formatting */

export const CONSOLE_RANGES: readonly { value: ConsoleRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export function rangeLabel(range: ConsoleRange): string {
  return `Last ${CONSOLE_RANGES.find((each) => each.value === range)?.label ?? "30 days"}`;
}

/** Micro-USD as the billing pages show money: "$12.40". */
export function formatMicros(micros: number): string {
  return formatMoneyMicros(micros, "usd");
}

const COUNT = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatTokens(value: number): string {
  return value < 10_000 ? COUNT.format(value) : COMPACT.format(value);
}

/** "45 s", "2 min 14 s", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/** The product's own id for the person, else a short form of their subject. */
export function endUserLabel(endUser: ConsoleEndUser | null | undefined): string {
  if (!endUser) return "—";
  if (endUser.externalId) return endUser.externalId;
  const subject = endUser.subjectId.replace(/^(?:external_user|user):/u, "");
  return subject.length > 14 ? `${subject.slice(0, 12)}…` : subject;
}

export function auditActionText(action: ConsoleAuditAction): string {
  switch (action) {
    case "session.transcript_viewed":
      return "Opened a transcript";
    case "session.metadata_viewed":
      return "Opened a session";
    case "settings.review_level_changed":
      return "Changed session review";
    case "workspace.kind_changed":
      return "Changed a workspace's kind";
  }
}

export function ConsolePage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-6">{children}</div>;
}
