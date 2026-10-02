import "@/components/playground/playground.css";

import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, PaletteIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { AcmeProduct } from "@/components/playground/acme-product";
import {
  ACME_EXCHANGES,
  suggestedQuestions,
  type ExchangeId,
} from "@/components/playground/acme-script";
import { useScriptedChat } from "@/components/playground/scripted-chat";
import { defaultChatStyle, type ChatStyle } from "@/components/playground/style-knobs";
import { CoachMark, Palette } from "@/components/playground/tour";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MoreMenu } from "@/components/ui/page-actions";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { markOnboarding, onboardingJourneyStorageKey } from "@/lib/onboarding-journey";
import { cn } from "@/lib/utils";

type StepId = "send" | "stream" | "style" | "memory" | "tool" | "finish";
const STEPS: readonly StepId[] = ["send", "stream", "style", "memory", "tool", "finish"];
const STEP_TITLES: Record<StepId, string> = {
  send: "Ask a question",
  stream: "Streaming, out of the box",
  style: "Match it to your product",
  memory: "Remembers each customer",
  tool: "Your product's actions as tools",
  finish: "Add an agent to your product",
};
type Sub = "" | "ask" | "asked";

type TourMemory = { step: number | null; done: StepId[] };

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private windows: the playground still works, it just forgets.
  }
}

function useNarrow(query = "(max-width: 1099px)"): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

/**
 * The playground: Acme, a sample product with Opengeni's support chat inside.
 * The chat is a recorded demo: the real `@opengeni/react` timeline replays a
 * scripted conversation (questions, streaming, a memory save and recall, tool
 * calls), and visitors pick suggested questions instead of typing. Nothing
 * calls a model or creates a session, so it works before any model is
 * connected. A coach-mark tour walks through streaming, restyling, memory,
 * tools and how to put an agent in a product.
 */
