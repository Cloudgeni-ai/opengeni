import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { VariableSetShortlistEditor } from "./variable-set-shortlist-editor";
import {
  readVariableSetShortlist,
  reconcileVariableSetShortlist,
  variableSetRuntimeIds,
  variableSetShortlistKey,
  writeVariableSetShortlist,
} from "@/lib/variable-set-shortlist";

export function NewSessionVariableSetPicker(props: {
  workspaceId: string;
  runtimeIds: string[];
  variableSets: { id: string; name: string; scope?: string }[];
  disabled: boolean;
  canAttach: boolean;
  canUse: boolean;
  leading?: ReactNode;
  onClose?: () => void;
  onChange: (runtimeIds: string[]) => void;
}) {
  const context = useAppContext();
  const key = variableSetShortlistKey(
    context.accessContext.subjectId,
    props.workspaceId,
    "new-chat",
  );
  return <DraftPicker key={key} {...props} preferenceKey={key} />;
}

function DraftPicker(
  props: Parameters<typeof NewSessionVariableSetPicker>[0] & { preferenceKey: string },
) {
  const runtimeKey = props.runtimeIds.join("\u0000");
  const load = useCallback(
    () =>
      reconcileVariableSetShortlist(
        runtimeKey ? runtimeKey.split("\u0000") : [],
        readVariableSetShortlist(props.preferenceKey),
      ),
    [runtimeKey, props.preferenceKey],
  );
  const [saved, setSaved] = useState(load);
  const [rows, setRows] = useState(load);
  useEffect(() => {
    const next = load();
    setSaved(next);
    setRows(next);
  }, [load]);
  const changed = JSON.stringify(rows) !== JSON.stringify(saved);
  const canEnable = props.canAttach && props.canUse;
  // A permission may be revoked after a switch changed but before Save.
  // Removing or switching off restored selections remains available.
  const unauthorizedAddition =
    !canEnable && rows.some((row) => row.enabled && !props.runtimeIds.includes(row.id));
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <VariableSetShortlistEditor
        rows={rows}
        variableSets={props.variableSets}
        disabled={props.disabled}
        canAdd={!props.disabled && canEnable}
        leading={props.leading}
        onChange={setRows}
      />
      {!canEnable ? (
        <p className="px-2 text-2xs text-fg-subtle">
          Attach and use permissions are required to enable variable sets. You can still turn sets
          off or remove them from this list.
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.disabled || !changed}
          onClick={() => setRows(saved)}
        >
          Undo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.disabled}
          onClick={() => {
            setRows(saved);
            props.onClose?.();
          }}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.disabled || !changed || unauthorizedAddition}
          onClick={() => {
            if (props.disabled || unauthorizedAddition) return;
            writeVariableSetShortlist(props.preferenceKey, rows);
            setSaved(rows);
            props.onChange(variableSetRuntimeIds(rows));
            props.onClose?.();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
