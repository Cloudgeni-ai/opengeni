import { describe, expect, test } from "bun:test";
import type { MachineInputMember } from "../src/timeline/types";
import {
  agentMemberText,
  agentMemberTitle,
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
  test("counts result receipts without claiming their agents finished", () => {
    expect(
      machineInputBatchLabel([
        member("child_terminal_result", "", "a"),
        member("child_terminal_result", "", "b"),
        member("child_terminal_result", "", "c"),
      ]),
    ).toBe("3 agent results received");
  });

  test("labels child lifecycle notices", () => {
    expect(machineInputBatchLabel([member("child_requires_action")])).toBe("Agent needs input");
    expect(
      machineInputBatchLabel([
        member("child_requires_action", "", "a"),
        member("child_requires_action", "", "b"),
      ]),
    ).toBe("2 agents need input");
    expect(machineInputBatchLabel([member("child_requires_action_resolved")])).toBe(
      "Agent unblocked",
    );
    expect(machineInputBatchLabel([member("child_paused")])).toBe("Agent paused");
    expect(machineInputBatchLabel([member("child_waiting_capacity")])).toBe(
      "Agent waiting for capacity",
    );
    expect(machineInputBatchLabel([member("child_progress")])).toBe("Agent progress");
    expect(
      machineInputBatchLabel([
        member("child_requires_action", "", "a"),
        member("child_progress", "", "b"),
      ]),
    ).toBe("2 updates · Agent needs input, Agent progress");
  });

  test("keeps a short mixed-kind label", () => {
    expect(
      machineInputBatchLabel([
        member("agent_message", "", "a"),
        member("child_terminal_result", "", "b"),
      ]),
    ).toBe("2 updates · Agent update, Agent result received");
  });

  test("single member uses the typed meta label", () => {
    expect(machineInputBatchLabel([member("goal_continuation")])).toBe("Goal continued");
  });

  test("names a single known agent source", () => {
    const agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const titleFor = (id: string) => (id === agent ? "Release audit" : null);
    const from = (kind: MachineInputMember["kind"], id: string) => ({
      ...member(kind, "", id),
      sourceId: agent,
    });
    expect(machineInputBatchLabel([from("agent_message", "a")], titleFor)).toBe(
      "Update from Release audit",
    );
    expect(machineInputBatchLabel([from("child_requires_action", "a")], titleFor)).toBe(
      "Release audit needs input",
    );
    // A result only means the agent went idle: never "finished".
    expect(machineInputBatchLabel([from("child_terminal_result", "a")], titleFor)).toBe(
      "Result from Release audit",
    );
    expect(
      machineInputBatchLabel([from("agent_message", "a"), from("child_progress", "b")], titleFor),
    ).toBe("2 updates from Release audit");
    // Other kinds of update follow the named agent part.
    expect(
      machineInputBatchLabel(
        [from("agent_message", "a"), member("background_command_result", "", "b")],
        titleFor,
      ),
    ).toBe("Update from Release audit · Command result received");
    // Unknown senders keep the generic labels.
    expect(machineInputBatchLabel([member("agent_message")], titleFor)).toBe("Agent update");
    expect(
      machineInputBatchLabel(
        [from("agent_message", "a"), member("agent_message", "", "b")],
        titleFor,
      ),
    ).toBe("2 agent updates");
  });

  test("names two senders, then counts", () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    const names = ["Audit", "Flake", "Docs"];
    const titleFor = (id: string) => names[ids.indexOf(id)] ?? null;
    const from = (index: number) => ({
      ...member("child_progress", "", `m-${index}`),
      sourceId: ids[index]!,
    });
    expect(
      machineInputBatchLabel([from(0), from(1), member("session_wait_timeout", "", "w")], titleFor),
    ).toBe("2 updates from Audit and Flake · Wait ended");
    expect(machineInputBatchLabel([from(0), from(1), from(2)], titleFor)).toBe(
      "3 updates from 3 agents",
    );
  });
});

describe("agent member presentation", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  test("titles fall back to the generic labels without a name", () => {
    expect(agentMemberTitle(member("agent_message"), null).text).toBe("Agent update");
    expect(agentMemberTitle(member("agent_steer_instruction"), "Manager").text).toBe(
      "Direction from Manager",
    );
    expect(
      agentMemberTitle({ kind: "child_terminal_result", classification: "failure" }, "Audit").text,
    ).toBe("Audit failed");
  });

  test("drops the model-facing worker framing", () => {
    expect(
      agentMemberText(member("child_progress", `Worker ${id} progress: Tests green.`)),
    ).toEqual({ preview: "Tests green.", body: "Tests green." });
    expect(
      agentMemberText(
        member(
          "child_requires_action",
          `Worker ${id} is blocked and needs input (turn ${id}). It asked: Raise the timeout?.`,
        ),
      ).preview,
    ).toBe("Raise the timeout?");
    // An agent's own message is shown verbatim.
    expect(agentMemberText(member("agent_message", "listRuns() returns a page")).preview).toBe(
      "listRuns() returns a page",
    );
    expect(
      agentMemberText(member("child_paused", `Worker ${id} was paused by a human.`)).preview,
    ).toBe("Paused by a human");
    expect(
      agentMemberText(
        member(
          "child_terminal_result",
          [
            `A worker session you spawned has COMPLETED its goal. Worker session id: ${id}.`,
            "Worker goal: Ship the audit",
            "Completion evidence: 3 breaking changes documented",
          ].join("\n"),
        ),
      ),
    ).toEqual({
      preview: "3 breaking changes documented",
      body: "Goal: Ship the audit\nEvidence: 3 breaking changes documented",
    });
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
