import type { ConnectionMetadata } from "@opengeni/sdk";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ComposerMenuSwitchIndicator } from "@/components/ui/composer-menu";
import type {
  ConnectedAccountGroup,
  ConnectionAccountChoices,
} from "./session-connection-accounts";

export function connectionAccountLabel(account: ConnectionMetadata, fallback: string): string {
  const metadata = account.metadata;
  const label = [
    metadata.email,
    metadata.displayName,
    metadata.accountName,
    metadata.teamName,
    metadata.workspaceName,
    metadata.team_name,
    metadata.workspace_name,
    typeof metadata.team === "object" && metadata.team !== null
      ? (metadata.team as Record<string, unknown>).name
      : metadata.team,
    typeof metadata.workspace === "object" && metadata.workspace !== null
      ? (metadata.workspace as Record<string, unknown>).name
      : metadata.workspace,
  ].find((value) => typeof value === "string" && value.trim());
  return typeof label === "string" ? label.trim() : fallback;
}

export type ConnectionAccountPickerProps = {
  groups: ConnectedAccountGroup[];
  choices: ConnectionAccountChoices;
  onChoose: (serverId: string, connectionIds: string[]) => void;
  disabled?: boolean;
  presentation?: "menu" | "dialog";
};

export type ConnectionAccountControls = ConnectionAccountPickerProps & {
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
};

export function ConnectionAccountPicker(props: ConnectionAccountPickerProps) {
  return props.groups.map((group) => {
    const chosen = props.choices[group.serverId] ?? group.accounts.map((account) => account.id);
    const missing = chosen.filter((id) => !group.accounts.some((account) => account.id === id));
    return (
      <div key={group.serverId} role="group" aria-label={`${group.name} accounts`}>
        {props.presentation !== "menu" ? (
          <p className="text-xs text-fg-muted">{group.name} accounts</p>
        ) : null}
        {group.accounts.map((account, index) => {
          const checked = chosen.includes(account.id);
          const label = connectionAccountLabel(account, `${group.name} account ${index + 1}`);
          const ownership = account.subjectId === null ? "This workspace" : "Only me";
          const onToggle = () =>
            props.onChoose(
              group.serverId,
              checked ? chosen.filter((id) => id !== account.id) : [...chosen, account.id],
            );
          const content = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">{label}</span>
                <span className="block text-xs text-fg-muted">{ownership}</span>
              </span>
              <ComposerMenuSwitchIndicator checked={checked} />
            </>
          );
          const className =
            "flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
          return props.presentation === "menu" ? (
            <DropdownMenuItem
              key={account.id}
              role="menuitemcheckbox"
              aria-checked={checked}
              aria-label={`${label}, ${ownership}`}
              disabled={props.disabled}
              className={className}
              onSelect={(event) => {
                event.preventDefault();
                onToggle();
              }}
            >
              {content}
            </DropdownMenuItem>
          ) : (
            <button
              key={account.id}
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={`${label}, ${ownership}`}
              disabled={props.disabled}
              className={className}
              onClick={onToggle}
            >
              {content}
            </button>
          );
        })}
        {missing.map((id, index) => {
          const label = `Remove disconnected account${missing.length > 1 ? ` ${index + 1}` : ""}`;
          const onRemove = () =>
            props.onChoose(
              group.serverId,
              chosen.filter((chosenId) => chosenId !== id),
            );
          const className = "min-h-11 px-2 text-left text-xs text-status-failed underline";
          return props.presentation === "menu" ? (
            <DropdownMenuItem
              key={id}
              disabled={props.disabled}
              className={className}
              onSelect={(event) => {
                event.preventDefault();
                onRemove();
              }}
            >
              {label}
            </DropdownMenuItem>
          ) : (
            <button
              key={id}
              type="button"
              disabled={props.disabled}
              className={className}
              onClick={onRemove}
            >
              {label}
            </button>
          );
        })}
        {!group.accounts.length ? (
          <p className="px-2 py-2 text-xs text-fg-muted">Connect an account in Capabilities.</p>
        ) : null}
        {!chosen.length && group.accounts.length > 0 ? (
          <p role="status" className="px-2 py-2 text-xs text-fg-muted">
            Attach an account or turn off this connector.
          </p>
        ) : null}
      </div>
    );
  });
}
