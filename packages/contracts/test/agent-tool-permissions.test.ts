import { describe, expect, test } from "bun:test";
import { agentToolPermissionFor } from "../src/index";

const target = {
  serverId: "server-gmail",
  providerDomain: "gmail.com",
  toolName: "send_email",
};

describe("agentToolPermissionFor", () => {
  test("no matching rule leaves the connection's own setting", () => {
    expect(agentToolPermissionFor([], target)).toBeNull();
    expect(
      agentToolPermissionFor([{ connector: "github.com", tool: "*", permission: "block" }], target),
    ).toBeNull();
  });

  test("server id beats provider domain beats every connector", () => {
    const rules = [
      { connector: "*", tool: "*", permission: "block" as const },
      { connector: "gmail.com", tool: "*", permission: "ask" as const },
    ];
    expect(agentToolPermissionFor(rules, target)).toBe("ask");
    expect(
      agentToolPermissionFor(
        [
          ...rules,
          {
            connector: "server-gmail",
            tool: "*",
            permission: "allow" as const,
          },
        ],
        target,
      ),
    ).toBe("allow");
  });

  test("an exact tool beats all tools of the same connector, and domains match case-insensitively", () => {
    const rules = [
      { connector: "Gmail.com", tool: "*", permission: "block" as const },
      {
        connector: "gmail.com",
        tool: "send_email",
        permission: "ask" as const,
      },
    ];
    expect(agentToolPermissionFor(rules, target)).toBe("ask");
    expect(agentToolPermissionFor(rules, { ...target, toolName: "list_messages" })).toBe("block");
  });

  test("equally specific rules resolve to the strictest", () => {
    const rules = [
      { connector: "gmail.com", tool: "*", permission: "allow" as const },
      { connector: "gmail.com", tool: "*", permission: "block" as const },
      { connector: "gmail.com", tool: "*", permission: "ask" as const },
    ];
    expect(agentToolPermissionFor(rules, target)).toBe("block");
  });

  test("a missing tool means all tools", () => {
    expect(agentToolPermissionFor([{ connector: "gmail.com", permission: "ask" }], target)).toBe(
      "ask",
    );
  });
});
