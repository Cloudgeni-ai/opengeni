import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type VariableSetLabel = {
  id: string;
  name: string;
};

export function SelectedVariableSetList(props: {
  selectedIds: string[];
  variableSets: VariableSetLabel[];
  disabled: boolean;
  onChange: (selectedIds: string[]) => void;
}) {
  return (
    <div className="space-y-1">
      {props.selectedIds.map((variableSetId, index) => {
        const variableSet = props.variableSets.find((candidate) => candidate.id === variableSetId);
        const label = variableSet?.name ?? `Selected Variable Set ${index + 1}`;
        return (
          <div
            key={variableSetId}
            className="flex min-w-0 items-center gap-1 rounded border border-border bg-bg/45 px-1.5 py-1"
          >
            <span className="w-4 shrink-0 text-center font-mono text-2xs text-fg-subtle">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${label} earlier`}
              disabled={props.disabled || index === 0}
              onClick={() => {
                const next = [...props.selectedIds];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                props.onChange(next);
              }}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${label} later`}
              disabled={props.disabled || index === props.selectedIds.length - 1}
              onClick={() => {
                const next = [...props.selectedIds];
                [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                props.onChange(next);
              }}
            >
              <ChevronDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${label}`}
              disabled={props.disabled}
              onClick={() => {
                props.onChange(props.selectedIds.filter((id) => id !== variableSetId));
              }}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
