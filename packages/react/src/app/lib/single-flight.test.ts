import { describe, expect, test } from "bun:test";

import { runSingleFlight } from "./single-flight";

describe("runSingleFlight", () => {
  test("coalesces concurrent reads and refreshes after settlement", async () => {
    const pending = new Map<string, Promise<string>>();
    let loads = 0;
    let resolve!: (value: string) => void;
    const load = () => {
      loads += 1;
      return new Promise<string>((done) => {
        resolve = done;
      });
    };

    const first = runSingleFlight(pending, "workspace", load);
    const duplicate = runSingleFlight(pending, "workspace", load);
    expect(duplicate).toBe(first);
    expect(loads).toBe(1);

    resolve("catalog");
    expect(await first).toBe("catalog");
    expect(await duplicate).toBe("catalog");

    const refreshed = runSingleFlight(pending, "workspace", async () => {
      loads += 1;
      return "fresh";
    });
    expect(await refreshed).toBe("fresh");
    expect(loads).toBe(2);
  });

  test("clears failed reads so a retry can run", async () => {
    const pending = new Map<string, Promise<string>>();
    const failed = runSingleFlight(pending, "workspace", async () => {
      throw new Error("offline");
    });
    await expect(failed).rejects.toThrow("offline");
    expect(await runSingleFlight(pending, "workspace", async () => "recovered")).toBe("recovered");
  });
});
