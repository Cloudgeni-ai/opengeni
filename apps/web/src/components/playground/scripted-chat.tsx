import { MessageTimeline } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { CirclePlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACME_EXCHANGES,
  exchangeTimeline,
  type ExchangeId,
} from "@/components/playground/acme-script";

const DEMO_WORKSPACE = "00000000-0000-4000-8000-00000000ac3e";
const DEMO_SESSION = "00000000-0000-4000-8000-00000000c4a7";

export type ScriptedChat = Readonly<{
  events: SessionEvent[];
  /** The exchange playing now. */
  playing: ExchangeId | null;
  /** Everything asked in this playground, in order. */
  asked: readonly ExchangeId[];
  play: (id: ExchangeId) => void;
  /** Starts a fresh chat (memory, like the real product, carries over). */
  newChat: () => void;
}>;

/**
 * Plays the recorded conversation: each question's session events arrive on
 * the timing a quick model would have, into the real timeline. Nothing calls
 * a model or creates a session.
 */
export function useScriptedChat({
  onFinished,
}: {
  /** An exchange finished playing (its turn completed). */
  onFinished?: (id: ExchangeId) => void;
} = {}): ScriptedChat {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [playing, setPlaying] = useState<ExchangeId | null>(null);
  const [asked, setAsked] = useState<ExchangeId[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const sequence = useRef(0);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const stop = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);
  useEffect(() => stop, [stop]);

  const play = useCallback(
    (id: ExchangeId) => {
      stop();
      if (ACME_EXCHANGES[id].freshChat) {
        sequence.current = 0;
        setEvents([]);
      }
      const started = Date.now();
      const turnId = `turn-${id}-${started}`;
      setPlaying(id);
      setAsked((current) => (current.includes(id) ? current : [...current, id]));
      for (const timed of exchangeTimeline(ACME_EXCHANGES[id], turnId)) {
        timers.current.push(
          setTimeout(() => {
            sequence.current += 1;
            const index = sequence.current;
            const event = {
              // A chat that opens with the question uses the accepted-create
              // id, so the timeline paints it at once.
              id: index === 1 ? "c" : `demo-${started}-${index}`,
              workspaceId: DEMO_WORKSPACE,
              sessionId: DEMO_SESSION,
              sequence: index,
              type: timed.type,
              payload: timed.payload,
              occurredAt: new Date(started + timed.afterMs).toISOString(),
              turnId: timed.turnId,
            } as SessionEvent;
            setEvents((current) => [...current, event]);
            if (timed.type === "turn.completed") {
              setPlaying(null);
              finished.current?.(id);
            }
          }, timed.afterMs),
        );
      }
    },
    [stop],
  );

  const newChat = useCallback(() => {
    stop();
    sequence.current = 0;
    setEvents([]);
    setPlaying(null);
  }, [stop]);

  return { events, playing, asked, play, newChat };
}

/**
 * The recorded support chat: the real `@opengeni/react` timeline over the
 * script, and suggested questions in place of a composer. It says plainly
 * that it is a recording.
 */
export function ScriptedChatView({
  chat,
  firstName,
  questions,
  finished = false,
}: {
  chat: ScriptedChat;
  firstName: string;
  /** The questions to offer now. */
  questions: readonly ExchangeId[];
  /** Nothing is left to ask (outside the tour): say how to replay. */
  finished?: boolean;
}) {
  const empty = chat.events.length === 0;
  const choices = (
    <div className="acme-suggestions" role="group" aria-label="Suggested questions">
      {questions.map((id) => (
        <button
          key={id}
          type="button"
          disabled={chat.playing !== null}
          onClick={() => chat.play(id)}
        >
          {ACME_EXCHANGES[id].question}
        </button>
      ))}
    </div>
  );
  return (
    <>
      {empty ? (
        <div className="acme-starter">
          <div className="acme-starter-hello">
            <h2>Hi {firstName}, how can we help?</h2>
            <p>Ask about orders, billing or your account.</p>
          </div>
          <div data-tour="composer" className="acme-ask">
            {choices}
          </div>
        </div>
      ) : (
        <>
          <div className="acme-thread" data-og-conversation="">
            <MessageTimeline
              events={chat.events}
              status={chat.playing ? "running" : "idle"}
              autoFollow
              emptyState={null}
            />
          </div>
          <div data-tour="composer" className="acme-ask">
            {questions.length > 0 ? (
              choices
            ) : finished && chat.playing === null ? (
              <p className="acme-ask-done">
                That's the whole recording. Start a new chat to replay it.
              </p>
            ) : null}
          </div>
        </>
      )}
      <p className="acme-demo-label">
        <CirclePlayIcon aria-hidden="true" />
        This is a recorded demo. Pick a question to see how the agent answers.
      </p>
    </>
  );
}
