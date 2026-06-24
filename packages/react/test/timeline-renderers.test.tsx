import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, flush } from "./render-hook";
import { defaultToolRegistry } from "../src/timeline";
import type { ToolCallItem } from "../src/timeline";

/* ----------------------------------------------------------------------------
   Renderer integration tests for Issue-2 (multi-file apply_patch count) and
   Issue-3 (exec failure NUL-storage vs generic failure distinction).

   These render real `ActivityDisclosure` trees via happy-dom so the assertions
   touch actual DOM text — the only reliable way to confirm the renderer emits
   the right words given the dispatch logic lives in JSX.
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
    status: "complete",
    occurredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/* ---- Issue 2: multi-file apply_patch count ------------------------------ */

describe("ApplyPatchRenderer — multi-file with one malformed op", () => {
  // Build a raw apply_patch_call with two ops: one valid update and one that
  // will throw in v4aToGitFileDiff (content with no @@ anchor on an update).
  const raw = {
    type: "apply_patch_call",
    operations: [
      // Valid: has a proper @@ anchor.
      { type: "update_file", path: "src/good.ts", diff: "@@ -1,2 +1,2 @@\n context\n-old\n+new" },
      // Malformed: update_file with non-empty content but no @@ anchor → v4aToGitFileDiff throws.
      { type: "update_file", path: "src/bad.ts", diff: "this has no hunk anchor at all" },
    ],
  };

  test("title and preview show ops.length (2), not the parsed-only count (1)", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw,
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // The title "Edited 2 files" must be present — not "Edited 1 files".
    const titleText = r.container.textContent ?? "";
    expect(titleText).toContain("2 files");
    expect(titleText).not.toContain("Edited 1 files");

    await r.unmount();
  });

  test("the malformed op renders a raw fallback, not silent omission", async () => {
    const item = toolItem({
      name: "apply_patch_call",
      raw,
      status: "complete",
      output: "ok",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    // Expand the disclosure to see the body content.
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const bodyText = r.container.textContent ?? "";
    // The raw patch fallback label must appear for the malformed op.
    expect(bodyText.toLowerCase()).toContain("raw patch");

    await r.unmount();
  });
});

/* ---- Issue 3: exec failure NUL-storage vs generic failure --------------- */

describe("ExecRenderer — failed+empty-output distinction", () => {
  const execArgs = JSON.stringify({ cmd: "npm test" });

  test("output===undefined (no output event) → NUL-storage explanation", async () => {
    // output stays undefined: projection never received agent.toolCall.output for this call.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: undefined,
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must mention NUL / NUL byte — the specific storage-failure explanation.
    expect(text.toLowerCase()).toContain("nul");

    await r.unmount();
  });

  test("output===null (output event arrived, empty) → generic failure, NOT NUL explanation", async () => {
    // output is null: an output event arrived (e.g. MCP isError) but with null payload.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: null,
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    // Must NOT claim NUL byte caused this failure.
    expect(text.toLowerCase()).not.toContain("nul");
    // Must surface a general failure signal.
    expect(text.toLowerCase()).toContain("fail");

    await r.unmount();
  });

  test("output==='' (output event arrived, empty string) → generic failure, NOT NUL explanation", async () => {
    // output is empty string: an output event arrived with error:true and empty output.
    const item = toolItem({
      name: "exec_command",
      arguments: execArgs,
      output: "",
      status: "failed",
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const r = await renderComponent(<Renderer item={item} />);
    await flush();

    const text = r.container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("nul");
    expect(text.toLowerCase()).toContain("fail");

    await r.unmount();
  });
});
