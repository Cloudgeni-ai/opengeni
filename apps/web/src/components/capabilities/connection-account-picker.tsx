import { Select } from "@/components/ui/select";
import type { ConnectedAccountGroup } from "./session-connection-accounts";

export function ConnectionAccountPicker(props: {
  groups: ConnectedAccountGroup[];
  choices: Record<string, string>;
  onChoose: (serverId: string, connectionId: string) => void;
  disabled?: boolean;
}) {
  return props.groups.map((group) => (
    <label key={group.serverId} className="mb-2 flex items-center gap-2 text-sm text-fg-muted">
      <span>{group.name} account</span>
      <Select
        value={props.choices[group.serverId] ?? ""}
        disabled={props.disabled}
        onChange={(event) => props.onChoose(group.serverId, event.target.value)}
      >
        <option value="">
          {group.accounts.length > 1 ? "Choose account" : "Use available account automatically"}
        </option>
        {props.choices[group.serverId] &&
        !group.accounts.some((account) => account.id === props.choices[group.serverId]) ? (
          <option value={props.choices[group.serverId]} disabled>
            Selected account disconnected
          </option>
        ) : null}
        {group.accounts.map((account) => {
          const label = [
            account.metadata.email,
            account.metadata.displayName,
            account.metadata.accountName,
          ].find((value) => typeof value === "string" && value.trim());
          return (
            <option key={account.id} value={account.id}>
              {typeof label === "string" ? label : `${group.name} · ${account.id.slice(0, 8)}`}
            </option>
          );
        })}
      </Select>
      {group.accounts.length === 0 ? (
        <span className="text-xs">Connect an account in Capabilities.</span>
      ) : null}
    </label>
  ));
}
