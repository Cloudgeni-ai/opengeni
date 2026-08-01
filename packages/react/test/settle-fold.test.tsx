import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, actRun, flush } from "./render-hook";
import { TurnSummary, useTurnSettleOpen } from "../src/timeline/turn-summary";
import {
  FoldMemoryProvider,
  inheritFoldRestingState,
  type FoldRestingState,
} from "../src/timeline/fold-memory";
import { MOTION_INSPECT_SCALE } from "../src/lib/motion-inspect";

registerDom();

const BEAT_AND_MARGIN_MS = 1400 * MOTION_INSPECT_SCALE;
/** Keep in sync with `--og-duration-disclose` / TurnSummary DISCLOSE_MS. */
const DISCLOSE_MS = 120 * MOTION_INSPECT_SCALE;
const SETTLE_FULL_MS = 2200 * MOTION_INSPECT_SCALE;

function NestFlatProbe() {
  // settle chrome = force nested chips open (not bare-rail flat-map).
  const settleChrome = useTurnSettleOpen();
  return <span data-testid="nest-flat">{settleChrome ? "flat" : "nested"}</span>;
}

describe("TurnSummary settle fold", () => {
  test("mounts open, holds the beat, then auto-collapses", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" settleFold>
        <div data-testid="body">the rows</div>
      </TurnSummary>,
    );
    // Open during the beat: the rows the reader was watching stay visible.
    expect(r.container.textContent).toContain("the rows");
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");
    // The chip eases in with its own entrance; the root does not re-animate
    // the already-visible body.
    expect(trigger?.className).toContain("animate-og-settle-chip");

    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await r.unmount();
  });

  test("user interaction during the beat cancels the auto-collapse", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" settleFold>
        <div>the rows</div>
      </TurnSummary>,
    );
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");
    // The reader toggles: closed by their own hand…
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    // …then reopens; the expired-beat timer must not close it again.
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("data-state")).toBe("open");
    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("open");
    await r.unmount();
  });

  test("cancel-close keeps nest-flat through fast collapse; reopen clears it", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" settleFold>
        <NestFlatProbe />
      </TurnSummary>,
    );
    const probe = () => r.container.querySelector("[data-testid='nest-flat']")?.textContent;
    expect(probe()).toBe("flat");
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");
    // Cancel mid-beat: settle CSS phase clears, but nest latch must hold
    // through the fast collapse so nested chips do not remount mid-height.
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    expect(probe()).toBe("flat");
    await flush(DISCLOSE_MS + 40);
    // Once the close animation and latch finish, Radix may either retain or
    // unmount the closed content depending on animation-event availability.
    expect(probe()).not.toBe("flat");
    // Reader reopens: nested chrome may appear immediately.
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("data-state")).toBe("open");
    expect(probe()).toBe("nested");
    await r.unmount();
  });

  test("without settleFold, and for defaultOpen folds, behavior is unchanged", async () => {
    const plain = await renderComponent(
      <TurnSummary items={[]} outcome="complete">
        <div>the rows</div>
      </TurnSummary>,
    );
    expect(plain.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    await plain.unmount();

    // A failed turn that defaults open must stay open — settleFold is ignored.
    const failed = await renderComponent(
      <TurnSummary items={[]} outcome="failed" defaultOpen settleFold>
        <div>the rows</div>
      </TurnSummary>,
    );
    const failedTrigger = failed.container.querySelector("button");
    expect(failedTrigger?.getAttribute("data-state")).toBe("open");
    await flush(BEAT_AND_MARGIN_MS);
    expect(failedTrigger?.getAttribute("data-state")).toBe("open");
    await failed.unmount();
  });

  test("settleFold rising edge on a live-open shell starts the beat→collapse", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} defaultOpen>
        <div data-testid="body">the rows</div>
      </TurnSummary>,
    );
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");

    await r.rerender(
      <TurnSummary items={[]} defaultOpen settleFold>
        <div data-testid="body">the rows</div>
      </TurnSummary>,
    );
    expect(trigger?.getAttribute("data-state")).toBe("open");
    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await r.unmount();
  });

  test("after auto-settle, a manual reopen uses the fast expand class", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" settleFold>
        <div>the rows</div>
      </TurnSummary>,
    );
    // Wait for beat + slow collapse + settlePhase clear (1100 + 820).
    await flush(SETTLE_FULL_MS);
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    const panel = r.container.querySelector("[data-og-fold-content]");
    expect(panel?.className).toContain("animate-og-expand");
    expect(panel?.className).toContain("animate-og-collapse");
    expect(panel?.className).not.toContain("animate-og-settle-collapse");
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger?.getAttribute("data-state")).toBe("open");
    await r.unmount();
  });

  test("settling never re-applies root entrance after the collapse (no chip flash)", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" settleFold>
        <div>the rows</div>
      </TurnSummary>,
    );
    const root = r.container.firstElementChild;
    expect(root?.className ?? "").not.toContain("animate-og-enter");
    await flush(SETTLE_FULL_MS);
    expect(r.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    // The bug: settling cleared → animate-og-enter toggled on → opacity replay.
    expect(root?.className ?? "").not.toContain("animate-og-enter");
    await r.unmount();
  });

  test("fold memory: a completed settle collapse never replays the open beat on remount", async () => {
    const memory = new Map<string, FoldRestingState>();
    const chip = (
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold foldKey="cluster-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>
    );
    const first = await renderComponent(chip);
    // Full choreography: beat + slow collapse; resting state is recorded.
    await flush(SETTLE_FULL_MS);
    expect(first.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    expect(memory.get("cluster-1")).toBe("closed");
    await first.unmount();

    // Remount with the same key (activity→turn wrap / key flip): mounts
    // CLOSED, no settle beat, and the beat window never reopens it.
    const remount = await renderComponent(chip);
    const trigger = remount.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    expect(trigger?.className ?? "").not.toContain("animate-og-settle-chip");
    expect(remount.container.textContent).not.toContain("the rows");
    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await remount.unmount();
  });

  test("fold memory: nest force-open (defaultOpen) cannot reopen a remembered-closed fold", async () => {
    const memory = new Map<string, FoldRestingState>([["cluster-1", "closed"]]);
    const r = await renderComponent(
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" defaultOpen bare foldKey="cluster-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>,
    );
    expect(r.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    expect(r.container.textContent).not.toContain("the rows");
    await r.unmount();
  });

  test("fold memory: a reader-closed fold stays closed across a settleFold remount", async () => {
    const memory = new Map<string, FoldRestingState>();
    const chip = (
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold foldKey="cluster-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>
    );
    const first = await renderComponent(chip);
    const trigger = first.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");
    // Reader closes mid-beat — their resolution, remembered as closed.
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(memory.get("cluster-1")).toBe("closed");
    await first.unmount();

    const remount = await renderComponent(chip);
    expect(remount.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    await flush(BEAT_AND_MARGIN_MS);
    expect(remount.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    await remount.unmount();
  });

  test("fold memory: a reader-opened fold remounts open and is not auto-collapsed", async () => {
    const memory = new Map<string, FoldRestingState>();
    const chip = (
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold foldKey="cluster-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>
    );
    const first = await renderComponent(chip);
    await flush(SETTLE_FULL_MS);
    const trigger = first.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    // Reader reopens after the settle: remembered as open.
    await actRun(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(memory.get("cluster-1")).toBe("open");
    await first.unmount();

    const remount = await renderComponent(chip);
    const reTrigger = remount.container.querySelector("button");
    expect(reTrigger?.getAttribute("data-state")).toBe("open");
    await flush(BEAT_AND_MARGIN_MS);
    expect(reTrigger?.getAttribute("data-state")).toBe("open");
    await remount.unmount();
  });

  test("fold memory: activity→turn key inheritance keeps the chip closed", async () => {
    const memory = new Map<string, FoldRestingState>();
    const activity = (
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold foldKey="activity-tool-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>
    );
    const first = await renderComponent(activity);
    await flush(SETTLE_FULL_MS);
    expect(memory.get("activity-tool-1")).toBe("closed");
    await first.unmount();

    inheritFoldRestingState(memory, "turn-abc", ["activity-tool-1"]);
    expect(memory.get("turn-abc")).toBe("closed");

    const turn = await renderComponent(
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold foldKey="turn-abc">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>,
    );
    const trigger = turn.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    expect(trigger?.className ?? "").not.toContain("animate-og-settle-chip");
    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await turn.unmount();
  });

  test("fold memory: a settleFold rising edge is inert once remembered closed", async () => {
    const memory = new Map<string, FoldRestingState>([["cluster-1", "closed"]]);
    const shell = (settleFold: boolean) => (
      <FoldMemoryProvider value={memory}>
        <TurnSummary items={[]} outcome="complete" settleFold={settleFold} foldKey="cluster-1">
          <div>the rows</div>
        </TurnSummary>
      </FoldMemoryProvider>
    );
    const r = await renderComponent(shell(false));
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await r.rerender(shell(true));
    // No open beat: the fold already resolved once.
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await flush(BEAT_AND_MARGIN_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    await r.unmount();
  });

  test("duration facet is held until settle finishes (no mid-fold · 8s pop)", async () => {
    const r = await renderComponent(
      <TurnSummary items={[]} outcome="complete" durationMs={8000} settleFold>
        <div>the rows</div>
      </TurnSummary>,
    );
    const trigger = r.container.querySelector("button");
    expect(trigger?.getAttribute("data-state")).toBe("open");
    expect(trigger?.textContent ?? "").not.toContain("8s");
    await flush(SETTLE_FULL_MS);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    expect(trigger?.textContent ?? "").toContain("8s");
    await r.unmount();
  });
});
