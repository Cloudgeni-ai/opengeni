// The shared machine-definition editor: base image, setup script, checks, and
// default variable sets. Used by rig create (advanced disclosure) and by the
// setup/definition edit that proposes a `definition_edit` change — one editor so
// the two paths never drift.
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { RigCheck, VariableSet } from "@/types";

export type RigDefinitionDraft = {
  image: string;
  setupScript: string;
  checks: RigCheck[];
  defaultVariableSetIds: string[];
};

export function emptyRigDefinitionDraft(): RigDefinitionDraft {
  return { image: "", setupScript: "", checks: [], defaultVariableSetIds: [] };
}

export function RigDefinitionFields({
  value,
  onChange,
  variableSets,
  disabled,
  idPrefix = "rig",
}: {
  value: RigDefinitionDraft;
  onChange: (next: RigDefinitionDraft) => void;
  variableSets: VariableSet[];
  disabled?: boolean;
  idPrefix?: string;
}) {
  const setChecks = (checks: RigCheck[]) => onChange({ ...value, checks });
  const toggleVariableSet = (id: string) => {
    const has = value.defaultVariableSetIds.includes(id);
    onChange({
      ...value,
      defaultVariableSetIds: has
        ? value.defaultVariableSetIds.filter((current) => current !== id)
        : [...value.defaultVariableSetIds, id],
    });
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-image`}>Base image</Label>
        <Input
          id={`${idPrefix}-image`}
          value={value.image}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, image: event.target.value })}
          placeholder="Leave blank for the workspace default image"
          className="h-9 font-mono text-xs"
        />
        <p className="text-2xs text-fg-subtle">
          A container image reference. Blank falls back to the deployment default.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-setup`}>Setup script</Label>
        <Textarea
          id={`${idPrefix}-setup`}
          value={value.setupScript}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, setupScript: event.target.value })}
          placeholder={
            "# runs once on cold sandbox create — keep it idempotent\napt-get install -y ripgrep"
          }
          className="min-h-24 font-mono text-xs leading-5"
          spellCheck={false}
        />
        <p className="text-2xs text-fg-subtle">
          Bash, run at first boot of every sandbox on this rig. Must be safe to re-run.
        </p>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>Checks</Label>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => setChecks([...value.checks, { name: "", command: "" }])}
          >
            <PlusIcon className="size-3" />
            Add check
          </Button>
        </div>
        {value.checks.length === 0 ? (
          <p className="text-2xs text-fg-subtle">
            A check is a command that must exit zero for the machine to count as healthy. None yet.
          </p>
        ) : (
          <div className="grid gap-1.5">
            {value.checks.map((check, index) => (
              // Index key: rows are positional and only edited/removed in place.
              // eslint-disable-next-line react/no-array-index-key
              <div
                key={index}
                className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-1.5"
              >
                <Input
                  value={check.name}
                  disabled={disabled}
                  onChange={(event) =>
                    setChecks(
                      value.checks.map((c, i) =>
                        i === index ? { ...c, name: event.target.value } : c,
                      ),
                    )
                  }
                  placeholder="node present"
                  aria-label={`Check ${index + 1} name`}
                  className="h-8 text-xs"
                />
                <Input
                  value={check.command}
                  disabled={disabled}
                  onChange={(event) =>
                    setChecks(
                      value.checks.map((c, i) =>
                        i === index ? { ...c, command: event.target.value } : c,
                      ),
                    )
                  }
                  placeholder="node --version"
                  aria-label={`Check ${index + 1} command`}
                  className="h-8 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`Remove check ${index + 1}`}
                  className="hover:text-status-failed"
                  onClick={() => setChecks(value.checks.filter((_, i) => i !== index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {variableSets.length > 0 ? (
        <div className="grid gap-2">
          <Label>Default variable sets</Label>
          <p className="-mt-1 text-2xs text-fg-subtle">
            Preselected on new sessions that pick this rig. A session can still override them.
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {variableSets.map((variableSet) => {
              const checked = value.defaultVariableSetIds.includes(variableSet.id);
              return (
                <label
                  key={variableSet.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border/70 bg-bg/25 px-2.5 py-1.5 text-xs hover:border-border-strong"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleVariableSet(variableSet.id)}
                    className="size-3.5 accent-brand"
                  />
                  <span className="min-w-0 flex-1 truncate">{variableSet.name}</span>
                  <span className="shrink-0 text-2xs text-fg-subtle">
                    {variableSet.variables.length} var
                    {variableSet.variables.length === 1 ? "" : "s"}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Drop empty check rows and blank fields before sending to the API. */
export function cleanRigChecks(checks: RigCheck[]): RigCheck[] {
  return checks
    .map((check) => ({ name: check.name.trim(), command: check.command.trim() }))
    .filter((check) => check.name && check.command);
}
