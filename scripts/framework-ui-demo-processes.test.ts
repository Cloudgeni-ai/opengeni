import { describe, expect, test } from "bun:test";
import type { StartedProcess } from "@opengeni/testing";
import { startFrameworkUiDemos } from "./framework-ui-demo-processes";

function process(stop: () => void | Promise<void>): StartedProcess {
  return { stop } as StartedProcess;
}

describe("framework UI demo process startup", () => {
  test("returns both successful processes without stopping either", async () => {
    let stops = 0;
    const react = process(() => {
      stops += 1;
    });
    const svelte = process(() => {
      stops += 1;
    });

    await expect(
      startFrameworkUiDemos(
        async () => react,
        async () => svelte,
      ),
    ).resolves.toEqual([react, svelte]);
    expect(stops).toBe(0);
  });

  test("stops a successful sibling before rethrowing the startup failure", async () => {
    const failure = new Error("Svelte startup failed");
    let stopped = false;
    const startup = startFrameworkUiDemos(
      async () =>
        process(async () => {
          await Promise.resolve();
          stopped = true;
        }),
      () => {
        throw failure;
      },
    );

    await expect(startup).rejects.toBe(failure);
    expect(stopped).toBe(true);
  });

  test("starts both process factories before waiting for either result", async () => {
    let resolveReact: ((value: StartedProcess) => void) | null = null;
    let svelteStarted = false;
    const react = process(() => undefined);
    const svelte = process(() => undefined);
    const startup = startFrameworkUiDemos(
      async () =>
        await new Promise<StartedProcess>((resolve) => {
          resolveReact = resolve;
        }),
      async () => {
        svelteStarted = true;
        return svelte;
      },
    );

    await Promise.resolve();
    expect(svelteStarted).toBe(true);
    resolveReact?.(react);
    await expect(startup).resolves.toEqual([react, svelte]);
  });
});
