import { useMemo, useState } from "react";
import { AGENT_ICONS, AGENT_ICON_NAMES } from "../lib/agent-icons";
import { AGENT_ICON_COMPONENTS } from "./agent-icon-components";

/** A searchable grid of the agent icons; picking one applies instantly. */
export function IconPicker({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (icon: string) => void;
}) {
  const [query, setQuery] = useState("");
  const names = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return AGENT_ICON_NAMES;
    return AGENT_ICON_NAMES.filter(
      (name) => name.includes(needle) || AGENT_ICONS[name]!.some((word) => word.startsWith(needle)),
    );
  }, [query]);
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search icons"
        className="mb-1.5 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--app-accent)]"
      />
      <div className="scroll-thin grid max-h-52 grid-cols-7 gap-0.5 overflow-y-auto">
        {names.map((name) => {
          const Icon = AGENT_ICON_COMPONENTS[name]!;
          const active = name === current;
          return (
            <button
              key={name}
              type="button"
              title={name.replace(/-/g, " ")}
              aria-label={name.replace(/-/g, " ")}
              aria-pressed={active}
              onClick={() => onPick(name)}
              className={`flex aspect-square items-center justify-center rounded-lg ${
                active
                  ? "bg-[var(--app-accent)] text-white"
                  : "text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
              }`}
            >
              <Icon size={17} />
            </button>
          );
        })}
        {names.length === 0 ? (
          <p className="col-span-7 py-3 text-center text-xs text-[var(--app-muted)]">
            No icons match.
          </p>
        ) : null}
      </div>
    </div>
  );
}
