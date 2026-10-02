import "@/components/playground/playground.css";

import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { AcmeProduct } from "@/components/playground/acme-product";
import {
  DEFAULT_AGENT_SETTINGS,
  QUESTIONS,
  type AgentSettings,
} from "@/components/playground/acme-script";
import { CodePanel } from "@/components/playground/code-panel";
import {
  GUIDE_STEPS,
  guideReducer,
  parseGuideState,
  type GuideStepId,
} from "@/components/playground/guide";
import { GuidePanel, STEP_TITLES, type AgentSettingId } from "@/components/playground/guide-panel";
import { integrationCode } from "@/components/playground/integration-code";
import { createRecordedClient, type RecordedAnswer } from "@/components/playground/recorded-client";
import { defaultChatStyle, type ChatStyle } from "@/components/playground/style-knobs";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { MANAGED_API_ORIGIN } from "@/lib/coding-agent-setup";
import { markOnboarding, onboardingJourneyStorageKey } from "@/lib/onboarding-journey";
import { cn } from "@/lib/utils";

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows: the playground still works, it just forgets.
  }
}

function useWide(query = "(min-width: 1024px)"): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return wide;
}

/**
 * The playground: Acme, a sample product with Opengeni's `<OpenGeniChat />`
 * inside, beside the few lines of code that put it there. The chat is the
 * real component on a recorded client: it never calls a model or creates
 * anything. Four light steps walk through asking, restyling, agent settings
 * and adding it to a product; every control also works on its own.
 */
