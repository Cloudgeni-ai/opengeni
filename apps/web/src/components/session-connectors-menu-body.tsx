import {
  CheckIcon,
  ChevronLeftIcon,
  PlugIcon,
  RefreshCwIcon,
  Loader2Icon,
  Settings2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  ConnectionAccountPicker,
  type ConnectionAccountControls,
} from "@/components/capabilities/connection-account-picker";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { ConnectorAction } from "@/components/ui/composer-menu-action";
import {
  ComposerMenuHeader,
  ComposerMenuSwitch,
  ComposerMenuSwitchIndicator,
  ComposerMenuRowsSkeleton,
} from "@/components/ui/composer-menu";
import {
  MENU_BACK_BUTTON_CLASS,
  MENU_CHECK_CLASS,
  MENU_LABEL_CLASS,
  MENU_NOTE_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";
import type { SessionToolSelection } from "@/components/pickers";
import { isComposerConnector, type McpServerOption } from "@/lib/session-tools";

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

/** Connected apps for one chat. Built-in tools follow the agent's capabilities (+ > Capabilities). */
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
            <ConnectorAction
              presentation={props.presentation}
              keepOpen
              label="Back to connectors"
              className={`${MENU_BACK_BUTTON_CLASS} w-8 gap-0 p-0`}
              onAction={() => setSettingsId(null)}
            >
              <ChevronLeftIcon aria-hidden="true" className="size-4" />
            </ConnectorAction>
          }
        />
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <p className={MENU_LABEL_CLASS}>Connected accounts</p>
          {accounts.loading &&
          !accounts.groups.some((group) => group.serverId === settingsServer.id) ? (
            <ComposerMenuRowsSkeleton rows={2} label="Loading accounts" />
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
            <p role="alert" className={cn(MENU_NOTE_CLASS, "text-status-failed")}>
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
            <span aria-hidden className="text-xs text-fg-muted">
              Customize
            </span>
            {props.presentation === "dialog" ? (
              <ComposerMenuSwitch
                label="Customize connectors"
                checked={customizing}
                onCheckedChange={(next) => props.onCustomizingChange?.(next)}
              />
            ) : (
              // Inside a menu the toggle is a checkable menu item.
              <ConnectorAction
                presentation="menu"
                keepOpen
                checked={customizing}
                label="Customize connectors"
                className="inline-flex size-9 shrink-0 items-center justify-end rounded-md p-0 pointer-coarse:size-11"
                onAction={() => props.onCustomizingChange?.(!customizing)}
              >
                <ComposerMenuSwitchIndicator checked={customizing} />
              </ConnectorAction>
            )}
          </div>
        }
      />
      <div
        role="group"
        tabIndex={0}
        className="min-h-0 shrink overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand/55"
      >
        {accounts?.error ? (
          <p role="alert" className={cn(MENU_NOTE_CLASS, "text-status-failed")}>
            {accounts.error}
          </p>
        ) : null}
        {props.loading && !connectors.length ? (
          <ComposerMenuRowsSkeleton rows={4} size="tile" label="Loading connectors" />
        ) : null}
        {!props.loading && !connectors.length ? (
          <p className={MENU_NOTE_CLASS}>Connect an app to use it in your conversations.</p>
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
              className="flex min-h-14 items-center gap-1 rounded-[10px] py-1.5 pl-2.5"
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
                <span className="flex size-11 shrink-0 items-center justify-center">
                  {selected ? <CheckIcon className={MENU_CHECK_CLASS} aria-hidden /> : null}
                  <span className="sr-only">{`${server.name}, ${selected ? "on" : "off"} for this session`}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {props.error ? (
        <p role="alert" className={cn(MENU_NOTE_CLASS, "text-status-failed")}>
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
