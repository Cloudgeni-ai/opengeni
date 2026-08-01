import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, actRun, flush } from "./render-hook";
import { TurnSummary, useTurnSettleOpen } from "../src/timeline/turn-summary";

registerDom();

const BEAT_AND_MARGIN_MS = 1400;
/** Keep in sync with `--og-duration-disclose` / TurnSummary DISCLOSE_MS. */
const DISCLOSE_MS = 120;

function NestFlatProbe() {
  const nestFlat = useTurnSettleOpen();
  return <span data-testid="nest-flat">{nestFlat ? "flat" : "nested"}</span>;
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
    expect(probe()).toBe("nested");
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
    await flush(2200);
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
    await flush(2200);
    expect(r.container.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    // The bug: settling cleared → animate-og-enter toggled on → opacity replay.
    expect(root?.className ?? "").not.toContain("animate-og-enter");
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
    await flush(2200);
    expect(trigger?.getAttribute("data-state")).toBe("closed");
    expect(trigger?.textContent ?? "").toContain("8s");
    await r.unmount();
  });
});
