import { CheckIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { GitHubRepositoryBranch } from "@/types";

export function RepositoryRefInput(props: {
  value: string;
  defaultRef: string;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
  loadBranches?: () => Promise<GitHubRepositoryBranch[]>;
}) {
  const [focused, setFocused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitHubRepositoryBranch[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const query = props.value.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query ? branches.filter((branch) => branch.name.toLowerCase().includes(query)) : branches,
    [branches, query],
  );

  async function load(): Promise<void> {
    if (!props.loadBranches || loaded || loading || props.disabled) return;
    setLoading(true);
    setError(null);
    try {
      setBranches(await props.loadBranches());
      setLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  const showMenu = focused && Boolean(props.loadBranches) && (loading || error || loaded);
  return (
    <div
      ref={containerRef}
      className="relative min-w-0 flex-1"
      onFocusCapture={() => {
        setFocused(true);
        void load();
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          containerRef.current?.contains(event.relatedTarget)
        ) {
          return;
        }
        setFocused(false);
      }}
    >
      <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-fg-subtle" />
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        disabled={props.disabled}
        placeholder={props.defaultRef}
        aria-label={props.label}
        className={cn(props.compact ? "h-7" : "h-8", "pl-7 text-xs")}
      />
      {showMenu ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border border-border bg-surface p-1 shadow-xl">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-fg-muted">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading branches…
            </div>
          ) : error ? (
            <div className="px-2 py-2 text-xs leading-4 text-status-failed">
              Couldn&apos;t load branches. Your typed ref is still valid.
            </div>
          ) : matches.length === 0 ? (
            <div className="px-2 py-2 text-xs leading-4 text-fg-muted">
              No matching branches. The typed ref will be kept.
            </div>
          ) : (
            matches.map((branch) => (
              <button
                key={branch.name}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onChange(branch.name);
                  setFocused(false);
                }}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-surface-2"
              >
                <span className="min-w-0 truncate">{branch.name}</span>
                {branch.isDefault ? (
                  <span className="flex shrink-0 items-center gap-1 text-2xs text-fg-subtle">
                    <CheckIcon className="size-3" /> Default
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
