import { expect, test } from "bun:test";
import { IssueHostMcpDelegationRequest } from "../src/host-mcp-bindings";

const input = (grant: unknown) => ({
  operationId: crypto.randomUUID(),
  bindingId: crypto.randomUUID(),
  expectedBindingGeneration: 1,
  grant,
});
test("host delegation retains native grant mode and shared-output acknowledgement", () => {
  for (const mode of ["always", "session"]) {
    const bound =
      mode === "session" ? { sessionId: crypto.randomUUID(), expectedAuthorityEpoch: 1 } : {};
    expect(
      IssueHostMcpDelegationRequest.safeParse(
        input({ scope: "user", mode, context: "user_private", ...bound }),
      ).success,
    ).toBe(true);
    expect(
      IssueHostMcpDelegationRequest.safeParse(
        input({ scope: "user", mode, context: "workspace_shared", ...bound }),
      ).success,
    ).toBe(false);
    expect(
      IssueHostMcpDelegationRequest.safeParse(
        input({
          scope: "user",
          mode,
          context: "workspace_shared",
          workspaceSharedAcknowledged: true,
          ...bound,
        }),
      ).success,
    ).toBe(true);
  }
  expect(
    IssueHostMcpDelegationRequest.safeParse(
      input({ scope: "user", mode: "once", context: "user_private" }),
    ).success,
  ).toBe(false);
});
test("host delegation requires paired session and safe epoch without key authority", () => {
  const grant = {
    scope: "user",
    mode: "session",
    context: "user_private",
    sessionId: crypto.randomUUID(),
    expectedAuthorityEpoch: 1,
  };
  expect(IssueHostMcpDelegationRequest.safeParse(input(grant)).success).toBe(true);
  for (const patch of [
    { expectedAuthorityEpoch: undefined },
    { sessionId: undefined },
    { mode: "always" },
    { expectedAuthorityEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(IssueHostMcpDelegationRequest.safeParse(input({ ...grant, ...patch })).success).toBe(
      false,
    );
  expect(
    IssueHostMcpDelegationRequest.safeParse({ ...input(grant), apiKeyId: crypto.randomUUID() })
      .success,
  ).toBe(false);
});
