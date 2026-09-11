import { ThinkingOrb } from "thinking-orbs";
import { useThemeType } from "../lib/use-theme-type";
import { useEffect, useState } from "react";

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
  const theme = useThemeType(undefined);
  const [phrase, setPhrase] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const update = () => {
      setShowDetails(Date.now() - Date.parse(startedAt) >= 15_000);
      setSlow(Date.now() - Date.parse(startedAt) >= 30_000);
      if (!document.hidden) setPhrase(Math.floor(Math.random() * PHRASES.length));
    };
    update();
    const timer = window.setInterval(update, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <div className="og-genie-loading">
      <div className="og-genie-orb" aria-hidden="true">
        <ThinkingOrb state="searching" size={64} theme={theme} speed={0.8} />
      </div>
      <div className="og-genie-copy">
        <span className="sr-only" role="status">
          {slow ? "Preparing your task. Taking longer than usual." : "Preparing your task."}
        </span>
        <span key={slow ? "slow" : phrase} className="og-genie-phrase" aria-hidden="true">
          {slow ? "A little longer than usual…" : PHRASES[phrase]}
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
