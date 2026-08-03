import { describe, expect, test } from "bun:test";
import type { MachineInputMember } from "../src/timeline/types";
import {
  cleanMachineInputSummary,
  machineInputBatchLabel,
  machineInputSummaryIsUseful,
} from "../src/components/machine-input-display";

function member(
  kind: MachineInputMember["kind"],
  summary = "",
  id: string = kind,
): MachineInputMember {
  return {
    id,
    kind,
    classification: "info",
    sourceId: "src",
    summary,
  };
}

describe("machineInputBatchLabel", () => {
  test("pluralizes identical agent-finished members", () => {
    expect(
      machineInputBatchLabel([
        member("child_terminal_result", "", "a"),
        member("child_terminal_result", "", "b"),
        member("child_terminal_result", "", "c"),
      ]),
    ).toBe("3 agents finished");
  });

  test("keeps a short mixed-kind label", () => {
    expect(
      machineInputBatchLabel([
        member("agent_message", "", "a"),
        member("child_terminal_result", "", "b"),
      ]),
    ).toBe("2 updates · Agent update, Agent finished");
  });

  test("single member uses the typed meta label", () => {
    expect(machineInputBatchLabel([member("goal_continuation")])).toBe("Goal continued");
  });
});

describe("cleanMachineInputSummary", () => {
  test("strips worker session UUIDs and protocol tags", () => {
    expect(
      cleanMachineInputSummary(
        "[CHILD] A worker session you spawned has finished its work and gone idle. Worker session id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBe("A worker session you spawned has finished its work and gone idle.");
  });
});

describe("machineInputSummaryIsUseful", () => {
  test("rejects generic child-finished boilerplate", () => {
    expect(
      machineInputSummaryIsUseful(
        "child_terminal_result",
        "A worker session you spawned has finished its work and gone idle.",
      ),
    ).toBe(false);
  });

  test("keeps a concrete agent update summary", () => {
    expect(machineInputSummaryIsUseful("agent_message", "Cache verification completed.")).toBe(
      true,
    );
  });
});
