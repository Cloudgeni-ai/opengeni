import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";
import { ModelsRefreshControl } from "./models-refresh-control";

let root: Root, container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const failed of [false, true]) {
  test(`pooled observations wait for live checks and Refresh waits for both phases (failed=${failed})`, async () => {
    const client = {};
    const live = deferred(),
      pooled = deferred();
    const events: string[] = [];
    let liveReads = 0,
      poolReads = 0,
      observation = "old";
    function Harness() {
      useSharedQuery(client, ["model-settings", "claude-usage", "account"], async () => {
        if (++liveReads === 1) return "initial";
        events.push("live-start");
        await live.promise;
        events.push("live-end");
        if (failed) throw new Error("provider unavailable");
        observation = "new";
        return observation;
      });
      const query = useSharedQuery(
        client,
        ["subscription-usage-pools", "workspace", "workspace"],
        async () => {
          if (++poolReads === 1) return observation;
          events.push("pool-start:" + observation);
          await pooled.promise;
          events.push("pool-end");
          return observation;
        },
      );
      return (
        <>
          <ModelsRefreshControl client={client} />
          <output>{query.data}</output>
        </>
      );
    }
    await act(async () => root.render(<Harness />));
    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    expect(events).toEqual(["live-start"]);
    expect(poolReads).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Refreshing…");
    await act(async () => live.resolve());
    expect(events).toEqual(["live-start", "live-end", "pool-start:" + (failed ? "old" : "new")]);
    expect(poolReads).toBe(2);
    expect(button.disabled).toBe(true);
    await act(async () => pooled.resolve());
    expect(events.at(-1)).toBe("pool-end");
    expect(container.querySelector("output")?.textContent).toBe(failed ? "old" : "new");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Refresh");
  });
}

test("pooled reads contribute to the Models updated timestamp", async () => {
  const client = {};
  function Harness() {
    useSharedQuery(client, ["subscription-usage-pools", "organization", "org"], async () => []);
    return <ModelsRefreshControl client={client} />;
  }
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain("Updated");
});
