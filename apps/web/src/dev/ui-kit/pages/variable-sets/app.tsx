import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { PlusIcon, VariableIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DestructiveConfirm, showUndoToast } from "@/components/ui/destructive-confirm";
import { DetailPage } from "@/components/ui/detail-page";

import { useAnswers, usePagePicks, useVerbs } from "./answers";
import { SetDetail, SetDetailLoading, announceUsage, type SetActions } from "./detail";
import {
  AddVariableForm,
  EditSetForm,
  NewSetForm,
  ReplaceValueDialog,
  wait,
  type AddMode,
  type NewSetValues,
  type SetTemplate,
} from "./forms";
import { AppFrame, useFrame } from "./frame";
import { ListPage, listIsEmpty, type LoadState } from "./list";
import {
  NOW_ISO,
  blockedDeleteHint,
  confirmDependencies,
  emptySet,
  joinAnd,
  newSetId,
  seedSets,
  setsReducer,
  usageEntries,
  type DataState,
  type NewVariable,
  type PreviewSet,
  type PreviewVariable,
} from "./model";

/* ----------------------------------------------------------------------------
   The Variable sets area as one small app on fixtures: the list, each set's
   own page, and every create and edit flow as its own page with a back link.
   Only confirmations and the one-field Replace value stay centered dialogs.
   -------------------------------------------------------------------------- */

type Route =
  | { name: "list" }
  | { name: "detail"; setId: string }
  | { name: "settings" }
  | { name: "new-set"; template?: SetTemplate }
  | { name: "add-variable"; setId: string; mode: AddMode }
  | { name: "edit-set"; setId: string };

function initialSets(dataState: DataState, withEmptySet: boolean): PreviewSet[] {
  const sets = seedSets(dataState === "loading" || dataState === "error" ? "default" : dataState);
  if (withEmptySet && !sets.some((set) => set.id === emptySet().id)) {
    return [...sets.slice(0, 4), emptySet(), ...sets.slice(4)];
  }
  return sets;
}

function loadStateFor(dataState: DataState): LoadState {
  return dataState === "loading" ? "loading" : dataState === "error" ? "error" : "ready";
}

/** Moves focus to the new page's heading, so keyboard and screen reader users land on it. */
function useFocusOnRouteChange(routeKey: string) {
  const { scrollRef } = useFrame();
  const previous = useRef(routeKey);
  useEffect(() => {
    // The first page doesn't take focus; only a change of page does.
    if (previous.current === routeKey) return;
    previous.current = routeKey;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: 0 });
    const heading = container.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.tabIndex = -1;
      // A heading is not a control: no ring, but screen readers start here.
      heading.style.outline = "none";
      heading.focus({ preventScroll: true });
    }
  }, [routeKey, scrollRef]);
}

function RouteFocus({ routeKey }: { routeKey: string }) {
  useFocusOnRouteChange(routeKey);
  return null;
}

