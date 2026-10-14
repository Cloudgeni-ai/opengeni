import { describe, expect, test } from "bun:test";
import {
  codexCutoverDisposition,
  selectCodexTurnCapacity,
  type CapacityPhaseDeps,
} from "../src/activities/agent-turn/codex-capacity";

describe("Codex provider cutover routing", () => {
  test("fails closed when the one-way cutover row is missing", () => {
    expect(codexCutoverDisposition("not_configured")).toBe("fail_closed");
    expect(codexCutoverDisposition("disabled")).toBe("fail_closed");
    expect(codexCutoverDisposition("enabled")).toBe("core");
  });

  test("does not consult Codex cutover state for a non-Codex turn", async () => {
    const deps = new Proxy(
      { billingState: { isCodexTurn: false } },
      {
        get(target, property, receiver) {
          if (property === "billingState") return Reflect.get(target, property, receiver);
          throw new Error(`non-Codex turn touched ${String(property)}`);
        },
      },
    ) as unknown as CapacityPhaseDeps;

    await expect(selectCodexTurnCapacity(deps)).resolves.toEqual({ ok: true });
  });
});
