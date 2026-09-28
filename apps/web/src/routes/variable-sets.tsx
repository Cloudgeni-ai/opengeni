// Variable sets: named organization-, workspace-, or user-scoped sets of secret
// variables that the worker decrypts and injects into the sandbox at session
// start. The web UI is write-only: values are never shown after saving (the
// permissioned, audited API and MCP read paths are unchanged).
//
//   /variable-sets                 the list          ?view=new  New variable set
//   /variable-sets/$variableSetId  the set's page    ?view=paste|edit
//                                  (?view=add redirects to the set's page, where one variable
//                                  is added inline at the bottom of the list)
import {
  useOpenGeni,
  useScheduledTasks,
  useVariableSets,
  useWorkspaceSessions,
} from "@opengeni/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  EditVariableSetPage,
  NewVariableSetPage,
  PasteVariablesPage,
  ReplaceValueDialog,
  type NewSetValues,
  type NewVariableInput,
} from "@/components/variable-sets/variable-set-forms";
import {
  blockedDeleteHint,
  confirmDependencies,
  errorParts,
  joinAnd,
  userFacingError,
  variableSetUsage,
  type VariableSetUsage,
} from "@/components/variable-sets/variable-set-model";
import {
  VariableSetDetailLoading,
  VariableSetDetailPage,
  VariableSetMissing,
  VariableSetsListPage,
  type ListState,
} from "@/components/variable-sets/variable-set-pages";
import { ContentPage } from "@/components/ui/content-layout";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { useAppContext } from "@/context";
import { orgLabel } from "@/lib/org";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { useWorkspaceRigs } from "@/lib/use-workspace-rigs";
import type { WorkspaceVariableSet } from "@/types";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";

export {
  sessionUsesVariableSet,
  variableSetUsage,
} from "@/components/variable-sets/variable-set-model";

export type VariableSetListView = "new";
export type VariableSetView = "paste" | "edit";

