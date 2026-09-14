import { RefreshCwIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import type { SessionToolSelection } from "@/components/pickers";
import type { McpServerOption } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

export type SessionConnectorsMenuProps = {
  presentation?: "menu" | "dialog";
  servers: McpServerOption[];
  firstPartyTools: ReadonlyArray<{ id: FirstPartyMcpToolName; name: string }>;
  selection: SessionToolSelection;
  onChange: (selection: SessionToolSelection) => void;
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
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-1 pb-1">
        {props.leading}
        <DropdownMenuLabel className="text-sm">Connectors</DropdownMenuLabel>
      </div>
      <div className="min-h-0 shrink overflow-y-auto overscroll-contain">
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
          const unavailable = server.connectionStatus === "unavailable";
          const busy = props.busyId === server.id;
          return (
            <ConnectorAction
              presentation={props.presentation}
              keepOpen
              key={server.id}
              checked={repair || unavailable ? undefined : selected}
              label={
                repair
                  ? `Reconnect ${server.name}`
                  : unavailable
                    ? `${server.name} unavailable`
                    : server.name
              }
              disabled={busy}
              onAction={() => {
                if (repair || unavailable) {
                  props.onReconnect?.(server.id);
                  return;
                }
                const next = new Set(props.selection.mcpServerIds);
                if (selected) next.delete(server.id);
                else next.add(server.id);
                // Preserve every hidden builtin and explicitly selected server.
                props.onChange({
                  mcpServerIds: next,
                  firstPartyToolIds: new Set(props.selection.firstPartyToolIds),
                });
              }}
              className="min-h-11 cursor-pointer gap-2.5 rounded-lg px-2 py-2"
            >
              <CapabilityLogo
                src={server.logoSrc ?? null}
                name={server.name}
                size="sm"
                className="size-7 rounded-md [&_img]:p-1"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{server.name}</span>
                {server.detail ? (
                  <span className="block truncate text-2xs text-fg-subtle">{server.detail}</span>
                ) : null}
                {repair || unavailable ? (
                  <span className="block text-2xs text-status-waiting">
                    {repair ? "Reconnect required" : "Unavailable · Manage connection"}
                  </span>
                ) : null}
                {server.connectionStatus === "unknown" ? (
                  <span className="block text-2xs text-fg-subtle">Status unavailable</span>
                ) : null}
              </span>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : repair || unavailable ? (
                <RefreshCwIcon className="size-4 text-fg-muted" />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
                    selected ? "bg-brand" : "bg-fg-subtle/35",
                  )}
                >
                  <span
                    className={cn(
                      "size-3 rounded-full bg-white shadow-sm transition-transform",
                      selected && "translate-x-3",
                    )}
                  />
                </span>
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
      <p className="shrink-0 px-2 pt-2 pb-1 text-2xs text-fg-subtle">
        Switches apply to this conversation.
      </p>
    </>
  );
}

function ConnectorAction(props: {
  presentation?: "menu" | "dialog";
  checked?: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
  keepOpen?: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  if (props.presentation === "dialog") {
    return (
      <button
        type="button"
        role={props.checked === undefined ? undefined : "switch"}
        aria-label={props.label}
        aria-checked={props.checked}
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
