import {
  ArrowUpIcon,
  EyeIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
} from "lucide-react";
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
      <header className="relative flex h-14 shrink-0 items-center justify-between gap-4 bg-og-ink px-5 text-white after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,#9fe3d3,#fbfbf8_55%,#ffb787)] after:opacity-60">
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-5 pt-9">
          <h3 className="text-[24px] font-semibold leading-[1.2] tracking-[-0.025em] text-og-fg">
            Hand this ticket to Opengeni
          </h3>
          <p className="mt-2 max-w-[34ch] text-[14px] leading-[1.55] text-og-fg-muted">
            It works inside Northstar with the same tools you use, and every change lands on the
            ticket as it happens.
          </p>

          <ul className="mt-7 divide-y divide-og-ink/[0.07] border-y border-og-ink/[0.07] text-[14px]">
            {(
              [
                ["read", `Reads ${supportCase.ticket.id} and its conversation`],
                ["read", `Reads ${supportCase.customer.name} account health and usage`],
                ["write", "Changes the ticket's priority and status"],
                ["write", "Adds internal notes for your team"],
              ] as const
            ).map(([access, label]) => (
              <li key={label} className="flex items-center gap-3 py-2.5">
                {access === "read" ? (
                  <EyeIcon className="size-4 shrink-0 text-og-fg-subtle" aria-label="Reads" />
                ) : (
                  <PencilIcon className="size-4 shrink-0 text-og-green" aria-label="Writes" />
                )}
                <span className="text-og-fg">{label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] leading-5 text-og-fg-subtle">
            It can&apos;t email the customer or open other tickets.
          </p>

          <div className="mt-auto pt-8">
            {startError ? (
              <p className="mb-3 rounded-lg bg-[#fbece8] px-3 py-2.5 text-[13px] leading-5 text-[#9b3322]">
                {startError.message}
              </p>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void startDemo();
              }}
              className="rounded-2xl bg-white p-3 shadow-[0_0_0_1px_rgba(17,19,17,0.1),0_10px_30px_-12px_rgba(17,19,17,0.25)]"
            >
              <p className="px-1.5 pt-1 text-[14.5px] leading-[1.55] text-og-fg">
                {demoPrompt(supportCase)}
              </p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="pl-1.5 text-[12px] text-og-fg-subtle">
                  Runs on this workspace&apos;s default model
                </span>
                <button
                  type="submit"
                  disabled={starting || !health?.ok}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl bg-og-ink pl-3.5 pr-2 text-[13px] font-semibold text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {starting ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                  {starting ? "Starting" : "Start"}
                  <ArrowUpIcon className="size-4 rounded-md bg-og-aqua p-0.5 text-og-ink" />
                </button>
              </div>
            </form>
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
