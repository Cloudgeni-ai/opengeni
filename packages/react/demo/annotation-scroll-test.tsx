import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { TimelineAnnotationsChip } from "../src/components/timeline-annotations";
import "./styles.css";

const initialAnnotations: DraftTimelineAnnotation[] = Array.from({ length: 12 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ordinal: index + 1,
  quote: `Synthetic quoted source ${index + 1}`,
  note: Array.from(
    { length: 24 },
    (_line, line) => `Note ${index + 1}, line ${line + 1}: preserve this detail.`,
  ).join("\n"),
  source: {
    kind: "assistant_message",
    eventId: "00000000-0000-4000-8000-000000000100",
    eventType: "agent.message.completed",
    sequence: 1,
    turnId: null,
    startOffset: 0,
    endOffset: 10,
    contextBefore: "",
    contextAfter: "",
  },
}));

function Harness() {
  const [annotations, setAnnotations] = useState(
    initialAnnotations.slice(0, Number(new URLSearchParams(location.search).get("count") ?? 12)),
  );
  const [revision, setRevision] = useState(0);
  return (
    <main className="og-root h-screen bg-og-bg p-6 text-og-fg" data-revision={revision}>
      <h1 className="text-og-lg font-semibold">Annotation scroll regression</h1>
      <p className="mt-2 text-og-sm text-og-fg-muted">
        12 synthetic annotations, each with a long editable note.
      </p>
      <button type="button" className="mt-3" onClick={() => setRevision((value) => value + 1)}>
        Refresh parent
      </button>
      <div className="fixed bottom-6 left-6">
        <TimelineAnnotationsChip
          annotations={annotations}
          focusAnnotationId={
            new URLSearchParams(location.search).get("focus") ? annotations[0]?.id : undefined
          }
          onFocusConsumed={
            new URLSearchParams(location.search).get("focus") ? () => undefined : undefined
          }
          editable
          onUpdate={(id, note) =>
            setAnnotations((items) =>
              items.map((item) => (item.id === id ? { ...item, note } : item)),
            )
          }
          onRemove={(id) => setAnnotations((items) => items.filter((item) => item.id !== id))}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
