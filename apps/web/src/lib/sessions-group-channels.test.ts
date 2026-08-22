import { describe, expect, test } from "bun:test";

import { creatorHue, creatorInitials } from "./creator-initials";
import { buildRailForest, channelRailSections, summarizeRailNodes } from "./sessions-group";
import type { Session } from "../types";

// channelRailSections only reads id / parentSessionId / status / channelId /
// timestamps off the sessions inside the forest, so a bounded fixture keeps
// this focused without replaying the whole Session contract.
function session(patch: Partial<Session> & Pick<Session, "id">): Session {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "idle",
    initialMessage: "hi",
    title: null,
    parentSessionId: null,
    channelId: null,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: activeControl(),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  } as Session;
}

function activeControl(): Session["effectiveControl"] {
  return {
    state: "active",
    controlVersion: 0,
    controlEtag: "active-0",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  };
}

function pausedControl(): Session["effectiveControl"] {
  const blocker = {
    kind: "session" as const,
    sessionId: "paused",
    displayName: "Paused here",
    actor: null,
    reason: null,
    changedAt: null,
    revision: 1,
  };
  return {
    ...activeControl(),
    state: "paused",
    controlVersion: 1,
    controlEtag: "paused-1",
    directState: "paused",
    primaryBlocker: blocker,
    blockers: [blocker],
    resumeOptions: [],
  };
}

const CHANNELS = [
  { id: "channel-knowledge", name: "knowledge" },
  { id: "channel-security", name: "security" },
];

describe("channelRailSections", () => {
  test("puts projects in channel order before unfiled Default", () => {
    const forest = buildRailForest([
      session({ id: "s-unfiled" }),
      session({ id: "s-security", channelId: "channel-security" }),
      session({ id: "s-running", channelId: "channel-security", status: "running" }),
    ]);
    const sections = channelRailSections(forest, CHANNELS);
    expect(sections.map((section) => section.key)).toEqual([
      "channel-knowledge",
      "channel-security",
      "default",
    ]);
    // knowledge stays visible while empty; security floats its running root first.
    expect(sections[0]!.sessions).toEqual([]);
    expect(sections[1]!.sessions.map((node) => node.session.id)).toEqual([
      "s-running",
      "s-security",
    ]);
    expect(sections[2]!.name).toBe("Default");
    expect(sections[2]!.channelId).toBeNull();
    expect(sections[2]!.sessions.map((node) => node.session.id)).toEqual(["s-unfiled"]);
  });

  test("omits empty Default and folds unknown project ids into it otherwise", () => {
    const filedOnly = channelRailSections(
      buildRailForest([session({ id: "s-1", channelId: "channel-security" })]),
      CHANNELS,
    );
    expect(filedOnly.some((section) => section.channelId === null)).toBe(false);

    const orphaned = channelRailSections(
      buildRailForest([session({ id: "s-orphan", channelId: "channel-deleted" })]),
      CHANNELS,
    );
    const defaultSection = orphaned.find((section) => section.channelId === null);
    expect(defaultSection?.key).toBe("default");
    expect(defaultSection?.sessions.map((node) => node.session.id)).toEqual(["s-orphan"]);
  });

  test("children stay nested under their root's channel section", () => {
    const forest = buildRailForest([
      session({ id: "root", channelId: "channel-security" }),
      session({ id: "child", parentSessionId: "root" }),
    ]);
    const sections = channelRailSections(forest, CHANNELS);
    const security = sections.find((section) => section.channelId === "channel-security");
    expect(security?.sessions).toHaveLength(1);
    expect(security?.sessions[0]!.children.map((node) => node.session.id)).toEqual(["child"]);
    // The unfiled child must not surface as its own Default root.
    expect(sections.some((section) => section.channelId === null)).toBe(false);
  });
});

