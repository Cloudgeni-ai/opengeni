// The routing decision is made from durable facts before any agent runs, so it
// is pure and testable without a database. The cases that matter are the ones
// where a wrong answer is invisible: a thread that silently changes tenant, a
// failed override that falls through as if it were a suggestion, and any path
// that quietly serves a request from a workspace the person did not name.
import { describe, expect, test } from "bun:test";
import {
  isSlackDirectMessageConversation,
  splitSlackLeadingMention,
  parseSlackWorkspacePrefix,
  resolveSlackWorkspaceRoute,
  slackRoutedRequestText,
  type SlackRouteInputs,
} from "../src/integrations/slack-routing";

const ACCOUNT = "account-1";
const HOME = { accountId: ACCOUNT, workspaceId: "workspace-home" };
const ACME = { accountId: ACCOUNT, workspaceId: "workspace-acme", label: "Acme", personal: false };
const LABS = {
  accountId: ACCOUNT,
  workspaceId: "workspace-labs",
  label: "Acme Labs",
  personal: false,
};
const PERSONAL = {
  accountId: ACCOUNT,
  workspaceId: "workspace-personal",
  label: "Sam",
  personal: true,
};

function inputs(overrides: Partial<SlackRouteInputs> = {}): SlackRouteInputs {
  return {
    home: HOME,
    entry: {
      triggerKind: "app_mention",
      slackChannelId: "C-DESIGN",
      slackUserId: "U-SAM",
      text: "ship it",
    },
    threadTenancy: null,
    channelRoute: null,
    dmRoute: null,
    personalWorkspaceId: null,
    candidates: [ACME, LABS],
    botUserId: "U0BOT",
    routingEnabled: true,
    askEnabled: true,
    ...overrides,
  };
}

