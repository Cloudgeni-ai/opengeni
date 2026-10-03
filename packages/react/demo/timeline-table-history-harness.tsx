import { ApprovalSurface, Markdown, MessageTimeline, type TimelineItem } from "@opengeni/react";
import { useEffect, useState } from "react";

// Synthetic, browser-only history. No client, authentication or model calls.
const table = [
  "| Inspection item | Owner | Status |",
  "| --- | --- | --- |",
  ...Array.from(
    { length: 18 },
    (_, i) =>
      `| Checkpoint ${i + 1}: inspect the junction between the external wall and roof covering | Site coordinator | Needs follow-up |`,
  ),
].join("\n");
const time = "2026-01-01T00:00:00Z";
const text = (index: number) =>
  `## Inspection round ${index + 1}\n\nSynthetic dense history for a reading-position test.\n\n${table}`;
const items: TimelineItem[] = Array.from({ length: 8 }, (_, i): TimelineItem[] => [
  {
    kind: "user-message",
    id: `u${i}`,
    text: `Show inspection round ${i + 1}.`,
    resources: [],
    tools: [],
    occurredAt: time,
  },
  {
    kind: "agent-message",
    id: `a${i}`,
    turnId: `t${i}`,
    text: text(i),
    streaming: false,
    occurredAt: time,
  },
  {
    kind: "turn-end",
    id: `e${i}`,
    turnId: `t${i}`,
    outcome: "complete",
    failureText: null,
    occurredAt: time,
  },
]).flat();
const stableCallback = async () => {};
const events: [] = [];
const summary = { rolling: true };

declare global {
  interface Window {
    tableHistoryHarness?: {
      rerender: () => void;
      stream: (index?: number) => void;
      approval: () => void;
    };
  }
}

export function TableHistoryHarness() {
  const [revision, setRevision] = useState(0);
  const [streamIndex, setStreamIndex] = useState<number | null>(null);
  const [approval, setApproval] = useState(false);
  const [draft, setDraft] = useState("");
  const query = new URLSearchParams(location.search);
  const bare = query.has("bare");
  const onFile = query.has("stable") ? stableCallback : async () => {};
  useEffect(() => {
    window.tableHistoryHarness = {
      rerender: () => setRevision((value) => value + 1),
      stream: (index = 7) => {
        setStreamIndex(index);
        setRevision((value) => value + 1);
      },
      approval: () => setApproval(true),
    };
    return () => {
      delete window.tableHistoryHarness;
    };
  }, []);
  const tail = `\n\nA new synthetic progress update ${revision}.`;
  const current = items.map((item) =>
    item.kind === "agent-message" && item.id === `a${streamIndex}`
      ? { ...item, text: item.text + tail, streaming: true }
      : item,
  );
  return (
    <div
      className="og-root"
      style={{
        height: "100dvh",
        width: "min(100vw,419px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ height: 56, flexShrink: 0 }}>Synthetic table history</header>
      <div
        style={{
          position: "relative",
          minHeight: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {bare ? (
          <div
            data-og-timeline-scroller=""
            style={{ overflowY: "auto", padding: 24, flex: 1, minHeight: 0 }}
          >
            <div data-og-wide-table-message="">
              <Markdown onSandboxFile={onFile}>
                {Array.from(
                  { length: 8 },
                  (_, i) => text(i) + (i === streamIndex ? tail : ""),
                ).join("\n\n")}
              </Markdown>
            </div>
          </div>
        ) : (
          <MessageTimeline
            items={current}
            events={events}
            status={streamIndex === null ? "idle" : "running"}
            turnSummary={summary}
            renderMessageText={(value, item) => (
              <Markdown
                onSandboxFile={onFile}
                streaming={item.kind === "agent-message" && item.streaming}
              >
                {value}
              </Markdown>
            )}
          />
        )}
        {approval && (
          <div style={{ position: "absolute", bottom: 12, left: 16, right: 16 }}>
            <ApprovalSurface
              approvals={[
                {
                  id: "sample-approval",
                  name: "sample.update",
                  arguments: { name: "Synthetic item" },
                },
              ]}
              onApprove={stableCallback}
              onReject={stableCallback}
            />
          </div>
        )}
      </div>
      <footer style={{ height: 100, flexShrink: 0 }}>
        <label>
          Draft
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
      </footer>
    </div>
  );
}
