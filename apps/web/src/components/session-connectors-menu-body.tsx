import { CheckIcon, PlugIcon, RefreshCwIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  ComposerMenuHeader,
  ComposerMenuSwitch,
  ComposerMenuSwitchIndicator,
} from "@/components/ui/composer-menu";
import type { SessionToolSelection } from "@/components/pickers";
import type { McpServerOption } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

export type SessionConnectorsMenuProps = {
  presentation?: "menu" | "dialog";
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  onChange: (selection: SessionToolSelection) => void;
  /** Header switch. Off = read-only workspace list; on = row toggles. */
  customizing?: boolean;
  onCustomizingChange?: (customizing: boolean) => void;
  leading?: ReactNode;
  onReconnect?: (serverId: string) => void;
  loading?: boolean;
  error?: string | null;
  busyId?: string | null;
};

export function isComposerConnector(server: Pick<McpServerOption, "id">): boolean {
  return !["opengeni", "files", "docs"].includes(server.id);
}

/** Connection availability belongs here; built-in tools remain in workspace settings. */
export function SessionConnectorsMenuBody(props: SessionConnectorsMenuProps) {
  const connectors = props.servers.filter(isComposerConnector);
  const customizing = props.customizing === true;
  return (
    <>
      <ComposerMenuHeader
        title="Connectors"
        leading={props.leading}
        trailing={
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-muted">Customize</span>
            <ComposerMenuSwitch
              label="Customize connectors"
              checked={customizing}
              onCheckedChange={(next) => props.onCustomizingChange?.(next)}
            />
          </div>
        }
      />
      <div className="min-h-0 shrink overflow-y-auto overscroll-contain p-2">
        <p className="px-2 pb-2 text-xs text-fg-muted">Personal connections use your account.</p>
        {props.loading && !connectors.length ? (
          <p className="px-2 py-4 text-xs text-fg-muted" role="status">
            Loading connectors…
          </p>
        ) : null}
        {!props.loading && !connectors.length ? (
          <p className="px-2 py-4 text-xs text-fg-muted">
            Connect an app to use it in your conversations.
          </p>
        ) : null}
        {connectors.map((server) => {
          const selected = props.selection.mcpServerIds.has(server.id);
          const repair = server.connectionStatus === "reconnect";
          const connect = server.connectionStatus === "connect";
          const unavailable = server.connectionStatus === "unavailable";
          const busy = props.busyId === server.id;
          const rowLocked = !customizing && !connect && !repair && !unavailable;
          return (
            <ConnectorAction
              presentation={props.presentation}
              keepOpen
              key={server.id}
              checked={connect || repair || unavailable || rowLocked ? undefined : selected}
              label={
                connect
                  ? `Connect your ${server.name} account`
                  : repair
                    ? `Reconnect ${server.name}`
                    : unavailable
                      ? `${server.name} unavailable`
                      : rowLocked
                        ? `${server.name}${selected ? ", on for this session" : ", off for this session"}`
                        : server.name
              }
              disabled={busy}
              locked={rowLocked}
              onAction={() => {
                if (connect || repair || unavailable) {
                  props.onReconnect?.(server.id);
                  return;
                }
                if (rowLocked) return;
                const next = new Set(props.selection.mcpServerIds);
                if (selected) next.delete(server.id);
                else next.add(server.id);
                // Preserve every hidden builtin and explicitly selected server.
                props.onChange({
                  mcpServerIds: next,
                  firstPartyToolIds: new Set(props.selection.firstPartyToolIds),
                });
              }}
              className={cn(
                "min-h-11 gap-3 rounded-none border-b border-border px-0 py-3 last:border-b-0",
                rowLocked ? "cursor-default hover:bg-transparent" : "cursor-pointer",
              )}
            >
              <CapabilityLogo
                src={server.logoSrc ?? null}
                name={server.name}
                size="sm"
                className="size-8 rounded-lg [&_img]:p-1"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{server.name}</span>
                {server.detail ? (
                  <span className="mt-1 block truncate text-xs text-fg-muted">{server.detail}</span>
                ) : null}
                {connect || repair || unavailable ? (
                  <span className="block text-2xs text-status-waiting">
                    {connect
                      ? "Connect your account"
                      : repair
                        ? "Reconnect required"
                        : "Unavailable · Manage connection"}
                  </span>
                ) : null}
                {server.connectionStatus === "unknown" ? (
                  <span className="block text-2xs text-fg-subtle">Status unavailable</span>
                ) : null}
              </span>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : connect ? (
                <PlugIcon className="size-4 text-fg-muted" />
              ) : repair || unavailable ? (
                <RefreshCwIcon className="size-4 text-fg-muted" />
              ) : customizing ? (
                <ComposerMenuSwitchIndicator checked={selected} />
              ) : selected ? (
                <CheckIcon className="size-4 text-fg-muted" aria-hidden />
              ) : (
                <span className="size-4" aria-hidden />
              )}
            </ConnectorAction>
          );
        })}
      </div>
      {props.error ? (
        <p role="alert" className="px-2 py-2 text-xs text-status-failed">
          {props.error}
        </p>
      ) : null}
    </>
  );
}

function ConnectorAction(props: {
  presentation?: "menu" | "dialog";
  checked?: boolean;
  label?: string;
  disabled?: boolean;
  locked?: boolean;
  className?: string;
  keepOpen?: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  if (props.locked) {
    return (
      <div
        aria-label={props.label}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
          props.className,
        )}
      >
        {props.children}
      </div>
    );
  }
  if (props.presentation === "dialog") {
    return (
      <button
        type="button"
        role={props.checked === undefined ? undefined : "switch"}
        aria-label={props.label}
        aria-checked={props.checked}
        aria-disabled={props.disabled || undefined}
        disabled={props.disabled}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          props.className,
        )}
        onClick={props.onAction}
      >
        {props.children}
      </button>
    );
  }
  return (
    <DropdownMenuItem
      role={props.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-label={props.label}
      aria-checked={props.checked}
      aria-disabled={props.disabled || undefined}
      disabled={props.disabled}
      className={props.className}
      onSelect={(event) => {
        if (props.keepOpen) event.preventDefault();
        props.onAction();
      }}
    >
      {props.children}
    </DropdownMenuItem>
  );
}
