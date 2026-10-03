import "@/components/playground/playground.css";

import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ADD_AGENT_DEFAULT_PROMPT } from "@/components/new-session-starters";
import { AcmeProduct } from "@/components/playground/acme-product";
import { QUESTIONS } from "@/components/playground/acme-script";
import { ADD_TO_PRODUCT_INSTRUCTIONS } from "@/components/playground/add-to-product";
import { chatSnippet } from "@/components/playground/chat-snippet";
import { ChatSnippetView } from "@/components/playground/chat-snippet-view";
import { createRecordedClient } from "@/components/playground/recorded-client";
import { ACCENTS, defaultChatStyle, type ChatStyle } from "@/components/playground/style-knobs";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { useFirstRunStarters } from "@/lib/first-run-starters";
import { markOnboarding, onboardingJourneyStorageKey } from "@/lib/onboarding-journey";
import { cn } from "@/lib/utils";

/**
 * The playground: Acme, a sample product with Opengeni's `<OpenGeniChat />`
 * inside, next to the few lines that put it there. The chat is the real
 * component on a recorded client: it never calls a model or creates anything.
 * A color and light/dark restyle it live and mark the lines they change; "Add
 * it to your product" opens a real chat that walks through the integration.
 */
export function PlaygroundRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { accessContext } = context;
  const navigate = useNavigate();
  const routeWorkspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const organizationId = routeWorkspace?.accountId ?? accessContext.defaultAccountId ?? null;
  const journeyKey = organizationId
    ? onboardingJourneyStorageKey(accessContext.subjectId, organizationId)
    : null;
  const firstRun = useFirstRunStarters(workspaceId);

  // Each action counts once.
  const reported = useRef(new Set<string>());
  const report = useCallback((step: "ask" | "style" | "ship") => {
    if (reported.current.has(step)) return;
    reported.current.add(step);
    captureAnalyticsEvent("playground_step_completed", { step });
  }, []);

  const [style, setStyle] = useState<ChatStyle>(() =>
    defaultChatStyle(document.documentElement.dataset.ogTheme === "light" ? "light" : "dark"),
  );
  const restyle = (next: ChatStyle) => {
    setStyle(next);
    report("style");
  };
  const lines = useMemo(() => chatSnippet(style), [style]);

  const [playing, setPlaying] = useState(0);
  const onAnswered = useRef(() => {});
  onAnswered.current = () => {
    setPlaying((count) => Math.max(0, count - 1));
    report("ask");
    if (journeyKey) markOnboarding(journeyKey, "playground");
  };
  const [client] = useState(() =>
    createRecordedClient({
      onAsked: () => setPlaying((count) => count + 1),
      onAnswered: () => onAnswered.current(),
    }),
  );
  useEffect(() => () => client.dispose(), [client]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const ask = (text: string) => {
    if (sessionId) {
      client.ask(sessionId, text);
      return;
    }
    setSessionId(client.startChat(text));
    // The chat list reads again, so the new chat shows in it.
    setEpoch((value) => value + 1);
  };

  // "Add it to your product" opens a real chat in this workspace, on its
  // default model, that walks the person through the integration.
  const [shipping, setShipping] = useState(false);
  const ship = async () => {
    if (shipping || context.busy) return;
    report("ship");
    setShipping(true);
    try {
      const created = await context.startSession(
        workspaceId,
        { text: firstRun.productPrompt || ADD_AGENT_DEFAULT_PROMPT },
        { instructions: ADD_TO_PRODUCT_INSTRUCTIONS },
      );
      if (created)
        await navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: created.id },
        });
    } finally {
      setShipping(false);
    }
  };

  const person = context.authSession?.user.name || context.authSession?.user.email || "You";
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col bg-canvas text-fg"
      data-playground=""
      data-workspace-scroll-owner="self-managed"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-bg px-2 sm:px-4">
        <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId }}
            aria-label="Back to new session"
          >
            <ArrowLeftIcon aria-hidden="true" />
            <span className="hidden sm:inline">New session</span>
          </Link>
        </Button>
        <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />
        <h1 className="truncate text-sm font-semibold text-fg">Playground</h1>
        <p className="hidden truncate text-xs text-fg-muted sm:block">A recorded demo</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1280px] gap-4 p-3 sm:p-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-6 lg:p-6">
          <section aria-label="Sample product" className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="text-sm font-medium text-fg">Try a color</p>
              <div
                role="radiogroup"
                aria-label="Color"
                className="flex gap-2"
                onKeyDown={(event) => {
                  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
                    event.key
                  ];
                  if (!step) return;
                  event.preventDefault();
                  const index = ACCENTS.indexOf(style.accent);
                  const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length]!;
                  restyle({ ...style, accent: next });
                  event.currentTarget
                    .querySelector<HTMLElement>(`[aria-label="${next.name}"]`)
                    ?.focus();
                }}
              >
                {ACCENTS.map((accent) => {
                  const selected = style.accent.name === accent.name;
                  return (
                    <button
                      key={accent.name}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={accent.name}
                      title={accent.name}
                      tabIndex={selected ? 0 : -1}
                      className={cn(
                        "size-7 rounded-full border-2 outline-none transition-[box-shadow] duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                        selected ? "border-canvas ring-2 ring-fg" : "border-transparent",
                      )}
                      style={{ background: accent.value }}
                      onClick={() => restyle({ ...style, accent })}
                    />
                  );
                })}
              </div>
              <SegmentedControl
                aria-label="Theme"
                size="sm"
                value={style.theme}
                onValueChange={(theme) => restyle({ ...style, theme })}
                options={[
                  { value: "light", label: "Light", icon: <SunIcon aria-hidden="true" /> },
                  { value: "dark", label: "Dark", icon: <MoonIcon aria-hidden="true" /> },
                ]}
              />
            </div>
            <div className="flex h-[min(64dvh,560px)] min-h-[380px] overflow-hidden rounded-[14px] border border-border lg:h-auto lg:min-h-0 lg:flex-1">
              <AcmeProduct
                client={client}
                style={style}
                sessionId={sessionId}
                onSessionChange={setSessionId}
                epoch={epoch}
                person={person}
              />
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested questions">
              {[QUESTIONS.order, QUESTIONS.charged].map((question) => (
                <button
                  key={question}
                  type="button"
                  disabled={playing > 0}
                  onClick={() => ask(question)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg transition-colors duration-[120ms] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 pointer-coarse:min-h-11"
                >
                  {question}
                </button>
              ))}
            </div>
          </section>
          <section aria-label="The code" className="flex min-w-0 flex-col gap-4 lg:pt-11">
            <ChatSnippetView lines={lines} />
            <Button
              type="button"
              className="self-start"
              disabled={shipping}
              onClick={() => void ship()}
            >
              Add it to your product
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}
