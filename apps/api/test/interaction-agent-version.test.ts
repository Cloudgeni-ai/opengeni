import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  agentUpdateRequiredForSecretsError,
  agentVersionRejectsSecretValues,
  MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES,
} from "../src/interaction-agent-version";

describe("agents that predate secret values", () => {
  test("only a known version older than the first supporting release is refused", () => {
    expect(MINIMUM_AGENT_VERSION_FOR_SECRET_VALUES).toBe("0.1.56");
    for (const version of ["0.1.41", "0.1.55", "v0.1.55", "0.0.9", "0.1.56-rc.1"]) {
      expect(agentVersionRejectsSecretValues(version)).toBe(true);
    }
    for (const version of ["0.1.56", "0.1.58", "0.2.0", "1.0.0"]) {
      expect(agentVersionRejectsSecretValues(version)).toBe(false);
    }
    // Unknown or unparsable versions are never refused on a guess.
    for (const version of [null, "", "dev", "unknown"]) {
      expect(agentVersionRejectsSecretValues(version)).toBe(false);
    }
  });

  test("the refusal names the installed version, the fix and that nothing was typed", () => {
    const error = agentUpdateRequiredForSecretsError("0.1.41");
    expect(error.status).toBe(422);
    expect(error.code).toBe("validation_failed");
    expect(error.retryable).toBe(false);
    expect(error.outcomeUnknown).toBe(false);
    expect(error.message).toContain("0.1.41");
    expect(error.message).toContain("0.1.56 or newer");
    expect(error.message).toContain("Update now");
    expect(error.message).toContain("Nothing was typed");
    expect(error.details).toEqual({
      reason: "agent_update_required",
      agentVersion: "0.1.41",
      minimumAgentVersion: "0.1.56",
    });
  });

  test("every device dispatch that carries secret values checks the controller first", () => {
    const sources = {
      computer: readFileSync(
        new URL("../src/routes/computer-sessions.ts", import.meta.url),
        "utf8",
      ),
      browser: readFileSync(new URL("../src/routes/browser-sessions.ts", import.meta.url), "utf8"),
    };
    const expected = { computer: 2, browser: 1 };
    for (const [name, source] of Object.entries(sources)) {
      const calls = source.split("resolveInteractionSecretValues({").slice(1);
      expect(calls.length).toBe(expected[name as keyof typeof expected]);
      for (const call of calls) {
        const body = call.slice(0, call.indexOf("});"));
        expect(body).toContain("beforeResolve: requirePlacementAcceptsSecretValues(");
        expect(body).toContain("record.session.placement");
      }
    }
  });
});
