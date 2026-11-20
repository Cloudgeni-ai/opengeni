// Shared state and small pieces for the Opengeni Console pages.
import type { ChatClient, ConsoleAuditEvent, ConsoleEndUser, ConsoleRange } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Link } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { CopyField } from "@opengeni/react/ui/copy-field";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { consoleAccessCovers, type ConsoleAccessLevel } from "@/lib/console-access";
import { onConsoleHost } from "@/lib/console-route";
import { rememberConsoleSignedOut } from "@/lib/console-sign-in";
import { orgAgentsApi, useOrgAgentsFlag, type OrgAgentsApi } from "@/lib/organization-agents";

export type ConsoleClient = ChatClient<OpenGeniBrowserClient>;

export type ConsoleContextValue = {
  client: ConsoleClient;
  organizationId: string;
  organizationLabel: string;
  /** Keeps the organization in Console links: `search={consoleSearch}`. */
  search: { org: string };
  /** A workspace in this organization the person can open in the app, for links there. */
  appWorkspaceId: string | null;
  /**
   * What the person may do here (docs/opengeni-console.md, "Roles"): `full`
   * for owners and admins, else their Console role. The API checks every call.
   */
  access: Exclude<ConsoleAccessLevel, "none">;
};

export const ConsoleContext = createContext<ConsoleContextValue | null>(null);

/** Whether the person's Console access allows what needs `needed`. */
export function useConsoleCan(needed: Exclude<ConsoleAccessLevel, "none">): boolean {
  return consoleAccessCovers(useConsole().access, needed);
}

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("Console context is not ready");
  return value;
}

/** Console agents and tool servers calls for this organization. */
export function useOrgAgentsApi(): OrgAgentsApi {
  const { client, organizationId } = useConsole();
  return useMemo(() => orgAgentsApi(client, organizationId), [client, organizationId]);
}

/** Whether this organization has Console agents (the per-organization flag); null while unknown. */
export function useOrgAgentsEnabled(): boolean | null {
  const { client, organizationId } = useConsole();
  return useOrgAgentsFlag(client, organizationId);
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

const CONSOLE_FORBIDDEN =
  /Opengeni Console is for organization owners|Only organization owners and admins can do this in Console/iu;
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
    // On Console's own host, the signed-out page then waits for Continue
    // instead of signing straight back in with the app's session.
    if (onConsoleHost()) rememberConsoleSignedOut();
    const done =
      browserAccounts && accounts ? accounts.logoutAll() : context.handleManagedSignOut();
    void Promise.resolve(done).catch((error: unknown) =>
      toast.error("Couldn't sign out", { description: userErrorText(error) }),
    );
  };
}

/**
 * Console is for owners, admins and members with a Console role (or this page
 * is for owners and admins): say so, with the way back to the app, or on a
 * Console host (where nothing leads into the app) Sign out.
 */
