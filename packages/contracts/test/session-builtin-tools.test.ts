import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  ScheduledTaskAgentConfigInput,
  disabledBuiltinToolsFromMetadata,
  withDisabledBuiltinToolsMetadata,
} from "../src/index";

describe("disabledBuiltinTools contract", () => {
  test("create and scheduled agent config accept only known, unique opt-outs", () => {
    expect(
      CreateSessionRequest.parse({
        initialMessage: "hi",
        disabledBuiltinTools: ["web_search", "human_input"],
      }).disabledBuiltinTools,
    ).toEqual(["human_input", "web_search"]);
    expect(
      CreateSessionRequest.safeParse({ initialMessage: "hi", disabledBuiltinTools: ["shell"] })
        .success,
    ).toBe(false);
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "hi",
        disabledBuiltinTools: ["web_search", "web_search"],
      }).success,
    ).toBe(false);
    expect(
      ScheduledTaskAgentConfigInput.parse({ prompt: "run", disabledBuiltinTools: ["web_search"] })
        .disabledBuiltinTools,
    ).toEqual(["web_search"]);
  });

  test("the reserved metadata key replaces any caller-supplied value", () => {
    const stored = withDisabledBuiltinToolsMetadata(
      { _opengeni_disabled_builtin_tools_v1: ["forged"], keep: 1 },
      ["human_input"],
    );
    expect(stored.keep).toBe(1);
    expect(disabledBuiltinToolsFromMetadata(stored)).toEqual(["human_input"]);
    expect(
      disabledBuiltinToolsFromMetadata(
        withDisabledBuiltinToolsMetadata({ _opengeni_disabled_builtin_tools_v1: ["x"] }, undefined),
      ),
    ).toEqual([]);
  });
});
