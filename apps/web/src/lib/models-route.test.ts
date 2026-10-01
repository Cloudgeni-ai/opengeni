import { describe, expect, test } from "bun:test";

import {
  accountKey,
  accountKeyOf,
  connectStepOf,
  parseModelsAccount,
  parseModelsView,
  workspaceModelsRedirect,
} from "./models-route";

describe("Models URLs", () => {
  test("organization accounts and connect steps have their own keys", () => {
    expect(parseModelsAccount("org:codex:acct-1")).toBe("org:codex:acct-1");
    expect(parseModelsAccount("org:gateway:openrouter")).toBe("org:gateway:openrouter");
    expect(parseModelsAccount("org:org:codex:acct-1")).toBeUndefined();
    expect(accountKeyOf("org:supergrok:x")).toEqual({
      provider: "supergrok",
      id: "x",
      organization: true,
    });
    expect(accountKeyOf("gateway:vercel")).toEqual({
      provider: "gateway",
      id: "vercel",
      organization: false,
    });
    expect(accountKey("codex", "acct-1", true)).toBe("org:codex:acct-1");
    expect(parseModelsView("connect-org:codex")).toBe("connect-org:codex");
    expect(parseModelsView("connect-workspace")).toBe("connect-workspace");
    expect(parseModelsView("connect-org:nope")).toBeUndefined();
    expect(connectStepOf("connect-org:openrouter")).toEqual({
      provider: "openrouter",
      organization: true,
    });
    expect(connectStepOf("connect:codex")).toEqual({ provider: "codex", organization: false });
    expect(connectStepOf("connect")).toBeNull();
  });

  test("a workspace's old Models URL opens its page in Organization settings > Models", () => {
    expect(
      workspaceModelsRedirect({ workspaceId: "ws-1", account: undefined, view: undefined }),
    ).toEqual({ section: "models", workspace: "ws-1" });
    expect(
      workspaceModelsRedirect({ workspaceId: "ws-1", account: "codex:acct-1", view: undefined }),
    ).toEqual({ section: "models", workspace: "ws-1", account: "codex:acct-1" });
    expect(
      workspaceModelsRedirect({
        workspaceId: "ws-1",
        account: "org:gateway:vercel",
        view: "model-access",
      }),
    ).toEqual({
      section: "models",
      workspace: "ws-1",
      account: "org:gateway:vercel",
      view: "model-access",
    });
    expect(
      workspaceModelsRedirect({
        workspaceId: "ws-1",
        account: undefined,
        view: "connect-workspace",
      }),
    ).toEqual({ section: "models", workspace: "ws-1", view: "connect" });
  });
});
