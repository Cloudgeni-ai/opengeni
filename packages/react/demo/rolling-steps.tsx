import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageTimeline, type ToolCallItem } from "@opengeni/react";
import "./styles.css";
const commands = [
  "rg --files src",
  "cat package.json",
  "bun run typecheck",
  "bun test",
  "git diff --stat",
];
function App() {
  const [step, setStep] = useState(0);
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => s + 1), 3200);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const items: ToolCallItem[] = commands
    .slice(0, (step % commands.length) + 1)
    .map((cmd, i, list) => ({
      kind: "tool-call",
      id: `tool-${Math.floor(step / commands.length)}-${i}`,
      turnId: "demo",
      callId: `call-${i}`,
      name: "exec_command",
      raw: undefined,
      arguments: { cmd },
      output: i === list.length - 1 ? undefined : "Completed successfully",
      status: i === list.length - 1 ? "running" : "complete",
      occurredAt: new Date(0).toISOString(),
    }));
  return (
    <main className="mx-auto max-w-3xl px-8 py-20">
      <div className="mb-12 flex items-center justify-between">
        <div>
          <p className="text-og-xs text-og-fg-subtle">OPENGENI / MOTION STUDY</p>
          <h1 className="mt-3 text-3xl text-og-fg">A quieter kind of progress.</h1>
        </div>
        <button onClick={() => setDark(!dark)}>Switch theme</button>
      </div>
      <p className="mb-10 text-og-fg-muted">One live line. All the detail, a click away.</p>
      <MessageTimeline items={items} turnSummary={{ rolling: true }} />
      <button className="mt-10 text-og-sm text-og-fg-subtle" onClick={() => setStep((s) => s + 1)}>
        Next activity ↗
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
