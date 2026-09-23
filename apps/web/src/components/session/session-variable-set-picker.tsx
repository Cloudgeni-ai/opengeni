import { useVariableSets } from "@opengeni/react";
import type { Session } from "@opengeni/sdk";
import { ArrowLeftIcon, BoxIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import {
  type ReactNode,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { VariableSetShortlistEditor } from "@/components/session/variable-set-shortlist-editor";
import { COMPOSER_MENU_PANEL_CLASS } from "@/components/ui/composer-menu";
import {
  readVariableSetShortlist,
  reconcileVariableSetShortlist,
  variableSetRuntimeIds,
  variableSetShortlistKey,
  writeVariableSetShortlist,
} from "@/lib/variable-set-shortlist";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";
import { sessionHasVariableSetBlockingWork } from "@/lib/session-variable-set-editability";
import type { SessionVariableSetPickerSharedState } from "@/lib/use-session-variable-set-picker-state";
export type { SessionVariableSetPickerSharedState } from "@/lib/use-session-variable-set-picker-state";

function selectedVariableSetIds(
  session: Pick<Session, "variableSetIds" | "variableSetId">,
): string[] {
  return session.variableSetIds ?? (session.variableSetId ? [session.variableSetId] : []);
}

export function SessionVariableSetPicker(props: {
  session: Pick<
    Session,
    | "id"
    | "workspaceId"
    | "variableSetIds"
    | "variableSetId"
    | "tenancy"
    | "status"
    | "activeTurnId"
  >;
  canControl: boolean;
  canAttach: boolean;
  canUse: boolean;
  canList: boolean;
  disabled?: boolean;
  busy?: boolean;
  goalActive?: boolean;
  voiceActive?: boolean;
  embedded?: boolean;
  leading?: ReactNode;
  onClose?: () => void;
  compact?: boolean;
  triggerClassName?: string;
  sharedState: SessionVariableSetPickerSharedState;
  setSharedState: Dispatch<SetStateAction<SessionVariableSetPickerSharedState>>;
  onReloadSession: () => Promise<void>;
}) {
  const context = useAppContext();
  const setSharedState = props.setSharedState;
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
  const [open, setLocalOpen] = useState(false);
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    if (!next) props.onClose?.();
  };
  const preferenceKey = variableSetShortlistKey(
    context.accessContext?.subjectId ?? "",
    props.session.workspaceId,
    props.session.id,
  );
  const activeScope = useRef({ key: preferenceKey, generation: 0 });
  if (activeScope.current.key !== preferenceKey) {
    activeScope.current = { key: preferenceKey, generation: activeScope.current.generation + 1 };
  }
  const scope = activeScope.current;
  const previousPreferenceKey = useRef(preferenceKey);
  useEffect(() => {
    if (previousPreferenceKey.current === preferenceKey) return;
    previousPreferenceKey.current = preferenceKey;
    setSharedState({ saving: false, committedSelection: null });
  }, [preferenceKey, setSharedState]);
  const loadRows = () =>
    reconcileVariableSetShortlist(currentIds, readVariableSetShortlist(preferenceKey));
  const [savedRows, setSavedRows] = useState(loadRows);
  const [draftRows, setDraftRows] = useState(loadRows);
  const draftIds = variableSetRuntimeIds(draftRows);
  const [error, setError] = useState<string | null>(null);
  const { committedSelection, saving } = props.sharedState;
  const refreshRequired = committedSelection?.sessionId === props.session.id;

  useEffect(() => {
    if (
      committedSelection?.sessionId === props.session.id &&
      currentKey !== committedSelection.key
    ) {
      return;
    }
    const rows = reconcileVariableSetShortlist(
      currentKey ? currentKey.split("\u0000") : [],
      readVariableSetShortlist(preferenceKey),
    );
    setSavedRows(rows);
    setDraftRows(rows);
    setError(null);
  }, [committedSelection, currentKey, preferenceKey, props.session.id]);

  const selectedChanged = JSON.stringify(draftRows) !== JSON.stringify(savedRows);
  const runtimeChanged = draftIds.join("\u0000") !== currentKey;
  const selectedPersonal = variableSets.variableSets.filter(
    (variableSet) => variableSet.scope === "user" && draftIds.includes(variableSet.id),
  );
  const workPending = props.busy || sessionHasVariableSetBlockingWork(props.session);
  const busy = workPending || props.goalActive || props.voiceActive;
  const canEdit =
    props.canControl && props.canAttach && !props.disabled && !refreshRequired && !busy;
  const canAdd = canEdit && props.canUse && props.canList;
  const visible =
    refreshRequired ||
    currentIds.length > 0 ||
    (props.canControl && props.canAttach && props.canUse && props.canList);
  if (!visible && !props.embedded) return null;

  const save = async () => {
    if (
      saving ||
      busy ||
      !canEdit ||
      !selectedChanged ||
      draftIds.length > 25 ||
      (draftIds.length > 0 && !props.canUse)
    )
      return;
    setSharedState((current) => ({ ...current, saving: true }));
    setError(null);
    try {
      if (!runtimeChanged) {
        writeVariableSetShortlist(preferenceKey, draftRows);
        setSavedRows(draftRows);
        setOpen(false);
        return;
      }
      await context.client.updateSessionVariableSets(props.session.workspaceId, props.session.id, {
        variableSetIds: draftIds,
      });
      writeVariableSetShortlist(preferenceKey, draftRows);
      if (activeScope.current !== scope) return;
      setSavedRows(draftRows);
      const nextCommittedKey = draftIds.join("\u0000");
      setSharedState((current) => ({
        ...current,
        committedSelection: { sessionId: props.session.id, key: nextCommittedKey },
      }));
      try {
        await props.onReloadSession();
      } catch (cause) {
        if (activeScope.current !== scope) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        const refreshMessage = `The Variable Sets were updated, but the session could not be refreshed: ${message}`;
        setError(refreshMessage);
        setOpen(false);
        toast.warning("Variable Sets updated; refresh required", { description: message });
        return;
      }
      if (activeScope.current !== scope) return;
      setOpen(false);
      toast.success("Variable Sets updated", {
        description: "The selection will apply to the next message in a fresh sandbox.",
      });
    } catch (cause) {
      if (activeScope.current !== scope) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error("Variable Sets were not updated", { description: message });
    } finally {
      if (activeScope.current === scope)
        setSharedState((current) => ({ ...current, saving: false }));
    }
  };

  const refreshCommittedSession = async () => {
    setSharedState((current) => ({ ...current, saving: true }));
    try {
      await props.onReloadSession();
      if (activeScope.current !== scope) return;
      setOpen(false);
      toast.success("Session refreshed");
    } catch (cause) {
      if (activeScope.current !== scope) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        `The Variable Sets were updated, but the session could not be refreshed: ${message}`,
      );
      toast.warning("Session refresh failed", { description: message });
    } finally {
      if (activeScope.current === scope)
        setSharedState((current) => ({ ...current, saving: false }));
    }
  };

  const content = (
    <>
      <VariableSetShortlistEditor
        key={preferenceKey}
        rows={draftRows}
        variableSets={variableSets.variableSets}
        loading={variableSets.loading}
        leading={
          props.leading ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Back"
              onClick={() => {
                setDraftRows(savedRows);
                setOpen(false);
              }}
            >
              <ArrowLeftIcon />
            </Button>
          )
        }
        disabled={saving || !canEdit || !props.canUse}
        canAdd={canAdd}
        onChange={setDraftRows}
      />

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
            onClick={() => setDraftRows((rows) => rows.map((row) => ({ ...row, enabled: false })))}
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
          Attached Only-me Variable Sets are available for your work in this session. Results are
          visible to people who can access this chat.
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
      ) : workPending ? (
        <p className="text-2xs text-fg-subtle">
          Variable Sets can be changed after the current and queued work finishes.
        </p>
      ) : null}
      {refreshRequired ? (
        <div className="flex items-center justify-between gap-3 text-xs text-status-waiting">
          <span>The update committed, but this session must be refreshed before more changes.</span>
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
          disabled={saving || !selectedChanged}
          onClick={() => setDraftRows(savedRows)}
        >
          Undo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            setDraftRows(savedRows);
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !selectedChanged || saving || busy || !canEdit || (draftIds.length > 0 && !props.canUse)
          }
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </>
  );
  if (props.embedded)
    return <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">{content}</div>;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          if (!refreshRequired) {
            const rows = loadRows();
            setSavedRows(rows);
            setDraftRows(rows);
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
        className={cn(COMPOSER_MENU_PANEL_CLASS, "gap-2")}
      >
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
