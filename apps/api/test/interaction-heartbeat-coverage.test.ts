import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const routes = {
  computer: new URL("../src/routes/computer-sessions.ts", import.meta.url),
  browser: new URL("../src/routes/browser-sessions.ts", import.meta.url),
};

/** Calls that move a lifecycle operation to dispatched inside a route. */
const DISPATCH_CALLS = [
  "await ensureDispatchedGeneration(",
  "await dispatchComputerSessionOperation(",
  "await dispatchBrowserSessionOperation(",
];

/** Calls that reach, start or provision the interaction controller. */
const PROVISION_CALLS = [
  "provisionController(",
  "provisionBrowserControlClient(",
  "withComputerCreationController(",
  "withBrowserCreationController(",
];

const HEARTBEAT_CALL = "withInteractionHolderHeartbeat(";

function occurrences(source: string, needle: string, end: number): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at !== -1 && at < end; at = source.indexOf(needle, at + 1))
    found.push(at);
  return found;
}

function nextOf(source: string, needles: readonly string[], from: number): number {
  const found = needles.map((needle) => source.indexOf(needle, from)).filter((at) => at !== -1);
  return found.length ? Math.min(...found) : -1;
}

describe("interaction lifecycle heartbeat", () => {
  // The transition reaper settles a dispatched operation whose heartbeat went
  // quiet as lost. Provisioning a controller on a slow or reconnecting machine
  // can take minutes, so a request that provisions after dispatch without a
  // heartbeat loses its operation while it is still working on it.
  for (const [name, url] of Object.entries(routes)) {
    test(`${name} routes heartbeat every dispatched operation before provisioning its controller`, async () => {
      const source = await readFile(url, "utf8");
      // Route handlers come before the dispatch helper's own definition.
      const helper = source.indexOf("function ensureDispatchedGeneration(");
      expect(helper).toBeGreaterThan(-1);
      const dispatches = DISPATCH_CALLS.flatMap((call) => occurrences(source, call, helper));
      expect(dispatches.length).toBeGreaterThan(1);
      for (const dispatch of dispatches) {
        const provision = nextOf(source, PROVISION_CALLS, dispatch);
        if (provision === -1) continue;
        const heartbeat = source.indexOf(HEARTBEAT_CALL, dispatch);
        const line = source.slice(0, dispatch).split("\n").length;
        expect({ line, heartbeatFirst: heartbeat !== -1 && heartbeat < provision }).toEqual({
          line,
          heartbeatFirst: true,
        });
      }
    });
  }
});
