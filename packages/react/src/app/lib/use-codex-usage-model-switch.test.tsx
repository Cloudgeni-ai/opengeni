import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../test/render-hook";
import { useCodexUsageModelSwitch } from "./use-codex-usage-model-switch";

registerDom();

type Props = { composerModel: string; enabled?: boolean | undefined };

async function setup(enabled = true) {
  const calls: string[] = [];
  const hook = await renderHook(
    ({ composerModel, enabled: blocked = enabled }: Props) =>
      useCodexUsageModelSwitch({
        sessionId: "session-1",
        sessionModel: "codex/gpt-6-sol",
        composerModel,
        enabled: blocked,
        closePicker: () => calls.push("close"),
        onContinue: (model) => calls.push(`continue:${model}`),
      }),
    { composerModel: "codex/gpt-6-sol" } as Props,
  );
  return { calls, hook };
}

describe("useCodexUsageModelSwitch", () => {
  test("picking another model on a blocked chat continues it with that model once", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.modelPicked("claude-opus-5.5"));
    // The composer commits the pick with its effort, then the chat continues.
    await hook.rerender({ composerModel: "claude-opus-5.5" });
    expect(calls).toEqual(["close", "continue:claude-opus-5.5"]);
    await hook.rerender({ composerModel: "claude-opus-5.5" });
    expect(calls.filter((call) => call.startsWith("continue"))).toHaveLength(1);
    await hook.unmount();
  });

  test("the chat's own model, or a chat that is not blocked, continues nothing", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.modelPicked("codex/gpt-6-sol"));
    await hook.rerender({ composerModel: "codex/gpt-6-sol" });
    expect(calls).toEqual([]);
    await hook.unmount();
    const unblocked = await setup(false);
    await actRun(() => unblocked.hook.result.current.modelPicked("gpt-6-astra"));
    await unblocked.hook.rerender({ composerModel: "gpt-6-astra" });
    expect(unblocked.calls).toEqual([]);
    await unblocked.hook.unmount();
  });

  test("a chat that stops being blocked before the pick lands does not continue", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.modelPicked("gpt-6-astra"));
    await hook.rerender({ composerModel: "gpt-6-astra", enabled: false });
    expect(calls).toEqual(["close"]);
    await hook.unmount();
  });

  test("a pick the composer never shows does not continue the chat later", async () => {
    const { calls, hook } = await setup();
    await actRun(() => hook.result.current.modelPicked("gpt-6-astra"));
    // The composer kept its model; the block ends, then comes back.
    await hook.rerender({ composerModel: "codex/gpt-6-sol", enabled: false });
    await hook.rerender({ composerModel: "codex/gpt-6-sol", enabled: true });
    await hook.rerender({ composerModel: "gpt-6-astra", enabled: true });
    expect(calls).toEqual(["close"]);
    await hook.unmount();
    // The composer settled on a different model than the pick.
    const other = await setup();
    await actRun(() => other.hook.result.current.modelPicked("gpt-6-astra"));
    await other.hook.rerender({ composerModel: "claude-opus-5.5" });
    await other.hook.rerender({ composerModel: "gpt-6-astra" });
    expect(other.calls).toEqual(["close"]);
    await other.hook.unmount();
  });
});
