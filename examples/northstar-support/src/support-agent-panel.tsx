import { EyeIcon, LoaderCircleIcon, Maximize2Icon, Minimize2Icon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { Markdown, OpenGeniProvider, SessionConversation } from "@opengeni/react";
import { OpenGeniClient } from "@opengeni/sdk";
import type { DemoHealth, SupportCase } from "./types";
import { createDemoSession } from "./use-support-demo";
import { supportToolRegistry } from "./support-tool-renderers";
import { OpengeniGlyph } from "./support-ticket";

// The unmodified SDK client, pointed at the product backend's packaged proxy.
const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });

function demoPrompt(supportCase: SupportCase): string {
  const { ticket, customer } = supportCase;
  return `Investigate ${ticket.id} for ${customer.name} using the Northstar support tools. Read the ticket and customer signals, decide whether its priority or status should change, apply justified changes, and add an internal note with the evidence and next step.`;
}

function renderNorthstarMessage(text: string) {
  return <Markdown className="northstar-agent-copy">{text}</Markdown>;
}

type SupportAgentPanelProps = {
  health: DemoHealth | null;
  supportCase: SupportCase;
  sessionId: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSessionCreated: (sessionId: string) => void;
  onClearSession: () => void;
};

export function SupportAgentPanel(props: SupportAgentPanelProps) {
  return (
    <OpenGeniProvider client={client} workspaceId={props.health?.workspaceId ?? "unconfigured"}>
      <SupportAgentPanelView {...props} />
    </OpenGeniProvider>
  );
}

function SupportAgentPanelView({
  health,
  supportCase,
  sessionId,
  expanded,
  onExpandedChange,
  onSessionCreated,
  onClearSession,
}: SupportAgentPanelProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<Error | null>(null);
  // One id per intentional start, so a retried request returns the same session.
  const [runId, setRunId] = useState(() => crypto.randomUUID());

  async function startDemo() {
    setStarting(true);
    setStartError(null);
    try {
      const session = await createDemoSession(
        supportCase.ticket.id,
        demoPrompt(supportCase),
        runId,
      );
      setRunId(crypto.randomUUID());
      onSessionCreated(session.id);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setStarting(false);
    }
  }

  return (
    <aside className="northstar-agent-panel flex h-full min-h-0 flex-col border-l border-og-ink bg-og-offwhite text-og-fg">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 bg-og-ink px-5 text-white">
        <div className="flex min-w-0 items-center gap-2.5">
          <OpengeniGlyph className="size-[22px] shrink-0 text-og-aqua" />
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Opengeni</h2>
          <McpIndicator health={health} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {sessionId ? (
            <button
              type="button"
              onClick={onClearSession}
              className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              New run
            </button>
          ) : null}
          <button
            type="button"
            aria-label={expanded ? "Collapse Opengeni panel" : "Expand Opengeni panel"}
            aria-pressed={expanded}
            title={expanded ? "Collapse panel" : "Expand panel"}
            onClick={() => onExpandedChange(!expanded)}
            className="grid size-8 place-items-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </button>
        </div>
      </header>

      {sessionId ? (
        <div className="min-h-0 flex-1 px-3 pb-3 pt-2">
          <SessionConversation
            sessionId={sessionId}
            toolRegistry={supportToolRegistry}
            renderMessageText={renderNorthstarMessage}
            // The panel is text-only; its relay forwards only the chat routes.
            attachments={false}
            voiceInput={false}
            renderInteractiveBlock={false}
            className="northstar-agent-conversation"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-6 pt-8">
          <p className="text-[14px] text-og-fg-muted">
            Opengeni will work this ticket with Northstar&apos;s own tools.
          </p>
          <blockquote className="mt-4 border-l-2 border-og-aqua pl-4 text-[19px] leading-[1.45] tracking-[-0.01em] text-og-fg">
            {demoPrompt(supportCase)}
          </blockquote>

          <h3 className="mt-9 text-[13px] font-semibold text-og-fg">What it can do here</h3>
          <ul className="mt-3 space-y-2.5 text-[14px] leading-5">
            {(
              [
                ["read", `Read ${supportCase.ticket.id} and its conversation`],
                ["read", `Read ${supportCase.customer.name} account health and usage`],
                ["write", "Change the ticket's priority and status"],
                ["write", "Add internal notes for your team"],
              ] as const
            ).map(([access, label]) => (
              <li key={label} className="flex items-start gap-3">
                {access === "read" ? (
                  <EyeIcon
                    className="mt-0.5 size-4 shrink-0 text-og-fg-subtle"
                    aria-label="Reads"
                  />
                ) : (
                  <PencilIcon
                    className="mt-0.5 size-4 shrink-0 text-og-green"
                    aria-label="Writes"
                  />
                )}
                <span className="text-og-fg">{label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] leading-5 text-og-fg-muted">
            It can&apos;t email the customer or touch other tickets. Every change shows up on the
            left as it happens.
          </p>

          <div className="mt-auto pt-8">
            {startError ? (
              <p className="mb-3 rounded-md bg-[#fbece8] px-3 py-2.5 text-[13px] leading-5 text-[#9b3322]">
                {startError.message}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void startDemo()}
              disabled={starting || !health?.ok}
              className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md bg-og-ink text-[14px] font-semibold text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
            >
              {starting ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              {starting ? "Starting" : `Investigate ${supportCase.ticket.id}`}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function McpIndicator({ health }: { health: DemoHealth | null }) {
  const connected = Boolean(health?.ok);
  return (
    <span
      className={
        connected
          ? "ml-1 inline-flex items-center gap-1.5 text-[12px] text-white/60"
          : "ml-1 inline-flex items-center gap-1.5 text-[12px] text-[#f0c27a]"
      }
    >
      <span
        className={
          connected ? "size-1.5 rounded-full bg-og-aqua" : "size-1.5 rounded-full bg-[#f0c27a]"
        }
      />
      {connected ? "Connected to Northstar" : "Not connected"}
    </span>
  );
}
