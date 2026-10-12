import type { VaultPolicy, VaultSummary } from "@opengeni/react";
import { Checkbox, Field, useField } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OWNER_LABEL } from "./vault-model";

/* ----------------------------------------------------------------------------
   The schedule form's Secrets row (S12): which vaults every run may use.
   "All vaults" is the server default and includes vaults added later; picking
   vaults narrows every run. Runs use the schedule owner's access, so someone
   else's schedule can't use your Only me vaults.
   -------------------------------------------------------------------------- */

export function scheduleSecretsSummary(policy: VaultPolicy | undefined): string | null {
  if (!policy || policy.mode === "all") return null;
  const count = policy.vaultIds.length;
  return count === 0 ? "No secrets" : count === 1 ? "1 vault" : `${count} vaults`;
}

type ScheduleSecretsFieldProps = {
  value: VaultPolicy | undefined;
  onChange: (policy: VaultPolicy | undefined) => void;
  /** The viewer's vaults; null while loading or unavailable. */
  vaults: readonly VaultSummary[] | null;
  loading: boolean;
  error: Error | null;
  /** False when editing someone else's schedule: their access applies. */
  ownerIsViewer: boolean;
  ownerName?: string | undefined;
};

export function ScheduleSecretsField(props: ScheduleSecretsFieldProps) {
  const mode = props.value?.mode ?? "all";
  const selectedCount = props.value?.mode === "selected" ? props.value.vaultIds.length : 0;
  const owner = props.ownerName ?? "the owner";
  const hint =
    mode === "all"
      ? `Every vault ${props.ownerIsViewer ? "you" : owner} can use, including ones added later.`
      : selectedCount === 0
        ? "Runs can't use any secrets."
        : "Runs can use only the checked vaults.";
  return (
    <Field label="Secrets" hint={hint} group>
      <ScheduleSecretsControl {...props} />
    </Field>
  );
}

function ScheduleSecretsControl({
  value,
  onChange,
  vaults,
  loading,
  error,
  ownerIsViewer,
  ownerName,
}: ScheduleSecretsFieldProps) {
  const field = useField();
  const labelId = field?.labelId;
  const mode = value?.mode ?? "all";
  const selected = new Set(value?.mode === "selected" ? value.vaultIds : []);
  const listed = (vaults ?? []).filter((vault) => vault.ownerKind !== "task");
  const hidden = [...selected].filter((id) => !listed.some((vault) => vault.id === id)).length;
  const outOfReach = (vault: VaultSummary) => !ownerIsViewer && vault.ownerKind === "user";
  const owner = ownerName ?? "the owner";

  return (
    <>
      <SegmentedControl<"all" | "selected">
        className="self-start"
        aria-labelledby={labelId}
        aria-describedby={field?.describedBy}
        value={mode}
        onValueChange={(next) =>
          onChange(
            next === "all"
              ? undefined
              : {
                  mode: "selected",
                  vaultIds: listed.filter((vault) => !outOfReach(vault)).map((vault) => vault.id),
                },
          )
        }
        options={[
          { value: "all", label: "All vaults" },
          { value: "selected", label: "Selected vaults" },
        ]}
      />
      {mode === "selected" ? (
        loading && !vaults ? (
          <p role="status" className="m-0 text-sm text-fg-muted">
            Loading vaults…
          </p>
        ) : error && !vaults ? (
          <p className="m-0 text-sm text-danger">Vaults couldn't load. Refresh and try again.</p>
        ) : (
          <div className="flex min-w-0 max-w-[480px] flex-col gap-2">
            <ul
              aria-labelledby={labelId}
              className="m-0 flex max-h-80 min-w-0 list-none flex-col overflow-y-auto rounded-[10px] border border-border p-1"
            >
              {listed.map((vault) => {
                const unreachable = outOfReach(vault);
                return (
                  <li key={vault.id}>
                    <label
                      data-disabled={unreachable || undefined}
                      className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 text-sm leading-5 text-fg hover:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 pointer-coarse:min-h-11"
                    >
                      <Checkbox
                        checked={selected.has(vault.id) && !unreachable}
                        disabled={unreachable}
                        onCheckedChange={(next) => {
                          const ids = new Set(selected);
                          if (next) ids.add(vault.id);
                          else ids.delete(vault.id);
                          onChange({ mode: "selected", vaultIds: [...ids] });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {unreachable ? `Only you` : OWNER_LABEL[vault.ownerKind]}
                      </span>
                    </label>
                  </li>
                );
              })}
              {listed.length === 0 ? (
                <li className="px-2.5 py-2 text-sm text-fg-muted">No vaults yet.</li>
              ) : null}
            </ul>
            {hidden > 0 || !ownerIsViewer ? (
              <p className="m-0 text-xs leading-4.5 text-fg-muted">
                {[
                  hidden > 0
                    ? `${hidden === 1 ? "1 vault you can't see stays" : `${hidden} vaults you can't see stay`} selected.`
                    : null,
                  !ownerIsViewer
                    ? `Runs use ${owner}'s access, so your Only me vaults aren't available.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </>
  );
}
