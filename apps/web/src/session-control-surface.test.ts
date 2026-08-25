import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${path}`).text();
}

describe("session control surface architecture", () => {
  test("renders SessionChrome above the composer", async () => {
    const route = await source("routes/session.tsx");
    expect(route.match(/<SessionChrome\b/g)).toHaveLength(1);
    expect(route).not.toContain("<QueueSurface");
    expect(route).not.toContain("<GoalSurface");
    expect(route).not.toContain("<ComposerAgentsPill");
    expect(route.indexOf("<SessionChrome")).toBeLessThan(route.indexOf("<ConsoleComposer"));
    // Both surfaces must share the same max-width child inside the same outer
    // page gutter. Putting the gutter inside only SessionChrome makes it 48px
    // narrower than the composer at desktop widths.
    expect(route).not.toContain('className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"');
    expect(route).toContain('className="mb-2 w-full shrink-0 px-4 sm:px-6"');
  });

  test("wires the authenticated retained screenshot loader into the production timeline", async () => {
    const route = await source("routes/session.tsx");
    expect(route).toContain("createSessionRetainedScreenshotLoader(");
    expect(route).toContain("loadRetainedScreenshot={loadRetainedScreenshot}");
  });

  test("routes every markdown sandbox file reference into Files without implicit publication", async () => {
    const route = await source("routes/session.tsx");
    expect(route).toContain("onSandboxFile={props.onOpenSandboxFile}");
    expect(route).not.toContain("downloadSandboxFileArtifact");
  });

  test("has no second Agents home in the header or dock", async () => {
    const [header, lineage, route] = await Promise.all([
      source("components/rail/session-header.tsx"),
      source("components/session/subagents.tsx"),
      source("routes/session.tsx"),
    ]);
    expect(header).not.toContain("agentsSlot");
    expect(lineage).not.toContain("AgentsPanel");
    expect(route).not.toContain('id: "agents"');
  });

  test("keeps setup above the prompt and model beside voice/send on new sessions", async () => {
    const route = await source("routes/sessions-index.tsx");
    const actions = route.indexOf("actions={");
    const model = route.indexOf("<SessionModelControl", actions);
    const voice = route.indexOf("<NewSessionRealtimeControl", model);
    const header = route.indexOf("header={", voice);
    const setup = route.indexOf("<SessionSetupStrip", header);
    expect(actions).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(actions);
    expect(voice).toBeGreaterThan(model);
    expect(header).toBeGreaterThan(voice);
    expect(setup).toBeGreaterThan(header);

    const setupImplementation = route.slice(
      route.indexOf("function SessionSetupStrip"),
      route.indexOf("function SessionModelControl"),
    );
    expect(setupImplementation).toContain("<SessionToolPicker");
    expect(setupImplementation).toContain("<SessionFolderPicker");
    expect(setupImplementation).toContain("<WorkspaceRepositoryPicker");
    expect(setupImplementation).not.toContain("<ModelPicker");
  });

  test("announces pin results through an independent live region", async () => {
    const [header, list] = await Promise.all([
      source("components/rail/session-header.tsx"),
      source("components/rail/session-list.tsx"),
    ]);
    // A persistent description on the action button would replay the previous
    // pin/unpin result every time keyboard focus returns. The result belongs in
    // the polite live region only, so it is announced at mutation time.
    expect(header).toContain('aria-live="polite"');
    expect(header).not.toContain("aria-describedby");
    // The same visible result can occur after a retry. Both pin surfaces use a
    // helper that still changes the live-region text node for that retry.
    expect(header).toContain("pinLiveAnnouncement");
    expect(list).toContain("pinLiveAnnouncement");
  });

  test("keeps rail optimistic pin overrides out of the header projection", async () => {
    const list = await source("components/rail/session-list.tsx");
    expect(list).toContain("const serverSessions = useMemo");
    expect(list).toContain("const projected = serverSessions.find");
    const paginationKey = list.match(/const paginationKey = sessionPageKey\([\s\S]*?\n  \);/)?.[0];
    expect(paginationKey).toContain("rail.workspaceId");
    expect(paginationKey).toContain('hierarchyMode ? "tree" : "browse"');
    expect(paginationKey).not.toContain("pinOverrides");
    expect(paginationKey).not.toContain("serverSessions");
  });

  test("hands keyboard focus across optimistic project-move remounts", async () => {
    const list = await source("components/rail/session-list.tsx");
    expect(list).toContain('void onMoveToChannel(session, channel.id, "actions")');
    expect(list).toContain('void onMoveToChannel(session, null, "actions")');
    expect(list).toContain("pendingSessionFocus.current = {");
    expect(list).toContain("if (!remountSelection.current) return;");
    expect(list).toContain("event.preventDefault();");
    expect(list).toContain("pending.settled = true;");
    expect(list).toContain("setFocusRestoreRevision((current) => current + 1)");
  });

  test("reconciles the open session project without regressing an owned optimistic move", async () => {
    const list = await source("components/rail/session-list.tsx");
    const move = await source("lib/session-channel-move.ts");
    const route = await source("routes/session.tsx");
    expect(list).toContain("applySessionChannelProjection(pinProjected, projected)");
    expect(list).toContain("channelMoveOverrides.has(openSessionId)");
    expect(list).toContain("readSessionChannelMovePoint(sessionClient");
    expect(list).toContain("sessionChannelProjectionAuthority.replace(");
    expect(list).toContain("rootReadGeneration");
    expect(list).toContain("globalPinsReadGeneration");
    expect(list).toContain("pinsChannelProjectionOwner");
    expect(list).toContain("currentListChannelEvidence");
    expect(list).toContain("sessionChannelProjectionAuthority.project(");
    expect(list).toContain("authoritativeSessionContinuationChannels(");
    expect(list).toContain("pageReadGeneration");
    expect(list).not.toContain("replace(owner, channelAuthoritySessions)");
    expect(list).not.toContain("replace(owner, listedSessions)");
    expect(list).toContain("applySessionRailProjection(session, projected, { channelOwned })");
    expect(list).toContain("sessionChannelProjectionAuthority.clear(owner)");
    expect(list).toContain("reconcileSessionChannelMovePointRead(");
    expect(list).toContain("reconcileSessionChannelMoves(current, channelAuthoritySessions)");
    expect(list).not.toContain("reconcileSessionChannelMoves(current, listedSessions)");
    expect(list).toContain("requestError.status === 404");
    expect(move).toContain("getSession(workspaceId, sessionId, {");
    expect(move).toContain("fresh: true");
    expect(move).toContain("onRequestStart");
    expect(route).toContain("readRevision: sessionReadRevision");
    expect(route).toContain("readGeneration: sessionReadGeneration");
    expect(route).toContain("sessionChannelProjectionAuthority.recordRead(");
    expect(route).toContain('context.sessionChannelProjectionAuthority,\n        "detail"');
    expect(route).toContain('context.sessionChannelProjectionAuthority,\n        "live"');
  });

  test("keeps the loaded creator picker identifiable and reachable", async () => {
    const list = await source("components/rail/session-list.tsx");
    expect(list).toContain("sessionCreatorLabelMap(allSessions)");
    expect(list).toContain("{ creatorLabels }");
    expect(list).toContain(
      'className="max-h-(--radix-dropdown-menu-content-available-height) w-52 overflow-x-hidden overflow-y-auto"',
    );
  });

  test("the retired client-side queue model is gone", async () => {
    expect(await Bun.file(`${import.meta.dir}/lib/queue.ts`).exists()).toBe(false);
  });
});
