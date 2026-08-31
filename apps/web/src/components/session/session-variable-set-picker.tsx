import { useVariableSets } from "@opengeni/react";
import type { Session } from "@opengeni/sdk";
import { BoxIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SelectedVariableSetList } from "@/components/session/selected-variable-set-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

function selectedVariableSetIds(
  session: Pick<Session, "variableSetIds" | "variableSetId">,
): string[] {
  return session.variableSetIds ?? (session.variableSetId ? [session.variableSetId] : []);
}

export function SessionVariableSetPicker(props: {
  session: Pick<Session, "id" | "workspaceId" | "variableSetIds" | "variableSetId" | "tenancy">;
  canControl: boolean;
  canAttach: boolean;
  canUse: boolean;
  canList: boolean;
  disabled?: boolean;
  busy?: boolean;
  goalActive?: boolean;
  voiceActive?: boolean;
  compact?: boolean;
  triggerClassName?: string;
  onReloadSession: () => Promise<void>;
}) {
  const context = useAppContext();
  const variableSets = useVariableSets({
    workspaceId: props.session.workspaceId,
    enabled: props.canList,
  });
  const variableSetIds = props.session.variableSetIds;
  const legacyVariableSetId = props.session.variableSetId;
  const currentIds = useMemo(
    () =>
      selectedVariableSetIds({
        variableSetIds,
        variableSetId: legacyVariableSetId,
      }),
    [legacyVariableSetId, variableSetIds],
  );
  const currentKey = currentIds.join("\u0000");
  const [open, setOpen] = useState(false);
  const [draftIds, setDraftIds] = useState(currentIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedSelection, setCommittedSelection] = useState<{
    sessionId: string;
    key: string;
  } | null>(null);
  const refreshRequired = committedSelection?.sessionId === props.session.id;

  useEffect(() => {
    if (
      committedSelection?.sessionId === props.session.id &&
      currentKey !== committedSelection.key
    ) {
      return;
    }
    setDraftIds(currentIds);
    setCommittedSelection(null);
    setError(null);
  }, [committedSelection, currentIds, currentKey, props.session.id]);

  const selectedChanged = draftIds.join("\u0000") !== currentKey;
  const availableVariableSets = variableSets.variableSets.filter(
    (variableSet) => !draftIds.includes(variableSet.id),
  );
  const selectedPersonal = variableSets.variableSets.filter(
    (variableSet) => variableSet.scope === "user" && draftIds.includes(variableSet.id),
  );
  const canEdit = props.canControl && props.canAttach && !refreshRequired;
  const canAdd = canEdit && props.canUse && props.canList;
  const busy = props.busy || props.goalActive || props.voiceActive;
  const visible = refreshRequired || currentIds.length > 0 || canAdd;
  if (!visible) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await context.client.updateSessionVariableSets(props.session.workspaceId, props.session.id, {
        variableSetIds: draftIds,
      });
      const nextCommittedKey = draftIds.join("\u0000");
      setCommittedSelection({ sessionId: props.session.id, key: nextCommittedKey });
      try {
        await props.onReloadSession();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const refreshMessage = `The Variable Sets were updated, but the session could not be refreshed: ${message}`;
        setError(refreshMessage);
        setOpen(false);
        toast.warning("Variable Sets updated; refresh required", { description: message });
        return;
      }
      setOpen(false);
      toast.success("Variable Sets updated", {
        description: "The selection will apply to the next message in a fresh sandbox.",
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error("Variable Sets were not updated", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const refreshCommittedSession = async () => {
    setSaving(true);
    try {
      await props.onReloadSession();
      setOpen(false);
      toast.success("Session refreshed");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        `The Variable Sets were updated, but the session could not be refreshed: ${message}`,
      );
      toast.warning("Session refresh failed", { description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          if (!refreshRequired) {
            setDraftIds(currentIds);
            setError(null);
          }
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size={props.compact ? "icon-xs" : "sm"}
          disabled={props.disabled}
          aria-label={`Variable Sets${currentIds.length > 0 ? `, ${currentIds.length} attached` : ""}`}
          className={cn(
            props.compact
              ? "size-11 shrink-0 rounded-full border border-border"
              : "h-8 max-w-44 gap-1.5 rounded-full px-2.5 text-xs",
            currentIds.length > 0 && "border-brand/35 bg-brand/10 text-fg",
            props.triggerClassName,
          )}
        >
          <BoxIcon className="size-3.5" />
          {props.compact ? null : (
            <>
              <span className="truncate">Variable Sets · {currentIds.length}</span>
              <ChevronDownIcon className="size-3 shrink-0" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-xl border-border bg-surface p-3 shadow-xl"
      >
        <div>
          <div className="text-sm font-medium text-fg">Variable Sets</div>
          <p className="mt-0.5 text-2xs leading-4 text-fg-subtle">
            Attach, remove, or reorder encrypted environment values for the next message.
          </p>
        </div>

        {draftIds.length > 0 ? (
          <SelectedVariableSetList
            selectedIds={draftIds}
            variableSets={variableSets.variableSets}
            disabled={saving || !canEdit || !props.canUse}
            onChange={setDraftIds}
          />
        ) : (
          <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-center text-xs text-fg-subtle">
            No Variable Sets attached.
          </p>
        )}

        {canAdd && availableVariableSets.length > 0 && draftIds.length < 25 ? (
          <Select
            value=""
            disabled={saving}
            onChange={(event) => {
              const variableSetId = event.target.value;
              if (!variableSetId) return;
              setDraftIds((current) => [...current, variableSetId]);
            }}
            className="h-8 w-full text-xs"
          >
            <option value="">Attach Variable Set…</option>
            {availableVariableSets
              .filter((variableSet) => variableSet.scope !== "user")
              .map((variableSet) => (
                <option key={variableSet.id} value={variableSet.id}>
                  {variableSet.name} ({variableSet.variables.length} vars)
                </option>
              ))}
            {availableVariableSets.some((variableSet) => variableSet.scope === "user") ? (
              <optgroup label="Only me">
                {availableVariableSets
                  .filter((variableSet) => variableSet.scope === "user")
                  .map((variableSet) => (
                    <option key={variableSet.id} value={variableSet.id}>
                      {variableSet.name} ({variableSet.variables.length} vars)
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </Select>
        ) : null}

        {canEdit && !props.canUse && draftIds.length > 0 ? (
          <div className="flex items-center justify-between gap-3 text-xs text-fg-subtle">
            <span>
              Without Variable Set use permission, all attachments must be removed together.
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => setDraftIds([])}
            >
              Remove all
            </Button>
          </div>
        ) : null}

        {variableSets.error ? (
          <div className="flex items-center justify-between gap-3 text-xs text-status-waiting">
            <span>
              Available Variable Sets could not be loaded.
              {canEdit
                ? props.canUse
                  ? " Attached entries can still be removed."
                  : " The complete attachment selection can still be cleared."
                : ""}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={variableSets.loading}
              onClick={() => void variableSets.refresh()}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {props.session.tenancy?.visibility === "workspace" && selectedPersonal.length > 0 ? (
          <p className="text-2xs leading-4 text-fg-subtle">
            Only-me Variable Sets are used only for messages you send. Other members may see the
            result, but cannot use your credentials.
          </p>
        ) : null}

        {!props.canControl ? (
          <p className="text-2xs text-fg-subtle">
            Session control permission is required to change Variable Sets.
          </p>
        ) : null}
        {props.goalActive ? (
          <p className="text-2xs text-fg-subtle">
            Pause or complete the active goal before changing Variable Sets.
          </p>
        ) : props.voiceActive ? (
          <p className="text-2xs text-fg-subtle">End voice mode before changing Variable Sets.</p>
        ) : props.busy ? (
          <p className="text-2xs text-fg-subtle">
            Variable Sets can be changed after the current and queued work finishes.
          </p>
        ) : null}
        {refreshRequired ? (
          <div className="flex items-center justify-between gap-3 text-xs text-status-waiting">
            <span>
              The update committed, but this session must be refreshed before more changes.
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => void refreshCommittedSession()}
            >
              Retry refresh
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-border/70 pt-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              !selectedChanged ||
              saving ||
              busy ||
              !canEdit ||
              (draftIds.length > 0 && !props.canUse)
            }
            onClick={() => void save()}
          >
            {saving ? <Loader2Icon className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
