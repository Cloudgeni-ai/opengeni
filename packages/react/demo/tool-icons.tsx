import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline, type ToolCallItem } from "@opengeni/react";
import "./styles.css";

// One finished turn that touches most first-party tool families, so every row's
// icon can be reviewed together in both themes.
const names = [
  "interaction__browser_open",
  "interaction__browser_observe",
  "interaction__browser_act",
  "interaction__browser_screenshot",
  "interaction__computer_open",
  "interaction__computer_act",
  "opengeni__excel_run",
  "web_search_call",
  "exec_command",
  "apply_patch",
  "view_image",
  "skill_read",
  "knowledge_search",
  "opengeni__goal_set",
  "opengeni__wait_for_input",
  "request_human_input",
  "opengeni__session_create",
  "secret_search",
  "tool_search",
  "scheduled_tasks_create",
  "artifacts_create_document",
  "sandbox_file_publish",
  "generate_image",
  "notify_user",
  "some_connector_tool",
];

const query = new URLSearchParams(location.search);

function App() {
  const [dark, setDark] = useState(query.get("theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const items: ToolCallItem[] = names.map((name, i) => ({
    kind: "tool-call",
    id: `tool-${i}`,
    turnId: "demo",
    callId: `call-${i}`,
    name,
    raw: undefined,
    arguments: name === "exec_command" ? { cmd: "bun test" } : {},
    output: "ok",
    status: "complete",
    occurredAt: new Date(0).toISOString(),
  }));
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <button className="mb-6 text-og-sm text-og-fg-subtle" onClick={() => setDark(!dark)}>
        Switch theme
      </button>
      <MessageTimeline items={items} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
