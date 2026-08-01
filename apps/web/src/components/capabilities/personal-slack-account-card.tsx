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
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  available: boolean;
  canManage: boolean;
  busy: boolean;
  accountState: PersonalSlackAccountState;
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
      className="rounded-xl border border-brand/25 bg-brand/[0.035] p-4"
      aria-labelledby="personal-slack-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
            <UserRoundIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="personal-slack-heading" className="text-sm font-semibold text-fg">
                Your Slack account
              </h3>
              <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 text-2xs font-medium text-brand">
                Personal · only you
              </span>
            </div>
            <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
              Authorize your own Slack identity for interactive tools. Messages act as you using
              @OpenGeni; workspace bot installations and scheduled tasks never borrow this grant.
            </p>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "mt-4 rounded-lg border p-3",
          view.attention
            ? "border-status-waiting/30 bg-status-waiting/5"
            : "border-border bg-bg/55",
        )}
      >
        <div className="flex items-start gap-3">
          <view.Icon
            className={cn(
              "mt-0.5 size-5 shrink-0",
              view.attention ? "text-status-waiting" : "text-brand",
            )}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">{view.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-fg-muted">{view.description}</p>
          </div>
        </div>
      </div>

      {connection ? (
        <details className="group mt-3 border-t border-border/70 pt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
            <ShieldCheckIcon className="size-3" />
            <span>Personal authorization details</span>
          </summary>
          <dl className="mt-3 grid gap-2 rounded-md bg-bg/50 p-3 text-2xs">
            <ConnectionFact label="Ownership">Only your signed-in OpenGeni identity</ConnectionFact>
            <ConnectionFact label="Granted scopes">
              {connection.grantedScopes.length > 0
                ? connection.grantedScopes.join(", ")
                : "Provider-managed; none reported"}
            </ConnectionFact>
            <ConnectionFact label="Last used">
              {formatConnectionDate(connection.lastUsedAt)}
            </ConnectionFact>
            <ConnectionFact label="Access expiry">
              {formatConnectionDate(connection.expiresAt)}
            </ConnectionFact>
          </dl>
        </details>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {accountState.state === "not_connected" ? (
          <Button type="button" disabled={!canManage || !canStartOAuth || busy} onClick={onConnect}>
            {busy ? <Loader2Icon className="animate-spin" /> : <UserRoundIcon />}
            Connect my Slack account
          </Button>
        ) : accountState.state === "connected" ||
          accountState.state === "reconnect_required" ||
          accountState.state === "disconnected" ? (
          <Button
            type="button"
            variant={accountState.state === "reconnect_required" ? "default" : "outline"}
            disabled={!canManage || !canStartOAuth || busy}
            onClick={onReconnect}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Reconnect my Slack account
          </Button>
        ) : null}
        {canDisconnect ? (
          <Button
            type="button"
            variant="ghost"
            className="text-status-failed hover:bg-status-failed/10 hover:text-status-failed"
            disabled={!canManage || busy}
            onClick={onDisconnect}
          >
            <UnplugIcon />
            Disconnect
          </Button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="mt-3 text-2xs text-fg-subtle">
          Connection management permission is required to change this personal link.
        </p>
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
        description: "Connect intentionally when you want agents to use your own Slack identity.",
        attention: false,
        Icon: UserRoundIcon,
      };
    case "connected":
      return state.accessTokenRefreshDue
        ? {
            label: "Connected · refresh pending",
            description:
              "The access token reached its expiry time. OpenGeni will refresh it automatically on use; reconnect only if Slack rejects that refresh.",
            attention: false,
            Icon: Clock3Icon,
          }
        : {
            label: "Connected",
            description: "Your subject-owned Slack authorization is ready for interactive use.",
            attention: false,
            Icon: CheckCircle2Icon,
          };
    case "reconnect_required":
      return {
        label: "Reconnect required",
        description:
          state.reason === "expired"
            ? "The authorization expired and could not be refreshed. Reconnect your Slack account to restore access."
            : state.reason === "provider_rejected"
              ? "Slack no longer accepts this authorization. Reconnect your account to restore access."
              : "OpenGeni could not use this authorization. Reconnect rather than reusing stale credentials.",
        attention: true,
        Icon: AlertTriangleIcon,
      };
    case "disconnected":
      return {
        label: "Disconnected",
        description:
          "OpenGeni no longer uses this personal grant. Reconnect to use your Slack identity again.",
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
