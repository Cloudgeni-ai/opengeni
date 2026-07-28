import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem } from "../src/index";
import "./styles.css";

type TimelineMergeHarness = {
  prependActivity: () => void;
};

declare global {
  interface Window {
    timelineMergeHarness?: TimelineMergeHarness;
  }
}

function reasoning(sequence: number): TimelineItem {
  return {
    kind: "reasoning",
    id: `reasoning-${sequence}`,
    turnId: "turn-merge",
    text: `reasoning-${sequence}`,
    streaming: false,
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
  };
}

function message(sequence: number): TimelineItem {
  return {
    kind: "user-message",
    id: `message-${sequence}`,
    text: `message-${sequence}`,
    resources: [],
    tools: [],
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
  };
}

function initialItems(): TimelineItem[] {
  return [
    ...Array.from({ length: 100 }, (_, index) => reasoning(index + 1)),
    ...Array.from({ length: 12 }, (_, index) => message(index + 1)),
  ];
}

function Harness() {
  const [items, setItems] = useState(initialItems);
  const prependActivity = useCallback(() => {
    flushSync(() => setItems((current) => [reasoning(0), ...current]));
  }, []);

  useEffect(() => {
    window.timelineMergeHarness = { prependActivity };
    return () => {
      delete window.timelineMergeHarness;
    };
  }, [prependActivity]);

  return (
    <main style={{ padding: 32 }} data-og-theme="light">
      <section style={{ margin: "0 auto", maxWidth: 900 }} data-timeline-merge-test>
        <MessageTimeline className="timeline-merge-test-shell" items={items} hasOlder />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
