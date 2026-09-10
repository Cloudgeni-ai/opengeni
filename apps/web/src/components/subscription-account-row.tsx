import { ChevronDownIcon, PencilIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";

/** The shared account presentation for subscription providers at every scope. */
export function SubscriptionAccountRow(props: {
  provider: string;
  name: string;
  label?: string | null;
  email?: string | null;
  plan?: string | null;
  selected: boolean;
  disabled: boolean;
  unavailable?: boolean;
  selectionLabel: string;
  group: string;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onSelect: () => void;
  onRename?: (label: string) => void;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = useRef(false);
  const finishRename = (save: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    if (save && draft !== null) props.onRename?.(draft.trim());
    setDraft(null);
  };
  return (
    <article aria-label={`${props.name} ${props.provider} subscription`}>
      <Collapsible open={props.expanded} onOpenChange={props.onExpandedChange}>
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2">
          <label
            className="flex min-h-9 min-w-9 cursor-pointer items-center justify-center"
            title="Used when a session isn't pinned to a specific subscription"
          >
            <input
              type="radio"
              name={props.group}
              className="size-3.5 accent-brand"
              aria-label={props.selectionLabel}
              checked={props.selected}
              disabled={props.disabled || props.unavailable}
              onChange={() => {
                if (!props.selected) props.onSelect();
              }}
            />
          </label>
          <div className="flex min-w-0 flex-1 basis-36 items-center gap-1">
            {draft !== null ? (
              <Input
                autoFocus
                value={draft}
                className="h-7 text-sm"
                aria-label={`Name for ${props.name}`}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => finishRename(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    finishRename(true);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    finishRename(false);
                  }
                }}
              />
            ) : (
              <>
                <CollapsibleTrigger className="min-w-0 truncate text-left text-sm font-medium">
                  {props.name}
                  {props.email && props.email !== props.name ? (
                    <span className="font-normal text-fg-subtle"> · {props.email}</span>
                  ) : null}
                </CollapsibleTrigger>
                {props.onRename ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    disabled={props.disabled}
                    aria-label={`Rename ${props.name}`}
                    onClick={() => {
                      editing.current = true;
                      setDraft(props.label ?? "");
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <MetaChip dot="idle" rounded="full">
            {props.plan ?? "Subscription"}
          </MetaChip>
          {props.meta}
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={`${props.expanded ? "Hide" : "Show"} details for ${props.name}`}
            >
              <ChevronDownIcon
                className={`size-4 text-fg-subtle transition-transform ${props.expanded ? "rotate-180" : ""}`}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="grid gap-2 border-t border-border/60 px-2.5 py-2.5">
          {props.children}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