export function VariableSetsRoute({
  workspaceId,
  variableSetId,
  view,
}: {
  workspaceId: string;
  /** The open set, or undefined on the list. */
  variableSetId?: string | undefined;
  view?: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { client } = useOpenGeni();
  const access = context.accessContext;
  const canList =
    hasWorkspacePermission(access, workspaceId, "variable-sets:list") &&
    hasWorkspacePermission(access, workspaceId, "secrets:list");
  const canWriteSet = hasWorkspacePermission(access, workspaceId, "variable-sets:write");
  const canWriteSecrets =
    canWriteSet && hasWorkspacePermission(access, workspaceId, "secrets:write");
  const workspaceGrant = access.workspaceGrants.find((grant) => grant.workspaceId === workspaceId);
  const canManageOrganization = Boolean(
    workspaceGrant?.accountId &&
    hasAccountPermission(access, workspaceGrant.accountId, "account:admin"),
  );
  const canCreatePersonal = Boolean(
    context.managedSelfContext?.identity.subjectId === access.subjectId &&
    workspaceGrant?.accountId &&
    context.managedSelfContext.memberships.some(
      (membership) =>
        membership.status === "active" && membership.organizationId === workspaceGrant.accountId,
    ),
  );
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const organizationName = workspace
    ? orgLabel(workspace.accountId, access.accountGrants)
    : "your organization";

  const variableSets = useVariableSets({ enabled: canList });
  // What uses each set: chats, schedules, and environments that add it by default.
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
  } = useWorkspaceSessions({ limit: 100 });
  const { tasks, loading: tasksLoading, error: tasksError } = useScheduledTasks();
  const rigs = useWorkspaceRigs();
  // Fail closed: never offer Delete while what uses a set is unknown (initial
  // load or a failed read); a false-empty view could remove a set in use.
  const usageKnown = !(
    sessionsError !== null ||
    tasksError !== null ||
    (sessionsLoading && sessions.length === 0) ||
    (tasksLoading && tasks.length === 0)
  );
  const usageFor = useCallback(
    (set: WorkspaceVariableSet): VariableSetUsage =>
      variableSetUsage({
        workspaceId,
        variableSetId: set.id,
        sessions,
        tasks,
        rigs: rigs.rigs,
        defaultRigId: workspace?.defaultRigId ?? null,
        known: usageKnown,
      }),
    [workspaceId, sessions, tasks, rigs.rigs, workspace?.defaultRigId, usageKnown],
  );

  const sets = variableSets.variableSets;
  const listState: ListState =
    variableSets.loading && sets.length === 0
      ? "loading"
      : variableSets.error && sets.length === 0
        ? "error"
        : "ready";
  const set = variableSetId ? sets.find((candidate) => candidate.id === variableSetId) : undefined;
  const canManage = (candidate: WorkspaceVariableSet | undefined) =>
    Boolean(candidate) && (candidate!.scope !== "organization" || canManageOrganization);
  const canManageSet = canWriteSet && canManage(set);
  const canManageSecrets = canWriteSecrets && canManage(set);

  /* ------------------------------------------------------------ navigation */

  const openList = useCallback(
    (search: { view?: VariableSetListView } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/variable-sets",
        params: { workspaceId },
        search,
      }),
    [navigate, workspaceId],
  );
  const openSet = useCallback(
    (id: string, search: { view?: VariableSetView } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/variable-sets/$variableSetId",
        params: { workspaceId, variableSetId: id },
        search,
      }),
    [navigate, workspaceId],
  );

  /* ------------------------------------------------------------ mutations */

  // Direct client calls so a failure shows inside the form or dialog that
  // caused it; the hook's list refreshes afterwards.
  async function attempt<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw userFacingError(error);
    }
  }

  async function createSet(values: NewSetValues) {
    const created = await attempt(() =>
      client.createVariableSet(workspaceId, {
        scope: values.scope,
        name: values.name,
        ...(values.description ? { description: values.description } : {}),
        variables: values.variables,
      }),
    );
    await variableSets.refresh();
    toast.success(`Created ${created.name}`);
    openSet(created.id);
  }

  async function addVariables(
    target: WorkspaceVariableSet,
    variables: NewVariableInput[],
    replaced: string[],
  ) {
    const saved: string[] = [];
    try {
      for (const variable of variables) {
        await attempt(() =>
          client.setVariableSetVariable(workspaceId, target.id, variable.name, variable.value),
        );
        saved.push(variable.name);
      }
    } catch (error) {
      await variableSets.refresh();
      const message = error instanceof Error ? error.message : String(error);
      throw userFacingError(
        error,
        saved.length ? `Saved ${joinAnd(saved)}, then stopped: ${message}` : message,
      );
    }
    await variableSets.refresh();
    toast.success(
      saved.length === 1
        ? `Added ${saved[0]} to ${target.name}`
        : `Added ${saved.length} variables to ${target.name}`,
      replaced.length ? { description: `Replaced the value of ${joinAnd(replaced)}.` } : undefined,
    );
    openSet(target.id);
  }

  /** The inline row on the set's page: saves one variable and stays on the page. */
  async function addOneVariable(target: WorkspaceVariableSet, variable: NewVariableInput) {
    await attempt(() =>
      client.setVariableSetVariable(workspaceId, target.id, variable.name, variable.value),
    );
    await variableSets.refresh();
    toast.success(`Added ${variable.name}`);
  }

  async function saveDetails(
    target: WorkspaceVariableSet,
    name: string,
    description: string | null,
  ) {
    await attempt(() => client.updateVariableSet(workspaceId, target.id, { name, description }));
    await variableSets.refresh();
    toast.success("Saved");
    openSet(target.id);
  }

  // The old Add variable page: adding one variable now happens inline on the set's page.
  useEffect(() => {
    if (variableSetId && view === "add") {
      void navigate({
        to: "/workspaces/$workspaceId/variable-sets/$variableSetId",
        params: { workspaceId, variableSetId },
        search: {},
        replace: true,
      });
    }
  }, [navigate, variableSetId, view, workspaceId]);

  /* ------------------------------------------------------------ dialogs */

  const [replacing, setReplacing] = useState<string | null>(null);
  const [deletingVariable, setDeletingVariable] = useState<string | null>(null);
  const [deletingSet, setDeletingSet] = useState(false);

  // Leaving a set closes its dialogs.
  useEffect(() => {
    setReplacing(null);
    setDeletingVariable(null);
    setDeletingSet(false);
  }, [variableSetId]);

  /* ------------------------------------------------------------ focus */

  const pageKey = `${variableSetId ?? ""}|${view ?? ""}`;
  const root = useFocusOnNavigation(pageKey, {
    onList: pageKey === "|",
    // An open set's page (not its forms): its title names its row on the list.
    rememberTitle: Boolean(variableSetId) && !view,
  });

  /* ------------------------------------------------------------ pages */

  let page: ReactNode;
  if (!variableSetId) {
    if (view === "new" && canList && canWriteSet) {
      page = (
        <NewVariableSetPage
          sets={sets}
          organizationName={organizationName}
          organizationEnabled={canManageOrganization}
          personalEnabled={canCreatePersonal}
          onClose={() => openList()}
          onCreate={createSet}
        />
      );
    } else {
      page = (
        <VariableSetsListPage
          state={listState}
          error={variableSets.error}
          sets={sets}
          usageFor={usageFor}
          organizationName={organizationName}
          canCreate={canWriteSet}
          canList={canList}
          onRetry={() => void variableSets.refresh()}
          onOpenSet={(each) => openSet(each.id)}
          onNewSet={() => openList({ view: "new" })}
        />
      );
    }
  } else if (!canList) {
    page = <VariableSetMissing onBack={() => openList()} />;
  } else if (!set) {
    page =
      listState === "ready" ? (
        <VariableSetMissing onBack={() => openList()} />
      ) : listState === "error" ? (
        <VariableSetMissing onBack={() => openList()} />
      ) : (
        <VariableSetDetailLoading onBack={() => openList()} />
      );
  } else if (view === "paste" && canManageSecrets) {
    page = (
      <PasteVariablesPage
        set={set}
        onClose={() => openSet(set.id)}
        onAdd={(variables, replaced) => addVariables(set, variables, replaced)}
      />
    );
  } else if (view === "edit" && canManageSet) {
    page = (
      <EditVariableSetPage
        set={set}
        sets={sets}
        organizationName={organizationName}
        onClose={() => openSet(set.id)}
        onSave={(name, description) => saveDetails(set, name, description)}
      />
    );
  } else {
    page = (
      <VariableSetDetailPage
        set={set}
        usage={usageFor(set)}
        organizationName={organizationName}
        canManageSet={canManageSet}
        canManageSecrets={canManageSecrets}
        actions={{
          back: () => openList(),
          addVariable: (variable) => addOneVariable(set, variable),
          pasteEnv: () => openSet(set.id, { view: "paste" }),
          replaceValue: setReplacing,
          deleteVariable: setDeletingVariable,
          editSet: () => openSet(set.id, { view: "edit" }),
          deleteSet: () => setDeletingSet(true),
          openUsage: (entry) => void navigate({ href: entry.href }),
        }}
      />
    );
  }

  const usage = set ? usageFor(set) : null;
  const inUse = Boolean(usage?.known && usage.entries.length > 0);
  const variableUsers = usage?.known ? usage.entries.map((entry) => entry.name) : [];

  return (
    <ContentPage width="standard">
      <div ref={root} className="min-w-0 pb-7">
        {page}
      </div>

      <ReplaceValueDialog
        set={set}
        variableName={replacing}
        onClose={() => setReplacing(null)}
        onReplace={async (value) => {
          if (!set || !replacing) return;
          const name = replacing;
          await attempt(() => client.setVariableSetVariable(workspaceId, set.id, name, value));
          await variableSets.refresh();
          toast.success(`Replaced ${name}`, { description: "New turns get the new value." });
        }}
      />

      <DestructiveConfirm
        open={Boolean(set && deletingVariable)}
        onOpenChange={(open) => (open ? undefined : setDeletingVariable(null))}
        title={deletingVariable ? `Delete ${deletingVariable}?` : ""}
        consequences={
          set && deletingVariable
            ? [
                variableUsers.length
                  ? `New turns in ${joinAnd(variableUsers.slice(0, 3))}${
                      variableUsers.length > 3 ? ` and ${variableUsers.length - 3} more` : ""
                    } won't get ${deletingVariable}.`
                  : `New turns that use ${set.name} won't get ${deletingVariable}.`,
                "Turns already running keep it.",
                "This can't be undone.",
              ]
            : undefined
        }
        confirmLabel="Delete variable"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!set || !deletingVariable) return;
          const name = deletingVariable;
          await attempt(() => client.deleteVariableSetVariable(workspaceId, set.id, name));
          await variableSets.refresh();
          toast.success(`Deleted ${name}`, { description: `From ${set.name}` });
        }}
      />

      <DestructiveConfirm
        open={Boolean(set && deletingSet)}
        onOpenChange={(open) => (open ? undefined : setDeletingSet(false))}
        variant={!usage?.known || inUse ? "blocked" : "consequences"}
        title={
          !set
            ? ""
            : !usage?.known
              ? `Checking what uses ${set.name}`
              : inUse
                ? `${set.name} is in use`
                : `Delete ${set.name}?`
        }
        description={
          !usage?.known
            ? "Chats and schedules are still loading, or couldn't load. Try again in a moment."
            : inUse
              ? blockedDeleteHint(usage.entries)
              : undefined
        }
        dependencies={inUse && usage ? confirmDependencies(usage.entries) : undefined}
        consequences={
          set
            ? [
                set.variables.length
                  ? `Its ${set.variables.length} ${
                      set.variables.length === 1 ? "variable goes" : "variables go"
                    } with it.`
                  : "It has no variables.",
                "No chat, schedule or environment here uses it, so nothing else changes.",
                "This can't be undone.",
              ]
            : undefined
        }
        confirmLabel="Delete variable set"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!set) return;
          const name = set.name;
          try {
            await client.deleteVariableSet(workspaceId, set.id);
          } catch (error) {
            const parts = errorParts(error);
            // The server also counts finished chats, older chats and other
            // workspaces, which this page can't list.
            throw userFacingError(
              error,
              parts.status === 409
                ? `Something still uses ${name}, like an older or finished chat. Remove it there first.`
                : parts.message,
            );
          }
          setDeletingSet(false);
          openList();
          toast.success(`Deleted ${name}`);
          await variableSets.refresh();
        }}
      />
    </ContentPage>
  );
}
