import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UnplugIcon,
  UserRoundIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PersonalSlackAccountState } from "@/lib/personal-slack";
import { cn } from "@/lib/utils";

export function PersonalSlackAccountCard({
  available,
  canManage,
  busy,
  accountState,
  embedded = false,
  readOnly = false,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  available: boolean;
  canManage: boolean;
  busy: boolean;
  accountState: PersonalSlackAccountState;
  embedded?: boolean;
  readOnly?: boolean;
  onConnect: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const view = personalSlackStateView(accountState, available);
  const connection = "connection" in accountState ? accountState.connection : null;
  const canDisconnect =
    connection !== null &&
    accountState.state !== "disconnected" &&
    accountState.state !== "unverified";
  const canStartOAuth = available && accountState.state !== "unverified";

  return (
    <section
      className={cn(!embedded && "rounded-lg border border-border bg-bg/40 p-3")}
      aria-label={embedded ? "Personal Slack access" : undefined}
      aria-labelledby={embedded ? undefined : "personal-slack-heading"}
    >
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="personal-slack-heading" className="text-sm font-semibold text-fg">
                Your Slack account
              </h3>
              <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 text-2xs font-medium text-fg">
                Personal · only you
              </span>
            </div>
            <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
              Let agents use Slack as you. This connection belongs only to your account.
            </p>
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-xs font-medium",
              view.attention ? "text-status-waiting" : "text-fg-muted",
            )}
          >
            <view.Icon className={cn("size-4 shrink-0", !view.attention && "text-brand")} />
            {view.label}
          </div>
        </div>
      ) : null}

      {!embedded ? (
        <p className="mt-2 text-xs leading-5 text-fg-muted">{view.description}</p>
      ) : null}

      <div className={cn("flex flex-wrap items-center gap-2", !embedded && "mt-3")}>
        {accountState.state === "not_connected" ? (
          <Button
            type="button"
            disabled={readOnly || !canManage || !canStartOAuth || busy}
            onClick={onConnect}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <UserRoundIcon />}
            Connect
          </Button>
        ) : accountState.state === "reconnect_required" || accountState.state === "disconnected" ? (
          <Button
            type="button"
            variant={accountState.state === "reconnect_required" ? "default" : "outline"}
            disabled={readOnly || !canManage || !canStartOAuth || busy}
            onClick={onReconnect}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Reconnect
          </Button>
        ) : null}
        {canDisconnect ? (
          <Button
            type="button"
            variant="ghost"
            className="text-status-failed hover:bg-status-failed/10 hover:text-status-failed"
            disabled={readOnly || !canManage || busy}
            onClick={onDisconnect}
          >
            <UnplugIcon />
            Disconnect
          </Button>
        ) : null}
      </div>

      {!canManage && !readOnly ? (
        <p className="mt-3 text-2xs text-fg-subtle">
          Connection management permission is required to change this personal link.
        </p>
      ) : null}

      {connection && !embedded ? (
        <details className="group mt-3 border-t border-border/70 pt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
            <ShieldCheckIcon className="size-3" />
            <span>Connection details</span>
          </summary>
          <dl className="mt-3 grid gap-2 rounded-md bg-bg/50 p-3 text-2xs">
            <ConnectionFact label="Owner">Your account only</ConnectionFact>
            <ConnectionFact label="Permissions">
              {connection.grantedScopes.length > 0
                ? connection.grantedScopes.join(", ")
                : "Managed by Slack"}
            </ConnectionFact>
            <ConnectionFact label="Last used">
              {formatConnectionDate(connection.lastUsedAt)}
            </ConnectionFact>
            <ConnectionFact label="Expires">
              {formatConnectionDate(connection.expiresAt)}
            </ConnectionFact>
          </dl>
        </details>
      ) : null}
    </section>
  );
}

function personalSlackStateView(
  state: PersonalSlackAccountState,
  available: boolean,
): {
  label: string;
  description: string;
  attention: boolean;
  Icon: typeof CheckCircle2Icon;
} {
  if (!available && state.state === "not_connected") {
    return {
      label: "Unavailable",
      description:
        "Personal Slack OAuth is not available in this deployment's integration catalog.",
      attention: true,
      Icon: AlertTriangleIcon,
    };
  }
  switch (state.state) {
    case "unverified":
      return {
        label: "Status unavailable",
        description:
          "OpenGeni could not load your personal connection status. Refresh before changing it.",
        attention: true,
        Icon: AlertTriangleIcon,
      };
    case "not_connected":
      return {
        label: "Not connected",
        description: "Connect only when an agent needs to work through your Slack account.",
        attention: false,
        Icon: UserRoundIcon,
      };
    case "connected":
      return state.accessTokenRefreshDue
        ? {
            label: "Connected · refresh pending",
            description:
              "OpenGeni will refresh this connection automatically when it is next used.",
            attention: false,
            Icon: Clock3Icon,
          }
        : {
            label: "Connected",
            description: "Agents can use your Slack identity when a task needs it.",
            attention: false,
            Icon: CheckCircle2Icon,
          };
    case "reconnect_required":
      return {
        label: "Reconnect required",
        description:
          state.reason === "expired"
            ? "The connection expired. Reconnect it to restore access."
            : state.reason === "provider_rejected"
              ? "Slack no longer accepts this connection. Reconnect it to restore access."
              : "OpenGeni could not use this connection. Reconnect it to restore access.",
        attention: true,
        Icon: AlertTriangleIcon,
      };
    case "disconnected":
      return {
        label: "Disconnected",
        description: "Reconnect when you want agents to use your Slack identity again.",
        attention: false,
        Icon: UnplugIcon,
      };
  }
}

function ConnectionFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-right text-fg-muted">{children}</dd>
    </div>
  );
}

function formatConnectionDate(value: string | null): string {
  if (!value) return "Not reported";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Not reported";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}
