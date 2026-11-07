import { expect, test } from "bun:test";
import type { ConnectorActionPolicyHooks, ConnectorActionToolCall } from "@opengeni/runtime";
import { resolveConnectorActionPolicy, connectorActionPolicyDecision } from "@opengeni/db";

import {
  githubRepositoryAttachUri,
  repositoryAttachRequest,
  withRepositoryAttachApproval,
} from "../src/activities/agent-turn/repository-attach-approval";

/** Stands in for the attempt ledger: an explicit choice for the call, else its default. */
function ledger() {
  const prepared: { call: ConnectorActionToolCall; decision: "allow" | "ask" | "block" }[] = [];
  const begun: ConnectorActionToolCall[] = [];
  const policy: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      const resolved = resolveConnectorActionPolicy([], {
        connectionId: call.connectionId!,
        serverId: call.serverId,
        toolName: call.toolName,
        actionName: call.toolName,
        defaultDecision: call.defaultDecision ?? "allow",
      });
      if (!resolved.managed) throw new Error("unmanaged");
      const decision = connectorActionPolicyDecision(resolved);
      prepared.push({ call, decision });
      return { managed: true, decision, requestId: decision === "ask" ? "req-1" : undefined };
    },
    begin: async (call) => {
      begun.push(call);
      return { allowed: true, managed: true, requestId: "req-1" };
    },
    complete: async () => undefined,
  };
  return { prepared, begun, policy };
}

function attachCall(
  args: Record<string, unknown> = { repository: "example-owner/service" },
  approvalId = "call-1",
): ConnectorActionToolCall {
  // What the runtime builds for an opengeni tool in requireApproval.
  return {
    approvalId,
    connectionId: "session-mcp:opengeni:hash",
    serverId: "opengeni",
    toolName: "github_repository_attach",
    arguments: args,
    reviewContext: { kind: "generic", title: "github_repository_attach" },
    approvalMode: "session_mcp",
    defaultDecision: "ask",
  };
}

function wrapped(input: {
  interactive: boolean | (() => Promise<boolean>);
  removedEarlier?: boolean | Error;
}) {
  const { prepared, begun, policy } = ledger();
  const reads: string[] = [];
  const hooks = withRepositoryAttachApproval(policy, {
    interactive: input.interactive,
    removedEarlier: async (repository) => {
      reads.push(repository);
      if (input.removedEarlier instanceof Error) throw input.removedEarlier;
      return input.removedEarlier ?? false;
    },
  });
  return { prepared, begun, hooks, reads };
}

test("an attended attach asks, naming the repository, branch and access", async () => {
  const { prepared, begun, hooks } = wrapped({ interactive: true });
  expect(await hooks.prepare(attachCall())).toMatchObject({ managed: true, decision: "ask" });
  expect(prepared[0]!.call).toMatchObject({
    approvalMode: "session_mcp",
    defaultDecision: "ask",
    reviewContext: {
      kind: "generic",
      title: "Attach example-owner/service to this chat",
      targetFacts: [
        { label: "Repository", value: "example-owner/service" },
        { label: "Branch", value: "Default branch" },
        { label: "Access", value: "Workspace GitHub App" },
      ],
    },
  });
  await hooks.begin(attachCall());
  expect(begun[0]!.reviewContext?.title).toBe("Attach example-owner/service to this chat");
});

test("the card names an asked branch and notes a repository removed earlier", async () => {
  const { prepared, hooks, reads } = wrapped({ interactive: true, removedEarlier: true });
  await hooks.prepare(attachCall({ repository: " example-owner/project ", ref: "release/2" }));
  expect(reads).toEqual(["example-owner/project"]);
  expect(prepared[0]!.call.reviewContext?.targetFacts).toEqual([
    { label: "Repository", value: "example-owner/project" },
    { label: "Branch", value: "release/2" },
    { label: "Access", value: "Workspace GitHub App" },
    { label: "Note", value: "Removed from this chat earlier" },
  ]);
});

test("a failed removal read still asks, without the note", async () => {
  const { prepared, hooks } = wrapped({ interactive: true, removedEarlier: new Error("db") });
  expect(await hooks.prepare(attachCall())).toMatchObject({ decision: "ask" });
  expect(prepared[0]!.call.reviewContext?.targetFacts).toHaveLength(3);
});

test("where nobody can answer, an attach is refused and never reaches the ledger", async () => {
  const { prepared, begun, hooks } = wrapped({ interactive: false });
  expect(await hooks.prepare(attachCall())).toEqual({ managed: true, decision: "block" });
  expect(await hooks.begin(attachCall())).toEqual({
    allowed: false,
    managed: true,
    requestId: "call-1",
    reason: "blocked",
  });
  expect(prepared).toEqual([]);
  expect(begun).toEqual([]);
});

test("one call keeps its first decision; a failed interactive read asks", async () => {
  let reads = 0;
  const { prepared, hooks } = wrapped({
    interactive: async () => {
      reads += 1;
      throw new Error("chain root unavailable");
    },
  });
  await hooks.prepare(attachCall());
  await hooks.begin(attachCall());
  await hooks.prepare(attachCall({ repository: "example-owner/project" }, "call-2"));
  expect(reads).toBe(1);
  expect(prepared.map((entry) => entry.decision)).toEqual(["ask", "ask"]);
});

test("other tools pass through untouched", async () => {
  const { prepared, hooks, reads } = wrapped({ interactive: false });
  const other: ConnectorActionToolCall = {
    ...attachCall(),
    toolName: "github_repositories_list",
    approvalMode: undefined,
    defaultDecision: "allow",
  };
  expect(await hooks.prepare(other)).toMatchObject({ decision: "allow" });
  expect(prepared[0]!.call).toBe(other);
  expect(reads).toEqual([]);
});

test("reads the repository a call names", () => {
  expect(repositoryAttachRequest({ arguments: { repository: "a/b", ref: " main " } })).toEqual({
    repository: "a/b",
    ref: "main",
  });
  expect(repositoryAttachRequest({ arguments: { repository: " " } })).toBeNull();
  expect(repositoryAttachRequest({ arguments: ["a/b"] })).toBeNull();
  expect(githubRepositoryAttachUri("Example-Owner/Service")).toBe(
    "https://github.com/Example-Owner/Service.git",
  );
  expect(githubRepositoryAttachUri("https://github.com/a/b.git/")).toBe(
    "https://github.com/a/b.git",
  );
  expect(githubRepositoryAttachUri("not a repository")).toBeNull();
});
