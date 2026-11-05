import { SearchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { SupportCase, SupportWorkspaceState } from "./types";

type InboxFilter = "mine" | "unassigned";

function relativeTime(value: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function priorityLabel(priority: SupportCase["ticket"]["priority"]): string {
  if (priority === "urgent") return "Urgent";
  if (priority === "high") return "High";
  return "";
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

  function switchFilter(nextFilter: InboxFilter) {
    setFilter(nextFilter);
    setQuery("");
    const selectedCase = state.cases.find(({ ticket }) => ticket.id === selectedTicketId);
    if (selectedCase?.ticket.inbox === nextFilter) return;
    const firstCase = state.cases.find(({ ticket }) => ticket.inbox === nextFilter);
    if (firstCase) onSelectTicket(firstCase.ticket.id);
  }

  return (
    <aside className="flex h-dvh min-h-0 flex-col border-r border-ns-line bg-ns-rail text-ns-ink">
      <header className="shrink-0 px-5 pt-5">
        <div className="flex h-7 items-center gap-2.5">
          <NorthstarMark className="size-[22px] text-ns-navy" />
          <p className="text-[16px] font-bold tracking-[-0.02em] text-ns-navy">Northstar</p>
        </div>

        <h1 className="mt-8 text-[22px] font-semibold tracking-[-0.025em]">Inbox</h1>

        <label className="mt-3 flex h-9 items-center gap-2 rounded-md border border-ns-line bg-ns-sheet px-2.5 text-ns-subtle transition-colors focus-within:border-ns-navy">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search tickets"
            placeholder="Search tickets or customers"
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
          ) : null}
        </label>

        <div
          className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-black/[0.045] p-1"
          role="group"
          aria-label="Inbox"
        >
          <InboxFilterButton
            active={filter === "mine"}
            label="Mine"
            count={mineCount}
            onClick={() => switchFilter("mine")}
          />
          <InboxFilterButton
            active={filter === "unassigned"}
            label="Unassigned"
            count={unassignedCount}
            onClick={() => switchFilter("unassigned")}
          />
        </div>
      </header>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
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
          <div className="px-3 py-10">
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

      <footer className="flex shrink-0 items-center gap-3 border-t border-ns-line px-5 py-3.5">
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
  const priority = priorityLabel(ticket.priority);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={
        selected
          ? "relative w-full rounded-md bg-ns-sheet px-3 py-3 text-left shadow-[0_0_0_1px_var(--color-ns-line)]"
          : "relative w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-black/[0.035]"
      }
    >
      {selected ? (
        <span className="absolute inset-y-2.5 left-0 w-[3px] rounded-r bg-ns-navy" />
      ) : null}
      <div className="flex items-baseline gap-2">
        {ticket.unread ? (
          <span
            className="size-[7px] shrink-0 -translate-y-px self-center rounded-full bg-ns-star"
            aria-label="Unread"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ns-muted">
          {customer.name}
        </span>
        <span className="shrink-0 text-[12px] text-ns-subtle">
          {relativeTime(ticket.createdAt)}
        </span>
      </div>
      <p
        className={
          ticket.unread || selected
            ? "mt-1 line-clamp-2 text-[14px] font-semibold leading-[1.35] tracking-[-0.01em] text-ns-ink"
            : "mt-1 line-clamp-2 text-[14px] leading-[1.35] text-ns-ink/80"
        }
      >
        {ticket.subject}
      </p>
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        <span className="text-ns-subtle">{ticket.id}</span>
        {priority ? (
          <span
            className={
              ticket.priority === "urgent"
                ? "font-semibold text-ns-alert"
                : "font-semibold text-[#9a6206]"
            }
          >
            {priority}
          </span>
        ) : null}
        {agentConnected ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 font-medium text-og-green"
            style={{ fontFamily: "var(--font-og)" }}
          >
            <span className="size-1.5 rounded-full bg-og-green" />
            Opengeni
          </span>
        ) : null}
      </div>
    </button>
  );
}

function InboxFilterButton({
  active,
  label,
  count,
  onClick,
}: {
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
          ? "rounded-[5px] bg-ns-sheet px-2 py-1.5 text-[13px] font-semibold text-ns-ink shadow-[0_1px_2px_rgba(18,26,51,0.12)]"
          : "rounded-[5px] px-2 py-1.5 text-[13px] font-medium text-ns-muted transition-colors hover:text-ns-ink"
      }
    >
      {label} <span className="ml-1 font-normal text-ns-subtle">{count}</span>
    </button>
  );
}
