import { describe, expect, test } from "bun:test";
import {
  loadRigDefaultVariableSetEnvironment,
  mergeRigDefaultVariableSetEnvironment,
  RIG_DEFAULT_VARIABLE_SET_LOAD_CONCURRENCY,
  variableSetScopeAllowedForRig,
} from "../src/rigs";

describe("rig default variable-set environment", () => {
  test("never lets a wider rig depend on a narrower Variable Set", () => {
    expect(variableSetScopeAllowedForRig("organization", "organization")).toBe(true);
    expect(variableSetScopeAllowedForRig("organization", "workspace")).toBe(false);
    expect(variableSetScopeAllowedForRig("organization", "user")).toBe(false);
    expect(variableSetScopeAllowedForRig("workspace", "organization")).toBe(true);
    expect(variableSetScopeAllowedForRig("workspace", "workspace")).toBe(true);
    expect(variableSetScopeAllowedForRig("workspace", "user")).toBe(false);
    expect(variableSetScopeAllowedForRig("user", "organization")).toBe(true);
    expect(variableSetScopeAllowedForRig("user", "workspace")).toBe(true);
    expect(variableSetScopeAllowedForRig("user", "user")).toBe(true);
  });

  test("loads at a bounded width while preserving listed-order precedence", async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 25 }, (_, index) => `set-${index}`);
    const values = await loadRigDefaultVariableSetEnvironment(ids, async (id) => {
      const index = Number(id.slice("set-".length));
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep((index % 4) + 1);
      active -= 1;
      return { values: { SHARED: String(index), [`ONLY_${index}`]: id } };
    });

    expect(peak).toBe(RIG_DEFAULT_VARIABLE_SET_LOAD_CONCURRENCY);
    expect(values.SHARED).toBe("24");
    expect(values.ONLY_0).toBe("set-0");
    expect(values.ONLY_24).toBe("set-24");
  });

  test("fails closed and drains reads already in flight", async () => {
    const launched: string[] = [];
    let active = 0;
    const failure = new Error("secret provider unavailable");
    await expect(
      loadRigDefaultVariableSetEnvironment(
        Array.from({ length: 12 }, (_, index) => `set-${index}`),
        async (id) => {
          launched.push(id);
          active += 1;
          try {
            if (id === "set-1") {
              await Bun.sleep(1);
              throw failure;
            }
            await Bun.sleep(10);
            return { values: { [id]: id } };
          } finally {
            active -= 1;
          }
        },
      ),
    ).rejects.toBe(failure);
    expect(launched).toEqual(["set-0", "set-1", "set-2", "set-3"]);
    expect(active).toBe(0);
  });

  test("keeps the explicit session set above every rig default", () => {
    expect(
      mergeRigDefaultVariableSetEnvironment(
        { SHARED: "rig", RIG_ONLY: "rig" },
        { SHARED: "session", SESSION_ONLY: "session" },
      ),
    ).toEqual({ SHARED: "session", RIG_ONLY: "rig", SESSION_ONLY: "session" });
  });
});