export function VariableSetsApp({
  dataState = "default",
  initialSetId,
  withEmptySet = false,
}: {
  dataState?: DataState;
  /** Open this set's detail page first (the detail preview). */
  initialSetId?: string;
  /** Include the new, empty "Sentry" set. */
  withEmptySet?: boolean;
}) {
  const picks = usePagePicks();
  const answers = useAnswers();
  const verbs = useVerbs();
  const [sets, dispatch] = useReducer(setsReducer, undefined, () =>
    initialSets(dataState, withEmptySet),
  );
  const [loadState, setLoadState] = useState<LoadState>(() => loadStateFor(dataState));
  const [route, setRoute] = useState<Route>(
    initialSetId ? { name: "detail", setId: initialSetId } : { name: "list" },
  );
  const [replacing, setReplacing] = useState<{ setId: string; name: string } | null>(null);
  const [deletingVariable, setDeletingVariable] = useState<{
    setId: string;
    name: string;
  } | null>(null);
  const [deletingSetId, setDeletingSetId] = useState<string | null>(null);

  const setById = (id: string | null | undefined) =>
    id ? sets.find((set) => set.id === id) : undefined;

  // A "Loading" preview settles after a moment, like a real request.
  useEffect(() => {
    if (loadState !== "loading" || dataState === "loading") return;
    const timer = setTimeout(() => setLoadState("ready"), 900);
    return () => clearTimeout(timer);
  }, [dataState, loadState]);

  /* -------------------------------------------------------------- navigation */

  const openSet = (set: PreviewSet) => setRoute({ name: "detail", setId: set.id });

  const onNavigate = (id: string) => {
    if (id === "variable-sets") {
      setRoute({ name: "list" });
      return;
    }
    if (id === "settings") {
      setRoute({ name: "settings" });
      return;
    }
    toast("Only Variable sets is live in this preview", {
      description: "The other pages have their own previews under Pages in the kit.",
    });
  };

  /* -------------------------------------------------------------- mutations */

  const createSet = (values: NewSetValues, variables: NewVariable[]) => {
    const id = newSetId(values.name, sets);
    dispatch({
      type: "create",
      set: {
        id,
        name: values.name,
        description: values.description,
        scope: values.scope,
        usedBy: [],
        updatedAt: NOW_ISO,
        variables: [],
      },
    });
    if (variables.length) dispatch({ type: "upsert-variables", id, variables });
    toast.success(`Created ${values.name}`);
    setRoute({ name: "detail", setId: id });
  };

  const addVariables = (set: PreviewSet, variables: NewVariable[], replaced: string[]) => {
    dispatch({ type: "upsert-variables", id: set.id, variables });
    const names = variables.map((variable) => variable.name);
    toast.success(
      names.length === 1
        ? `Added ${names[0]} to ${set.name}`
        : `Added ${names.length} variables to ${set.name}`,
      replaced.length ? { description: `Replaced the value of ${joinAnd(replaced)}.` } : undefined,
    );
  };

  const removeSet = (set: PreviewSet) => {
    const index = sets.findIndex((each) => each.id === set.id);
    dispatch({ type: "delete-set", id: set.id });
    setRoute({ name: "list" });
    if (picks.destructive === "undo") {
      showUndoToast({
        title: `${verbs.removed} ${set.name}`,
        description: `${set.variables.length} ${set.variables.length === 1 ? "variable" : "variables"}`,
        onUndo: () => dispatch({ type: "restore-set", set, index }),
      });
    } else {
      toast.success(`${verbs.removed} ${set.name}`);
    }
  };

  const removeVariable = (set: PreviewSet, variable: PreviewVariable) => {
    const index = set.variables.findIndex((each) => each.name === variable.name);
    dispatch({ type: "delete-variable", id: set.id, name: variable.name });
    if (picks.destructive === "undo") {
      showUndoToast({
        title: `${verbs.removed} ${variable.name}`,
        description: `From ${set.name}`,
        onUndo: () => dispatch({ type: "restore-variable", id: set.id, variable, index }),
      });
    } else {
      toast.success(`${verbs.removed} ${variable.name}`, { description: `From ${set.name}` });
    }
  };

  const actionsFor = (set: PreviewSet): SetActions => ({
    addVariable: (mode) => setRoute({ name: "add-variable", setId: set.id, mode }),
    replaceValue: (variable) => setReplacing({ setId: set.id, name: variable.name }),
    deleteVariable: (variable) => {
      if (picks.destructive === "undo") removeVariable(set, variable);
      else setDeletingVariable({ setId: set.id, name: variable.name });
    },
    editSet: () => setRoute({ name: "edit-set", setId: set.id }),
    deleteSet: () => {
      const inUse = set.usedBy.length > 0;
      if (inUse && answers.inUse === "disable") return;
      if (!inUse && picks.destructive === "undo") removeSet(set);
      else setDeletingSetId(set.id);
    },
    openUsage: (entry) => announceUsage(entry),
  });

  /* -------------------------------------------------------------- pages */

  const detailSet = route.name === "detail" ? setById(route.setId) : undefined;
  const routeSet = "setId" in route ? setById(route.setId) : undefined;
  const backToSet = () =>
    setRoute(routeSet ? { name: "detail", setId: routeSet.id } : { name: "list" });

  // If the open set is deleted elsewhere (an undo toast from another pane), go back.
  useEffect(() => {
    if ("setId" in route && !routeSet && loadState === "ready") {
      setRoute({ name: "list" });
    }
  }, [routeSet, loadState, route]);

  const empty = listIsEmpty(sets, loadState);
  const newSetButton = (
    <Button
      type="button"
      onClick={() => setRoute({ name: "new-set" })}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      New variable set
    </Button>
  );

  const routeKey = "setId" in route ? `${route.name}:${route.setId}` : route.name;
  let page: ReactNode;

  if (route.name === "new-set") {
    page = (
      <AppFrame header={null} onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
        <NewSetForm
          presentation="page"
          open
          template={route.template}
          sets={sets}
          onClose={() => setRoute({ name: "list" })}
          onCreate={createSet}
          back={{ label: "Variable sets", onClick: () => setRoute({ name: "list" }) }}
        />
      </AppFrame>
    );
  } else if (route.name === "add-variable") {
    page = (
      <AppFrame header={null} onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
        <AddVariableForm
          presentation="page"
          open
          set={routeSet}
          initialMode={route.mode}
          onClose={backToSet}
          onAdd={(variables, replaced) => routeSet && addVariables(routeSet, variables, replaced)}
          back={routeSet ? { label: routeSet.name, onClick: backToSet } : undefined}
        />
      </AppFrame>
    );
  } else if (route.name === "edit-set") {
    page = (
      <AppFrame header={null} onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
        <EditSetForm
          set={routeSet}
          sets={sets}
          onClose={backToSet}
          onSave={(name, description) => {
            if (!routeSet) return;
            dispatch({ type: "update", id: routeSet.id, name, description });
            toast.success("Saved");
          }}
        />
      </AppFrame>
    );
  } else if (route.name === "settings") {
    page = (
      <AppFrame header={null} settingsIndex onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
      </AppFrame>
    );
  } else if (route.name === "detail") {
    page = (
      <AppFrame header={null} onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
        <DetailPage
          back={{ label: "Variable sets", onClick: () => onNavigate("variable-sets") }}
          className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
        >
          {loadState === "loading" || !detailSet ? (
            <SetDetailLoading />
          ) : (
            <SetDetail set={detailSet} actions={actionsFor(detailSet)} />
          )}
        </DetailPage>
      </AppFrame>
    );
  } else {
    page = (
      <AppFrame
        header={{
          title: "Variable sets",
          icon: <VariableIcon />,
          description: "Environment variables and secrets your agents get in their sandbox.",
          // One primary per region: hide it while the empty state offers it.
          actions: empty ? undefined : newSetButton,
        }}
        onNavigate={onNavigate}
      >
        <RouteFocus routeKey={routeKey} />
        <ListPage
          sets={sets}
          loadState={loadState}
          onRetry={() => {
            setLoadState("loading");
            void wait(900).then(() => setLoadState("ready"));
          }}
          onOpenSet={openSet}
          onNewSet={(template) => setRoute({ name: "new-set", template })}
        />
      </AppFrame>
    );
  }

  /* -------------------------------------------------------------- overlays */

  const replaceSet = setById(replacing?.setId);
  const replaceVariable = replaceSet?.variables.find((each) => each.name === replacing?.name);
  const variableSet = setById(deletingVariable?.setId);
  const variable = variableSet?.variables.find((each) => each.name === deletingVariable?.name);
  const deleteSet = setById(deletingSetId);
  const deleteBlocked = Boolean(deleteSet && deleteSet.usedBy.length > 0);

  const variableUsage = variableSet ? usageEntries(variableSet).map((entry) => entry.name) : [];

  return (
    <>
      {page}

      <ReplaceValueDialog
        set={replaceSet}
        variable={replaceVariable}
        onClose={() => setReplacing(null)}
        onReplace={(value) => {
          if (!replaceSet || !replaceVariable) return;
          dispatch({ type: "replace-value", id: replaceSet.id, name: replaceVariable.name, value });
          toast.success(`${verbs.replaced} ${replaceVariable.name}`, {
            description: "New turns get the new value.",
          });
        }}
      />

      {/* Links to what depends on a set can't leave the preview. */}
      <div
        className="contents"
        onClickCapture={(event) => {
          const anchor = (event.target as Element).closest("a[href]");
          if (!anchor || !deleteSet) return;
          event.preventDefault();
          const entry = usageEntries(deleteSet).find(
            (each) => each.href === anchor.getAttribute("href"),
          );
          if (entry) announceUsage(entry);
        }}
      >
        <DestructiveConfirm
          open={Boolean(deleteSet)}
          onOpenChange={(open) => (open ? undefined : setDeletingSetId(null))}
          variant={
            deleteBlocked
              ? "blocked"
              : picks.destructive === "type-to-confirm"
                ? "type-to-confirm"
                : "consequences"
          }
          title={
            deleteSet
              ? deleteBlocked
                ? `${deleteSet.name} is in use`
                : `${verbs.remove} ${deleteSet.name}?`
              : ""
          }
          description={
            deleteSet && deleteBlocked ? blockedDeleteHint(deleteSet, verbs.remove) : undefined
          }
          dependencies={deleteSet && deleteBlocked ? confirmDependencies(deleteSet) : undefined}
          consequences={
            deleteSet
              ? [
                  deleteSet.variables.length
                    ? `Its ${deleteSet.variables.length} ${
                        deleteSet.variables.length === 1 ? "variable goes" : "variables go"
                      } with it.`
                    : "It has no variables.",
                  "Nothing uses it right now, so no chat or schedule changes.",
                  "This can't be undone.",
                ]
              : undefined
          }
          confirmText={deleteSet?.name}
          confirmLabel={`${verbs.remove} variable set`}
          pendingLabel={verbs.removing}
          onConfirm={async () => {
            await wait(700);
            if (deleteSet) removeSet(deleteSet);
          }}
        />
      </div>

      <DestructiveConfirm
        open={Boolean(variable)}
        onOpenChange={(open) => (open ? undefined : setDeletingVariable(null))}
        title={variable ? `${verbs.remove} ${variable.name}?` : ""}
        consequences={
          variable && variableSet
            ? [
                variableUsage.length
                  ? `New turns in ${joinAnd(variableUsage)} won't get ${variable.name}.`
                  : `Nothing uses ${variableSet.name} right now, so no chat or schedule changes.`,
                ...(variableUsage.length ? ["Turns already running keep it."] : []),
                "This can't be undone.",
              ]
            : undefined
        }
        confirmLabel={`${verbs.remove} variable`}
        pendingLabel={verbs.removing}
        onConfirm={async () => {
          await wait(600);
          if (variableSet && variable) removeVariable(variableSet, variable);
        }}
      />
    </>
  );
}
