// Variable sets: named, workspace-scoped sets of secret variables that the
// worker decrypts and injects into the sandbox as variable set variables at
// session start. Values are write-only by design — set or rotate, never read.
import { useVariableSets, useScheduledTasks, useWorkspaceSessions } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimestamp } from "@/lib/format";
import { listViewState } from "@/lib/load-state";
import type { ScheduledTask, Session, WorkspaceVariableSet } from "@/types";

export function VariableSetsRoute({ workspaceId }: { workspaceId: string }) {
  const variableSets = useVariableSets();
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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<BoxIcon className="size-4" />}
        title="Variable sets"
        description="Named secret sets injected into the sandbox as environment variables at session start. Values are write-only: set or rotate them here; nothing ever reads them back."
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void variableSets.refresh()}
              disabled={variableSets.loading}
              className="h-9"
            >
              <RefreshCwIcon
                className={variableSets.loading ? "size-3.5 animate-spin" : "size-3.5"}
              />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setCreateOpen((open) => !open)}
              className="h-9"
            >
              <PlusIcon className="size-3.5" />
              New variable set
            </Button>
          </>
        }
      />

      {createOpen ? (
        <div className="mt-4 grid gap-3 rounded-lg border border-border bg-surface p-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="variableSet-name">Name</Label>
            <Input
              id="variableSet-name"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="staging-aws"
              className="h-9"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="variableSet-description">Description</Label>
            <Input
              id="variableSet-description"
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              placeholder="What these credentials reach"
              className="h-9"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              disabled={variableSets.mutating || !createName.trim()}
              onClick={() => void createVariableSet()}
              className="h-9"
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
        {variableSetsView === "loading" ? (
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
              <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-3.5" />
                New variable set
              </Button>
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
              onUpdate={(patch) => variableSets.update(variableSet.id, patch)}
              onDelete={async () => {
                const removed = await variableSets.remove(variableSet.id);
                if (removed) {
                  toast.success("Variable set deleted");
                }
                return removed;
              }}
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
    </div>
  );
}

function VariableSetCard(props: {
  workspaceId: string;
  variableSet: WorkspaceVariableSet;
  attachedSessions: Session[];
  attachedTasks: ScheduledTask[];
  attachmentsUnknown: boolean;
  mutating: boolean;
  onUpdate: (patch: {
    name?: string;
    description?: string | null;
  }) => Promise<WorkspaceVariableSet | null>;
  onDelete: () => Promise<boolean>;
  onSetVariable: (name: string, value: string) => Promise<unknown>;
  onDeleteVariable: (name: string) => Promise<boolean>;
}) {
  const { variableSet } = props;
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(variableSet.name);
  const [descriptionDraft, setDescriptionDraft] = useState(variableSet.description ?? "");
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  // Per-variable rotate drafts (write-only value entry).
  const [rotatingName, setRotatingName] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState("");
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
      toast.success(`Variable ${name} rotated`);
    }
  }

  return (
    <article className="rounded-lg border border-border bg-surface/45 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        {editing ? (
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            <Input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              aria-label="Variable set name"
              className="h-8 text-sm"
            />
            <Input
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              placeholder="Description"
              aria-label="Variable set description"
              className="h-8 text-sm"
            />
          </div>
        ) : (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{variableSet.name}</div>
            <div className="mt-0.5 text-xs text-fg-muted">
              {variableSet.description ?? "No description"}
            </div>
            <div className="mt-1 text-2xs text-fg-subtle">
              {variableSet.variables.length} variable{variableSet.variables.length === 1 ? "" : "s"}{" "}
              · updated {formatTimestamp(variableSet.updatedAt)}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={props.mutating}
                onClick={() => void saveDetails()}
              >
                <CheckIcon className="size-3.5" />
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Edit variable set"
                onClick={() => {
                  setNameDraft(variableSet.name);
                  setDescriptionDraft(variableSet.description ?? "");
                  setEditing(true);
                }}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete variable set"
                className="hover:text-status-failed"
                disabled={props.mutating || deleteBlocked}
                title={deleteBlockedReason ?? "Delete variable set"}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

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
              <div className="flex min-w-0 items-center gap-2">
                <KeyRoundIcon className="size-3 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{variable.name}</span>
                <span className="shrink-0 text-2xs text-fg-subtle">
                  v{variable.version} · {formatTimestamp(variable.updatedAt)}
                </span>
                <span
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle"
                  title="Values are write-only and never returned by the API"
                >
                  ••••••
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 shrink-0 text-2xs"
                  disabled={props.mutating}
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
                  className="shrink-0 hover:text-status-failed"
                  disabled={props.mutating}
                  onClick={() => setConfirmDeleteVariable(variable.name)}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
              {rotatingName === variable.name ? (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    type="password"
                    value={rotateValue}
                    onChange={(event) => setRotateValue(event.target.value)}
                    placeholder="New value (write-only)"
                    aria-label={`New value for ${variable.name}`}
                    className="h-8 flex-1 text-xs"
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-8"
                    disabled={props.mutating || !rotateValue}
                    onClick={() => void rotateVariable(variable.name)}
                  >
                    <CheckIcon className="size-3.5" />
                    Set
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
        <Input
          value={variableName}
          onChange={(event) => setVariableName(event.target.value)}
          placeholder="VARIABLE_NAME"
          aria-label="New variable name"
          className="h-8 font-mono text-xs"
        />
        <Input
          type="password"
          value={variableValue}
          onChange={(event) => setVariableValue(event.target.value)}
          placeholder="Value (write-only)"
          aria-label="New variable value"
          className="h-8 text-xs"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8"
          disabled={props.mutating || !variableName.trim() || !variableValue}
          onClick={() => void addVariable()}
        >
          <PlusIcon className="size-3.5" />
          Set variable
        </Button>
      </div>

      {attachmentCount > 0 ? (
        <div className="mt-3 border-t border-border/70 pt-2">
          <span className="text-2xs font-medium text-fg-muted">Attached to</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {props.attachedSessions.slice(0, 4).map((session) => (
              <Link
                key={session.id}
                to="/workspaces/$workspaceId/sessions/$sessionId"
                params={{ workspaceId: props.workspaceId, sessionId: session.id }}
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
  );
}