export function ConsoleForbidden({
  ownersAndAdmins = false,
  title,
}: {
  /** A page for owners and admins (the person has a Console role). */
  ownersAndAdmins?: boolean;
  /** Overrides the title for a page the person's Console role doesn't cover. */
  title?: string;
}) {
  const limited = ownersAndAdmins || title !== undefined;
  const signOut = useConsoleSignOut();
  const consoleHost = onConsoleHost();
  return (
    <EmptyState
      variant="page"
      icon={<LockIcon />}
      title={
        title ??
        (ownersAndAdmins
          ? "Only organization owners and admins can open this"
          : "Opengeni Console is for organization owners, admins and members with a Console role")
      }
      description={limited ? undefined : "Ask an owner or admin of this organization for access."}
      action={
        limited ? undefined : consoleHost ? (
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
/**
 * USD micros as money. A cost under a cent reads "<$0.01" in lists and
 * tiles; `precise` (a session's own cost) shows its first significant
 * digits instead, such as "$0.0025".
 */
export function formatMicros(micros: number, options: { precise?: boolean } = {}): string {
  if (micros > 0 && micros < 10_000) {
    if (!options.precise) return `<${formatMoneyMicros(10_000, "usd")}`;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      maximumSignificantDigits: 2,
    }).format(micros / 1_000_000);
  }
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

export type EndUserDisplay = {
  /** Name, else email, else the product's id, else a short form of the subject. */
  primary: string;
  /** The email under a name; null when the primary line already is the email or there is none. */
  secondary: string | null;
  /** The product's own id (else the subject): shown on hover and copied. */
  id: string;
  /** The name or email shown is what the product sent, which Opengeni doesn't verify. */
  unverified: boolean;
};

/** Hover note on a name or email the product sent. */
export const END_USER_UNVERIFIED_NOTE = "Name and email sent by your product, not verified";

function shortSubject(subjectId: string): string {
  const subject = subjectId.replace(/^(?:external_user|user):/u, "");
  return subject.length > 14 ? `${subject.slice(0, 12)}…` : subject;
}

/** How Console names an end user: name, then email, then the product's id. */
export function endUserDisplay(endUser: ConsoleEndUser | null | undefined): EndUserDisplay | null {
  if (!endUser) return null;
  const name = endUser.displayName?.trim() || null;
  const email = endUser.email?.trim() || null;
  const id = endUser.externalId ?? endUser.subjectId;
  const primary = name ?? email ?? endUser.externalId ?? shortSubject(endUser.subjectId);
  return {
    primary,
    secondary: name && email ? email : null,
    id,
    unverified: Boolean(name ?? email),
  };
}

/** One line: the end user's name, else email, else the product's id. */
export function endUserLabel(endUser: ConsoleEndUser | null | undefined): string {
  return endUserDisplay(endUser)?.primary ?? "—";
}

/** Matches a search against the end user's name, email and id (client-side lists). */
export function endUserMatches(endUser: ConsoleEndUser | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (!endUser) return false;
  return [endUser.displayName, endUser.email, endUser.externalId, endUser.subjectId].some(
    (value) => value?.toLowerCase().includes(needle) ?? false,
  );
}

/**
 * The end user in a table cell or detail row: name and email, wrapping
 * instead of cutting off, with the product's id on hover. `copyable` adds the
 * id with a copy button (detail pages).
 */
export function EndUserName({
  endUser,
  copyable = false,
}: {
  endUser: ConsoleEndUser | null | undefined;
  copyable?: boolean;
}) {
  const display = endUserDisplay(endUser);
  if (!display) return <span className="text-fg-subtle">—</span>;
  return (
    <span
      className="flex min-w-0 flex-col whitespace-normal"
      title={display.unverified ? `${display.id}\n${END_USER_UNVERIFIED_NOTE}` : display.id}
    >
      <span className="break-words">{display.primary}</span>
      {display.secondary ? (
        <span className="text-xs break-words text-fg-subtle">{display.secondary}</span>
      ) : null}
      {copyable ? (
        <CopyField
          value={display.id}
          label="end user ID"
          truncate="middle"
          className="text-xs text-fg-subtle"
        />
      ) : null}
    </span>
  );
}

/** A workspace name in full: wraps instead of cutting off, with the name on hover. */
export function WorkspaceName({ name }: { name: string }) {
  return (
    <span className="block whitespace-normal break-words" title={name}>
      {name}
    </span>
  );
}

/** What an audit action did; an action a newer server added reads as itself. */
export function auditActionText(action: ConsoleAuditEvent["action"]): string {
  switch (action) {
    case "session.transcript_viewed":
      return "Opened a transcript";
    case "session.metadata_viewed":
      return "Opened a session";
    case "settings.review_level_changed":
      return "Changed session review";
    case "workspace.kind_changed":
      return "Changed a workspace's kind";
    case "agent.created":
      return "Created an agent";
    case "agent.updated":
      return "Changed where an agent is available";
    case "agent.version_saved":
      return "Saved an agent version";
    case "agent.published":
      return "Published an agent";
    case "agent.archived":
      return "Archived an agent";
    case "agent.management_changed":
      return "Changed who manages an agent";
    case "agent.deployed":
      return "Deployed an agent";
    case "tool_server.created":
      return "Added a tool server";
    case "tool_server.updated":
      return "Changed a tool server";
    case "tool_server.deleted":
      return "Removed a tool server";
    case "tool_credential.written":
      return "Stored an end user's tool login";
    case "tool_credential.deleted":
      return "Removed an end user's tool login";
    case "member.console_role_changed":
      return "Changed a member's Console role";
    case "agent.sessions_viewed":
      return "Opened an agent's sessions";
    default:
      return action;
  }
}

export function ConsolePage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-6">{children}</div>;
}
