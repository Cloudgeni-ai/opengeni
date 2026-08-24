// The routing decision is made from durable facts before any agent runs, so it
// is pure and testable without a database. The cases that matter are the ones
// where a wrong answer is invisible: a thread that silently changes tenant, a
// failed override that falls through as if it were a suggestion, and any path
// that quietly serves a request from a workspace the person did not name.
import { describe, expect, test } from "bun:test";
import {
  isSlackDirectMessageConversation,
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
    expect(slackRoutedRequestText("in Acme:   ship it", resolution)).toBe("ship it");
  });

  test("leaves the text alone for every other source", () => {
    const resolution = resolveSlackWorkspaceRoute(inputs({ routingEnabled: false }));
    expect(slackRoutedRequestText("in Acme: ship it", resolution)).toBe("in Acme: ship it");
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
    const resolution = resolveSlackWorkspaceRoute(
      inputs({
        routingEnabled: false,
        threadTenancy: { accountId: ACCOUNT, workspaceId: LABS.workspaceId },
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

  test("a direct message from someone with no workspace of their own is refused", () => {
    expect(
      resolveSlackWorkspaceRoute(
        inputs({
          entry: { ...inputs().entry, triggerKind: "dm", slackChannelId: "D-SAM" },
          personalWorkspaceId: null,
        }),
      ),
    ).toMatchObject({ kind: "denied", reason: "no_candidates" });
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
