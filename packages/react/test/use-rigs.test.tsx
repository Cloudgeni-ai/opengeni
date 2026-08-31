import { describe, expect, test } from "bun:test";

import { useRigVersions } from "../src/hooks/use-rigs";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

const RIG_ID = "22222222-2222-4222-8222-222222222222";

describe("useRigVersions", () => {
  test("keeps failed history unavailable until an explicit retry succeeds", async () => {
    let available = false;
    const client = fakeClient({
      listRigVersions: async () => {
        if (!available) throw new Error("version history unavailable");
        return [];
      },
    });
    const hook = await renderHook(
      () => useRigVersions(RIG_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    expect(hook.result.current.versions).toBeNull();
    await flush();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.versions).toBeNull();
    expect(hook.result.current.error?.message).toBe("version history unavailable");

    available = true;
    await actRun(async () => await hook.result.current.refresh());
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.versions).toEqual([]);
    await hook.unmount();
  });
});
