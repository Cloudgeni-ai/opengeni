// The grouped permission picker idiom shared by the API key dialog and the
// session create form's first-party MCP permission scope. Groups derive from
// the contracts Permission enum (lib/permissions.ts) so they can never drift
// from the API.
import type { PermissionGroup } from "@/lib/permissions";

export function PermissionGroupPicker(props: {
  groups: PermissionGroup[];
  selected: Set<string>;
  /** Permissions the current grant may delegate; others render disabled. */
  delegable?: Set<string>;
  disabled?: boolean;
  onToggle: (permission: string) => void;
}) {
  return (
    <div className="grid gap-3">
      {props.groups.map((group) => (
        <div key={group.label} className="grid gap-1.5">
          <div className="text-xs font-medium text-fg-muted">{group.label}</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.permissions.map((permission) => {
              const delegable = props.delegable ? props.delegable.has(permission) : true;
              return (
                <label
                  key={permission}
                  title={delegable ? undefined : "Your grant cannot delegate this permission"}
                  className={`flex items-center gap-2 rounded-md border border-border bg-bg/35 px-2 py-1.5 text-xs ${delegable && !props.disabled ? "" : "cursor-not-allowed opacity-50"}`}
                >
                  <input
                    type="checkbox"
                    disabled={!delegable || props.disabled}
                    checked={delegable && props.selected.has(permission)}
                    onChange={() => props.onToggle(permission)}
                  />
                  <span>{permission}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
