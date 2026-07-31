import {
  ArrowRightIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Markdown,
  MessageTimeline,
  SessionStatus,
  useComposer,
  useFileAttachments,
  useSession,
  useSessionEvents,
  type ComposerState,
  type UseFileAttachmentsResult,
} from "@opengeni/react";
import * as Composer from "@opengeni/react/composer";
import type { EffectiveSessionControl } from "@opengeni/sdk";
import type { DemoHealth, SupportCase } from "./types";
import { createDemoSession } from "./use-support-demo";
import { supportToolRegistry } from "./support-tool-renderers";

function demoPrompt(supportCase: SupportCase): string {
  const { ticket, customer } = supportCase;
  return `Investigate ${ticket.id} for ${customer.name} using the Northstar support tools. Read the ticket and customer signals, decide whether its priority or status should change, apply justified changes, and add an internal note with the evidence and next step.`;
}

function renderNorthstarMessage(text: string) {
  return <Markdown className="northstar-agent-copy">{text}</Markdown>;
}

export function SupportAgentPanel({
  health,
  supportCase,
  sessionId,
  expanded,
  onExpandedChange,
  onSessionCreated,
  onClearSession,
}: {
  health: DemoHealth | null;
  supportCase: SupportCase;
  sessionId: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSessionCreated: (sessionId: string) => void;
  onClearSession: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<Error | null>(null);

  async function startDemo() {
    setStarting(true);
    setStartError(null);
    try {
      const session = await createDemoSession(supportCase.ticket.id, demoPrompt(supportCase));
      onSessionCreated(session.id);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setStarting(false);
    }
  }

  return (
    <aside className="northstar-agent-panel flex h-full min-h-0 flex-col border-l border-[#302a40] bg-white text-og-fg">
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#252131] px-5 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-[#6759ce] text-white">
            <SparklesIcon className="size-4" />
            <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[#252131] bg-[#54b987]" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-white">
              OpenGeni
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-white/55">
              Live inside Northstar · {supportCase.ticket.id}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {sessionId ? (
            <button
              type="button"
              onClick={onClearSession}
              className="rounded-lg px-2.5 py-2 text-[11px] font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              New run
            </button>
          ) : (
            <McpIndicator health={health} />
          )}
          <button
            type="button"
            aria-label={expanded ? "Collapse OpenGeni panel" : "Expand OpenGeni panel"}
            aria-pressed={expanded}
            title={expanded ? "Collapse panel" : "Expand panel"}
            onClick={() => onExpandedChange(!expanded)}
            className="grid size-8 place-items-center rounded-lg text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
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
        <LiveAgentSession sessionId={sessionId} expanded={expanded} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto bg-[#f7f7f7] px-7 py-7">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold text-[#5c50bf]">
              <ShieldCheckIcon className="size-3.5" /> Connected to Northstar
            </div>
            <h3 className="mt-5 max-w-sm text-[27px] font-semibold leading-[1.12] tracking-[-0.04em] text-[#25222c]">
              Investigate with OpenGeni
            </h3>
            <p className="mt-3 max-w-sm text-[13px] leading-5 text-[#6d6973]">
              The agent reads this case, uses Northstar’s tools, and writes each result back here.
            </p>

            <div className="mt-7 overflow-hidden rounded-xl border border-[#dedce5] bg-white">
              <div className="border-b border-[#e8e7eb] px-4 py-3.5">
                <p className="text-[11px] font-semibold text-[#514d59]">Available product tools</p>
                <p className="mt-1 text-[10px] text-[#96929c]">
                  Four MCP tools, scoped to {supportCase.ticket.id}
                </p>
              </div>
              <div className="divide-y divide-[#ecebee] px-4">
                {[
                  ["Read", "Ticket details", "The case, message, tags, status"],
                  ["Read", "Customer signals", "Plan, usage, health, failures"],
                  ["Write", "Update the case", "Priority and workflow status"],
                  ["Write", "Document the work", "Evidence-backed internal notes"],
                ].map(([access, label, detail]) => (
                  <div key={label} className="flex items-center gap-3 py-3">
                    <span
                      className={
                        access === "Read"
                          ? "w-11 text-[9px] font-bold uppercase tracking-[0.08em] text-[#3f8069]"
                          : "w-11 text-[9px] font-bold uppercase tracking-[0.08em] text-[#6558cd]"
                      }
                    >
                      {access}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-[#3d3948]">{label}</p>
                      <p className="mt-0.5 truncate text-[10px] text-[#9994a4]">{detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 border-t border-[#dedde2] pt-4">
              <p className="text-[10px] font-medium text-[#918e96]">Investigation sequence</p>
              <div className="mt-2 flex items-center gap-2 text-[11px] font-medium text-[#5d5963]">
                <span>Understand</span>
                <ArrowRightIcon className="size-3 text-[#aaa7ae]" />
                <span>Reason</span>
                <ArrowRightIcon className="size-3 text-[#aaa7ae]" />
                <span>Act</span>
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 z-10 mt-8 border-t border-[#dedde2] bg-[#f7f7f7] pb-1 pt-4">
            {startError ? (
              <p className="mb-3 rounded-xl bg-[#fff0ed] px-3 py-2 text-xs text-[#b44835]">
                {startError.message}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void startDemo()}
              disabled={starting || !health?.ok}
              className="group flex w-full items-center justify-between rounded-lg bg-[#5f52c5] px-4 py-3 text-left text-[12px] font-semibold text-white transition hover:bg-[#5448b2] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="flex items-center gap-2.5">
                {starting ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <SparklesIcon className="size-4 text-[#d8d4ff]" />
                )}
                {starting ? "Starting agent…" : "Start agent investigation"}
              </span>
              <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
            </button>
            <p className="mt-3.5 text-center text-[10px] text-[#9792a1]">
              Authenticated session · MCP tools · live product updates
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
          ? "inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-semibold text-[#8de0ba]"
          : "inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-semibold text-[#e8bc75]"
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

function LiveAgentSession({ sessionId, expanded }: { sessionId: string; expanded: boolean }) {
  const { session } = useSession(sessionId, { pollIntervalMs: 4_000 });
  const { timeline, sessionStatus, connectionState, hasOlder, loadingOlder, loadOlder, error } =
    useSessionEvents(sessionId);
  const attachments = useFileAttachments();
  const composer = useComposer(sessionId, {
    sendExtras: () => ({ resources: attachments.readyResources }),
    sendBlocked: () => attachments.hasUnresolved,
    onSent: (_text, input) =>
      attachments.removeReadyFiles(
        (input.resources ?? []).flatMap((resource) =>
          resource.kind === "file" ? [resource.fileId] : [],
        ),
      ),
  });
  const status = sessionStatus ?? session?.status ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-og-border/70 px-5 py-2.5">
        <span
          className="inline-flex items-center gap-1.5 text-[10px] text-og-fg-subtle"
          data-stream-error={error?.message}
          title={error?.message}
        >
          <span
            className={
              connectionState === "live"
                ? "size-1.5 rounded-full bg-og-status-idle"
                : "size-1.5 rounded-full bg-og-status-waiting"
            }
          />
          {connectionState === "live"
            ? "Live session"
            : connectionState === "error"
              ? "Reconnecting timeline"
              : connectionState}
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
        renderMessageText={renderNorthstarMessage}
        className="northstar-agent-timeline min-h-0 flex-1"
      />

      <div className="shrink-0 border-t border-og-border/70 bg-white px-4 pb-3 pt-3">
        <NorthstarComposer
          composer={composer}
          effectiveControl={session?.effectiveControl}
          attachments={attachments}
          expanded={expanded}
        />
      </div>
    </div>
  );
}

function NorthstarComposer({
  composer,
  effectiveControl,
  attachments,
  expanded,
}: {
  composer: ComposerState;
  effectiveControl: EffectiveSessionControl | null | undefined;
  attachments: UseFileAttachmentsResult;
  expanded: boolean;
}) {
  const controller = Composer.useChatComposerController({
    delivery: composer,
    draft: composer,
    control: composer,
    effectiveControl,
    attachments,
  });

  return (
    <Composer.Root controller={controller} className="northstar-agent-composer">
      <Composer.Frame>
        <Composer.CommandPalette />
        <Composer.Surface className="rounded-[11px] border-[#dedce5] shadow-none focus-within:border-[#8b7fe1] focus-within:shadow-[0_0_0_3px_rgba(103,89,206,0.10)]">
          <Composer.PausedState />
          <Composer.RestoredResources />
          <Composer.Attachments />
          <Composer.Input
            placeholder="Ask OpenGeni…"
            className="min-h-[42px] px-3.5 pb-1 pt-2.5 !text-[13px] !leading-5"
          />
          {controller.confirmState ? (
            <Composer.Confirmation />
          ) : (
            <Composer.Footer className="items-center px-2.5 pb-2 pt-0.5">
              <Composer.Controls className="flex-nowrap gap-1">
                <Composer.AttachButton className="size-7 rounded-lg pointer-coarse:size-10" />
                <span className="min-w-0 flex-1 truncate px-1 text-[10px] text-og-fg-subtle">
                  {expanded
                    ? "Add context · Enter to send · Shift+Enter for a new line"
                    : "Add context"}
                </span>
              </Composer.Controls>
              <Composer.Actions className="gap-1">
                <Composer.PauseButton className="size-7 rounded-lg pointer-coarse:size-10" />
                <Composer.SendButton className="size-7 rounded-lg pointer-coarse:size-10" />
              </Composer.Actions>
            </Composer.Footer>
          )}
        </Composer.Surface>
      </Composer.Frame>
      <Composer.Help />
      <Composer.Status />
    </Composer.Root>
  );
}
