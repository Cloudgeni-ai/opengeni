import { describe, expect, test } from "bun:test";
import { codexCutoverDisposition } from "../src/activities/agent-turn/codex-capacity";

describe("Codex provider cutover routing", () => {
  test("permits the legacy path only when no one-way cutover row exists", () => {
    expect(codexCutoverDisposition("not_configured")).toBe("legacy");
    expect(codexCutoverDisposition("disabled")).toBe("fail_closed");
    expect(codexCutoverDisposition("enabled")).toBe("core");
  });
});
