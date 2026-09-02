import { describe, expect, test } from "bun:test";

import { useRig, useRigVersions } from "../src/hooks/use-rigs";
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

describe("useRig", () => {
  test("verifies one exact version and refreshes the Rig", async () => {
    const versionId = "33333333-3333-4333-8333-333333333333";
    const calls: Array<[string, string, string]> = [];
    let loads = 0;
    const client = fakeClient({
      getRig: async () => {
        loads += 1;
        return null as never;
      },
      verifyRigVersion: async (workspaceId, rigId, requestedVersionId) => {
        calls.push([workspaceId, rigId, requestedVersionId]);
        return { ok: true, versionId: requestedVersionId };
      },
    });
    const hook = await renderHook(
      () => useRig(RIG_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    const initialLoads = loads;

    await actRun(async () => {
      expect(await hook.result.current.verifyVersion(versionId)).toEqual({ ok: true, versionId });
    });

    expect(calls).toEqual([[WORKSPACE_ID, RIG_ID, versionId]]);
    expect(loads).toBeGreaterThan(initialLoads);
    await hook.unmount();
  });
});
