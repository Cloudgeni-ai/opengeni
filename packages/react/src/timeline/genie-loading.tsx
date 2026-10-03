import { ThinkingOrb } from "thinking-orbs";
import { useThemeType } from "../lib/use-theme-type";
import { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "./genie-copy";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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

const PHRASES = GENIE_PREPARING_PHRASES;
const WAITING_PHRASES = GENIE_WAITING_PHRASES;

/** Decorative copy never substitutes for a failure or claims measurable progress. */
export function GenieLoading({
  startedAt,
  phase = "preparing",
  onShowDetails,
  detailsOpen = false,
}: {
  startedAt: string;
  phase?: GenieLoadingRenderProps["phase"];
  onShowDetails: () => void;
  detailsOpen?: boolean;
}) {
  const options = useContext(GenieLoadingOptionsContext);
  const waiting = phase === "waiting";
  const phrases = options?.phrases?.length ? options.phrases : waiting ? WAITING_PHRASES : PHRASES;
  const theme = useThemeType(undefined);
  const [phrase, setPhrase] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const update = () => {
      setShowDetails(Date.now() - Date.parse(startedAt) >= 15_000);
      setSlow(Date.now() - Date.parse(startedAt) >= 30_000);
      if (!document.hidden) setPhrase(Math.floor(Math.random() * phrases.length));
    };
    update();
    const timer = window.setInterval(update, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt, phrases]);
  if (options?.render) return options.render({ startedAt, phase, detailsOpen, onShowDetails });
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
          {slow
            ? (options?.messages?.slowStatus ??
              (waiting
                ? "Waiting for a response. Taking longer than usual."
                : "Preparing your task. Taking longer than usual."))
            : (options?.messages?.status ??
              (waiting ? "Waiting for a response." : "Preparing your task."))}
        </span>
        <span key={slow ? "slow" : phrase} className="og-genie-phrase" aria-hidden="true">
          {slow
            ? (options?.messages?.slowText ??
              (waiting ? "Still waiting for a response…" : "A little longer than usual…"))
            : phrases[phrase % phrases.length]}
        </span>
        {showDetails || detailsOpen ? (
          <button
            type="button"
            className="og-genie-details"
            aria-expanded={detailsOpen}
            onClick={onShowDetails}
          >
            {detailsOpen
              ? (options?.messages?.hideDetails ?? "Hide details")
              : (options?.messages?.showDetails ?? (waiting ? "Show details" : "Behind the magic"))}
            <span aria-hidden="true"> ↗</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