function channelRoute(workspaceId: string) {
  return {
    id: "route-1",
    accountId: ACCOUNT,
    workspaceId: HOME.workspaceId,
    connectionId: "connection-1",
    slackTeamId: "T1",
    slackChannelId: "C-DESIGN",
    targetAccountId: ACCOUNT,
    targetWorkspaceId: workspaceId,
    decidedBySubjectId: "user:sam",
    decidedBySlackUserId: "U-SAM",
    source: "picker" as const,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("the strict workspace prefix", () => {
  test("matches only at byte 0", () => {
    expect(parseSlackWorkspacePrefix("in Acme: ship it")).toEqual({
      requested: "Acme",
      remainder: "ship it",
    });
    expect(parseSlackWorkspacePrefix("In acme: ship it")?.requested).toBe("acme");
    expect(parseSlackWorkspacePrefix("working in Acme: ship it")).toBeNull();
    expect(parseSlackWorkspacePrefix("  in Acme: ship it")).toBeNull();
  });

  test("refuses shapes that are not an override", () => {
    expect(parseSlackWorkspacePrefix("in Acme ship it")).toBeNull();
    expect(parseSlackWorkspacePrefix("in : ship it")).toBeNull();
    expect(parseSlackWorkspacePrefix("in\nAcme: ship it")).toBeNull();
    // A colon on a later line is punctuation, not a prefix.
    expect(parseSlackWorkspacePrefix("in Acme\nnote: ship it")).toBeNull();
    expect(parseSlackWorkspacePrefix("stop")).toBeNull();
  });

  test("keeps the request text and drops only the addressing", () => {
    const resolution = resolveSlackWorkspaceRoute(
      inputs({ entry: { ...inputs().entry, text: "in Acme:   ship it" } }),
    );
    expect(resolution).toMatchObject({ kind: "resolved", source: "prefix" });
    expect(slackRoutedRequestText("in Acme:   ship it", resolution, "U0BOT")).toBe("ship it");
  });

  test("leaves the text alone for every other source", () => {
    const resolution = resolveSlackWorkspaceRoute(inputs({ routingEnabled: false }));
    expect(slackRoutedRequestText("in Acme: ship it", resolution, "U0BOT")).toBe(
      "in Acme: ship it",
    );
  });
});

describe("direct message detection", () => {
  test("covers both the dm trigger and a D-prefixed channel", () => {
    expect(
      isSlackDirectMessageConversation({ triggerKind: "dm", slackChannelId: "C-OPEN" }),
    ).toBe(true);
    expect(
      isSlackDirectMessageConversation({ triggerKind: "app_mention", slackChannelId: "D-SAM" }),
    ).toBe(true);
    expect(
      isSlackDirectMessageConversation({ triggerKind: "app_mention", slackChannelId: "C-OPEN" }),
    ).toBe(false);
  });
});

describe("the routing decision order", () => {
  test("with the flag off it is the installation workspace and nothing is read", () => {
    // A channel route and an explicit prefix are both ignored. A mapped thread
    // is NOT: its session genuinely lives there, and rollback must not address
    // a live conversation in a workspace it is not in.
    const resolution = resolveSlackWorkspaceRoute(
      inputs({
        routingEnabled: false,
        channelRoute: channelRoute(ACME.workspaceId),
        entry: { ...inputs().entry, text: "in Acme Labs: ship it" },
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      workspaceId: HOME.workspaceId,
      source: "installation",
    });
  });

  test("a mapped thread keeps its workspace even after the channel is re-pointed", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          threadTenancy: { accountId: ACCOUNT, workspaceId: ACME.workspaceId },
          channelRoute: channelRoute(LABS.workspaceId),
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: ACME.workspaceId, source: "thread" });
  });

  test("a thread beats an explicit prefix, because the thread already exists", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          threadTenancy: { accountId: ACCOUNT, workspaceId: ACME.workspaceId },
          entry: { ...inputs().entry, text: "in Acme Labs: ship it" },
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: ACME.workspaceId, source: "thread" });
  });

  test("a prefix beats the channel route without changing it", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          channelRoute: channelRoute(ACME.workspaceId),
          entry: { ...inputs().entry, text: "in Acme Labs: ship it" },
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: LABS.workspaceId, source: "prefix" });
  });

  test("a prefix naming something the subject cannot reach is refused, never a fallthrough", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          channelRoute: channelRoute(ACME.workspaceId),
          entry: { ...inputs().entry, text: "in Finance: ship it" },
        }),
      ),
    ).toMatchObject({ kind: "denied", reason: "no_access_to_named", requested: "Finance" });
  });

  test("the channel's remembered answer wins over asking", () => {
    expect(
      resolveSlackWorkspaceRoute(inputs({ channelRoute: channelRoute(LABS.workspaceId) })),
    ).toMatchObject({ kind: "resolved", workspaceId: LABS.workspaceId, source: "channel" });
  });

  test("a direct message lands in the subject's own workspace", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: PERSONAL.workspaceId,
          candidates: [ACME, LABS, PERSONAL],
        }),
      ),
    ).toMatchObject({
      kind: "resolved",
      workspaceId: PERSONAL.workspaceId,
      label: "Sam",
      source: "dm_personal",
    });
  });

  test("an explicit direct-message route beats the personal default", () => {
    const dmRoute = { ...channelRoute(ACME.workspaceId), slackUserId: "U-SAM" };
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: PERSONAL.workspaceId,
          dmRoute,
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: ACME.workspaceId, source: "dm_route" });
  });

  test("a direct message from someone with no workspace of their own still asks", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: null,
        }),
      ),
    ).toEqual({ kind: "ask", candidates: [ACME, LABS] });
  });

  test("one workspace is not a choice, so it never asks", () => {
    expect(resolveSlackWorkspaceRoute(inputs({ candidates: [ACME] }))).toMatchObject({
      kind: "resolved",
      workspaceId: ACME.workspaceId,
      source: "sole_candidate",
    });
  });

  test("no workspace at all is a refusal, not the installation's", () => {
    expect(resolveSlackWorkspaceRoute(inputs({ candidates: [] }))).toMatchObject({
      kind: "denied",
      reason: "no_candidates",
    });
  });

  test("genuine ambiguity asks once", () => {
    expect(resolveSlackWorkspaceRoute(inputs())).toEqual({
      kind: "ask",
      candidates: [ACME, LABS],
    });
  });

  test("ambiguity keeps the installation workspace until the picker exists", () => {
    expect(resolveSlackWorkspaceRoute(inputs({ askEnabled: false }))).toMatchObject({
      kind: "resolved",
      workspaceId: HOME.workspaceId,
      source: "installation",
    });
  });
});

