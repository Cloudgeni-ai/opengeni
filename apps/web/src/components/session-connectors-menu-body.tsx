import {
  CheckIcon,
  PlugIcon,
  RefreshCwIcon,
  Loader2Icon,
  Settings2Icon,
  ChevronLeftIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  ConnectionAccountPicker,
  type ConnectionAccountControls,
} from "@/components/capabilities/connection-account-picker";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  ComposerMenuHeader,
  ComposerMenuSwitch,
  ComposerMenuSwitchIndicator,
} from "@/components/ui/composer-menu";
import type { SessionToolSelection } from "@/components/pickers";
import { isComposerConnector, type McpServerOption } from "@/lib/session-tools";
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
  accountControls?: ConnectionAccountControls;
};

/** Connection availability belongs here; built-in tools remain in workspace settings. */
export function SessionConnectorsMenuBody(props: SessionConnectorsMenuProps) {
  const connectors = props.servers.filter(isComposerConnector);
  const customizing = props.customizing === true;
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const settingsServer = connectors.find((server) => server.id === settingsId);
  const accounts = props.accountControls;
  const changeConnector = (serverId: string, enabled: boolean) => {
    const next = new Set(props.selection.mcpServerIds);
    if (enabled) next.add(serverId);
    else next.delete(serverId);
    props.onCustomizingChange?.(true);
    props.onChange({
      mcpServerIds: next,
      firstPartyToolIds: new Set(props.selection.firstPartyToolIds),
    });
  };
  if (settingsServer && accounts) {
    return (
      <>
        <ComposerMenuHeader
          title={settingsServer.name}
          leading={
            <button
              type="button"
              aria-label="Back to connectors"
              className="inline-flex size-9 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setSettingsId(null)}
            >
              <ChevronLeftIcon className="size-4" />
            </button>
          }
        />
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
          <p className="px-2 pb-2 text-xs text-fg-muted">Connected accounts</p>
          {accounts.loading ? (
            <p role="status" className="p-2 text-xs text-fg-muted">
              Loading accounts…
            </p>
          ) : null}
          <ConnectionAccountPicker
            {...accounts}
            groups={accounts.groups.filter((group) => group.serverId === settingsServer.id)}
            choices={
              props.selection.mcpServerIds.has(settingsServer.id)
                ? accounts.choices
                : { ...accounts.choices, [settingsServer.id]: [] }
            }
            onChoose={(serverId, ids) => {
              accounts.onChoose(serverId, ids);
              if (props.selection.mcpServerIds.has(serverId) !== ids.length > 0) {
                changeConnector(serverId, ids.length > 0);
              }
            }}
            presentation={props.presentation}
            disabled={accounts.disabled || accounts.loading || Boolean(accounts.error)}
          />
          {accounts.error ? (
            <p role="alert" className="p-2 text-xs text-status-failed">
              {accounts.error}
            </p>
          ) : null}
          {accounts.error && !accounts.accessDenied && accounts.onRefresh ? (
            <ConnectorAction
              presentation={props.presentation}
              keepOpen
              label="Retry accounts"
              onAction={accounts.onRefresh}
              disabled={accounts.loading}
            >
              <RefreshCwIcon className="size-4" /> Retry accounts
            </ConnectorAction>
          ) : null}
        </div>
      </>
    );
  }
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
        {accounts?.loading ? (
          <p role="status" className="px-2 py-2 text-xs text-fg-muted">
            Loading accounts…
          </p>
        ) : null}
        {accounts?.error ? (
          <p role="alert" className="px-2 py-2 text-xs text-status-failed">
            {accounts.error}
          </p>
        ) : null}
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
          const setupAction = (connect || repair || unavailable) && !(customizing && selected);
          const accountGroup = accounts?.groups.find((group) => group.serverId === server.id);
          const setupLabel = connect
            ? `Connect your ${server.name} account`
            : repair
              ? `Reconnect ${server.name}`
              : `${server.name} unavailable`;
          return (
            <div
              key={server.id}
              className="flex min-h-16 items-center gap-1 border-b border-border px-2 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3 pr-2">
                <CapabilityLogo
                  src={server.logoSrc ?? null}
                  name={server.name}
                  size="sm"
                  className="size-8 rounded-lg [&_img]:p-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{server.name}</span>
                  {server.detail ? (
                    <span className="mt-1 block truncate text-xs text-fg-muted">
                      {server.detail}
                    </span>
                  ) : null}
                  {connect || repair || unavailable ? (
                    <span className="block text-2xs text-status-waiting">
                      {connect
                        ? "No connected account"
                        : repair
                          ? "Reconnect required"
                          : "Unavailable"}
                    </span>
                  ) : null}
                  {server.connectionStatus === "unknown" ? (
                    <span className="block text-2xs text-fg-subtle">Status unavailable</span>
                  ) : null}
                </span>
              </div>
              <span className="flex size-11 shrink-0 items-center justify-center">
                {accounts &&
                accountGroup &&
                (accountGroup.accounts.length > 0 ||
                  (accounts.choices[server.id]?.length ?? 0) > 0) ? (
                  <ConnectorAction
                    presentation={props.presentation}
                    keepOpen
                    label={`${server.name} account settings`}
                    disabled={busy || accounts.disabled}
                    className="connector-control flex size-11 shrink-0 items-center justify-center rounded-md p-2"
                    onAction={() => setSettingsId(server.id)}
                  >
                    <Settings2Icon className="size-4 text-fg-muted" />
                  </ConnectorAction>
                ) : null}
              </span>
              {customizing || setupAction ? (
                <ConnectorAction
                  presentation={props.presentation}
                  keepOpen
                  checked={setupAction ? undefined : selected}
                  label={setupAction ? setupLabel : server.name}
                  disabled={busy || accounts?.disabled || (!selected && accounts?.loading)}
                  className="connector-control flex size-11 shrink-0 items-center justify-center rounded-md p-2"
                  onAction={() => {
                    if (setupAction) {
                      props.onReconnect?.(server.id);
                      return;
                    }
                    if (!selected && accounts?.choices[server.id]?.length === 0) {
                      accounts.onChoose(
                        server.id,
                        accountGroup?.accounts.map((account) => account.id) ?? [],
                      );
                    }
                    changeConnector(server.id, !selected);
                  }}
                >
                  {busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : setupAction ? (
                    connect ? (
                      <PlugIcon className="size-4 text-fg-muted" />
                    ) : (
                      <RefreshCwIcon className="size-4 text-fg-muted" />
                    )
                  ) : (
                    <ComposerMenuSwitchIndicator checked={selected} />
                  )}
                </ConnectorAction>
              ) : (
                <span
                  aria-label={`${server.name}, ${selected ? "on" : "off"} for this session`}
                  className="flex size-11 shrink-0 items-center justify-center"
                >
                  {selected ? <CheckIcon className="size-4 text-fg-muted" aria-hidden /> : null}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {props.error ? (
        <p role="alert" className="px-2 py-2 text-xs text-status-failed">
          {props.error}
        </p>
      ) : null}
      {accounts?.error && !accounts.accessDenied && accounts.onRefresh ? (
        <ConnectorAction presentation={props.presentation} keepOpen onAction={accounts.onRefresh}>
          Retry accounts
        </ConnectorAction>
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
