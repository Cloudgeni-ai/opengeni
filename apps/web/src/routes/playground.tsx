import "@/components/playground/playground.css";

import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ADD_AGENT_DEFAULT_PROMPT } from "@/components/new-session-starters";
import { AcmeProduct } from "@/components/playground/acme-product";
import { DEMO_AUTHORIZATION_URL, QUESTIONS } from "@/components/playground/acme-script";
import {
  ADD_TO_PRODUCT_FIRST_REPLY,
  ADD_TO_PRODUCT_INSTRUCTIONS,
} from "@/components/playground/add-to-product";
import { Callout, type CalloutSide } from "@/components/playground/callout";
import { chatSnippet } from "@/components/playground/chat-snippet";
import { ChatSnippetView } from "@/components/playground/chat-snippet-view";
import { createRecordedClient } from "@/components/playground/recorded-client";
import {
  ACCENTS,
  customAccent,
  defaultChatStyle,
  type ChatStyle,
} from "@/components/playground/style-knobs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { useFirstRunStarters } from "@/lib/first-run-starters";
import { markOnboarding, onboardingJourneyStorageKey } from "@/lib/onboarding-journey";
import { cn } from "@/lib/utils";

/** The callouts, in order. Each moves on only when the person acts. */
export type Tip = "chat" | "color" | "code" | "tool" | "ship";
const SIDES: Record<Tip, readonly CalloutSide[]> = {
  chat: ["right", "below"],
  color: ["below", "right"],
  code: ["left", "above"],
  tool: ["right", "below"],
  ship: ["right", "below"],
};
const TARGETS: Record<Tip, string | readonly string[]> = {
  chat: "[data-callout-target='questions'] [data-question='order']",
  // A color to pick: the swatch after the selected one.
  color: "[data-callout-target='colors'] [data-next-swatch]",
  code: "[data-snippet='page'] [data-changed]",
  // The chat's Connect card once it shows; until then, the question that needs it.
  tool: [
    `[data-playground-product] a[href="${DEMO_AUTHORIZATION_URL}"]`,
    "[data-callout-target='questions'] [data-question='pickup']",
  ],
  ship: "[data-callout-target='ship']",
};

