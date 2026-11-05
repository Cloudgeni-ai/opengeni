import { InboxIcon, SearchIcon, UserRoundPlusIcon } from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Kbd, MOD_KEY, PRIORITY_LABEL, PriorityGlyph, StatusGlyph } from "./ticket-glyphs";
import type { SupportCase, SupportWorkspaceState } from "./types";

type InboxFilter = "mine" | "unassigned";

function relativeTime(value: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function SupportInbox({
  state,
  selectedTicketId,
  agentEnabled,
  onSelectTicket,
}: {
  state: SupportWorkspaceState;
  selectedTicketId: string;
  agentEnabled: boolean;
  onSelectTicket: (ticketId: string) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("mine");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const mineCount = state.cases.filter(({ ticket }) => ticket.inbox === "mine").length;
  const unassignedCount = state.cases.filter(({ ticket }) => ticket.inbox === "unassigned").length;
  const visibleCases = state.cases.filter(({ customer, ticket }) => {
    if (ticket.inbox !== filter) return false;
    if (!deferredQuery) return true;
    return [ticket.id, ticket.subject, customer.name, customer.primaryContact.name].some((value) =>
      value.toLowerCase().includes(deferredQuery),
    );
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function switchFilter(nextFilter: InboxFilter) {
    setFilter(nextFilter);
    setQuery("");
    const selectedCase = state.cases.find(({ ticket }) => ticket.id === selectedTicketId);
    if (selectedCase?.ticket.inbox === nextFilter) return;
    const firstCase = state.cases.find(({ ticket }) => ticket.inbox === nextFilter);
    if (firstCase) onSelectTicket(firstCase.ticket.id);
  }

  return (
    <aside className="flex h-full min-h-0 flex-col text-ns-ink">
      <header className="shrink-0 px-3 pt-3">
        <div className="flex h-8 items-center gap-2 px-2">
          <NorthstarMark className="size-5 text-ns-navy" />
          <p className="text-[15px] font-bold tracking-[-0.02em] text-ns-navy">Northstar</p>
        </div>

        <label className="mt-4 flex h-9 items-center gap-2 rounded-lg bg-ns-sheet/70 px-2.5 text-ns-subtle shadow-[inset_0_0_0_1px_var(--color-ns-line)] transition-shadow focus-within:bg-ns-sheet focus-within:shadow-[inset_0_0_0_1.5px_var(--color-ns-navy)]">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            aria-label="Search tickets"
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ns-ink outline-none placeholder:text-ns-subtle"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-[12px] font-medium text-ns-muted hover:text-ns-ink"
            >
              Clear
            </button>
          ) : (
            <Kbd>{`${MOD_KEY}K`}</Kbd>
          )}
        </label>

        <nav className="mt-3 space-y-px" aria-label="Inbox views">
          <ViewButton
            icon={<InboxIcon className="size-4" />}
            active={filter === "mine"}
            label="My inbox"
            count={mineCount}
            onClick={() => switchFilter("mine")}
          />
          <ViewButton
            icon={<UserRoundPlusIcon className="size-4" />}
            active={filter === "unassigned"}
            label="Unassigned"
            count={unassignedCount}
            onClick={() => switchFilter("unassigned")}
          />
        </nav>
      </header>

      <div className="mx-5 mt-3 h-px shrink-0 bg-ns-line" />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        <ul className="space-y-px">
          {visibleCases.map((supportCase) => (
            <li key={supportCase.ticket.id}>
              <TicketRow
                supportCase={supportCase}
                selected={supportCase.ticket.id === selectedTicketId}
                agentConnected={agentEnabled && supportCase.ticket.id === selectedTicketId}
                onClick={() => onSelectTicket(supportCase.ticket.id)}
              />
            </li>
          ))}
        </ul>
        {visibleCases.length === 0 ? (
          <div className="px-2 py-8">
            <p className="text-[13px] font-semibold text-ns-ink">
              {query ? `No tickets match “${query}”` : "Nothing waiting here"}
            </p>
            <p className="mt-1 text-[12px] leading-5 text-ns-muted">
              {query
                ? "Search looks at ticket numbers, subjects, and customer names."
                : "New tickets land here as customers write in."}
            </p>
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-2.5 px-5 pb-4 pt-2">
        <div className="grid size-7 place-items-center rounded-full bg-[#d9cdbd] text-[11px] font-semibold text-[#4d4134]">
          MC
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-4">Maya Chen</p>
          <p className="text-[12px] leading-4 text-ns-muted">Support lead</p>
        </div>
      </footer>
    </aside>
  );
}

export function NorthstarMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M12 1.5c.5 5.6 2.4 8.4 5.2 9.7l5.3 0.8-5.3.8c-2.8 1.3-4.7 4.1-5.2 9.7-.5-5.6-2.4-8.4-5.2-9.7L1.5 12l5.3-.8C9.6 9.9 11.5 7.1 12 1.5Z"
      />
      <circle cx="18.6" cy="5.4" r="1.6" fill="var(--color-ns-star)" />
    </svg>
  );
}

function ViewButton({
  icon,
  active,
  label,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "flex h-8 w-full items-center gap-2.5 rounded-md bg-black/[0.06] px-2 text-[13px] font-semibold text-ns-ink"
          : "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-ns-muted transition-colors hover:bg-black/[0.04] hover:text-ns-ink"
      }
    >
      <span className={active ? "text-ns-navy" : "text-ns-subtle"}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      <span className="text-[12px] font-medium tabular-nums text-ns-subtle">{count}</span>
    </button>
  );
}

function TicketRow({
  supportCase,
  selected,
  agentConnected,
  onClick,
}: {
  supportCase: SupportCase;
  selected: boolean;
  agentConnected: boolean;
  onClick: () => void;
}) {
  const { customer, ticket } = supportCase;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={
        selected
          ? "relative w-full rounded-lg bg-ns-sheet px-2.5 py-2.5 text-left shadow-[0_1px_2px_rgba(18,26,51,0.08),0_0_0_1px_var(--color-ns-line)]"
          : "relative w-full rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-black/[0.04]"
      }
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-[3px]" title={ticket.status.replaceAll("_", " ")}>
          <StatusGlyph status={ticket.status} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={
              ticket.unread || selected
                ? "line-clamp-2 text-[13.5px] font-semibold leading-[1.35] tracking-[-0.01em] text-ns-ink"
                : "line-clamp-2 text-[13.5px] leading-[1.35] text-ns-ink/75"
            }
          >
            {ticket.subject}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ns-subtle">
            <span title={`${PRIORITY_LABEL[ticket.priority]} priority`}>
              <PriorityGlyph priority={ticket.priority} className="size-3" />
            </span>
            <span className="min-w-0 truncate">{customer.name}</span>
            {agentConnected ? (
              <span
                className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-og-green"
                style={{ fontFamily: "var(--font-og)" }}
              >
                <span className="relative flex size-1.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-og-green/50" />
                  <span className="relative size-1.5 rounded-full bg-og-green" />
                </span>
                Opengeni
              </span>
            ) : (
              <span className="ml-auto shrink-0 tabular-nums">
                {ticket.unread ? (
                  <span
                    className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-ns-star"
                    aria-label="Unread"
                  />
                ) : null}
                {relativeTime(ticket.createdAt)}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
