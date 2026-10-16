import type { MoveVaultItemRequest, VaultItem, VaultSummary } from "@opengeni/react";
import { useState } from "react";

import { Field, FieldStack } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";

import { VAULT_GROUP_TITLE, vaultErrorText, vaultGroup } from "./vault-model";

/**
 * Move or copy one item to another vault (a small prompt, so a dialog). Copy
 * only when this vault can't let the item go, for example a password manager
 * vault Opengeni can't archive in.
 */
export function MoveItemDialog({
  item,
  targets,
  canMove = true,
  leavesBehind,
  open,
  onOpenChange,
  onMove,
}: {
  item: VaultItem | undefined;
  /** The vaults that can take this item, decided by the route. */
  targets: VaultSummary[];
  /** Whether this vault can let the item go; otherwise only Copy. */
  canMove?: boolean;
  /**
   * What a move does to the original in a password manager, said up front:
   * "A move puts the original in Proton Pass trash."
   */
  leavesBehind?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (request: MoveVaultItemRequest, target: VaultSummary) => Promise<void>;
}) {
  const initialMode: MoveVaultItemRequest["mode"] = canMove ? "move" : "copy";
  const [mode, setMode] = useState<MoveVaultItemRequest["mode"]>(initialMode);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setMode(initialMode);
          setTarget(null);
          setError(undefined);
        }
        onOpenChange(next);
      }}
      size="sm"
      title={
        canMove
          ? item
            ? `Move ${item.name}`
            : "Move item"
          : item
            ? `Copy ${item.name}`
            : "Copy item"
      }
      description={
        canMove
          ? `${leavesBehind ? `${leavesBehind} ` : ""}References that name the old vault stop working after a move. A copy leaves this item where it is.`
          : "A copy leaves this item where it is. Only vaults that can hold everything in it are listed."
      }
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
        {canMove ? (
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
        ) : null}
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
