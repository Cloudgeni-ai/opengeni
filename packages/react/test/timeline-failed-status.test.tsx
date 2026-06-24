import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, flush } from "./render-hook";
import {
  defaultToolRegistry,
  ActivityRail,
  type ToolCallItem,
  type WorkerItem,
  type SandboxItem,
} from "../src/timeline";

/* ----------------------------------------------------------------------------
   Failed-status structural guard + explicit regression tests.

   STRUCTURAL GUARD: Every renderer in the default registry must surface the
   "failed" affordance when given a failed item. The affordance is the "failed"
   chip text (from ActivityDisclosure's `failed` prop) OR a chip/icon tone that
   signals failure (we detect "failed" as text in the rendered output, which the
   bad-chip always emits).

   EXPLICIT TESTS: The two flagged renderers (WorkerRow + ComputerCallRenderer)
   get precise assertions to pin the exact behavioral contract.

   HOW THE GUARD WORKS: ActivityDisclosure, when `failed={true}` (and no
   explicit chip is supplied), injects a chip with text "failed". When a renderer
   supplies its own explicit chip (e.g. ExecRenderer's "exit N", or GenericRenderer's
   "error"), that chip wins and "failed" text does NOT appear — but some failure
   word does. We therefore look for "fail" (substring-insensitive) which covers:
     • "failed" chip text from ActivityDisclosure
     • "error" chip from GenericRenderer
     • "exit N" chip from ExecRenderer still has `failed` prop set so output
       contains "failed" in the tool-call-failed + NUL branch text
     • explicit text in renderer copy ("output contained a NUL byte", "failed")
   -------------------------------------------------------------------------- */

registerDom();

function toolItem(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tc-1",
    turnId: "turn-1",
    callId: "call-1",
    name: "exec_command",
    arguments: {},
    output: undefined,
    raw: undefined,
    status: "failed",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function workerItem(overrides: Partial<WorkerItem>): WorkerItem {
  return {
    kind: "worker",
    id: "w-1",
    turnId: "turn-1",
    callId: "call-1",
    action: "spawn",
    prompt: "do something",
    workerSessionId: "sess-abc123",
    status: "failed",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function sandboxItem(overrides: Partial<SandboxItem> = {}): SandboxItem {
  return {
    kind: "sandbox",
    id: "sb-1",
    turnId: "turn-1",
    name: "exec",
    command: "terraform apply",
    output: "",
    status: "failed",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/* ============================================================================
   STRUCTURAL GUARD — table-driven: every renderer, every named tool
   ============================================================================ */

/**
 * Each entry: a description, the item to render, and whether to use the
 * ActivityRail (for non-tool-call items like WorkerRow / SandboxRow).
 */
type Case =
  | { label: string; kind: "tool"; item: ToolCallItem }
  | { label: string; kind: "rail-worker"; item: WorkerItem }
  | { label: string; kind: "rail-sandbox"; item: SandboxItem };

const CASES: Case[] = [
  /* ---- tool-call renderers ------------------------------------------------ */
  {
    label: "ExecRenderer — failed + undefined output (NUL path)",
    kind: "tool",
    item: toolItem({ name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), output: undefined }),
  },
  {
    label: "ExecRenderer — failed + empty output (generic path)",
    kind: "tool",
    item: toolItem({ name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), output: "" }),
  },
  {
    label: "ExecRenderer — failed + non-empty output",
    kind: "tool",
    item: toolItem({ name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), output: "build failed" }),
  },
  {
    label: "WriteStdinRenderer — failed",
    kind: "tool",
    item: toolItem({ name: "write_stdin", arguments: JSON.stringify({ session_id: "s1", chars: "ls\n" }), output: "" }),
  },
  {
    label: "ApplyPatchRenderer — failed (explicit failed branch)",
    kind: "tool",
    item: toolItem({
      name: "apply_patch_call",
      raw: { type: "apply_patch_call", operations: [{ type: "update_file", path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] },
      output: "patch conflict",
    }),
  },
  {
    label: "WebSearchRenderer — failed",
    kind: "tool",
    item: toolItem({
      name: "web_search_call",
      raw: { providerData: { action: { query: "test query" } } },
      output: null,
    }),
  },
  {
    label: "ComputerCallRenderer — failed + isImage output",
    kind: "tool",
    item: toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "data:image/png;base64,abc",
    }),
  },
  {
    label: "ComputerCallRenderer — failed + empty output",
    kind: "tool",
    item: toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "",
    }),
  },
  {
    label: "ComputerCallRenderer — failed + non-image non-empty output (click path)",
    kind: "tool",
    item: toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "click", x: 10, y: 20 } },
      output: "some text output",
    }),
  },
  {
    label: "ViewImageRenderer — failed + data: output",
    kind: "tool",
    item: toolItem({
      name: "view_image",
      arguments: JSON.stringify({ path: "/tmp/img.png" }),
      output: "data:image/png;base64,abc",
    }),
  },
  {
    label: "ViewImageRenderer — failed + No image data output",
    kind: "tool",
    item: toolItem({
      name: "view_image",
      arguments: JSON.stringify({ path: "/tmp/img.png" }),
      output: "No image data returned",
    }),
  },
  {
    label: "ViewImageRenderer — failed + OpenAI file reference output",
    kind: "tool",
    item: toolItem({
      name: "view_image",
      arguments: JSON.stringify({ path: "/tmp/img.png" }),
      output: "OpenAI file reference: file-abc123",
    }),
  },
  {
    label: "SecretSetRenderer — failed",
    kind: "tool",
    item: toolItem({
      name: "environment_set_variable",
      arguments: JSON.stringify({ name: "MY_VAR", value: "secret" }),
      output: "permission denied",
    }),
  },
  {
    label: "GenericRenderer (fallback) — failed",
    kind: "tool",
    item: toolItem({ name: "some_mcp_tool", arguments: JSON.stringify({ foo: "bar" }), output: "tool error" }),
  },
  /* ---- non-tool rail rows ------------------------------------------------- */
  {
    label: "WorkerRow — failed spawn",
    kind: "rail-worker",
    item: workerItem({ action: "spawn" }),
  },
  {
    label: "WorkerRow — failed message",
    kind: "rail-worker",
    item: workerItem({ action: "message" }),
  },
  {
    label: "SandboxRow — failed",
    kind: "rail-sandbox",
    item: sandboxItem(),
  },
];

