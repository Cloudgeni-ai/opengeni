import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import type { TerminalChunk, UseSandboxTerminalResult } from "../src/hooks/use-sandbox-terminal";
import "./styles.css";

/* ----------------------------------------------------------------------------
   M6 terminal harness (static, fixture-driven) — the overhauled <SandboxTerminal>
   in every state the review passes + the real-browser evidence probes need.
   Driven by query params so Playwright can select a state:
     ?view=idle | booting | handoff | burst
     &theme=dark|light
     &fail=webgl | webgl,canvas   (force the renderer fallback ladder)

   Read/writes to the terminal go through the debug seam the component exposes on
   `window.__OG_TERMINAL_DEBUG__` — the harness stashes the live term + info on
   `window.__ogTerm` / `window.__ogTermInfo` for the evidence script.
   -------------------------------------------------------------------------- */

const ESC = "\x1b[";
const R = `${ESC}0m`;

/** A colorful transcript that exercises the full ANSI-16 palette, bold/dim, and
 *  a git-status-shaped block — so the themed screenshots show real color. */
function transcriptChunks(): TerminalChunk[] {
  const lines: string[] = [];
  lines.push(`${ESC}2m$ ${R}${ESC}1mgit${R} status`);
  lines.push(`On branch ${ESC}32mfeat/workbench-v2${R}`);
  lines.push(`Changes to be committed:`);
  lines.push(`  ${ESC}32mmodified:   packages/react/src/components/sandbox-terminal.tsx${R}`);
  lines.push(`  ${ESC}32mnew file:   packages/react/src/lib/xterm-renderer.ts${R}`);
  lines.push(`Changes not staged for commit:`);
  lines.push(`  ${ESC}31mmodified:   packages/react/src/lib/xterm-theme.ts${R}`);
  lines.push(`  ${ESC}31mdeleted:    demo/old-terminal.tsx${R}`);
  lines.push("");
  lines.push(`${ESC}2m$ ${R}${ESC}1mls${R} --color`);
  lines.push(`${ESC}34msrc${R}  ${ESC}34mtest${R}  ${ESC}36mREADME.md${R}  ${ESC}33mpackage.json${R}  ${ESC}35mtsconfig.json${R}`);
  lines.push("");
  // 16-color chart — normal row then bright row.
  const chart = (base: number) =>
    Array.from({ length: 8 }, (_, i) => `${ESC}${base + i}m ${(base + i) % 10} ${R}`).join("");
  lines.push(`${ESC}1mANSI:${R} ${chart(30)}`);
  lines.push(`${ESC}1mbold:${R} ${chart(90)}`);
  lines.push("");
  lines.push(`${ESC}2m$ ${R}echo ${ESC}33m"warming complete — interactive shell ready"${R}`);
  lines.push(`warming complete — interactive shell ready`);
  lines.push(`${ESC}2m$ ${R}${ESC}5m▊${R}`);
  return lines.map((text, i) => ({ id: `c${i}`, text: `${text}\r\n`, stream: "stdout" as const, seq: i }));
}

function makeResult(overrides: Partial<UseSandboxTerminalResult> = {}): UseSandboxTerminalResult {
  return {
    chunks: [],
    running: true,
    write: null,
    activePtyId: null,
    close: () => {},
    error: null,
    ...overrides,
  };
}

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "idle";
const theme = params.get("theme") === "light" ? "light" : "dark";
const fail = params.get("fail");

// Force the renderer fallback ladder BEFORE the component mounts (E1 proof).
if (fail) (globalThis as { __OG_FORCE_RENDERER_FAIL__?: string }).__OG_FORCE_RENDERER_FAIL__ = fail;

// Stash the live terminal for the evidence script.
(globalThis as Record<string, unknown>).__OG_TERMINAL_DEBUG__ = (info: unknown) => {
  const w = globalThis as Record<string, unknown>;
  w.__ogTermInfo = info;
  w.__ogTerm = (info as { term?: unknown }).term;
  w.__ogReady = true;
};

function App() {
  // For the handoff view we start read-only (firehose) then flip to interactive
  // (write fn) WITHOUT remounting — proving screen preservation (E5). Toggled by
  // the evidence script via `window.__ogFlipInteractive()`.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => {
    (globalThis as Record<string, unknown>).__ogFlipInteractive = () => setInteractive(true);
  }, []);

  let result: UseSandboxTerminalResult;
  let liveness: string | undefined;

  switch (view) {
    case "booting":
      // Empty screen + not-warm box → boot-in-terminal status lines after focus.
      result = makeResult({ chunks: [], running: false });
      liveness = "warming";
      break;
    case "handoff":
      result = makeResult({
        chunks: transcriptChunks(),
        write: interactive ? () => {} : null,
      });
      liveness = "warm";
      break;
    case "burst":
      result = makeResult({ chunks: [], running: true });
      liveness = "warm";
      break;
    default: // idle
      result = makeResult({ chunks: transcriptChunks() });
      liveness = "warm";
  }

  return (
    <div
      className="og-root h-dvh bg-og-bg p-4"
      data-og-theme={theme === "light" ? "light" : undefined}
    >
      <div className="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-bg shadow-og-md">
        <SandboxTerminal
          result={result}
          liveness={liveness}
          showHeader
          shell="/bin/bash"
          onActivate={() => {
            (globalThis as Record<string, unknown>).__ogActivated = true;
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
