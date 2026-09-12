import { ThinkingOrb } from "thinking-orbs";
import { useThemeType } from "../lib/use-theme-type";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type GenieLoadingRenderProps = {
  startedAt: string;
  detailsOpen: boolean;
  onShowDetails: () => void;
};

export type GenieLoadingOptions = {
  /** Replace the visual while preserving SDK loading visibility and transitions. */
  render?: (props: GenieLoadingRenderProps) => ReactNode;
  phrases?: readonly string[];
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

const PHRASES = [
  "Polishing the lamp…",
  "Consulting the carpet…",
  "Untangling wishes…",
  "Summoning a little cleverness…",
  "Checking the fine print on infinity…",
  "Warming up the abracadabra…",
  "Rearranging the stars…",
  "Negotiating with the lamp…",
  "Dusting off a thousand years…",
  "Wishful thinking…",
  "Decanting a little magic…",
  "Finding the good stardust…",
  "Fluffing the magic carpet…",
  "Putting a wish into motion…",
  "A little hocus. A little pocus…",
];

/** Decorative copy never substitutes for a failure or claims measurable progress. */
export function GenieLoading({
  startedAt,
  onShowDetails,
  detailsOpen = false,
}: {
  startedAt: string;
  onShowDetails: () => void;
  detailsOpen?: boolean;
}) {
  const options = useContext(GenieLoadingOptionsContext);
  const phrases = options?.phrases?.length ? options.phrases : PHRASES;
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
  if (options?.render) return options.render({ startedAt, detailsOpen, onShowDetails });
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
          {slow ? "Preparing your task. Taking longer than usual." : "Preparing your task."}
        </span>
        <span key={slow ? "slow" : phrase} className="og-genie-phrase" aria-hidden="true">
          {slow ? "A little longer than usual…" : phrases[phrase % phrases.length]}
        </span>
        {showDetails || detailsOpen ? (
          <button
            type="button"
            className="og-genie-details"
            aria-expanded={detailsOpen}
            onClick={onShowDetails}
          >
            {detailsOpen ? "Hide details" : "Behind the magic"}
            <span aria-hidden="true"> ↗</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
