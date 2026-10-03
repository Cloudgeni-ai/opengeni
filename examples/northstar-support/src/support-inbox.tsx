import { InboxIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { SupportCase, SupportWorkspaceState } from "./types";

type InboxFilter = "mine" | "unassigned";

function relativeTime(value: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
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
    <aside className="flex h-dvh min-h-0 flex-col border-r border-[#d9d9d4] bg-[#f1f1ee] text-[#1f2421]">
      <header className="shrink-0 px-5 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-[#173f35] text-[13px] font-bold text-white">
            N
          </div>
          <div>
            <p className="text-[14px] font-bold tracking-[-0.01em]">Northstar</p>
            <p className="mt-0.5 text-[11px] text-[#77766f]">Customer support</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-[10px] font-medium text-[#507166]">
            <span className="size-1.5 rounded-full bg-[#31926f]" /> Online
          </div>
        </div>

        <div className="mt-7 flex items-end justify-between">
          <div>
            <p className="text-[11px] font-medium text-[#85857f]">Support queue</p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.035em]">Inbox</h1>
          </div>
          <div className="mb-0.5 grid size-8 place-items-center text-[#356a59]">
            <InboxIcon className="size-4" />
          </div>
        </div>

        <label className="mt-4 flex h-10 items-center gap-2.5 rounded-lg border border-[#d7d7d2] bg-white px-3 text-[#8a8982] focus-within:border-[#6c9185]">
          <SearchIcon className="size-4" />
          <span className="sr-only">Search tickets</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search tickets"
            placeholder="Search customers or tickets"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[#242b28] outline-none placeholder:text-[#9a9992]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-[11px] font-semibold text-[#587468]"
            >
              Clear
            </button>
          ) : null}
        </label>

        <div className="mt-3 grid grid-cols-2 border-b border-[#d9d9d4]">
          <InboxFilterButton
            active={filter === "mine"}
            label="My inbox"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className="mb-1 mt-1 flex items-center justify-between px-3 text-[10px] font-medium text-[#8d8b84]">
          <span>{filter === "mine" ? "Assigned to Maya" : "Needs an owner"}</span>
          <span>{visibleCases.length}</span>
        </div>

        <div className="space-y-1.5">
          {visibleCases.map((supportCase) => (
            <TicketRow
              key={supportCase.ticket.id}
              supportCase={supportCase}
              selected={supportCase.ticket.id === selectedTicketId}
              agentConnected={agentEnabled && supportCase.ticket.id === selectedTicketId}
              onClick={() => onSelectTicket(supportCase.ticket.id)}
            />
          ))}
          {visibleCases.length === 0 ? (
            <div className="rounded-[18px] border border-dashed border-black/15 px-4 py-10 text-center">
              <SearchIcon className="mx-auto size-5 text-[#96948d]" />
              <p className="mt-3 text-[13px] font-semibold text-[#5a5b56]">No matching tickets</p>
              <p className="mt-1 text-[11px] text-[#92918b]">Try another search or inbox.</p>
            </div>
          ) : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-[#d9d9d4] px-5 py-4">
        <div className="grid size-8 place-items-center rounded-full bg-[#cbbdaa] text-[10px] font-bold text-[#594c3e]">
          MC
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold">Maya Chen</p>
          <p className="mt-0.5 text-[10px] text-[#818078]">Support lead</p>
        </div>
        <span className="size-2 rounded-full bg-[#31926f]" />
      </footer>
    </aside>
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
          ? "group relative w-full overflow-hidden rounded-xl border border-[#d5d5d0] bg-white px-3.5 py-3.5 text-left"
          : "group w-full rounded-xl border border-transparent px-3.5 py-3.5 text-left transition hover:bg-white/60"
      }
    >
      {selected ? <span className="absolute inset-y-3 left-0 w-[3px] bg-[#27715e]" /> : null}
      <div className="flex items-start gap-3.5">
        <div
          className={
            selected
              ? "grid size-9 shrink-0 place-items-center rounded-lg bg-[#1d2925] text-[10px] font-bold text-white"
              : "grid size-9 shrink-0 place-items-center rounded-lg bg-black/[0.055] text-[9px] font-bold text-[#67706a]"
          }
        >
          {customer.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#555b57]">
              {customer.name}
            </span>
            {ticket.unread ? <span className="size-2 rounded-full bg-[#d86c4f]" /> : null}
            <span className="shrink-0 text-[10px] text-[#999992]">
              {relativeTime(ticket.createdAt)}
            </span>
          </div>
          <p
            className={
              selected
                ? "mt-1.5 line-clamp-2 text-[13px] font-semibold leading-[1.4] tracking-[-0.01em] text-[#202622]"
                : "mt-1.5 line-clamp-2 text-[13px] leading-[1.4] text-[#666a66]"
            }
          >
            {ticket.subject}
          </p>
          <div className="mt-3 flex min-h-5 items-center justify-between gap-2">
            {priority ? (
              <span
                className={
                  ticket.priority === "urgent"
                    ? "rounded-full bg-[#ffede6] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.06em] text-[#b74e34]"
                    : "rounded-full bg-[#fff0d5] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.06em] text-[#93621e]"
                }
              >
                {priority}
              </span>
            ) : (
              <span className="text-[10px] font-medium capitalize text-[#91918b]">
                {ticket.status.replaceAll("_", " ")}
              </span>
            )}
            {agentConnected ? (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[#6558cc]">
                <SparklesIcon className="size-3" /> OpenGeni
              </span>
            ) : (
              <span className="text-[10px] text-[#9c9b95]">{ticket.id}</span>
            )}
          </div>
        </div>
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
          ? "border-b-2 border-[#2c725f] px-3 py-2.5 text-[11px] font-semibold text-[#285e4f]"
          : "border-b-2 border-transparent px-3 py-2.5 text-[11px] font-medium text-[#7d7c76] transition hover:text-[#494c49]"
      }
    >
      {label} <span className="ml-1.5 opacity-55">{count}</span>
    </button>
  );
}
