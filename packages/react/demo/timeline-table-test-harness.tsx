import { MessageTimeline, type TimelineItem } from "@opengeni/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Load only one consumer stylesheet: compiled mode must not be rescued by the
// demo's Tailwind source scanning. Both run from the production Vite graph.
if (new URLSearchParams(location.search).has("compiled")) {
  await import("@opengeni/react/compiled.css");
} else {
  await import("./styles.css");
}

const small = "| Small | Value |\n| --- | --- |\n| Alpha | Beta |";
const wide = [
  "| Wide | Deployment region | Monthly allocation | Availability target | Primary maintainer | Recovery objective |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Production | Northern Europe region | Reserved monthly allocation | Regional availability target | Infrastructure operations team | Documented recovery objective |",
].join("\n");
const oversized = `| Oversized | Value |\n| --- | --- |\n| ${"Unbreakable".repeat(80)} | Beta |`;
const baseline = [
  "Ordinary assistant prose stays in the readable text column before and after a wide table.",
  wide,
  "Prose after the table retains the same left and right edges.",
  small,
  wide
    .replaceAll("Wide", "Quoted")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n"),
  `- Nested list table\n\n${wide
    .replaceAll("Wide", "Listed")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}`,
  `\`\`\`text\n${"code stays prose width ".repeat(12)}\n\`\`\``,
  oversized,
].join("\n\n");

type TableContent = "baseline" | "small" | "wide" | "oversized";
declare global {
  interface Window {
    timelineTableHarness?: {
      content: (value: TableContent) => void;
      panel: (width: number | null) => void;
    };
  }
}

function Harness() {
  const [content, setContent] = useState<TableContent>("baseline");
  const [panel, setPanel] = useState<number | null>(null);
  useEffect(() => {
    window.timelineTableHarness = { content: setContent, panel: setPanel };
    return () => {
      delete window.timelineTableHarness;
    };
  }, []);
  const items: TimelineItem[] = [
    {
      kind: "user-message",
      id: "user",
      text: "User bubble remains in the prose column.",
      resources: [],
      tools: [],
      occurredAt: "2026-01-01T00:00:00.000Z",
    },
    {
      kind: "agent-message",
      id: "assistant",
      turnId: "table-turn",
      text: { baseline, small, wide, oversized }[content],
      streaming: content !== "baseline",
      occurredAt: "2026-01-01T00:00:01.000Z",
    },
  ];
  return (
    <main
      data-og-theme="light"
      style={{ padding: "0 12px", display: "flex", justifyContent: "flex-end" }}
    >
      <section data-table-panel style={{ width: panel ?? "100%", maxWidth: "100%", minWidth: 0 }}>
        <MessageTimeline className="table-test-shell" items={items} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
