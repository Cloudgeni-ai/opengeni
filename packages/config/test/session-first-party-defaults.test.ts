import { expect, test } from "bun:test";
import { resolveSessionFirstPartyMcpTools } from "../src";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type FirstPartyMcpToolName,
  type SessionToolPolicy,
} from "@opengeni/contracts";

const defaults: FirstPartyMcpToolName[] = ["session_get", "custom_mcp_setup_request"];
const settings = { defaultFirstPartyMcpTools: defaults, allowedFirstPartyMcpTools: defaults };
const policy: SessionToolPolicy = {
  mode: "workspace_default",
  inheritedFromSessionId: null,
  firstPartyMode: "workspace_default",
};
const session = {
  toolPolicy: policy,
  firstPartyMcpTools: ["session_get"] as FirstPartyMcpToolName[],
};

test("follow-default sessions receive new defaults without mutating their stored snapshot", () => {
  expect(resolveSessionFirstPartyMcpTools(settings, session, {})).toEqual(defaults);
  expect(session.firstPartyMcpTools).toEqual(["session_get"]);
});

test("current deployment defaults restore notification tools absent from an old session snapshot", () => {
  const oldSession = {
    ...session,
    firstPartyMcpTools: DEFAULT_FIRST_PARTY_MCP_TOOLS.filter(
      (tool) => tool !== "notify_user" && tool !== "notification_withdraw" && tool !== "inbox_tidy",
    ),
  };
  const before = structuredClone(oldSession);
  const effective = resolveSessionFirstPartyMcpTools({}, oldSession, {});
  expect(effective).toContain("notify_user");
  expect(effective).toContain("notification_withdraw");
  expect(effective).toContain("inbox_tidy");
  expect(oldSession).toEqual(before);
});

test("notification defaults never widen explicit pins or ambiguous legacy snapshots", () => {
  for (const firstPartyMode of [undefined, "explicit"] as const) {
    for (const firstPartyMcpTools of [[], ["session_get"]] as FirstPartyMcpToolName[][]) {
      expect(
        resolveSessionFirstPartyMcpTools(
          {},
          { ...session, firstPartyMcpTools, toolPolicy: { ...policy, firstPartyMode } },
          {},
        ),
      ).toEqual(firstPartyMcpTools);
    }
  }
});

test("notification defaults remain bounded by deployment and workspace overrides", () => {
  expect(
    resolveSessionFirstPartyMcpTools({ allowedFirstPartyMcpTools: ["session_get"] }, session, {}),
  ).not.toContain("notify_user");
  expect(
    resolveSessionFirstPartyMcpTools({}, session, {
      sessionToolDefaults: { firstPartyMcpTools: [] },
    }),
  ).toEqual([]);
  expect(
    resolveSessionFirstPartyMcpTools({ defaultFirstPartyMcpTools: ["session_get"] }, session, {}),
  ).toEqual(["session_get"]);
});

test("explicit and ambiguous legacy selections, including empty selections, stay pinned", () => {
  for (const firstPartyMode of [undefined, "explicit"] as const) {
    for (const firstPartyMcpTools of [[], ["session_get"]] as FirstPartyMcpToolName[][]) {
      expect(
        resolveSessionFirstPartyMcpTools(
          settings,
          {
            toolPolicy: { ...policy, firstPartyMode },
            firstPartyMcpTools,
          },
          {},
        ),
      ).toEqual(firstPartyMcpTools);
    }
  }
});

test("workspace defaults replace deployment defaults, including an explicit empty override", () => {
  for (const tools of [[], ["custom_mcp_setup_request"]] as FirstPartyMcpToolName[][]) {
    expect(
      resolveSessionFirstPartyMcpTools(settings, session, {
        sessionToolDefaults: { firstPartyMcpTools: tools },
      }),
    ).toEqual(tools);
  }
});

test("following defaults never lifts the deployment ceiling or preserves removed defaults", () => {
  expect(
    resolveSessionFirstPartyMcpTools(
      {
        defaultFirstPartyMcpTools: ["custom_mcp_setup_request", "session_pause"],
        allowedFirstPartyMcpTools: defaults,
      },
      session,
      {},
    ),
  ).toEqual(["custom_mcp_setup_request"]);
});

test("guaranteed additions ride on top of whatever defaults the session follows", () => {
  const withAdditions = {
    toolPolicy: { ...policy, firstPartyAdditions: ["session_pause"] as FirstPartyMcpToolName[] },
    firstPartyMcpTools: ["session_get", "session_pause"] as FirstPartyMcpToolName[],
  };
  const wider = { ...settings, allowedFirstPartyMcpTools: [...defaults, "session_pause"] as const };
  // Deployment defaults, then a workspace override (even an empty one), each
  // keep the additions; new defaults still arrive.
  expect(resolveSessionFirstPartyMcpTools(wider, withAdditions, {})).toEqual([
    ...defaults,
    "session_pause",
  ]);
  expect(
    resolveSessionFirstPartyMcpTools(wider, withAdditions, {
      sessionToolDefaults: { firstPartyMcpTools: [] },
    }),
  ).toEqual(["session_pause"]);
  // The deployment ceiling still bounds an addition.
  expect(resolveSessionFirstPartyMcpTools(settings, withAdditions, {})).toEqual(defaults);
  // An explicit selection ignores additions entirely.
  expect(
    resolveSessionFirstPartyMcpTools(
      wider,
      {
        ...withAdditions,
        toolPolicy: { ...withAdditions.toolPolicy, firstPartyMode: "explicit" },
        firstPartyMcpTools: [],
      },
      {},
    ),
  ).toEqual([]);
});
