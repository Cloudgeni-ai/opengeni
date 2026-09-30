import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ComposerMenuHeader,
  ComposerMenuRowsSkeleton,
  ComposerMenuSwitch,
  MenuBackButton,
} from "@/components/ui/composer-menu";
import { MENU_BUTTON_CLASS, MENU_NOTE_CLASS } from "@/components/ui/menu-styles";
import type { VariableSetShortlistRow } from "@/lib/variable-set-shortlist";

export function VariableSetShortlistEditor(props: {
  rows: VariableSetShortlistRow[];
  variableSets: { id: string; name: string; scope?: string }[];
  disabled: boolean;
  canAdd: boolean;
  loading?: boolean;
  leading?: ReactNode;
  onChange: (rows: VariableSetShortlistRow[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const enabledCount = props.rows.filter((row) => row.enabled).length;
  const toggle = (id: string, enabled: boolean) => {
    if (props.disabled || (enabled && (!props.canAdd || enabledCount >= 25))) return;
    props.onChange(
      props.rows.some((row) => row.id === id)
        ? props.rows.map((row) => (row.id === id ? { id, enabled } : row))
        : [{ id, enabled }, ...props.rows],
    );
  };
  const catalog = props.variableSets.filter((set) =>
    set.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <ComposerMenuHeader
        title={adding ? "Add variable sets" : "Variable sets"}
        leading={
          adding ? (
            <MenuBackButton
              label="Back to selected variable sets"
              onClick={() => setAdding(false)}
            />
          ) : (
            props.leading
          )
        }
      />
      {adding ? (
        <input
          aria-label="Search variable sets"
          placeholder="Search variable sets…"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
          className="mb-1.5 h-8 rounded-[10px] border border-border bg-surface px-2.5 text-sm outline-none placeholder:text-fg-subtle focus-visible:border-brand pointer-coarse:h-11"
        />
      ) : (
        <p className="px-2.5 pb-1.5 text-xs leading-4.5 text-fg-muted">
          Sets higher in the list take precedence when names collide.
        </p>
      )}
      <div className="min-h-0 max-h-[300px] overflow-y-auto overscroll-contain">
        {adding
          ? catalog.map((set) => {
              const checked = props.rows.some((row) => row.id === set.id && row.enabled);
              return (
                <div
                  key={set.id}
                  className="flex min-h-8 items-center gap-2.5 rounded-[10px] px-2.5 hover:bg-surface-2 pointer-coarse:min-h-11"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {set.name}
                    {set.scope === "user" ? (
                      <span className="ml-2 text-xs text-fg-muted">Only me</span>
                    ) : null}
                  </span>
                  <ComposerMenuSwitch
                    label={`Enable ${set.name}`}
                    checked={checked}
                    disabled={props.disabled || (!checked && (!props.canAdd || enabledCount >= 25))}
                    onCheckedChange={(value) => toggle(set.id, value)}
                  />
                </div>
              );
            })
          : props.rows.map((row, index) => {
              const set = props.variableSets.find((candidate) => candidate.id === row.id);
              const label = set?.name ?? `Selected Variable Set ${index + 1}`;
              const move = (offset: number) => {
                const next = [...props.rows];
                [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
                props.onChange(next);
              };
              return (
                <div
                  key={row.id}
                  className="flex min-h-8 items-center gap-0.5 rounded-[10px] px-2.5 hover:bg-surface-2 pointer-coarse:min-h-11"
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${row.enabled ? "text-fg" : "text-fg-subtle"}`}
                  >
                    {label}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${label} earlier`}
                    disabled={props.disabled || !row.enabled || index === 0}
                    onClick={() => move(-1)}
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${label} later`}
                    disabled={props.disabled || !row.enabled || index === props.rows.length - 1}
                    onClick={() => move(1)}
                  >
                    <ChevronDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${label}`}
                    title="Remove from this list"
                    disabled={props.disabled}
                    onClick={() =>
                      props.onChange(props.rows.filter((candidate) => candidate.id !== row.id))
                    }
                  >
                    <XIcon />
                  </Button>
                  <ComposerMenuSwitch
                    label={`Enable ${label}`}
                    checked={row.enabled}
                    disabled={
                      props.disabled || (!row.enabled && (!props.canAdd || enabledCount >= 25))
                    }
                    onCheckedChange={(value) => toggle(row.id, value)}
                  />
                </div>
              );
            })}
        {(adding ? catalog : props.rows).length === 0 ? (
          adding && props.loading ? (
            <ComposerMenuRowsSkeleton rows={3} label="Loading variable sets" />
          ) : (
            <p className={MENU_NOTE_CLASS}>
              {adding ? "No matching variable sets." : "No variable sets in this list."}
            </p>
          )
        ) : null}
      </div>
      {!adding && props.canAdd ? (
        <button
          type="button"
          className={MENU_BUTTON_CLASS}
          disabled={props.disabled}
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
          Add variable sets
        </button>
      ) : null}
      {enabledCount >= 25 ? (
        <p className="px-2.5 text-xs text-fg-muted">
          Up to 25 sets can be on. Turn one off to enable another.
        </p>
      ) : null}
    </>
  );
}
