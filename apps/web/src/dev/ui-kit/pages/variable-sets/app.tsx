import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { PlusIcon, VariableIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DestructiveConfirm, showUndoToast } from "@/components/ui/destructive-confirm";
import { DetailPage, DetailSheet, DetailSheetContent } from "@/components/ui/detail-sheet";

import { useAnswers, usePagePicks, useVerbs } from "./answers";
import { SetDetail, SetDetailLoading, announceUsage, type SetActions } from "./detail";
import {
  AddVariableForm,
  EditSetDialog,
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
   The Variable sets area as one small app: the list, the detail page, their
   forms and dialogs, on fixtures only. Everything follows the current picks
   and the answers to the open questions.
   -------------------------------------------------------------------------- */

type Route = { name: "list" } | { name: "detail"; setId: string } | { name: "settings" };

type FormState =
  | { kind: "new-set"; template?: SetTemplate }
  | { kind: "add-variable"; setId: string; mode: AddMode }
  | null;

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
  const [sheetSetId, setSheetSetId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [replacing, setReplacing] = useState<{ setId: string; name: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  // The expand-in-place and sheet answers only make sense from the list.
  useEffect(() => {
    if (answers.opens !== "inline") setExpandedId(null);
    if (answers.opens !== "sheet") setSheetSetId(null);
  }, [answers.opens]);

  /* -------------------------------------------------------------- navigation */

  const openSet = (set: PreviewSet) => {
    if (answers.opens === "sheet") setSheetSetId(set.id);
    else if (answers.opens === "inline")
      setExpandedId((current) => (current === set.id ? null : set.id));
    else setRoute({ name: "detail", setId: set.id });
  };

  const onNavigate = (id: string) => {
    if (id === "variable-sets") {
      setRoute({ name: "list" });
      setForm(null);
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
    setSheetSetId(null);
    setExpandedId(null);
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
    setSheetSetId(null);
    setExpandedId(null);
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
    addVariable: (mode) => {
      // A full-page form replaces the page, so the sheet behind it closes.
      if (picks.form === "page") setSheetSetId(null);
      setForm({ kind: "add-variable", setId: set.id, mode });
    },
    replaceValue: (variable) => setReplacing({ setId: set.id, name: variable.name }),
    deleteVariable: (variable) => {
      if (picks.destructive === "undo") removeVariable(set, variable);
      else setDeletingVariable({ setId: set.id, name: variable.name });
    },
    editSet: () => setEditingId(set.id),
    deleteSet: () => {
      const inUse = set.usedBy.length > 0;
      if (inUse && answers.inUse === "disable") return;
      if (!inUse && picks.destructive === "undo") removeSet(set);
      else setDeletingSetId(set.id);
    },
    openUsage: (entry) => announceUsage(entry),
  });

  /* -------------------------------------------------------------- pages */

  const closeForm = () => setForm(null);
  const formSet = form?.kind === "add-variable" ? setById(form.setId) : undefined;
  const detailSet = route.name === "detail" ? setById(route.setId) : undefined;

  // If the open set is deleted elsewhere (an undo toast from another pane), go back.
  useEffect(() => {
    if (route.name === "detail" && !detailSet && loadState === "ready") {
      setRoute({ name: "list" });
    }
  }, [detailSet, loadState, route.name]);

  const newSetForm = (presentation: "dialog" | "page" | "inline") => (
    <NewSetForm
      presentation={presentation}
      open={form?.kind === "new-set"}
      template={form?.kind === "new-set" ? form.template : undefined}
      sets={sets}
      onClose={closeForm}
      onCreate={createSet}
      back={{ label: "Variable sets", onClick: closeForm }}
    />
  );

  const addVariableForm = (presentation: "dialog" | "page" | "inline") => (
    <AddVariableForm
      presentation={presentation}
      open={form?.kind === "add-variable"}
      set={formSet}
      initialMode={form?.kind === "add-variable" ? form.mode : "one"}
      onClose={closeForm}
      onAdd={(variables, replaced) => formSet && addVariables(formSet, variables, replaced)}
      back={formSet ? { label: formSet.name, onClick: closeForm } : undefined}
    />
  );

  // Inline forms need a place on the page: Add variable from a sheet or an
  // expanded row falls back to a dialog.
  const addPresentation: "dialog" | "page" | "inline" =
    picks.form === "inline" ? (route.name === "detail" ? "inline" : "dialog") : picks.form;
  const pageForm =
    form &&
    ((form.kind === "new-set" && picks.form === "page") ||
      (form.kind === "add-variable" && addPresentation === "page"));

  const empty = listIsEmpty(sets, loadState);
  const newSetButton = (
    <Button
      type="button"
      onClick={() => setForm({ kind: "new-set" })}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      New variable set
    </Button>
  );

  let page: ReactNode;
  let routeKey: string = route.name === "detail" ? `detail:${route.setId}` : route.name;

  if (form && pageForm) {
    routeKey = `form:${form.kind}`;
    page = (
      <AppFrame header={null} onNavigate={onNavigate}>
        <RouteFocus routeKey={routeKey} />
        {form.kind === "new-set" ? newSetForm("page") : addVariableForm("page")}
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
            <SetDetail
              set={detailSet}
              actions={actionsFor(detailSet)}
              inlineForm={
                addPresentation === "inline" &&
                form?.kind === "add-variable" &&
                form.setId === detailSet.id
                  ? addVariableForm("inline")
                  : undefined
              }
            />
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
          // One primary per region: hide it while the empty state or the inline form offers it.
          actions:
            empty || (picks.form === "inline" && form?.kind === "new-set")
              ? undefined
              : newSetButton,
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
          selectedId={sheetSetId}
          expandedId={expandedId}
          onOpenSet={openSet}
          actionsFor={actionsFor}
          onNewSet={(template) => setForm({ kind: "new-set", template })}
          inlineForm={picks.form === "inline" ? newSetForm("inline") : undefined}
        />
      </AppFrame>
    );
  }

  /* -------------------------------------------------------------- overlays */

  const sheetSet = setById(sheetSetId);
  const replaceSet = setById(replacing?.setId);
  const replaceVariable = replaceSet?.variables.find((each) => each.name === replacing?.name);
  const editSet = setById(editingId);
  const variableSet = setById(deletingVariable?.setId);
  const variable = variableSet?.variables.find((each) => each.name === deletingVariable?.name);
  const deleteSet = setById(deletingSetId);
  const deleteBlocked = Boolean(deleteSet && deleteSet.usedBy.length > 0);

  const variableUsage = variableSet ? usageEntries(variableSet).map((entry) => entry.name) : [];

  return (
    <>
      {page}

      {picks.form === "dialog" ? newSetForm("dialog") : null}
      {addPresentation === "dialog" ? addVariableForm("dialog") : null}

      <DetailSheet
        open={Boolean(sheetSet)}
        onOpenChange={(open) => (open ? undefined : setSheetSetId(null))}
      >
        {sheetSet ? (
          <DetailSheetContent {...(sheetSet.description ? {} : { "aria-describedby": undefined })}>
            <SetDetail
              set={sheetSet}
              actions={actionsFor(sheetSet)}
              onDone={() => setSheetSetId(null)}
            />
          </DetailSheetContent>
        ) : null}
      </DetailSheet>

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

      <EditSetDialog
        set={editSet}
        sets={sets}
        onClose={() => setEditingId(null)}
        onSave={(name, description) => {
          if (!editSet) return;
          dispatch({ type: "update", id: editSet.id, name, description });
          toast.success("Saved");
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
