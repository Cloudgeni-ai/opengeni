import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "@opengeni/react";
import type { ReasoningEffort } from "@opengeni/sdk";
import { ModelPicker } from "../../../src/components/pickers";
import { BrandMark } from "../../../src/components/brand-mark";
import { galleryModelRows, idleComposer } from "../../../src/dev/composer-chrome-fixtures";
import "../../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
const rows = galleryModelRows.filter((row) =>
  ["gpt-5.6-sol", "codex/gpt-6-astra"].includes(row.id) || row.catalog.cost === "free",
);

function Preview() {
  const [model, setModel] = useState(
    params.get("selected") === "free"
      ? rows.find((row) => row.catalog.cost === "free")!.id
      : "gpt-5.6-sol",
  );
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [value, setValue] = useState("Summarize this week's progress.");
  return (
    <main className="flex min-h-dvh flex-col bg-bg px-6 py-8 text-fg">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <BrandMark className="w-6" />
        <div>
          <h1 className="text-lg font-semibold">Console model picker</h1>
          <p className="text-xs text-fg-muted">Sample data · production components · no model calls</p>
        </div>
      </header>
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center py-8">
        <ChatComposer
          composer={idleComposer({ value, setValue, hasDraftContent: () => value.length > 0 })}
          controlsStart={
            <ModelPicker
              rows={rows}
              model={model}
              effort={effort}
              latencyMode="standard"
              onModelChange={setModel}
              onEffortChange={setEffort}
              onLatencyModeChange={() => {}}
            />
          }
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);