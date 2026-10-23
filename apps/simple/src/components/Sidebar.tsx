import { ChevronDown, Plus, Settings, X } from "lucide-react";
import { useState } from "react";
import { organizeSidebar, type Agent } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";

export function Sidebar({
  agents,
  selectedId,
  workspaceName,
  drafting,
  onSelect,
  onNew,
  onSettings,
  onClose,
}: {
  agents: Agent[];
  selectedId: string | null;
  workspaceName: string | null;
  drafting: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onClose?: (() => void) | undefined;
}) {
  const sections = organizeSidebar(agents);
  const [quietOpen, setQuietOpen] = useState(false);
  return (
    <nav className="flex h-full w-full flex-col bg-[var(--app-sidebar)]" aria-label="Agents">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div
          className="h-6 w-6 rounded-lg"
          style={{ background: "linear-gradient(135deg, #a78bfa, #f472b6)" }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
          Opengeni
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:hidden"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        ) : null}
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onNew}
          aria-current={drafting ? "page" : undefined}
          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors ${
            drafting
              ? "bg-[var(--app-card)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
              : "hover:bg-[var(--app-hover)]"
          }`}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-card)]">
            <Plus size={16} />
          </span>
          New agent
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sections.map((section) => {
          const collapsed = section.collapsible && !quietOpen;
          return (
            <div key={section.id} className="mb-2">
              {section.label ? (
                <button
                  type="button"
                  disabled={!section.collapsible}
                  onClick={() => setQuietOpen((open) => !open)}
                  className="flex w-full items-center gap-1 px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--app-muted)] uppercase"
                >
                  {section.label}
                  {section.collapsible ? (
                    <>
                      <span className="font-normal normal-case">({section.agents.length})</span>
                      <ChevronDown
                        size={12}
                        className={`transition-transform ${quietOpen ? "" : "-rotate-90"}`}
                      />
                    </>
                  ) : null}
                </button>
              ) : null}
              {collapsed
                ? null
                : section.agents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      selected={agent.id === selectedId}
                      onSelect={() => onSelect(agent.id)}
                    />
                  ))}
            </div>
          );
        })}
      </div>
      <div className="border-t border-[var(--app-border)] p-2">
        <button
          type="button"
          onClick={onSettings}
          className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
        >
          <Settings size={16} />
          <span className="min-w-0 flex-1 truncate">Settings</span>
          {workspaceName ? (
            <span className="max-w-[45%] truncate text-xs opacity-70">{workspaceName}</span>
          ) : null}
        </button>
      </div>
    </nav>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}) {
  const subtitle = agent.needsYou
    ? "Needs you"
    : agent.working
      ? "Working…"
      : (agent.description ?? (agent.role === "main" ? "Your main agent" : null));
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--app-card)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          : "hover:bg-[var(--app-hover)]"
      }`}
    >
      <div className="relative">
        <AgentAvatar agent={agent} size={34} />
        {agent.working ? (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-[var(--app-sidebar)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-sm ${agent.unread || agent.needsYou ? "font-semibold" : "font-medium"}`}
        >
          {agent.name}
        </div>
        {subtitle ? (
          <div
            className={`truncate text-xs ${agent.needsYou ? "text-amber-600 dark:text-amber-400" : "text-[var(--app-muted)]"}`}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {agent.unread || agent.needsYou ? (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${agent.needsYou ? "bg-amber-500" : "bg-[var(--app-accent)]"}`}
          aria-label={agent.needsYou ? "Needs you" : "Unread"}
        />
      ) : null}
    </button>
  );
}
