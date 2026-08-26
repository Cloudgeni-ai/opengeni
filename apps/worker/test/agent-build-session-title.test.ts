import { describe, expect, test } from "bun:test";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
} from "@opengeni/contracts";

import {
  shouldRequestMissingSessionTitle,
  withEagerSessionTitleTool,
} from "../src/activities/agent-turn/session-title";

describe("shouldRequestMissingSessionTitle", () => {
  test("requests semantic titling while the durable title is absent or still the fallback", () => {
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(true);
    expect(
      shouldRequestMissingSessionTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "agent",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(true);
  });

  test("does not advertise an unavailable, unauthorized, or human-locked title tool", () => {
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: [],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: null,
        titleSource: null,
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: ["sessions:read"],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: "Human title",
        titleSource: "user",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: AUTOMATIC_SESSION_TITLE_FALLBACK,
        titleSource: "user",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
    expect(
      shouldRequestMissingSessionTitle({
        title: "Semantic agent title",
        titleSource: "agent",
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      }),
    ).toBe(false);
  });
});

describe("withEagerSessionTitleTool", () => {
  test("makes an already-selected first-party server visible on title-needing first requests", () => {
    expect(
      withEagerSessionTitleTool(
        [
          { kind: "mcp", id: "opengeni" },
          { kind: "mcp", id: "connector", optional: true },
        ],
        true,
      ),
    ).toEqual([
      { kind: "mcp", id: "opengeni", eager: true },
      { kind: "mcp", id: "connector", optional: true },
    ]);
  });

  test("does not grant the server or make semantic-title turns eager", () => {
    const withoutFirstParty = [{ kind: "mcp" as const, id: "connector" }];
    expect(withEagerSessionTitleTool(withoutFirstParty, true)).toBe(withoutFirstParty);

    const titled = [{ kind: "mcp" as const, id: "opengeni" }];
    expect(withEagerSessionTitleTool(titled, false)).toBe(titled);
  });
});