describe("the bot mention", () => {
  test("is split off so the prefix is the first thing the person typed", () => {
    expect(splitSlackLeadingMention("<@U0BOT> in Acme: ship it", "U0BOT")).toEqual({
      lead: "<@U0BOT> ",
      rest: "in Acme: ship it",
    });
    expect(splitSlackLeadingMention("in Acme: ship it", "U0BOT")).toEqual({
      lead: "",
      rest: "in Acme: ship it",
    });
    // Only a LEADING mention of THIS bot.
    expect(splitSlackLeadingMention("hi <@U0BOT> in Acme: x", "U0BOT").lead).toBe("");
    expect(splitSlackLeadingMention("<@U0OTHER> in Acme: x", "U0BOT").lead).toBe("");
    expect(splitSlackLeadingMention("<@U0BOT> in Acme: x", null).lead).toBe("");
  });

  test("does not hide an override on the surface routing exists for", () => {
    // Slack delivers an app_mention with the mention still in the text. Parsing
    // the prefix at byte 0 of the raw text would silently ignore every override
    // typed the natural way.
    const resolution = resolveSlackWorkspaceRoute(
      inputs({
        channelRoute: channelRoute(ACME.workspaceId),
        entry: { ...inputs().entry, text: "<@U0BOT> in Acme Labs: ship it" },
      }),
    );
    expect(resolution).toMatchObject({ kind: "resolved", workspaceId: LABS.workspaceId });
    expect(slackRoutedRequestText("<@U0BOT> in Acme Labs: ship it", resolution, "U0BOT")).toBe(
      "<@U0BOT> ship it",
    );
  });
});

describe("what may address a message", () => {
  test("a message shortcut never takes a prefix out of someone else's message", () => {
    // The text belongs to the message being acted on, not to the person
    // invoking OpenGeni, so a prefix there was never an instruction.
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: {
            ...inputs().entry,
            triggerKind: "message_shortcut",
            text: "in Acme Labs: something a colleague wrote",
          },
          channelRoute: channelRoute(ACME.workspaceId),
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: ACME.workspaceId, source: "channel" });
  });

  test("a bare address with no request is not an override", () => {
    expect(parseSlackWorkspacePrefix("in Acme:")).toBeNull();
    expect(parseSlackWorkspacePrefix("in Acme:   ")).toBeNull();
  });

  test("two workspaces with the same label are a refusal, not a coin flip", () => {
    const twin = { ...LABS, workspaceId: "workspace-twin", label: "Acme" };
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          candidates: [ACME, twin],
          entry: { ...inputs().entry, text: "in acme: ship it" },
        }),
      ),
    ).toMatchObject({ kind: "denied", reason: "no_access_to_named", requested: "acme" });
  });
});

describe("turning the flag back off", () => {
  test("still keeps a mapped thread in the workspace it actually lives in", () => {
    // Rollback must stop NEW routing, not strand a live conversation by
    // addressing it in a workspace its session is not in.
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          routingEnabled: false,
          threadTenancy: { accountId: ACCOUNT, workspaceId: LABS.workspaceId },
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: LABS.workspaceId, source: "thread" });
  });
});

describe("a direct message with no workspace of one's own", () => {
  test("falls through to the ordinary rules instead of refusing", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: null,
          candidates: [ACME],
        }),
      ),
    ).toMatchObject({ kind: "resolved", workspaceId: ACME.workspaceId, source: "sole_candidate" });
  });

  test("is refused only when there is genuinely nowhere to work", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: null,
          candidates: [],
        }),
      ),
    ).toMatchObject({ kind: "denied", reason: "no_candidates" });
  });
});
