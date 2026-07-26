import { ArrowRightIcon, LoaderCircleIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import {
  ChatComposer,
  MessageTimeline,
  SessionStatus,
  useComposer,
  useSession,
  useSessionEvents,
} from "@opengeni/react";
import type { DemoHealth } from "./types";
import { createDemoSession } from "./use-support-demo";
import { supportToolRegistry } from "./support-tool-renderers";

const DEMO_PROMPT =
  "Investigate TKT-2847 using the support tools. If the evidence warrants it, mark it urgent and investigating, then add an internal note with the evidence and next step.";

export function SupportAgentPanel({
  health,
  sessionId,
  onSessionCreated,
  onClearSession,
}: {
  health: DemoHealth | null;
  sessionId: string | null;
  onSessionCreated: (sessionId: string) => void;
  onClearSession: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<Error | null>(null);

  async function startDemo() {
    setStarting(true);
    setStartError(null);
    try {
      const session = await createDemoSession(DEMO_PROMPT);
      onSessionCreated(session.id);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setStarting(false);
    }
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-black/[0.07] bg-white text-og-fg">
      <header className="flex h-[73px] shrink-0 items-center justify-between gap-4 border-b border-og-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-[#20222b] text-white shadow-sm">
            <SparklesIcon className="size-4" />
            <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white bg-[#47b881]" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[#242631]">Northstar Copilot</h2>
            <p className="mt-0.5 truncate text-[11px] text-[#8f929c]">
              OpenGeni · live product tools
            </p>
          </div>
        </div>
        {sessionId ? (
          <button
            type="button"
            onClick={onClearSession}
            className="text-[11px] font-medium text-[#8b8e98] transition hover:text-[#3f424c]"
          >
            New run
          </button>
        ) : (
          <McpIndicator health={health} />
        )}
      </header>

      {sessionId ? (
        <LiveAgentSession sessionId={sessionId} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto px-6 py-7">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#f0efff] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#625ed3]">
              <ShieldCheckIcon className="size-3" /> Live product actions
            </div>
            <h3 className="mt-5 max-w-sm text-[25px] font-semibold leading-[1.15] tracking-[-0.035em] text-[#20222b]">
              Let the agent investigate inside your product.
            </h3>
            <p className="mt-3 max-w-sm text-[13px] leading-6 text-[#717581]">
              It reads this ticket and customer through MCP, then its actions appear in the product
              instantly.
            </p>

            <div className="mt-7 space-y-2.5">
              {[
                ["1", "Read ticket and customer context"],
                ["2", "Find the failed-export risk signal"],
                ["3", "Update priority, status, and internal notes"],
              ].map(([step, label]) => (
                <div
                  key={step}
                  className="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-[#fafafb] px-3.5 py-3 text-xs text-[#5f626d]"
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white text-[10px] font-semibold text-[#6864dc] shadow-sm">
                    {step}
                  </span>
                  {label}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8">
            {startError ? (
              <p className="mb-3 rounded-xl bg-[#fff0ed] px-3 py-2 text-xs text-[#b44835]">
                {startError.message}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void startDemo()}
              disabled={starting || !health?.ok}
              className="group flex w-full items-center justify-between rounded-[16px] bg-[#252732] px-4 py-3.5 text-left text-sm font-semibold text-white shadow-[0_10px_25px_rgba(36,38,49,0.16)] transition hover:-translate-y-0.5 hover:bg-[#30323e] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="flex items-center gap-2.5">
                {starting ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <SparklesIcon className="size-4 text-[#aaa7ff]" />
                )}
                {starting ? "Starting agent…" : "Run the investigation"}
              </span>
              <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
            </button>
            <p className="mt-3 text-center text-[10px] text-[#9da0a9]">
              OpenGeni session · authenticated product MCP · live product SSE
            </p>
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
          ? "inline-flex items-center gap-1.5 rounded-full bg-[#eef9f4] px-2.5 py-1 text-[10px] font-semibold text-[#2e7a5d]"
          : "inline-flex items-center gap-1.5 rounded-full bg-[#fff4e5] px-2.5 py-1 text-[10px] font-semibold text-[#94671f]"
      }
    >
      <span
        className={
          connected ? "size-1.5 rounded-full bg-[#44aa7c]" : "size-1.5 rounded-full bg-[#d49737]"
        }
      />
      {connected ? "Ready" : "Setup required"}
    </span>
  );
}

function LiveAgentSession({ sessionId }: { sessionId: string }) {
  const { session } = useSession(sessionId, { pollIntervalMs: 4_000 });
  const { timeline, sessionStatus, connectionState, hasOlder, loadingOlder, loadOlder } =
    useSessionEvents(sessionId);
  const composer = useComposer(sessionId);
  const status = sessionStatus ?? session?.status ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-og-border/70 px-5 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-og-fg-subtle">
          <span
            className={
              connectionState === "live"
                ? "size-1.5 rounded-full bg-og-status-idle"
                : "size-1.5 rounded-full bg-og-status-waiting"
            }
          />
          {connectionState === "live" ? "Live session" : connectionState}
        </span>
        {status ? <SessionStatus status={status} size="sm" /> : null}
      </div>

      <MessageTimeline
        items={timeline}
        status={status}
        toolRegistry={supportToolRegistry}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        className="min-h-0 flex-1"
      />

      <div className="shrink-0 border-t border-og-border/70 bg-white px-4 pb-4 pt-3">
        <ChatComposer
          composer={composer}
          effectiveControl={session?.effectiveControl}
          placeholder="Ask a follow-up…"
        />
      </div>
    </div>
  );
}
