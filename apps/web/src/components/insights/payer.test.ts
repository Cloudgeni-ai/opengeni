import { describe, expect, test } from "bun:test";

import { usagePayer } from "./payer";

describe("usagePayer", () => {
  test("credits, connected plans and own keys", () => {
    expect(usagePayer("opengeni_credits", "openai")).toBe("opengeni_credits");
    expect(usagePayer("external", "codex-subscription")).toBe("subscription");
    expect(usagePayer("external", "supergrok-subscription")).toBe("subscription");
    expect(usagePayer("external", "workspace-claude-subscription")).toBe("subscription");
    expect(usagePayer("external", "organization-claude-subscription")).toBe("subscription");
    expect(usagePayer("external", "workspace-gateway")).toBe("own_key");
    expect(usagePayer("external", "anthropic")).toBe("own_key");
    expect(usagePayer("external", "constructor")).toBe("own_key");
  });
});
