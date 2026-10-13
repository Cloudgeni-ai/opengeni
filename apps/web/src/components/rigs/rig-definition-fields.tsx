// The shared environment definition editor: setup script and checks. Secrets
// come from vaults through {{secret:...}} references, never from the
// environment definition. Every environment layers on the deployment-owned platform
// image; the editable image field is intentionally absent so Computer/Browser/
// Terminal cannot be replaced by an environment definition.
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import type { RigCheck } from "@/types";

export type RigDefinitionDraft = {
  setupScript: string;
  checks: RigCheck[];
};

export function emptyRigDefinitionDraft(): RigDefinitionDraft {
  return { setupScript: "", checks: [] };
}

export function RigDefinitionFields({
  value,
  onChange,
  disabled,
  idPrefix = "rig",
}: {
  value: RigDefinitionDraft;
  onChange: (next: RigDefinitionDraft) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const checkKeys = useRef<string[]>([]);
  const nextCheckKey = useRef(1);
  while (checkKeys.current.length < value.checks.length) {
    checkKeys.current.push(`${idPrefix}-check-row-${nextCheckKey.current}`);
    nextCheckKey.current += 1;
  }
  if (checkKeys.current.length > value.checks.length) {
    checkKeys.current.length = value.checks.length;
  }
  const setChecks = (checks: RigCheck[]) => onChange({ ...value, checks });

  return (
    <FieldStack>
      <Field
        label="Setup script"
        optional
        hint="Bash that runs once when a sandbox starts. Keep it safe to run again."
      >
        <TextArea
          mono
          rows={5}
          value={value.setupScript}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, setupScript: event.target.value })}
          placeholder={"apt-get install -y ripgrep"}
          spellCheck={false}
        />
      </Field>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm leading-5 font-medium text-fg">
              Checks <span className="ml-1.5 text-xs font-normal text-fg-subtle">Optional</span>
            </p>
            <p className="text-xs leading-4.5 text-fg-muted">
              Commands that must succeed for the environment to count as healthy.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="shrink-0 pointer-coarse:h-11"
            onClick={() => setChecks([...value.checks, { name: "", command: "" }])}
          >
            <PlusIcon aria-hidden="true" />
            Add check
          </Button>
        </div>
        {value.checks.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2">
            {value.checks.map((check, index) => (
              <div
                key={checkKeys.current[index]}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
              >
                <TextInput
                  value={check.name}
                  disabled={disabled}
                  onChange={(event) =>
                    setChecks(
                      value.checks.map((c, i) =>
                        i === index ? { ...c, name: event.target.value } : c,
                      ),
                    )
                  }
                  placeholder="Node installed"
                  aria-label={`Check ${index + 1} name`}
                  className="max-sm:col-span-1"
                />
                <TextInput
                  mono
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
                  className="max-sm:order-3 max-sm:col-span-2"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={`Remove check ${index + 1}`}
                  className="text-fg-muted hover:text-danger pointer-coarse:size-11"
                  onClick={() => {
                    checkKeys.current.splice(index, 1);
                    setChecks(value.checks.filter((_, i) => i !== index));
                  }}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </FieldStack>
  );
}

/** Drop empty check rows and blank fields before sending to the API. */
export function cleanRigChecks(checks: RigCheck[]): RigCheck[] {
  return checks
    .map((check) => ({ name: check.name.trim(), command: check.command.trim() }))
    .filter((check) => check.name && check.command);
}
