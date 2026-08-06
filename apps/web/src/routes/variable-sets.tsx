// Variable sets: named, workspace-scoped sets of secret variables that the
// worker decrypts and injects into the sandbox as variable set variables at
// session start. Generic reads are metadata-only; an explicitly permissioned
// and audited endpoint reveals one value on demand.
import { useVariableSets, useScheduledTasks, useWorkspaceSessions } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { formatTimestamp } from "@/lib/format";
import { listViewState } from "@/lib/load-state";
import { hasWorkspacePermission } from "@/lib/permissions";
import type {
  ScheduledTask,
  Session,
  WorkspaceVariableSet,
  WorkspaceVariableSetSecret,
} from "@/types";

export function VariableSetsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const canList =
    hasWorkspacePermission(context.accessContext, workspaceId, "variable-sets:list") &&
    hasWorkspacePermission(context.accessContext, workspaceId, "secrets:list");
  const canWriteSet = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "variable-sets:write",
  );
  const canWriteSecrets =
    canWriteSet && hasWorkspacePermission(context.accessContext, workspaceId, "secrets:write");
  const canReadSecrets =
    hasWorkspacePermission(context.accessContext, workspaceId, "variable-sets:read") &&
    hasWorkspacePermission(context.accessContext, workspaceId, "secrets:read");
  const variableSets = useVariableSets({ enabled: canList });
  // Attachment views: which sessions and scheduled tasks carry each variableSet.
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
  } = useWorkspaceSessions({ limit: 100 });
  const { tasks, loading: tasksLoading, error: tasksError } = useScheduledTasks();
  // Fail closed: never delete a variable set while its attachment set is
  // unknown (initial load or a failed read) — a false-empty attachment view
  // could otherwise let a still-referenced variableSet be removed.
  const attachmentsUnknown =
    sessionsError !== null ||
    tasksError !== null ||
    (sessionsLoading && sessions.length === 0) ||
    (tasksLoading && tasks.length === 0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [revealEpoch, setRevealEpoch] = useState(0);
  // Honest list state: a failed load renders as an error with retry, never as
  // the "No variable sets yet…" empty state.
  const variableSetsView = listViewState({
    loading: variableSets.loading,
    error: variableSets.error,
    count: variableSets.variableSets.length,
  });

  async function createVariableSet() {
    const name = createName.trim();
    if (!name) {
      toast.error("Variable set name is required");
      return;
    }
    const created = await variableSets.create({
      name,
      ...(createDescription.trim() ? { description: createDescription.trim() } : {}),
    });
    if (created) {
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      toast.success("Variable set created");
    } else if (variableSets.mutationError) {
      toast.error("Failed to create variableSet", {
        description: variableSets.mutationError.message,
      });
    }
  }

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BoxIcon className="size-4" />}
        title="Variable sets"
        description="Named secrets injected into sandboxes at session start. Values stay encrypted at rest; explicitly permissioned reads reveal one value on demand and are audited."
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRevealEpoch((current) => current + 1);
                void variableSets.refresh();
              }}
              disabled={variableSets.loading}
              className="h-9 pointer-coarse:min-h-10"
            >
              <RefreshCwIcon
                className={variableSets.loading ? "size-3.5 animate-spin" : "size-3.5"}
              />
              Refresh
            </Button>
            {canWriteSet ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen((open) => !open)}
                className="h-9 pointer-coarse:min-h-10"
              >
                <PlusIcon className="size-3.5" />
                New variable set
              </Button>
            ) : null}
          </>
        }
      />

      {!canList ? (
        <div className="mt-5">
          <Notice tone="info">You don&apos;t have permission to list variable sets.</Notice>
        </div>
      ) : createOpen && canWriteSet ? (
        <div className="mt-4 grid gap-3 rounded-lg border border-border bg-surface p-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="variableSet-name">Name</Label>
            <Input
              id="variableSet-name"
              name="variable-set-name"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="staging-aws"
              autoComplete="off"
              className="h-9 pointer-coarse:min-h-10"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="variableSet-description">Description</Label>
            <Input
              id="variableSet-description"
              name="variable-set-description"
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="What these credentials reach"
              autoComplete="off"
              className="h-9 pointer-coarse:min-h-10"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              disabled={variableSets.mutating || !createName.trim()}
              onClick={() => void createVariableSet()}
              className="h-9 pointer-coarse:min-h-10"
            >
              {variableSets.mutating ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
              Create
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        {!canList ? null : variableSetsView === "loading" ? (
          <>
            {[0, 1].map((key) => (
              <div key={key} className="rounded-lg border border-border bg-surface/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="size-8 rounded-md" />
                </div>
                <Skeleton className="mt-3 h-8 w-full" />
              </div>
            ))}
          </>
        ) : variableSetsView === "error" ? (
          <LoadErrorState
            title="Couldn't load variable sets"
            error={variableSets.error}
            onRetry={() => void variableSets.refresh()}
          />
        ) : variableSetsView === "empty" ? (
          <EmptyState
            icon={<BoxIcon className="size-4" />}
            title="No variable sets yet"
            description="Create one to give sessions and scheduled tasks credentials without pasting secrets into prompts."
            action={
              canWriteSet ? (
                <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
                  <PlusIcon className="size-3.5" />
                  New variable set
                </Button>
              ) : undefined
            }
          />
        ) : (
          variableSets.variableSets.map((variableSet) => (
            <VariableSetCard
              key={variableSet.id}
              workspaceId={workspaceId}
              variableSet={variableSet}
              attachedSessions={sessions.filter(
                (session) => session.variableSetId === variableSet.id,
              )}
              attachedTasks={tasks.filter((task) => task.variableSetId === variableSet.id)}
              attachmentsUnknown={attachmentsUnknown}
              mutating={variableSets.mutating}
              canWriteSet={canWriteSet}
              canWriteSecrets={canWriteSecrets}
              canReadSecrets={canReadSecrets}
              revealEpoch={revealEpoch}
              onUpdate={(patch) => variableSets.update(variableSet.id, patch)}
              onDelete={async () => {
                const removed = await variableSets.remove(variableSet.id);
                if (removed) {
                  toast.success("Variable set deleted");
                }
                return removed;
              }}
              onReadVariable={(name) => variableSets.readVariable(variableSet.id, name)}
              onSetVariable={(name, value) => variableSets.setVariable(variableSet.id, name, value)}
              onDeleteVariable={(name) => variableSets.deleteVariable(variableSet.id, name)}
            />
          ))
        )}
        {variableSets.mutationError ? (
          <Notice
            tone="failed"
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={variableSets.clearMutationError}
              >
                Dismiss
              </Button>
            }
          >
            {variableSets.mutationError.message}
          </Notice>
        ) : null}
      </div>
    </ContentPage>
  );
}

