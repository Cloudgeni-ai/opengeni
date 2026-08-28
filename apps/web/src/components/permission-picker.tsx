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
  onSetGroup?: (permissions: string[], selected: boolean) => void;
}) {
  return (
    <div className="grid gap-4">
      {props.groups.map((group) => (
        <section key={group.label} className="grid gap-2">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 text-xs font-medium text-fg-muted">
              {group.label}
              <span className="ml-1.5 font-normal text-fg-subtle">
                {group.permissions.filter((permission) => props.selected.has(permission)).length}/
                {group.permissions.length}
              </span>
            </div>
            {props.onSetGroup && group.permissions.length > 1 ? (
              <button
                type="button"
                className="shrink-0 text-2xs font-medium text-fg-muted hover:text-fg disabled:opacity-50"
                disabled={props.disabled}
                aria-label={`${
                  group.permissions
                    .filter((permission) => !props.delegable || props.delegable.has(permission))
                    .every((permission) => props.selected.has(permission))
                    ? "Remove all"
                    : "Grant all"
                } ${group.label} permissions`}
                onClick={() => {
                  const selectable = group.permissions.filter(
                    (permission) => !props.delegable || props.delegable.has(permission),
                  );
                  const allSelected = selectable.every((permission) =>
                    props.selected.has(permission),
                  );
                  props.onSetGroup?.(selectable, !allSelected);
                }}
              >
                {group.permissions
                  .filter((permission) => !props.delegable || props.delegable.has(permission))
                  .every((permission) => props.selected.has(permission))
                  ? "Remove all"
                  : "Grant all"}
              </button>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {group.permissions.map((permission) => {
              const delegable = props.delegable ? props.delegable.has(permission) : true;
              return (
                <label
                  key={permission}
                  title={delegable ? undefined : "Your grant cannot delegate this permission"}
                  className={`flex min-w-0 items-start gap-2 rounded-md border border-border bg-bg/35 px-2.5 py-2 text-xs transition-colors ${delegable && !props.disabled ? "cursor-pointer hover:border-border-strong hover:bg-surface-2" : "cursor-not-allowed opacity-50"}`}
                >
                  <input
                    className="mt-0.5 shrink-0"
                    type="checkbox"
                    disabled={!delegable || props.disabled}
                    checked={delegable && props.selected.has(permission)}
                    onChange={() => props.onToggle(permission)}
                  />
                  <span className="min-w-0 break-words leading-4">{permission}</span>
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