describe("summarizeRailNodes", () => {
  test("shows a local message delivery failure without calling the session failed", () => {
    const forest = buildRailForest([session({ id: "delivery-failed", status: "idle" })]);
    const nodes = forest.grouped.flatMap((bucket) => bucket.sessions);
    expect(summarizeRailNodes(nodes, new Map([["delivery-failed", 2]]))).toEqual({
      kind: "send_failed",
      count: 2,
      total: 1,
      label: "2 messages not sent",
    });
    expect(nodes[0]?.session.status).toBe("idle");
  });

  test("keeps a loaded child's local failure visible through server tree stats", () => {
    const forest = buildRailForest([
      session({
        id: "root",
        treeStats: {
          directChildren: 1,
          totalDescendants: 1,
          runningDescendants: 0,
          queuedDescendants: 0,
          attentionDescendants: 0,
          pausedDescendants: 0,
          failedDescendants: 0,
          truncated: false,
        },
      }),
      session({ id: "child", parentSessionId: "root" }),
    ]);
    const nodes = forest.grouped.flatMap((bucket) => bucket.sessions);

    expect(summarizeRailNodes(nodes, new Map([["child", 1]]))).toEqual({
      kind: "send_failed",
      count: 1,
      total: 2,
      label: "1 message not sent",
    });
  });

  test("uses the highest-priority hidden descendant state", () => {
    const forest = buildRailForest([
      session({
        id: "root",
        status: "idle",
        treeStats: {
          directChildren: 4,
          totalDescendants: 4,
          runningDescendants: 1,
          queuedDescendants: 1,
          attentionDescendants: 1,
          pausedDescendants: 0,
          failedDescendants: 1,
          truncated: false,
        },
      }),
    ]);
    const summary = summarizeRailNodes(forest.running);
    expect(summary).toEqual({
      kind: "needs_attention",
      count: 1,
      total: 5,
      label: "1 needs you",
    });
  });

  test("treats capacity waits as working, not as needing user input", () => {
    const forest = buildRailForest([session({ id: "waiting", status: "waiting_capacity" })]);
    expect(summarizeRailNodes(forest.running)).toMatchObject({
      kind: "active",
      label: "1 working",
    });
  });

  test("does not count a paused queued child as working", () => {
    const forest = buildRailForest([
      session({ id: "root" }),
      session({
        id: "paused",
        parentSessionId: "root",
        status: "queued",
        effectiveControl: pausedControl(),
      }),
    ]);
    const nodes = forest.grouped.flatMap((bucket) => bucket.sessions);

    expect(forest.running).toEqual([]);
    expect(summarizeRailNodes(nodes)).toEqual({
      kind: "neutral",
      count: 0,
      total: 2,
      label: "Read",
    });
  });

  test("shows an acknowledged terminal section with no status marker", () => {
    const forest = buildRailForest([session({ id: "one" }), session({ id: "two" })]);
    const nodes = forest.grouped.flatMap((bucket) => bucket.sessions);
    expect(summarizeRailNodes(nodes)).toEqual({
      kind: "neutral",
      count: 0,
      total: 2,
      label: "Read",
    });
  });

  test("solid unread wins over the actively-working follow-up label", () => {
    const forest = buildRailForest([
      session({ id: "one", unread: true, activelyWorking: true }),
      session({ id: "two", activelyWorking: true }),
    ]);
    const nodes = forest.grouped.flatMap((bucket) => bucket.sessions);
    expect(summarizeRailNodes(nodes)).toEqual({
      kind: "unread",
      count: 1,
      total: 2,
      label: "1 unread",
    });
  });
});

describe("creatorInitials", () => {
  test("derives two-letter monograms from labels and subject ids", () => {
    expect(
      creatorInitials({ kind: "subject", subjectId: "user:x", label: "Davlet Dzhakishev" }),
    ).toBe("DD");
    expect(creatorInitials({ kind: "subject", subjectId: "user:x", label: "iuliia" })).toBe("IU");
    expect(creatorInitials({ kind: "subject", subjectId: "user:bendik" })).toBe("BE");
  });

  test("hides machinery: service and unattributed-legacy creators get none", () => {
    expect(creatorInitials({ kind: "service", subjectId: "scheduled-task" })).toBeNull();
    expect(creatorInitials({ kind: "subject", subjectId: "unattributed-legacy" })).toBeNull();
  });

  test("hue is stable per subject and in range", () => {
    const hue = creatorHue("user:test");
    expect(hue).toBe(creatorHue("user:test"));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});