export function VariableSetCard(props: {
  workspaceId: string;
  variableSet: WorkspaceVariableSet;
  attachedSessions: Session[];
  attachedTasks: ScheduledTask[];
  attachmentsUnknown: boolean;
  mutating: boolean;
  canWriteSet: boolean;
  canWriteSecrets: boolean;
  canReadSecrets: boolean;
  revealEpoch: number;
  onUpdate: (patch: {
    name?: string;
    description?: string | null;
  }) => Promise<WorkspaceVariableSet | null>;
  onDelete: () => Promise<boolean>;
  onReadVariable: (name: string) => Promise<WorkspaceVariableSetSecret | null>;
  onSetVariable: (name: string, value: string) => Promise<unknown>;
  onDeleteVariable: (name: string) => Promise<boolean>;
}) {
  const { variableSet } = props;
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [nameDraft, setNameDraft] = useState(variableSet.name);
  const [descriptionDraft, setDescriptionDraft] = useState(variableSet.description ?? "");
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  // Per-variable rotate drafts are separate from explicitly revealed values.
  const [rotatingName, setRotatingName] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [readingName, setReadingName] = useState<string | null>(null);
  // Destructive confirms (D5): delete the variableSet, or one of its variables.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteVariable, setConfirmDeleteVariable] = useState<string | null>(null);
  const attachmentCount = props.attachedSessions.length + props.attachedTasks.length;
  const deleteBlocked = attachmentCount > 0 || props.attachmentsUnknown;
  const deleteBlockedReason = props.attachmentsUnknown
    ? "Checking where this variable set is used…"
    : attachmentCount > 0
      ? "Detach it from sessions and tasks first"
      : undefined;

  useEffect(() => {
    setRevealedValues({});
  }, [props.revealEpoch, variableSet.updatedAt]);

  function clearRevealedValue(name: string) {
    setRevealedValues((current) => {
      if (!Object.hasOwn(current, name)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  async function revealVariable(name: string) {
    setReadingName(name);
    try {
      const secret = await props.onReadVariable(name);
      if (secret) {
        setRevealedValues((current) => ({ ...current, [name]: secret.value }));
      }
    } finally {
      setReadingName((current) => (current === name ? null : current));
    }
  }

  async function copyRevealedValue(name: string) {
    const value = revealedValues[name];
    if (value === undefined) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${name}`);
    } catch {
      toast.error("Clipboard access was denied");
    }
  }

  async function saveDetails() {
    const result = await props.onUpdate({
      name: nameDraft.trim() || variableSet.name,
      description: descriptionDraft.trim() ? descriptionDraft.trim() : null,
    });
    if (result) {
      setEditing(false);
      toast.success("Variable set updated");
    }
  }

  async function addVariable() {
    const name = variableName.trim();
    if (!name || !variableValue) {
      toast.error("Variable name and value are required");
      return;
    }
    const result = await props.onSetVariable(name, variableValue);
    if (result) {
      setVariableName("");
      setVariableValue("");
      toast.success(`Variable ${name} set`);
    }
  }

  async function rotateVariable(name: string) {
    if (!rotateValue) {
      toast.error("Enter the new value");
      return;
    }
    const result = await props.onSetVariable(name, rotateValue);
    if (result) {
      setRotatingName(null);
      setRotateValue("");
      clearRevealedValue(name);
      toast.success(`Variable ${name} rotated`);
    }
  }

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        setExpanded(next);
        if (!next) {
          setRevealedValues({});
          setReadingName(null);
        }
      }}
      asChild
    >
      <article className="min-w-0 rounded-xl border border-border bg-surface/45 p-3 sm:p-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          {editing ? (
            <div className="grid min-w-0 gap-2 md:grid-cols-2">
              <Input
                name="variable-set-name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                aria-label="Variable set name"
                autoComplete="off"
                className="h-8 text-sm"
              />
              <Input
                name="variable-set-description"
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                placeholder="Description"
                aria-label="Variable set description"
                autoComplete="off"
                className="h-8 text-sm"
              />
            </div>
          ) : (
            <div className="min-w-0">
              <div
                className="break-words text-sm font-medium [overflow-wrap:anywhere]"
                title={variableSet.name}
              >
                {variableSet.name}
              </div>
              <div className="mt-0.5 break-words text-xs text-fg-muted [overflow-wrap:anywhere]">
                {variableSet.description ?? "No description"}
              </div>
              <div className="mt-1 text-2xs text-fg-subtle">
                {variableSet.variables.length} variable
                {variableSet.variables.length === 1 ? "" : "s"} · updated{" "}
                {formatTimestamp(variableSet.updatedAt)}
                {attachmentCount > 0
                  ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                  : ""}
              </div>
            </div>
          )}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 sm:shrink-0">
            {editing ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 pointer-coarse:min-h-10"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 pointer-coarse:min-h-10"
                  disabled={props.mutating}
                  onClick={() => void saveDetails()}
                >
                  <CheckIcon className="size-3.5" />
                  Save
                </Button>
              </>
            ) : (
              <>
                {props.canWriteSet ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="pointer-coarse:size-10"
                    aria-label="Edit variable set"
                    onClick={() => {
                      setNameDraft(variableSet.name);
                      setDescriptionDraft(variableSet.description ?? "");
                      setEditing(true);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                {props.canWriteSecrets ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete variable set"
                    className="hover:text-status-failed pointer-coarse:size-10"
                    disabled={props.mutating || deleteBlocked}
                    title={deleteBlockedReason ?? "Delete variable set"}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ) : null}
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 pointer-coarse:min-h-10"
                    aria-label={`${expanded ? "Hide" : "Show"} variables for ${variableSet.name}`}
                  >
                    {expanded ? "Hide" : "Show"}
                    <ChevronDownIcon
                      className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </Button>
                </CollapsibleTrigger>
              </>
            )}
          </div>
        </div>

        <CollapsibleContent>
          <div className="mt-3 space-y-1.5">
            {variableSet.variables.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                No variables yet — add one below to inject it into the sandbox.
              </p>
            ) : (
              variableSet.variables.map((variable) => (
                <div
                  key={variable.name}
                  className="rounded-md border border-border/70 bg-bg/25 px-2.5 py-1.5"
                >
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="flex min-w-0 items-start gap-2">
                      <KeyRoundIcon className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
                      <span
                        className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]"
                        title={variable.name}
                      >
                        {variable.name}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end">
                      <span className="text-2xs text-fg-subtle">
                        v{variable.version} · {formatTimestamp(variable.updatedAt)}
                      </span>
                      {revealedValues[variable.name] === undefined ? (
                        <span
                          className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle"
                          title={
                            props.canReadSecrets
                              ? "Value is hidden until explicitly revealed"
                              : "Requires variable-sets:read and secrets:read"
                          }
                          aria-label="Value hidden"
                        >
                          ••••••
                        </span>
                      ) : null}
                      {props.canReadSecrets ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-7 text-2xs pointer-coarse:min-h-10"
                          disabled={readingName === variable.name}
                          aria-label={`${
                            revealedValues[variable.name] === undefined ? "Reveal" : "Hide"
                          } variable ${variable.name}`}
                          onClick={() => {
                            if (revealedValues[variable.name] === undefined) {
                              void revealVariable(variable.name);
                            } else {
                              clearRevealedValue(variable.name);
                            }
                          }}
                        >
                          {readingName === variable.name ? (
                            <Loader2Icon className="size-3 animate-spin" />
                          ) : revealedValues[variable.name] === undefined ? (
                            <EyeIcon className="size-3" />
                          ) : (
                            <EyeOffIcon className="size-3" />
                          )}
                          {revealedValues[variable.name] === undefined ? "Reveal" : "Hide"}
                        </Button>
                      ) : null}
                      {props.canWriteSecrets ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="h-7 text-2xs pointer-coarse:min-h-10"
                            disabled={props.mutating}
                            aria-label={`Rotate variable ${variable.name}`}
                            aria-expanded={rotatingName === variable.name}
                            onClick={() => {
                              setRotatingName((current) =>
                                current === variable.name ? null : variable.name,
                              );
                              setRotateValue("");
                            }}
                          >
                            Rotate
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete variable ${variable.name}`}
                            className="hover:text-status-failed pointer-coarse:size-10"
                            disabled={props.mutating}
                            onClick={() => setConfirmDeleteVariable(variable.name)}
                          >
                            <Trash2Icon className="size-3" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {revealedValues[variable.name] !== undefined ? (
                    <div
                      className="mt-2 rounded-md border border-border bg-surface px-2.5 py-2"
                      aria-label={`Revealed value for ${variable.name}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-fg">
                          {revealedValues[variable.name]}
                        </pre>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-7 shrink-0 text-2xs pointer-coarse:min-h-10"
                          aria-label={`Copy variable ${variable.name}`}
                          onClick={() => void copyRevealedValue(variable.name)}
                        >
                          <CopyIcon className="size-3" />
                          Copy
                        </Button>
                      </div>
                      <p className="mt-1.5 text-2xs text-fg-subtle">
                        Audited plaintext read. Hide it when you&apos;re done.
                      </p>
                    </div>
                  ) : null}
                  {props.canWriteSecrets && rotatingName === variable.name ? (
                    <form
                      aria-label={`Rotate variable ${variable.name}`}
                      autoComplete="off"
                      className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rotateVariable(variable.name);
                      }}
                    >
                      <Input
                        name="variable-value"
                        type="password"
                        value={rotateValue}
                        onChange={(event) => setRotateValue(event.target.value)}
                        placeholder="New value"
                        aria-label={`New value for ${variable.name}`}
                        autoComplete="new-password"
                        className="h-8 flex-1 text-xs pointer-coarse:min-h-10"
                        autoFocus
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 pointer-coarse:min-h-10"
                        disabled={props.mutating || !rotateValue}
                      >
                        <CheckIcon className="size-3.5" />
                        Set
                      </Button>
                    </form>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {props.canWriteSecrets ? (
            <form
              aria-label={`Add variable to ${variableSet.name}`}
              autoComplete="off"
              className="mt-2 grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void addVariable();
              }}
            >
              <Input
                name="variable-name"
                value={variableName}
                onChange={(event) => setVariableName(event.target.value)}
                placeholder="VARIABLE_NAME"
                aria-label="New variable name"
                autoComplete="off"
                className="h-8 font-mono text-xs pointer-coarse:min-h-10"
              />
              <Input
                name="variable-value"
                type="password"
                value={variableValue}
                onChange={(event) => setVariableValue(event.target.value)}
                placeholder="Value"
                aria-label="New variable value"
                autoComplete="new-password"
                className="h-8 text-xs pointer-coarse:min-h-10"
              />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                className="h-8 pointer-coarse:min-h-10"
                disabled={props.mutating || !variableName.trim() || !variableValue}
              >
                <PlusIcon className="size-3.5" />
                Set variable
              </Button>
            </form>
          ) : null}

          {attachmentCount > 0 ? (
            <div className="mt-3 border-t border-border/70 pt-2">
              <span className="text-2xs font-medium text-fg-muted">Attached to</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {props.attachedSessions.slice(0, 4).map((session) => (
                  <Link
                    key={session.id}
                    to="/workspaces/$workspaceId/sessions/$sessionId"
                    params={{
                      workspaceId: props.workspaceId,
                      sessionId: session.id,
                    }}
                    className="min-w-0 max-w-full rounded-md hover:text-fg"
                    title={session.initialMessage}
                  >
                    <MetaChip className="hover:border-border-strong">
                      session · {session.initialMessage}
                    </MetaChip>
                  </Link>
                ))}
                {props.attachedSessions.length > 4 ? (
                  <MetaChip>+{props.attachedSessions.length - 4} more sessions</MetaChip>
                ) : null}
                {props.attachedTasks.map((task) => (
                  <MetaChip key={task.id} title={task.name}>
                    task · {task.name}
                  </MetaChip>
                ))}
              </div>
            </div>
          ) : null}
        </CollapsibleContent>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete variable set “${variableSet.name}”?`}
          description="Its variables are removed and sessions can no longer use them. This can't be undone."
          confirmLabel="Delete variable set"
          onConfirm={() => props.onDelete()}
        />
        <ConfirmDialog
          open={confirmDeleteVariable !== null}
          onOpenChange={(next) => setConfirmDeleteVariable(next ? confirmDeleteVariable : null)}
          title={`Delete variable “${confirmDeleteVariable ?? ""}”?`}
          description="Sessions using this variable set can no longer read it. This can't be undone."
          confirmLabel="Delete variable"
          onConfirm={async () => {
            const name = confirmDeleteVariable;
            if (!name) {
              return;
            }
            const removed = await props.onDeleteVariable(name);
            if (removed) {
              toast.success(`Variable ${name} deleted`);
            }
            return removed;
          }}
        />
      </article>
    </Collapsible>
  );
}
