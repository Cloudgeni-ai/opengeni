import type { MoveVaultItemRequest, VaultItem, VaultSummary } from "@opengeni/react";
import { useState } from "react";

import { Field, FieldStack } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";

import { VAULT_GROUP_TITLE, vaultErrorText, vaultGroup } from "./vault-model";

/** Move or copy one item to another writable vault (a small prompt, so a dialog). */
export function MoveItemDialog({
  item,
  vaults,
  open,
  onOpenChange,
  onMove,
}: {
  item: VaultItem | undefined;
  /** Every vault the person can see; the dialog offers the writable ones. */
  vaults: VaultSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (request: MoveVaultItemRequest, target: VaultSummary) => Promise<void>;
}) {
  const targets = vaults.filter(
    (vault) => vault.canWrite && vault.id !== item?.vaultId && vault.ownerKind !== "task",
  );
  const [mode, setMode] = useState<MoveVaultItemRequest["mode"]>("move");
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setMode("move");
          setTarget(null);
          setError(undefined);
        }
        onOpenChange(next);
      }}
      size="sm"
      title={item ? `Move ${item.name}` : "Move item"}
      description="References that name the old vault stop working after a move. A copy leaves this item where it is."
      submitLabel={mode === "move" ? "Move item" : "Copy item"}
      pendingLabel={mode === "move" ? "Moving…" : "Copying…"}
      submitDisabled={targets.length === 0}
      disabledReason={
        targets.length === 0 ? "There's no other vault you can add items to." : undefined
      }
      onSubmit={async (event) => {
        event.preventDefault();
        const chosen = targets.find((vault) => vault.id === target);
        if (!chosen) {
          setError("Choose a vault.");
          return false;
        }
        try {
          await onMove({ targetVaultId: chosen.id, mode }, chosen);
          return true;
        } catch (caught) {
          setError(vaultErrorText((caught as { cause?: unknown })?.cause ?? caught));
          return false;
        }
      }}
    >
      <FieldStack>
        <Field label="Action" group>
          <SegmentedControl
            options={[
              { value: "move" as const, label: "Move" },
              { value: "copy" as const, label: "Copy" },
            ]}
            value={mode}
            onValueChange={setMode}
            fullWidth
          />
        </Field>
        <Field label="To vault" error={error}>
          <SelectMenu
            options={targets.map((vault) => ({
              value: vault.id,
              label: vault.name,
              group: VAULT_GROUP_TITLE[vaultGroup(vault) ?? "workspace"],
            }))}
            value={target}
            onValueChange={(value) => {
              setTarget(value);
              setError(undefined);
            }}
            placeholder="Choose a vault"
            invalid={Boolean(error)}
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}