export function PlaygroundRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const { accessContext } = context;
  const subject = accessContext.subjectId;
  const routeWorkspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
  const organizationId = routeWorkspace?.accountId ?? accessContext.defaultAccountId ?? null;
  const narrow = useNarrow();
  const journeyKey = organizationId ? onboardingJourneyStorageKey(subject, organizationId) : null;
  const storageKey = `og.playground:v2:${encodeURIComponent(subject)}:tour`;

  const [tour, setTour] = useState<TourMemory>(() => {
    try {
      const saved = JSON.parse(storageGet(storageKey) ?? "null") as TourMemory | null;
      if (
        saved &&
        (saved.step === null || typeof saved.step === "number") &&
        Array.isArray(saved.done)
      )
        return { step: saved.step, done: saved.done.filter((id) => STEPS.includes(id)) };
    } catch {
      // A malformed memory starts the tour over.
    }
    return { step: 0, done: [] };
  });
  useEffect(() => storageSet(storageKey, JSON.stringify(tour)), [storageKey, tour]);
  const stepIndex = tour.step === null ? null : Math.min(tour.step, STEPS.length - 1);
  const stepId = stepIndex === null ? null : STEPS[stepIndex]!;
  const [sub, setSub] = useState<Sub>("");
  const [style, setStyle] = useState<ChatStyle>(() =>
    defaultChatStyle(document.documentElement.dataset.ogTheme === "light" ? "light" : "dark"),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);

  const finish = useCallback(
    (id: StepId, nextSub: Sub = "") => {
      captureAnalyticsEvent("playground_step_completed", { step: id });
      if (id === "stream" && journeyKey) markOnboarding(journeyKey, "playground");
      const index = STEPS.indexOf(id) + 1;
      setTour((current) => ({
        step: index < STEPS.length ? index : null,
        done: current.done.includes(id) ? current.done : [...current.done, id],
      }));
      setSub(nextSub);
    },
    [journeyKey],
  );

  // The tour moves on when an answer finishes playing.
  const onFinished = useCallback((id: ExchangeId) => {
    if (id === "remember") setSub("ask");
    else if (id === "recall" || id === "refund") setSub("asked");
  }, []);
  const chat = useScriptedChat({ onFinished });

  // Watching the first answer stream is the stream step; it moves on after.
  useEffect(() => {
    if (stepId === "send" && chat.playing) finish("send");
  }, [chat.playing, finish, stepId]);
  useEffect(() => {
    if (stepId !== "stream" || chat.playing || chat.events.length === 0) return;
    const timer = setTimeout(() => finish("stream"), 1600);
    return () => clearTimeout(timer);
  }, [chat.events.length, chat.playing, finish, stepId]);
  useEffect(() => {
    if (sub !== "asked" || chat.playing) return;
    if (stepId !== "memory" && stepId !== "tool") return;
    const timer = setTimeout(() => finish(stepId), 2600);
    return () => clearTimeout(timer);
  }, [chat.playing, finish, stepId, sub]);
  // On phones the palette folds behind Restyle; the restyle step opens it.
  useEffect(() => {
    if (narrow && stepId === "style") setPaletteOpen(true);
  }, [narrow, stepId]);

  const changeStyle = (next: ChatStyle) => {
    setStyle(next);
    if (stepId === "style" && !tour.done.includes("style")) {
      setTour((current) => ({ ...current, done: [...current.done, "style"] }));
      captureAnalyticsEvent("playground_step_completed", { step: "style" });
      setTimeout(() => {
        setTour((current) =>
          current.step === STEPS.indexOf("style")
            ? { ...current, step: STEPS.indexOf("memory") }
            : current,
        );
        setSub("");
      }, 2400);
    }
  };
  const restart = () => {
    setTour({ step: 0, done: [] });
    setSub("");
    chat.newChat();
  };
  const jump = (index: number) => {
    setTour((current) => ({ ...current, step: index }));
    setSub("");
  };

  // What the visitor can ask: the tour's next question, or anything left.
  const questions: ExchangeId[] =
    stepId === "send"
      ? ["order", "charged"]
      : stepId === "memory"
        ? sub === "" && !chat.playing
          ? ["remember"]
          : sub === "ask"
            ? ["recall"]
            : []
        : stepId === "tool"
          ? sub === "" && !chat.playing
            ? ["refund"]
            : []
          : stepId === "stream"
            ? []
            : suggestedQuestions(chat.asked);

  const touring = stepIndex !== null;
  const showPalette = !touring || stepIndex >= STEPS.indexOf("style");
  const stepLabel = (id: StepId) => `Step ${STEPS.indexOf(id) + 1} of ${STEPS.length}`;
  const skip = (id: StepId) => (
    <Button type="button" size="xs" variant="ghost" onClick={() => finish(id)}>
      Skip
    </Button>
  );
  const ask = (id: ExchangeId, options: { newChat?: boolean } = {}) => (
    <Button
      type="button"
      size="xs"
      disabled={chat.playing !== null}
      onClick={() => {
        if (options.newChat) chat.newChat();
        chat.play(id);
      }}
    >
      {ACME_EXCHANGES[id].question}
    </Button>
  );
  const person = context.authSession?.user.name || context.authSession?.user.email || "there";
  const sharedTarget = routeWorkspace?.kind === "shared" ? routeWorkspace.id : null;

  let coach: ReactNode = null;
  if (stepId === "send")
    coach = (
      <CoachMark
        id="send"
        anchor="composer"
        step={stepLabel("send")}
        title={STEP_TITLES.send}
        body="This is a recorded demo of an Opengeni agent inside a product. Pick a question."
      >
        {ask("order")}
      </CoachMark>
    );
  else if (stepId === "stream" && chat.events.length > 0)
    coach = (
      <CoachMark
        id="stream"
        anchor="reply"
        step={stepLabel("stream")}
        title={STEP_TITLES.stream}
        body="Replies stream in, with every step the agent takes. In your product it's one React component."
        code="<SessionConversation />"
      />
    );
  else if (stepId === "style")
    coach = (
      <CoachMark
        id="style"
        anchor="palette"
        side="right"
        step={stepLabel("style")}
        title={STEP_TITLES.style}
        body="Pick a color, corners, a font or a theme. It's a few CSS variables."
        code="--og-color-accent"
      >
        {skip("style")}
      </CoachMark>
    );
  else if (stepId === "memory" && sub === "asked")
    coach = (
      <CoachMark
        id="recall"
        anchor="reply"
        step={stepLabel("memory")}
        title={chat.playing ? "Looking it up in memory" : "Recalled from memory"}
        body="A new chat, and it still knows. Memory is kept per customer."
      />
    );
  else if (stepId === "memory" && sub === "ask")
    coach = (
      <CoachMark
        id="ask"
        anchor="composer"
        step={stepLabel("memory")}
        title="Now ask in a new chat"
      >
        {ask("recall", { newChat: true })}
      </CoachMark>
    );
  else if (stepId === "memory")
    coach = (
      <CoachMark
        id="memory"
        anchor="composer"
        step={stepLabel("memory")}
        title={STEP_TITLES.memory}
        body="Tell it something, then ask in a fresh chat."
      >
        {ask("remember", { newChat: true })}
        {skip("memory")}
      </CoachMark>
    );
  else if (stepId === "tool" && sub === "asked")
    coach = (
      <CoachMark
        id="tool-run"
        anchor="reply"
        step={stepLabel("tool")}
        title={chat.playing ? "Calling your tools" : "Tool calls show up here"}
        body="It looked up the charges and refunded the extra one, with tools your product gives it."
      />
    );
  else if (stepId === "tool")
    coach = (
      <CoachMark
        id="tool"
        anchor="composer"
        step={stepLabel("tool")}
        title={STEP_TITLES.tool}
        body="Give the agent your product's actions, like billing, as MCP tools."
        code="mcpServers: [{ url }]"
      >
        <Button
          type="button"
          size="xs"
          disabled={chat.playing !== null}
          onClick={() => {
            chat.newChat();
            chat.play("refund");
            setSub("asked");
          }}
        >
          Ask for a refund
        </Button>
        {skip("tool")}
      </CoachMark>
    );
  else if (stepId === "finish")
    coach = (
      <CoachMark
        id="finish"
        anchor="chat"
        side="right"
        step={stepLabel("finish")}
        title={STEP_TITLES.finish}
        body="Your coding agent can build this into your product in a few minutes."
        code="npm i @opengeni/react"
      >
        <Button asChild type="button" size="xs" onClick={() => finish("finish")}>
          <Link
            to="/workspaces/$workspaceId/organization"
            params={{ workspaceId: sharedTarget ?? workspaceId }}
            search={{ section: "developer" } as never}
          >
            Add it to your product
          </Link>
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => finish("finish")}>
          Done
        </Button>
      </CoachMark>
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
        <p className="hidden truncate text-xs text-fg-muted lg:block">
          A sample product with Opengeni inside. The chat is a recorded demo.
        </p>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {touring ? (
            <ol aria-label="Tour progress" className="mr-1 hidden items-center gap-1 sm:flex">
              {STEPS.map((id, index) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-label={`Step ${index + 1}: ${STEP_TITLES[id]}${tour.done.includes(id) ? " (done)" : ""}`}
                    aria-current={index === stepIndex ? "step" : undefined}
                    onClick={() => jump(index)}
                    className="grid size-5 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span
                      className={cn(
                        "block size-1.5 rounded-full transition-colors duration-[120ms]",
                        index === stepIndex
                          ? "size-2 bg-fg"
                          : tour.done.includes(id)
                            ? "bg-fg-muted"
                            : "bg-border-strong",
                      )}
                    />
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {narrow && showPalette ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={paletteOpen}
              aria-label="Restyle"
              data-tour="palette-toggle"
              onClick={() => setPaletteOpen((open) => !open)}
            >
              <PaletteIcon aria-hidden="true" />
              <span className="hidden sm:inline">Restyle</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={touring ? () => setTour((current) => ({ ...current, step: null })) : restart}
          >
            {touring ? "Skip tour" : "Restart tour"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="hidden sm:inline-flex"
            disabled={chat.events.length === 0}
            onClick={chat.newChat}
          >
            New chat
          </Button>
          <div className="sm:hidden">
            <MoreMenu label="Playground options" quiet>
              <DropdownMenuItem
                onSelect={
                  touring ? () => setTour((current) => ({ ...current, step: null })) : restart
                }
              >
                {touring ? "Skip tour" : "Restart tour"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={chat.events.length === 0} onSelect={chat.newChat}>
                New chat
              </DropdownMenuItem>
            </MoreMenu>
          </div>
        </div>
      </header>
      {narrow && paletteOpen && showPalette ? (
        <div className="flex shrink-0 justify-center border-b border-border bg-bg px-2 py-2">
          <Palette style={style} onChange={changeStyle} orientation="horizontal" />
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <AcmeProduct
          chat={chat}
          questions={questions}
          finished={!touring && questions.length === 0}
          person={person}
          style={style}
        />
        {!narrow && showPalette ? (
          <Palette
            style={style}
            onChange={changeStyle}
            orientation="vertical"
            className="absolute top-24 right-5 z-30"
          />
        ) : null}
      </div>
      {coach}
      <p className="sr-only" aria-live="polite">
        {stepId ? `${stepLabel(stepId)}: ${STEP_TITLES[stepId]}` : ""}
      </p>
    </div>
  );
}
