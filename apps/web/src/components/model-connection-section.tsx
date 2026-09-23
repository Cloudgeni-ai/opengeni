import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

/** One connection surface for subscription and API-key providers at either scope.
 * Native details keeps forms and pending authorization mounted while collapsed.
 */
export function ModelConnectionSection({
  title,
  description,
  status,
  mark,
  children,
  testId,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description: string;
  status: string;
  mark: ReactNode;
  children: ReactNode;
  testId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  return (
    <details
      className="group/model-connection min-w-0 border-b border-border"
      data-testid={testId}
      open={controlledOpen ?? localOpen}
      onToggle={(event) => {
        setLocalOpen(event.currentTarget.open);
        onOpenChange?.(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 rounded-md py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [&::-webkit-details-marker]:hidden">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg">
          {mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{title}</span>
          <span className="mt-0.5 block text-xs text-fg-subtle">{description}</span>
        </span>
        <span className="max-w-36 shrink-0 text-right text-xs text-fg-muted" aria-live="polite">
          {status}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none group-open/model-connection:rotate-180"
        />
      </summary>
      <div className="grid min-w-0 gap-3 pb-4 pt-1">{children}</div>
    </details>
  );
}
