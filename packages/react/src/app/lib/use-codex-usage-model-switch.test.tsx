import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../test/render-hook";
import { useCodexUsageModelSwitch } from "./use-codex-usage-model-switch";

registerDom();

type Props = { composerModel: string; enabled?: boolean | undefined };

async function setup() {
  const calls: string[] = [];
  const hook = await renderHook(
    ({ composerModel, enabled = true }: Props) =>
      useCodexUsageModelSwitch({
        sessionId: "session-1",
        sessionModel: "codex/gpt-6-sol",
        composerModel,
        enabled,
        openPicker: () => calls.push("open"),
        closePicker: () => calls.push("close"),
        onContinue: (model) => calls.push(`continue:${model}`),
      }),
    { composerModel: "codex/gpt-6-sol" } as Props,
  );
  return { calls, hook };
}

describe("useCodexUsageModelSwitch", () => {
  test("Switch model opens the picker and a pick continues the chat with that model once", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.start());
    expect(calls).toEqual(["open"]);
    await actRun(() => hook.result.current.modelPicked("claude-opus-5.5"));
    // The composer commits the pick with its effort, then the chat continues.
    await hook.rerender({ composerModel: "claude-opus-5.5" });
    expect(calls).toEqual(["open", "close", "continue:claude-opus-5.5"]);
    await hook.rerender({ composerModel: "claude-opus-5.5" });
    expect(calls.filter((call) => call.startsWith("continue"))).toHaveLength(1);
    await hook.unmount();
  });

  test("an ordinary pick, the chat's own model or closing the picker continues nothing", async () => {
    const { calls, hook } = await setup();
    // Without Switch model, choosing a model only changes the composer.
    await actRun(() => hook.result.current.modelPicked("claude-opus-5.5"));
    await hook.rerender({ composerModel: "claude-opus-5.5" });
    expect(calls).toEqual([]);
    await actRun(() => hook.result.current.start());
    await actRun(() => hook.result.current.modelPicked("codex/gpt-6-sol"));
    await actRun(() => hook.result.current.pickerClosed());
    await actRun(() => hook.result.current.modelPicked("gpt-6-astra"));
    await hook.rerender({ composerModel: "gpt-6-astra" });
    expect(calls).toEqual(["open"]);
    await hook.unmount();
  });

  test("a chat that is no longer blocked does not continue", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.start());
    await actRun(() => hook.result.current.modelPicked("gpt-6-astra"));
    await hook.rerender({ composerModel: "gpt-6-astra", enabled: false });
    expect(calls).toEqual(["open", "close"]);
    await hook.unmount();
  });
});
