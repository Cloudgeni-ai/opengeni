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

  test("makes the full chat viewport a file drop target", async () => {
    const route = await source("routes/session.tsx");
    expect(route).toContain("<ChatViewportFileDropTarget");
    expect(route).toContain('data-workspace-scroll-owner="self-managed"');
    expect(route).toContain(
      "enabled={!terminal && context.clientConfig.fileUploads.enabled === true}",
    );
    expect(route).toContain("onFiles={attachments.addFiles}");
  });

  test("shares one route-level attachment lightbox across the timeline and composer", async () => {
    const [sessionRoute, newSessionRoute, chatComposer] = await Promise.all([
      source("routes/session.tsx"),
      source("routes/sessions-index.tsx"),
      source("../../../packages/react/src/components/chat-composer.tsx"),
    ]);
    const provider = sessionRoute.indexOf("createElement(\n    LightboxProvider,");
    const timeline = sessionRoute.indexOf("<MessageTimeline", provider);
    const composer = sessionRoute.indexOf("<ConsoleComposer", timeline);
    const providerEnd = sessionRoute.indexOf("</ChatViewportFileDropTarget>,", composer);

    expect(provider).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(provider);
    expect(composer).toBeGreaterThan(timeline);
    expect(providerEnd).toBeGreaterThan(composer);
    expect(newSessionRoute).toContain("createElement(\n    LightboxProvider,");
    expect(chatComposer).not.toContain("<LightboxProvider>");
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

  test("keeps Variable Sets editable at create time and beside an established composer", async () => {
    const [route, establishedRoute, establishedControl, establishedPicker] = await Promise.all([
      source("routes/sessions-index.tsx"),
      source("routes/session.tsx"),
      source("components/personal-resource-attachment-control.tsx"),
      source("components/session/session-variable-set-picker.tsx"),
    ]);
    expect(route).toContain("Add Variable Set…");
    expect(route).toContain("<SelectedVariableSetList");
    expect(route).toContain(
      "const showVariableSets = draft.variableSetIds.length > 0 || hasEnumerableVariableSets",
    );
    expect(route).toContain("hasVariableSetChoices && draft.variableSetIds.length < 25");
    expect(route).toContain("PersonalResourceAccessInline");
    expect(route).toContain("will be used only for the message you send");
    expect(route).not.toContain("personalResourceSendBlocker");
    expect(route).not.toContain("Confirm private credential or resource use before sending");
    expect(route).not.toContain("PersonalResourceAttachmentControl");
    expect(route).not.toContain("Your resource access");
    expect(route).not.toContain("loadPersonalResourceCatalog");
    expect(route).toContain("reconcileNewSessionFixedResources");
    expect(route).toContain("newSessionFixedResourceCatalogFailed");
    expect(route).toContain('"variable-sets:list"');
    expect(route).toContain('"secrets:list"');
    expect(route).toContain("resolveVariableSetAttachments");
    expect(route).toContain("fixedResourceSelection.selectionResolved");
    expect(route).toContain("personalResourceSelectionIdentityKey");
    expect(route).toContain("recoverPersonalResourceAttachment(error, request)");
    expect(route).toContain("recoverNewSessionPersonalResourceAttachment");
    expect(route).toContain("refreshPersonalResourceCatalogs");
    expect(route).toContain("canLoadVariableSetCatalog");
    expect(route).toContain("canResolveVariableSetAttachments");
    expect(route).toContain(
      "newSessionDraftOptionsFromSessionDraft(\n        draft,\n        defaultFirstPartyMcpTools,\n        newSessionCreateVisibility(personalWorkspace, draft.visibility),\n      )",
    );
    expect(route).toContain("const selectedRigDefaultVariableSetIds =");
    expect(route).toContain("selectedRigDefaultVariableSetIds,");
    expect(route).toContain(
      "selectedRigDefaultVariableSetIds: selectedRigDefaultVariableSetIdsKey",
    );
    expect(route).toContain("Couldn’t verify the selected Variable Set or Rig");
    expect(route).toContain("onRetry: () => void refreshPersonalResourceCatalogs()");
    expect(establishedRoute).toContain("<SessionVariableSetPicker");
    expect(establishedPicker).toContain("Attach Variable Set…");
    expect(establishedPicker).toContain("Attached entries can still be removed");
    expect(establishedPicker).toContain("updateSessionVariableSets");
    expect(establishedControl).not.toContain('value: "once"');
    expect(establishedControl).not.toContain('value: "session"');
    expect(establishedControl).not.toContain('value: "always"');
    expect(establishedControl).not.toContain('type="checkbox"');
    expect(establishedControl).toContain("is available in this private session");
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
    const appContext = await source("context.tsx");
    const lineageHook = await source("../../../packages/react/src/hooks/use-session-lineage.ts");
    expect(list).toContain("applySessionChannelProjection(pinProjected, projected)");
    expect(list).toContain("channelMoveOverrides.has(openSessionId)");
    expect(list).toContain("const promise = readSessionChannelMovePoint(");
    expect(list).toContain("sessionClient,");
    expect(list).toContain("sessionChannelProjectionAuthority.replace(");
    expect(list).toContain("rootReadGeneration");
    expect(list).toContain("globalPinsReadGeneration");
    expect(list).toContain("pinsChannelProjectionOwner");
    expect(list).toContain("lineageChannelProjectionOwner");
    expect(list).toContain("beginRead: context.sessionChannelProjectionAuthority.beginRead");
    expect(list).toContain("activeLineage.readGeneration");
    expect(lineageHook).toContain("getSessionLineage(workspaceId, sessionId, {");
    expect(lineageHook).toContain("onRequestStart: (sharedReadGeneration) => {");
    expect(appContext).toContain(
      "createOpenGeniClient(sessionChannelProjectionAuthority.beginRead)",
    );
    expect(list).toContain(
      "const lineageProjected = context.sessionChannelProjectionAuthority.project(",
    );
    expect(list).toContain("currentListChannelEvidence");
    expect(list).toContain("sessionChannelProjectionAuthority.project(");
    expect(list).toContain("authoritativeSessionContinuationChannels(");
    expect(list).toContain("pageReadGeneration");
    expect(list).not.toContain("replace(owner, channelAuthoritySessions)");
    expect(list).not.toContain("replace(owner, listedSessions)");
    expect(list).toContain(
      "applySessionRailProjection(lineageProjected, projected, { channelOwned })",
    );
    expect(list).toContain("sessionChannelProjectionAuthority.owns(authoritative)");
    expect(list).toContain("sessionChannelProjectionAuthority.clear(owner)");
    expect(list).toContain("sessionChannelProjectionAuthority.beginMove(");
    expect(list).toContain("sessionChannelProjectionAuthority.ownsMove(");
    expect(list).toContain("sessionChannelProjectionAuthority.recordMove(");
    expect(list).toContain('if (disposition === "rejected")');
    expect(list).not.toContain('if (disposition === "verification-required")');
    expect(list).toContain("await verifySessionChannelMove(session.id, operation)");
    expect(list).toContain("sessionChannelProjectionAuthority.finishMove(");
    expect(list).toContain("context.client.updateSessionChannel(");
    expect(list).not.toContain("moveSession: requestMoveSession");
    expect(list).not.toContain("await requestMoveSession(");
    expect(list).not.toContain("const movingSessions = useRef(");
    expect(list).not.toContain("const channelMoveOperation = useRef(");
    expect(list).toContain("useSyncExternalStore(");
    expect(list).toContain("subscribe,");
    expect(list).toContain("getRevision");
    expect(list).toContain("acceptedChannelReadRevision");
    expect(list).toContain("subscribe((accepted) =>");
    expect(list).toContain("override?.committed");
    expect(list).toContain("applySessionChannelProjection(current, accepted)");
    expect(list).toContain("reconcileSessionChannelMovePointRead(");
    expect(list).toContain("reconcileSessionChannelMoves(current, channelAuthoritySessions)");
    expect(list).not.toContain("reconcileSessionChannelMoves(current, listedSessions)");
    expect(list).toContain("requestError.status === 404");
    expect(list).toContain("sessionChannelProjectionAuthority.beginDetailRead(");
    expect(list).toContain("sessionChannelProjectionAuthority.finishDetailReads(detailReadOwner)");
    expect(move).toContain("getSession(workspaceId, sessionId, {");
    expect(move).toContain("fresh: true");
    expect(move).toContain("onRequestStart");
    expect(route).toContain("readRevision: sessionReadRevision");
    expect(route).toContain("readGeneration: sessionReadGeneration");
    expect(route).toContain("sessionChannelProjectionAuthority.beginDetailRead(");
    expect(route).toContain("sessionChannelProjectionAuthority.finishDetailReads(");
    expect(route).toContain("sessionChannelProjectionAuthority.recordRead(");
    expect(route).toContain(
      "const accepted = context.sessionChannelProjectionAuthority.recordRead(",
    );
    expect(route).toContain("mergeSessionDetailReadProjection(");
    expect(route).toContain("sessionReadGeneration,\n        accepted,");
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
