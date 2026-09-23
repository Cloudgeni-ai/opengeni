import { Markdown, TurnSummary, type ToolCallItem } from "@opengeni/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@opengeni/react/compiled.css";

const step: ToolCallItem = {
  kind: "tool-call",
  id: "skill",
  turnId: "turn",
  callId: "skill",
  name: "skill_read",
  arguments: {},
  output: "Done",
  raw: undefined,
  status: "complete",
  occurredAt: "2026-09-14T13:00:00Z",
};
const source =
  "Here is the proposed screen.\n\n```opengeni-html\n<button>Preview content</button>\n";

function Harness() {
  const [state, setState] = useState("loading");
  return (
    <main
      className="og-root"
      data-og-theme="light"
      style={{ maxWidth: 800, margin: "48px auto", padding: 24 }}
    >
      <TurnSummary items={[step]}>Skill read — Done</TurnSummary>
      <Markdown
        streaming={state === "loading"}
        renderInteractiveBlock={(block) => (
          <section data-preview="ready">Ready: {block.kind}</section>
        )}
      >
        {source + (state === "ready" ? "```" : "")}
      </Markdown>
      <button onClick={() => setState("ready")}>Finish generation</button>{" "}
      <button onClick={() => setState("stopped")}>Stop generation</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
