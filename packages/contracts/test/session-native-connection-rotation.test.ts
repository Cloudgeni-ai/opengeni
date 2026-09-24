import { expect, test } from "bun:test";
import { RotateSessionMcpCredentialsRequest } from "../src/index";

const request = {
  operationKey: "11111111-1111-4111-8111-111111111111",
  updates: [
    {
      id: "external",
      expectedCredentialVersion: 1,
      expectedServerUrl: "https://tools.example.test/mcp",
      nativeConnectionId: "22222222-2222-4222-8222-222222222222",
    },
  ],
};

test("standalone rotation accepts an exact native account without caller-supplied authority", () => {
  expect(RotateSessionMcpCredentialsRequest.parse(request)).toEqual(request);
});

test("native replacement can explicitly name the new account-bound destination while retaining the old URL precondition", () => {
  const candidate = {
    ...request,
    updates: [
      {
        ...request.updates[0]!,
        replacementServerUrl: "https://tools.example.test/mcp/organizations/example",
      },
    ],
  };
  expect(RotateSessionMcpCredentialsRequest.parse(candidate)).toEqual(candidate);
});

test("native replacement cannot also provide inline secrets, owners, or authority refs", () => {
  for (const extra of [
    { headers: { authorization: "Bearer synthetic" } },
    { subjectId: "someone-else" },
    { connectionRef: { authoritySource: "host", connectionId: "host-ref" } },
  ]) {
    expect(
      RotateSessionMcpCredentialsRequest.safeParse({
        ...request,
        updates: [{ ...request.updates[0], ...extra }],
      }).success,
    ).toBe(false);
  }
});

test("native replacement retains exact destination and version preconditions", () => {
  for (const patch of [
    { expectedCredentialVersion: 0 },
    { expectedServerUrl: "http://tools.example.test/mcp" },
    { nativeConnectionId: "host-opaque-id" },
  ]) {
    expect(
      RotateSessionMcpCredentialsRequest.safeParse({
        ...request,
        updates: [{ ...request.updates[0], ...patch }],
      }).success,
    ).toBe(false);
  }
});