export function PlaygroundRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { accessContext } = context;
  const subject = accessContext.subjectId;
  const routeWorkspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const organizationId = routeWorkspace?.accountId ?? accessContext.defaultAccountId ?? null;
  const journeyKey = organizationId ? onboardingJourneyStorageKey(subject, organizationId) : null;
  const guideKey = `og.playground:v3:${encodeURIComponent(subject)}:guide`;
  const wide = useWide();

  const [guide, dispatch] = useReducer(guideReducer, guideKey, (key) =>
    parseGuideState(storageGet(key)),
  );
  useEffect(() => storageSet(guideKey, JSON.stringify(guide)), [guide, guideKey]);
  // Each step counts once, when it is first done.
  const reported = useRef(new Set(guide.done));
  useEffect(() => {
    for (const step of guide.done) {
      if (reported.current.has(step)) continue;
      reported.current.add(step);
      captureAnalyticsEvent("playground_step_completed", { step });
    }
  }, [guide.done]);

  const [style, setStyle] = useState<ChatStyle>(() =>
    defaultChatStyle(document.documentElement.dataset.ogTheme === "light" ? "light" : "dark"),
  );
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [playing, setPlaying] = useState(0);
  const [lastAnswer, setLastAnswer] = useState<RecordedAnswer | null>(null);

  const onAnswered = useCallback(
    (answer: RecordedAnswer) => {
      setPlaying((count) => Math.max(0, count - 1));
      setLastAnswer(answer);
      dispatch({ type: "answered", question: answer.question, settings: answer.settings });
      if (journeyKey) markOnboarding(journeyKey, "playground");
    },
    [journeyKey],
  );
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  const [client] = useState(() =>
    createRecordedClient({
      settings: () => settingsRef.current,
      onAsked: () => setPlaying((count) => count + 1),
      onAnswered: (answer) => answered.current(answer),
    }),
  );
  useEffect(() => () => client.dispose(), [client]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const ask = (text: string, { newChat }: { newChat: boolean }) => {
    if (sessionId && !newChat) {
      client.ask(sessionId, text);
      return;
    }
    setSessionId(client.startChat(text));
    // The chat list reads again, so the new chat shows in it.
    setEpoch((value) => value + 1);
  };
  // Settings shape new chats, as on a real server: offer one when they changed.
  const differs = (from: AgentSettings) =>
    (Object.keys(settings) as AgentSettingId[]).some((id) => from[id] !== settings[id]);
  const chatSettings = sessionId ? client.settingsOf(sessionId) : null;
  const offerNewChat = chatSettings ? differs(chatSettings) : differs(DEFAULT_AGENT_SETTINGS);
  const followUp =
    lastAnswer?.sessionId === sessionId &&
    lastAnswer.question === "charged" &&
    lastAnswer.settings.tools
      ? QUESTIONS.refund
      : null;

  const changeStyle = (next: ChatStyle) => {
    setStyle(next);
    dispatch({ type: "styled" });
  };
  const changeSetting = (id: AgentSettingId, on: boolean) =>
    setSettings((current) => ({ ...current, [id]: on }));

  const files = useMemo(
    () => integrationCode(style, settings, MANAGED_API_ORIGIN),
    [settings, style],
  );
  const person = context.authSession?.user.name || context.authSession?.user.email || "You";
  const sharedTarget = routeWorkspace?.kind === "shared" ? routeWorkspace.id : null;
  const shipAction = (
    <Button asChild size="sm" onClick={() => dispatch({ type: "shipped" })}>
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId: sharedTarget ?? workspaceId }}
        search={{ section: "developer" } as never}
      >
        Add it to your product
        <ArrowRightIcon aria-hidden="true" />
      </Link>
    </Button>
  );

  const startOver = () => {
    dispatch({ type: "restart" });
    setStyle(defaultChatStyle(style.theme));
    setSettings(DEFAULT_AGENT_SETTINGS);
    setSessionId(null);
    setLastAnswer(null);
  };
  const codePanel = (
    <CodePanel
      files={files}
      className="rounded-[14px] border border-border bg-surface lg:h-[34%] lg:max-h-[320px] lg:min-h-[220px] lg:shrink-0"
    />
  );
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col bg-canvas text-fg"
      data-playground=""
      data-workspace-scroll-owner="self-managed"
    >
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-bg px-2 sm:gap-2 sm:px-4">
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
        <p className="hidden truncate text-xs text-fg-muted md:block">
          Opengeni inside a sample product. A recording: no model, nothing saved.
        </p>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <ol aria-label="Steps" className="mr-1 flex items-center">
            {GUIDE_STEPS.map((id, index) => (
              <li key={id}>
                <button
                  type="button"
                  aria-label={`Step ${index + 1}: ${STEP_TITLES[id]}${guide.done.includes(id) ? " (done)" : ""}`}
                  aria-current={guide.current === id ? "step" : undefined}
                  onClick={() => dispatch({ type: "jump", step: id })}
                  className="grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11"
                >
                  <span
                    className={cn(
                      "block rounded-full transition-colors duration-[120ms]",
                      guide.current === id ? "size-2 bg-fg" : "size-1.5",
                      guide.current !== id &&
                        (guide.done.includes(id) ? "bg-fg-muted" : "bg-border-strong"),
                    )}
                  />
                </button>
              </li>
            ))}
          </ol>
          <Button type="button" variant="ghost" size="sm" onClick={startOver}>
            Start over
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="z-10 flex shrink-0 flex-col gap-3 bg-canvas p-2 max-lg:sticky max-lg:top-0 max-lg:h-[min(56dvh,560px)] max-lg:min-h-[380px] max-lg:border-b max-lg:border-border sm:p-3 lg:min-h-0 lg:min-w-0 lg:flex-1 lg:p-4">
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-border">
            <AcmeProduct
              client={client}
              style={style}
              sessionId={sessionId}
              onSessionChange={setSessionId}
              epoch={epoch}
              person={person}
            />
          </div>
          {wide ? codePanel : null}
        </div>
        <aside
          aria-label="Try it"
          className="flex shrink-0 flex-col gap-3 p-2 sm:p-3 lg:w-[360px] lg:overflow-y-auto lg:border-l lg:border-border lg:bg-bg"
        >
          <GuidePanel
            guide={guide}
            style={style}
            settings={settings}
            playing={playing > 0}
            followUp={followUp}
            offerNewChat={offerNewChat}
            onStyle={changeStyle}
            onSetting={changeSetting}
            onAsk={ask}
            onSkip={() => dispatch({ type: "skip" })}
            shipAction={shipAction}
          />
          {wide ? null : codePanel}
        </aside>
      </div>
      <p className="sr-only" aria-live="polite">
        {guide.current ? stepAnnouncement(guide.current) : ""}
      </p>
    </div>
  );
}

function stepAnnouncement(step: GuideStepId): string {
  return `Step ${GUIDE_STEPS.indexOf(step) + 1} of ${GUIDE_STEPS.length}: ${STEP_TITLES[step]}`;
}