/**
 * Detect the failed affordance in a rendered container.
 *
 * Two signals qualify:
 *   1. Text: "failed", "fail", or "error" in the text content (covers the chip,
 *      error copy, NUL copy, GenericRenderer "error" chip).
 *   2. CSS class `text-og-status-failed` on any element in the tree (covers
 *      rows where the media thumbnail wins the gutter slot so the chip text is
 *      suppressed, but the icon tone is still red — e.g. ComputerCallRenderer
 *      with isImage or empty output).
 */
function hasFailedAffordance(container: HTMLElement): boolean {
  const text = container.textContent ?? "";
  if (/fail|error/i.test(text)) {
    return true;
  }
  // Check for the failed-tone CSS class on any element.
  return container.querySelector(".text-og-status-failed") !== null;
}

describe("Structural guard — every renderer surfaces failure affordance on failed status", () => {
  for (const c of CASES) {
    test(c.label, async () => {
      if (c.kind === "tool") {
        const Renderer = defaultToolRegistry.resolve(c.item);
        const r = await renderComponent(<Renderer item={c.item} />);
        await flush();
        expect(hasFailedAffordance(r.container)).toBe(true);
        await r.unmount();
      } else if (c.kind === "rail-worker") {
        const r = await renderComponent(<ActivityRail items={[c.item]} />);
        await flush();
        expect(hasFailedAffordance(r.container)).toBe(true);
        await r.unmount();
      } else {
        const r = await renderComponent(<ActivityRail items={[c.item]} />);
        await flush();
        expect(hasFailedAffordance(r.container)).toBe(true);
        await r.unmount();
      }
    });
  }
});

/* ============================================================================
   EXPLICIT TESTS for the two flagged fixes
   ============================================================================ */

/* ---- Fix 1: WorkerRow — failed status ------------------------------------- */

describe("WorkerRow — failed status (flagged fix)", () => {
  test("failed spawn: shows 'spawn failed' title copy, not success copy", async () => {
    const item = workerItem({ action: "spawn" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must NOT show the success copy.
    expect(text).not.toContain("Worker spawned");
    // Must show failure copy.
    expect(text.toLowerCase()).toContain("fail");
    await r.unmount();
  });

  test("failed message: shows 'message failed' title copy, not success copy", async () => {
    const item = workerItem({ action: "message" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text).not.toContain("Worker messaged");
    expect(text.toLowerCase()).toContain("fail");
    await r.unmount();
  });

  test("failed spawn: shows the failed chip signal in the gutter", async () => {
    const item = workerItem({ action: "spawn" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    // The failed chip text ("failed") must be present.
    expect(text.toLowerCase()).toContain("failed");
    await r.unmount();
  });

  test("running spawn still shows shimmer title and NOT failure copy (regression guard)", async () => {
    const item = workerItem({ action: "spawn", status: "running" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text).toContain("Spawning worker");
    expect(text).not.toContain("failed");
    await r.unmount();
  });

  test("complete spawn still shows 'Worker spawned' (regression guard)", async () => {
    const item = workerItem({ action: "spawn", status: "complete" });
    const r = await renderComponent(<ActivityRail items={[item]} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text).toContain("Worker spawned");
    expect(text).not.toContain("failed");
    await r.unmount();
  });
});

/* ---- Fix 2: ComputerCallRenderer — failed status -------------------------- */

describe("ComputerCallRenderer — failed status (flagged fix)", () => {
  test("failed with image output: shows failed affordance alongside the screenshot", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "data:image/png;base64,abc123",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // When media is present the chip slot is taken by the thumbnail, so we
    // detect the failed icon tone class as the affordance signal.
    expect(hasFailedAffordance(r.container)).toBe(true);
    await r.unmount();
  });

  test("failed with empty output: shows failed affordance", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // MediaEmpty takes the gutter slot; detect via icon tone class or chip text.
    expect(hasFailedAffordance(r.container)).toBe(true);
    await r.unmount();
  });

  test("failed with empty output: shows failure note in body on expand", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand the row.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("fail");
    await r.unmount();
  });

  test("failed non-screenshot click: shows failed affordance (not success 'accent' path)", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "click", x: 100, y: 200 } },
      output: "some text",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("fail");
    await r.unmount();
  });

  test("complete computer_call with image does NOT show failed affordance (regression guard)", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "screenshot" } },
      output: "data:image/png;base64,abc123",
      status: "complete",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("fail");
    await r.unmount();
  });
});

/* ---- Regression: read-only and rejected paths are unaffected -------------- */

describe("ComputerCallRenderer — read-only and rejected paths unaffected by failed fix", () => {
  test("read-only complete: shows 'read-only' chip (not failed)", async () => {
    const item = toolItem({
      name: "computer_call",
      raw: { type: "computer_call", action: { type: "click", x: 1, y: 1 } },
      output: "write actions are read-only",
      status: "complete",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("read-only");
    await r.unmount();
  });
});
