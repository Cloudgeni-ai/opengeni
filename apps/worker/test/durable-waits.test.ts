import { describe, expect, test } from "bun:test";
import { askUserBoundaryFromApprovals } from "../src/activities/durable-waits";

const request = {
  requestKey: "deploy-choice",
  title: "Choose a target",
  questions: [
    {
      id: "target",
      type: "single_select" as const,
      prompt: "Where should this run?",
      required: true,
      options: [
        { value: "staging", label: "Staging" },
        { value: "production", label: "Production" },
      ],
    },
  ],
};

describe("askUserBoundaryFromApprovals", () => {
  test("parses the built-in tool and keeps the serialized approval id", () => {
    expect(
      askUserBoundaryFromApprovals([
        { id: "call-1", name: "ask_user", arguments: JSON.stringify(request) },
      ]),
    ).toEqual({ approvalId: "call-1", request });
  });

  test("accepts the namespaced alias and SDK rawItem form", () => {
    expect(
      askUserBoundaryFromApprovals([
        {
          rawItem: {
            callId: "call-2",
            name: "opengeni__ask_user",
            arguments: request,
          },
        },
      ]),
    ).toEqual({ approvalId: "call-2", request });
  });

  test("unwraps the runtime fallback raw object", () => {
    expect(
      askUserBoundaryFromApprovals([
        {
          id: "call-3",
          name: "ask_user",
          arguments: null,
          raw: { rawItem: { name: "ask_user", arguments: JSON.stringify(request) } },
        },
      ]),
    ).toEqual({ approvalId: "call-3", request });
  });

  test("ignores unrelated generic approvals", () => {
    expect(
      askUserBoundaryFromApprovals([{ id: "call-other", name: "delete_repository" }]),
    ).toBeNull();
  });

  test("rejects malformed JSON, missing ids, and multiple ask_user actions", () => {
    expect(() =>
      askUserBoundaryFromApprovals([{ id: "call-bad", name: "ask_user", arguments: "{" }]),
    ).toThrow("malformed JSON");
    expect(() => askUserBoundaryFromApprovals([{ name: "ask_user", arguments: request }])).toThrow(
      "missing its SDK approval id",
    );
    expect(() =>
      askUserBoundaryFromApprovals([
        { id: "call-1", name: "ask_user", arguments: request },
        { id: "call-2", name: "ask_user", arguments: request },
      ]),
    ).toThrow("more than one ask_user");
  });
});
