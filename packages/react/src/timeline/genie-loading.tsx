import { ThinkingOrb } from "thinking-orbs";
import { useThemeType } from "../lib/use-theme-type";
import { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "./genie-copy";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

export type GenieLoadingRenderProps = {
  startedAt: string;
  phase: "preparing" | "waiting";
  detailsOpen: boolean;
  onShowDetails: () => void;
};

export type GenieLoadingOptions = {
  /** Replace the visual while preserving SDK loading visibility and transitions. */
  render?: (props: GenieLoadingRenderProps) => ReactNode;
  phrases?: readonly string[];
  /** Native copy overrides. Omitted messages retain the default English copy. */
  messages?: {
    status?: string;
    slowStatus?: string;
    slowText?: string;
    showDetails?: string;
    hideDetails?: string;
  };
  /** Public adapter options; the renderer dependency's declarations stay private. */
  orb?: {
    state?:
      | "working"
      | "searching"
      | "solving"
      | "listening"
      | "connecting"
      | "weaving"
      | "composing"
      | "breathing"
      | "shaping";
    size?: 64 | 20;
    speed?: number;
  };
};
export const GenieLoadingOptionsContext = createContext<GenieLoadingOptions | undefined>(undefined);

/**
 * Neutral defaults for conversations embedded in another product
 * (`SessionConversation`, `OpenGeniChat`), which should not carry Opengeni's
 * own playful copy. The Opengeni app keeps the defaults above.
 */
export const EMBEDDED_GENIE_LOADING = (t: OpenGeniText) =>
  ({
    phrases: [t("timeline.genieLoading.thinking")],
    messages: { showDetails: t("timeline.genieLoading.showDetails") },
  }) as const satisfies GenieLoadingOptions;

/** Decorative copy never substitutes for a failure or claims measurable progress. */
export function GenieLoading({
  startedAt,
  phase = "preparing",
  onShowDetails,
  detailsOpen = false,
  notice,
}: {
  startedAt: string;
  phase?: GenieLoadingRenderProps["phase"];
  onShowDetails: () => void;
  detailsOpen?: boolean;
  /** An actionable startup problem takes precedence over decorative copy. */
  notice?: string | undefined;
}) {
  const t = useOpenGeniText();
  const options = useContext(GenieLoadingOptionsContext);
  const waiting = phase === "waiting";
  const phrases = options?.phrases?.length
    ? options.phrases
    : waiting
      ? GENIE_WAITING_PHRASES(t)
      : GENIE_PREPARING_PHRASES(t);
  const theme = useThemeType(undefined);
  const [phrase, setPhrase] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [slow, setSlow] = useState(false);
  // Only the number of phrases matters to the rotation. The phrase list is a
  // fresh array on every render (translated text, or an inline host option),
  // so depending on its identity would restart the timer and re-pick a phrase
  // after every render, chaining renders until the random pick repeats.
  const phraseCount = phrases.length;
  useEffect(() => {
    const update = () => {
      setShowDetails(Date.now() - Date.parse(startedAt) >= 30_000);
      setSlow(Date.now() - Date.parse(startedAt) >= 60_000);
      if (!document.hidden) setPhrase(Math.floor(Math.random() * phraseCount));
    };
    update();
    const timer = window.setInterval(update, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt, phraseCount]);
  if (options?.render && !notice)
    return options.render({ startedAt, phase, detailsOpen, onShowDetails });
  return (
    <div className="og-genie-loading">
      <div
        className="og-genie-orb"
        aria-hidden="true"
        style={{
          width: options?.orb?.size ?? 64,
          height: options?.orb?.size ?? 64,
          flexBasis: options?.orb?.size ?? 64,
        }}
      >
        <ThinkingOrb state="searching" size={64} theme={theme} speed={0.8} {...options?.orb} />
      </div>
      <div className="og-genie-copy">
        <span className="sr-only" role="status">
          {notice ??
            (slow
              ? (options?.messages?.slowStatus ??
                (waiting
                  ? t("timeline.genieLoading.waitingForAResponseTaking")
                  : t("timeline.genieLoading.preparingYourTaskTakingLonger")))
              : (options?.messages?.status ??
                (waiting
                  ? t("timeline.genieLoading.waitingForAResponse")
                  : t("timeline.genieLoading.preparingYourTask"))))}
        </span>
        <span
          key={notice ?? (slow ? "slow" : phrase)}
          className="og-genie-phrase"
          style={notice ? { animation: "none" } : undefined}
          aria-hidden="true"
        >
          {notice ??
            (slow
              ? (options?.messages?.slowText ??
                (waiting
                  ? t("timeline.genieLoading.stillWaitingForAResponse")
                  : t("timeline.genieLoading.aLittleLongerThanUsual")))
              : phrases[phrase % phrases.length])}
        </span>
        {showDetails || detailsOpen || notice ? (
          <button
            type="button"
            className="og-genie-details"
            aria-expanded={detailsOpen}
            onClick={onShowDetails}
          >
            {detailsOpen
              ? (options?.messages?.hideDetails ?? t("timeline.genieLoading.hideDetails"))
              : (options?.messages?.showDetails ??
                (waiting
                  ? t("timeline.genieLoading.showDetails")
                  : t("timeline.genieLoading.behindTheMagic")))}
            <span aria-hidden="true"> ↗</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