/**
 * The playground: Acme, a sample product with Opengeni's `<OpenGeniChat />`
 * inside, next to the few lines that put it there. The chat is the real
 * component on a recorded client: it never calls a model or creates anything.
 * A color and light/dark restyle it live and mark the lines they change; "Add
 * it to your product" opens a real chat that walks through the integration.
 * A few callouts point the way; each waits for the person to act.
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

  // Every visit starts with the tips; Skip hides them for this visit only,
  // and "Show tips" brings them back.
  const [tip, setTip] = useState<Tip | null>("chat");
  const endTips = () => setTip(null);

  const [style, setStyle] = useState<ChatStyle>(() =>
    defaultChatStyle(document.documentElement.dataset.ogTheme === "light" ? "light" : "dark"),
  );
  const restyle = (next: ChatStyle) => {
    // Only a different color moves the tips on (light and dark don't).
    const recolored = next.accent.value !== style.accent.value;
    setStyle(next);
    report("style");
    if (recolored)
      setTip((current) => (current === "chat" || current === "color" ? "code" : current));
  };
  const [hex, setHex] = useState("");
  const lines = useMemo(() => chatSnippet(style), [style]);

  const [playing, setPlaying] = useState(0);
  const onAnswered = useRef(() => {});
  onAnswered.current = () => {
    setPlaying((count) => Math.max(0, count - 1));
    report("ask");
    setTip((current) => (current === "chat" ? "color" : current));
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
  const onConnected = () => {
    if (!sessionId) return;
    client.connected(sessionId);
    setTip((current) => (current === "tool" ? "ship" : current));
  };
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
  // default model, that walks the person through the integration. Without a
  // real workspace (the walkthrough preview) it shows how that chat starts.
  const prompt = firstRun.productPrompt || ADD_AGENT_DEFAULT_PROMPT;
  const [shipping, setShipping] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const ship = async () => {
    if (shipping || context.busy) return;
    report("ship");
    if (tip) endTips();
    if (typeof context.startSession !== "function") {
      setPreviewOpen(true);
      return;
    }
    setShipping(true);
    try {
      const created = await context.startSession(
        workspaceId,
        { text: prompt },
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

  const skip = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="text-canvas/80 hover:bg-canvas/15 hover:text-canvas"
      onClick={endTips}
    >
      Skip
    </Button>
  );
  const callouts: Record<Tip, { text: ReactNode; actions: ReactNode }> = {
    chat: {
      text: (
        <>
          One{" "}
          <code className="rounded bg-canvas/15 px-1 font-mono text-xs">{"<OpenGeniChat />"}</code>{" "}
          is the whole chat - streaming, chat list, new chat, light and dark. Ask it something.
        </>
      ),
      actions: skip,
    },
    color: { text: "Try a color.", actions: skip },
    code: {
      text: "That's all it took - one prop.",
      actions: (
        <>
          {skip}
          <Button
            type="button"
            size="xs"
            className="border-transparent bg-canvas text-fg hover:bg-canvas/90"
            onClick={() => setTip("tool")}
          >
            Next
          </Button>
        </>
      ),
    },
    tool: { text: "Agents ask users to connect tools right in the chat.", actions: skip },
    ship: {
      text: "Ready? This opens a chat where an agent adds it to your product with you.",
      actions: skip,
    },
  };
  // The first callout waits while the answer plays.
  const showTip = tip && !(tip === "chat" && playing > 0) ? tip : null;

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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setTip(tip ? null : sessionId ? "color" : "chat")}
        >
          {tip ? "Hide tips" : "Show tips"}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-playground-scroll="">
        <div className="mx-auto grid w-full max-w-[1320px] gap-4 p-3 sm:p-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_500px] lg:gap-6 lg:p-6">
          <section aria-label="Sample product" className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-sm font-medium text-fg">Ask the chat</p>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Suggested questions"
                data-callout-target="questions"
              >
                {(["order", "charged", "pickup"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={playing > 0}
                    onClick={() => ask(QUESTIONS[id])}
                    data-question={id}
                    // The question the current tip is about pulses gently.
                    data-pulse={
                      (showTip === "chat" && id === "order") ||
                      (showTip === "tool" && id === "pickup")
                        ? ""
                        : undefined
                    }
                    className="og-pulse rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg transition-colors duration-[120ms] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 pointer-coarse:min-h-11"
                  >
                    {QUESTIONS[id]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-sm font-medium text-fg">Try a color</p>
              <div
                role="radiogroup"
                aria-label="Color"
                data-callout-target="colors"
                className="flex gap-2"
                onKeyDown={(event) => {
                  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
                    event.key
                  ];
                  if (!step) return;
                  event.preventDefault();
                  const index = Math.max(0, ACCENTS.indexOf(style.accent));
                  const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length]!;
                  restyle({ ...style, accent: next });
                  event.currentTarget
                    .querySelector<HTMLElement>(`[aria-label="${next.name}"]`)
                    ?.focus();
                }}
              >
                {ACCENTS.map((accent, index) => {
                  const selected = style.accent.name === accent.name;
                  const custom = !ACCENTS.includes(style.accent);
                  const selectedIndex = ACCENTS.findIndex(
                    (each) => each.name === style.accent.name,
                  );
                  const next = index === (selectedIndex + 1) % ACCENTS.length;
                  return (
                    <button
                      key={accent.name}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-next-swatch={next ? "" : undefined}
                      aria-label={accent.name}
                      title={accent.name}
                      tabIndex={selected || (custom && index === 0) ? 0 : -1}
                      className={cn(
                        "size-7 rounded-full border-2 outline-none transition-[box-shadow] duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11",
                        selected ? "border-canvas ring-2 ring-fg" : "border-transparent",
                      )}
                      style={{ background: accent.value }}
                      onClick={() => {
                        setHex("");
                        restyle({ ...style, accent });
                      }}
                    />
                  );
                })}
              </div>
              <Input
                aria-label="Your brand color"
                placeholder="#hex"
                value={hex}
                spellCheck={false}
                maxLength={7}
                className="h-8 w-20 font-mono text-xs"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setHex(value);
                  const accent = customAccent(value);
                  if (accent) restyle({ ...style, accent });
                }}
              />
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
            <div
              data-callout-target="chat"
              className="flex h-[min(64dvh,560px)] min-h-[360px] w-full overflow-hidden rounded-[14px] border border-border lg:h-auto lg:min-h-0 lg:flex-1"
            >
              <AcmeProduct
                client={client}
                style={style}
                sessionId={sessionId}
                onSessionChange={setSessionId}
                epoch={epoch}
                person={person}
                onConnected={onConnected}
              />
            </div>
          </section>
          <section aria-label="The code" className="flex min-w-0 flex-col gap-4 lg:pt-11">
            <ChatSnippetView lines={lines} label="Support.jsx" marks />
            <div className="grid gap-1.5">
              <div data-callout-target="ship" className="self-start justify-self-start">
                <Button type="button" disabled={shipping} onClick={() => void ship()}>
                  Add it to your product
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              </div>
              {/* The last callout says the same thing, so the caption steps aside. */}
              <p
                className={cn("max-w-56 text-xs text-fg-muted", showTip === "ship" && "invisible")}
              >
                Opens a chat where an agent adds it to your product with you.
              </p>
            </div>
          </section>
        </div>
      </div>
      {showTip ? (
        <Callout
          key={showTip}
          id={showTip}
          target={TARGETS[showTip]}
          sides={SIDES[showTip]}
          actions={callouts[showTip].actions}
        >
          {callouts[showTip].text}
        </Callout>
      ) : null}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-lg" data-ship-preview="">
          <DialogHeader>
            <DialogTitle>A chat like this opens</DialogTitle>
            <DialogDescription>
              In your workspace, this starts a real chat with an agent.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p className="max-w-[85%] justify-self-end rounded-[14px] bg-surface-2 px-3 py-2 text-fg">
              {prompt}
            </p>
            <p className="max-w-[90%] text-fg">{ADD_TO_PRODUCT_FIRST_REPLY}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
