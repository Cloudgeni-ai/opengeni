import { expect, test } from "bun:test";
import { authorizeConnectAttempt, type ConnectAttempt } from "../src";

const attempt: ConnectAttempt = {
  id: "attempt",
  workspaceId: "workspace",
  providerId: "provider",
  ownership: "personal",
  revision: 1,
  state: "requires_user_action",
  credentialsCommitted: false,
  integrationInstalled: false,
  completionRequirement: "connection",
  nextAction: { type: "authorize", url: "https://provider.example/authorize?state=%2f" },
  expiresAt: "2030-01-01T00:00:00Z",
};
test("popup opens synchronously and only backend completion resolves it", async () => {
  let opened = "";
  let closed = false;
  const complete: ConnectAttempt = {
    ...attempt,
    revision: 2,
    state: "complete",
    credentialsCommitted: true,
    nextAction: { type: "none" },
  };
  const pending = authorizeConnectAttempt(
    { get: async () => complete },
    attempt,
    {
      openPopup: (url) => {
        opened = url;
        return {
          close: () => {
            closed = true;
          },
        };
      },
      redirect: () => {
        throw new Error("unexpected redirect");
      },
    },
    { mode: "popup" },
  );
  expect(opened).toBe("https://provider.example/authorize?state=%2f");
  expect(await pending).toEqual(complete);
  expect(closed).toBe(true);
});
test("blocked popup does not poll or silently redirect", () => {
  expect(() =>
    authorizeConnectAttempt(
      {
        get: async () => {
          throw new Error("unexpected poll");
        },
      },
      attempt,
      {
        openPopup: () => null,
        redirect: () => {
          throw new Error("unexpected redirect");
        },
      },
      { mode: "popup" },
    ),
  ).toThrow("blocked");
});
test("popup rejects older completion and still closes the window", async () => {
  let closed = false;
  await expect(
    authorizeConnectAttempt(
      {
        get: async () => ({
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
        }),
      },
      { ...attempt, revision: 3 },
      {
        openPopup: () => ({
          close: () => {
            closed = true;
          },
        }),
        redirect: () => {},
      },
      { mode: "popup" },
    ),
  ).rejects.toThrow("revision mismatch");
  expect(closed).toBe(true);
});
test("redirect preserves authorization URL and leaves recovery to host", async () => {
  let url = "";
  expect(
    await authorizeConnectAttempt(
      {
        get: async () => {
          throw new Error("unexpected poll");
        },
      },
      attempt,
      {
        openPopup: () => {
          throw new Error("unexpected popup");
        },
        redirect: (value) => {
          url = value;
        },
      },
      { mode: "redirect" },
    ),
  ).toBeNull();
  expect(url).toBe("https://provider.example/authorize?state=%2f");
});
test("unsafe destination is rejected before navigation", () => {
  expect(() =>
    authorizeConnectAttempt(
      { get: async () => attempt },
      { ...attempt, nextAction: { type: "authorize", url: "javascript:alert(1)" } },
      {
        openPopup: () => {
          throw new Error("unexpected popup");
        },
        redirect: () => {},
      },
      { mode: "popup" },
    ),
  ).toThrow("HTTPS");
});
