// Preview-only: the SDK calls the Site view makes (the Site, its versions and
// HTML, each conversation's history and live events, a restore), answered in
// memory. SiteView and SessionConversation are real. A message the `edit`
// script recognizes runs a short turn that publishes a new version, as the
// agent would, so the Site view can be seen going live. Publishing to the web
// (the header's Publish and its form) is answered in memory too.
import {
  DEFAULT_SITE_LIMITS,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import { OpenGeniApiError, type SessionEvent } from "@opengeni/sdk";
import type { Session } from "@opengeni/react/app/types";

const control = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "preview",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

const blankDraft = () => ({
  revision: 0,
  text: "",
  resources: [],
  model: "preview-model",
  reasoningEffort: "medium",
  latencyMode: "standard",
  sourceTurnId: null,
  sourceTurnVersion: null,
  updatedAt: null,
});

const waitForAbort = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

export type PreviewSite = { id: string; title: string; html: string };

/** Exchanges per conversation: the person's question, then the answer. */
export type PreviewHistory = ReadonlyMap<string, readonly (readonly [string, string])[]>;

/** What the agent does for a message about the Site: its tool call, the new HTML and its reply. */
export type PreviewEdit = {
  tool: string;
  arguments: Record<string, unknown>;
  html: (current: string) => string;
  reply: string;
};

type PreviewVersion = { id: string; revision: number; html: string; createdAt: string };

export function siteViewPreviewClient(options: {
  workspaceId: string;
  sites: readonly PreviewSite[];
  rows: Session[];
  history: PreviewHistory;
  /** The agent's edit for a message, or null to answer nothing. */
  edit?: ((text: string) => PreviewEdit | null) | undefined;
  /** Each Site's published address; without it the API has no publishing. */
  publishedHost?: ((siteId: string) => string) | undefined;
  /**
   * The deployment can publish: a Site without a published address is
   * "not published", and Publish puts it on `sitesDomain`.
   */
  publishable?: boolean | undefined;
  /** How long a publish takes, to show Publishing…; Infinity never finishes. */
  publishDelayMs?: number | undefined;
  /** How long loading a version's page takes, to show Updating. */
  htmlDelayMs?: number | undefined;
}) {
  const { workspaceId } = options;
  const sitesDomain = "sites.opengeni.ai";
  const versionId = (siteId: string, revision: number) =>
    `${siteId.slice(0, -4)}7e${String(revision).padStart(2, "0")}`;
  const site = (siteId: string) => {
    const found = options.sites.find((candidate) => candidate.id === siteId);
    if (!found) throw new OpenGeniApiError(404, "{}", { code: "artifact_not_found" });
    return found;
  };
  // Four versions each, the newest live, published a day apart.
  const versions = new Map<string, PreviewVersion[]>();
  const live = new Map<string, string>();
  const changes = new Map<string, object[]>();
  for (const each of options.sites) {
    const list = [1, 2, 3, 4].map((revision) => ({
      id: versionId(each.id, revision),
      revision,
      html: each.html,
      createdAt: new Date(Date.now() - (5 - revision) * 86_400_000).toISOString(),
    }));
    versions.set(each.id, list);
    live.set(each.id, list.at(-1)!.id);
    changes.set(
      each.id,
      list.map((version, index) => change(each.id, "published", list[index - 1] ?? null, version)),
    );
  }
  function change(
    siteId: string,
    type: "published" | "rolled_back",
    from: PreviewVersion | null,
    to: PreviewVersion,
  ) {
    return {
      id: `${to.id}:${type}:${Date.now()}`,
      artifactId: siteId,
      workspaceId,
      type,
      fromVersionId: from?.id ?? null,
      toVersionId: to.id,
      reason: type,
      actorSubjectId: "preview",
      createdAt: type === "published" ? to.createdAt : new Date().toISOString(),
    };
  }
  const versionsOf = (siteId: string) => {
    site(siteId);
    return versions.get(siteId)!;
  };
  const liveVersion = (siteId: string) =>
    versionsOf(siteId).find((version) => version.id === live.get(siteId))!;
  const publish = (siteId: string, html: string) => {
    const list = versionsOf(siteId);
    const from = liveVersion(siteId);
    const next = {
      id: versionId(siteId, list.length + 1),
      revision: list.length + 1,
      html,
      createdAt: new Date().toISOString(),
    };
    list.push(next);
    live.set(siteId, next.id);
    changes.get(siteId)!.push(change(siteId, "published", from, next));
    return next;
  };
  // Each Site's publication on the web, as the publication API keeps it.
  const publications = new Map<string, SitePublication>();
  const publication = (
    siteId: string,
    hostname: string,
    patch: Partial<SitePublication> = {},
  ): SitePublication => ({
    siteId,
    workspaceId,
    label: hostname.split(".")[0]!,
    hostname,
    url: `https://${hostname}/`,
    access: "members",
    status: "active",
    noindex: true,
    agent: { enabled: false, model: null, instructions: null, tools: null, guestTools: false },
    limitProfile: { kind: "standard", overrides: null },
    effectiveLimits: { ...DEFAULT_SITE_LIMITS },
    invitedEmails: [],
    moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
    usage: { agentMicrosThisMonth: 0, agentMicrosToday: 0, conversationsToday: 0 },
    warnings: [],
    outsideAgentModel: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  });
  for (const each of options.sites) {
    const hostname = options.publishedHost?.(each.id);
    if (hostname) publications.set(each.id, publication(each.id, hostname));
  }
  const notPublished = () => {
    // A deployment without publishing has no route (404); one with it says so.
    if (!options.publishable) throw new OpenGeniApiError(404, "{}");
    throw new OpenGeniApiError(404, "{}", { code: "site_not_published" });
  };
  const events = new Map<string, SessionEvent[]>();
  for (const [sessionId, exchanges] of options.history) {
    const row = options.rows.find((candidate) => candidate.id === sessionId);
    const start = Date.parse(row?.updatedAt ?? new Date().toISOString()) - 60_000;
    const list: SessionEvent[] = [];
    exchanges.forEach(([question, answer], index) => {
      const turnId = `${sessionId}:turn-${index + 1}`;
      const at = new Date(start + index * 20_000).toISOString();
      for (const [type, payload, turn] of [
        ["user.message", { text: question }, null],
        ["turn.started", {}, turnId],
        ["agent.message.completed", { phase: "final", text: answer }, turnId],
        ["turn.completed", {}, turnId],
      ] as const)
        list.push({
          id: `${sessionId}:${list.length + 1}`,
          workspaceId,
          sessionId,
          sequence: list.length + 1,
          type,
          payload,
          occurredAt: at,
          turnId: turn,
        } as unknown as SessionEvent);
    });
    events.set(sessionId, list);
  }
  // Open live streams per conversation; each gets what is appended after it opened.
  const streams = new Map<string, Set<{ queue: SessionEvent[]; wake: () => void }>>();
  let eventNumber = 0;
  const append = (
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    extra: { turnId?: string | null; clientEventId?: string } = {},
  ) => {
    const list = events.get(sessionId) ?? [];
    events.set(sessionId, list);
    const event = {
      id: `${sessionId}:live-${(eventNumber += 1)}`,
      workspaceId,
      sessionId,
      sequence: (list.at(-1)?.sequence ?? 0) + 1,
      type,
      payload,
      occurredAt: new Date().toISOString(),
      turnId: extra.turnId ?? null,
      clientEventId: extra.clientEventId ?? null,
    } as unknown as SessionEvent;
    list.push(event);
    for (const stream of streams.get(sessionId) ?? []) {
      stream.queue.push(event);
      stream.wake();
    }
    return event;
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The person's message, then the agent's turn: a tool call that publishes, and its reply. */
  const send = (sessionId: string, text: string, clientEventId?: string) => {
    const accepted = append(
      sessionId,
      "user.message",
      { text, routing: "accepted_for_execution" },
      clientEventId ? { clientEventId } : {},
    );
    const turnId = `${sessionId}:live-turn-${eventNumber}`;
    const row = options.rows.find((candidate) => candidate.id === sessionId);
    const siteId = (row?.metadata as { _opengeniSiteOrigin?: { siteId?: string } } | undefined)
      ?._opengeniSiteOrigin?.siteId;
    const edit = siteId ? options.edit?.(text) : null;
    void (async () => {
      await pause(300);
      append(sessionId, "turn.started", { triggerEventId: accepted.id }, { turnId });
      if (!edit || !siteId) {
        append(sessionId, "agent.message.completed", { phase: "final", text: "Done." }, { turnId });
        append(sessionId, "turn.completed", {}, { turnId });
        return;
      }
      const callId = `${turnId}:call`;
      append(
        sessionId,
        "agent.toolCall.created",
        { id: callId, name: edit.tool, arguments: edit.arguments },
        { turnId },
      );
      await pause(1_400);
      const next = publish(siteId, edit.html(liveVersion(siteId).html));
      append(
        sessionId,
        "agent.toolCall.output",
        { id: callId, output: JSON.stringify({ versionId: next.id, revision: next.revision }) },
        { turnId },
      );
      await pause(700);
      append(
        sessionId,
        "agent.message.completed",
        { phase: "final", text: edit.reply },
        { turnId },
      );
      append(sessionId, "turn.completed", {}, { turnId });
    })();
    return accepted;
  };
  const detail = (siteId: string) => {
    const { id, title } = site(siteId);
    const shape = (version: PreviewVersion) => ({
      id: version.id,
      artifactId: id,
      revision: version.revision,
      requestedTools: [],
      createdAt: version.createdAt,
    });
    const current = shape(liveVersion(id));
    return {
      artifact: {
        id,
        workspaceId,
        kind: "site",
        title,
        status: "active",
        currentVersion: current,
        createdAt: versionsOf(id)[0]!.createdAt,
        updatedAt: current.createdAt,
      },
      versions: [...versionsOf(id)].reverse().map(shape),
      events: [...changes.get(id)!].reverse(),
    };
  };
  return {
    getClientConfig: async () => ({
      deploymentRevision: "preview",
      defaultModel: "preview-model",
      allowedModels: ["preview-model"],
      models: [],
      modelSelection: false,
      mcpServers: [],
      fileUploads: { enabled: false, maxSizeBytes: 0 },
      productAccessMode: "local",
      auth: { mode: "none" },
      structuredServices: { fileSystem: false, git: false, terminalEvents: false },
    }),
    getWorkspace: async (id: string) => ({ id, name: "Product engineering", kind: "shared" }),
    getWorkspaceModelCatalog: async () => ({ models: [] }),
    getWorkspaceArtifact: async (_workspace: string, siteId: string) => detail(siteId),
    getWorkspaceArtifactCurrent: async (_workspace: string, siteId: string) => ({
      artifact: detail(siteId).artifact,
    }),
    getWorkspaceArtifactHtml: async (
      _workspace: string,
      siteId: string,
      request: { versionId?: string } = {},
    ) => {
      const html = (
        versionsOf(siteId).find((version) => version.id === request.versionId) ??
        liveVersion(siteId)
      ).html;
      if (options.htmlDelayMs) await pause(options.htmlDelayMs);
      return html;
    },
    rollbackWorkspaceArtifact: async (
      _workspace: string,
      siteId: string,
      request: { versionId: string; expectedCurrentVersionId?: string },
    ) => {
      const from = liveVersion(siteId);
      if (request.expectedCurrentVersionId && request.expectedCurrentVersionId !== from.id)
        throw new OpenGeniApiError(409, "{}", { code: "artifact_version_conflict" });
      const to = versionsOf(siteId).find((version) => version.id === request.versionId)!;
      live.set(siteId, to.id);
      changes.get(siteId)!.push(change(siteId, "rolled_back", from, to));
      return detail(siteId);
    },
    /** Preview control: publish a version as someone else would, elsewhere. */
    publishPreviewVersion: (siteId: string, html: (current: string) => string) =>
      publish(siteId, html(liveVersion(siteId).html)),
    // The header's published-link read: the Site's address, or not published.
    getSitePublicationLink: async (_workspace: string, siteId: string) => {
      const saved = publications.get(siteId);
      if (!saved) return notPublished();
      const { hostname, url, status } = saved;
      return { siteId, hostname, url, status };
    },
    // The publish form: its publication, a name check and Publish.
    getSitePublication: async (_workspace: string, siteId: string) =>
      publications.get(siteId) ?? notPublished(),
    checkSiteHostname: async (_workspace: string, label: string) => ({
      label,
      hostname: `${label}.${sitesDomain}`,
      available: true,
      problem: null,
      message: null,
    }),
    updateSitePublication: async (
      _workspace: string,
      siteId: string,
      request: UpsertSitePublicationRequest,
    ) => {
      const delay = options.publishDelayMs ?? 600;
      await new Promise<void>((resolve) => {
        if (Number.isFinite(delay)) setTimeout(resolve, delay);
      });
      const saved = publications.get(siteId);
      const label = request.label ?? saved?.label ?? `site-${siteId.slice(0, 4)}`;
      const next = publication(siteId, `${label}.${sitesDomain}`, {
        ...saved,
        label,
        hostname: `${label}.${sitesDomain}`,
        url: `https://${label}.${sitesDomain}/`,
        ...(request.access ? { access: request.access } : {}),
        ...(request.noindex !== undefined ? { noindex: request.noindex } : {}),
        status: request.status ?? saved?.status ?? "active",
        updatedAt: new Date().toISOString(),
      });
      publications.set(siteId, next);
      return next;
    },
    unpublishSite: async (_workspace: string, siteId: string) => {
      const saved = publications.get(siteId);
      if (!saved) return notPublished();
      const next = {
        ...saved,
        status: "unpublished" as const,
        updatedAt: new Date().toISOString(),
      };
      publications.set(siteId, next);
      return next;
    },
    listSiteAbuseReports: async () => ({ reports: [] }),
    listEvents: async (
      _workspace: string,
      sessionId: string,
      request: { after?: number; before?: number; limit?: number; latest?: string } = {},
    ) => {
      let list = events.get(sessionId) ?? [];
      if (request.latest) return [];
      if (typeof request.after === "number")
        list = list.filter((event) => event.sequence > request.after!);
      if (typeof request.before === "number")
        list = list.filter((event) => event.sequence < request.before!);
      return list;
    },
    streamEvents: async function* (
      _workspace: string,
      sessionId: string,
      request: { signal?: AbortSignal; onOpen?: () => void } = {},
    ) {
      const stream = { queue: [] as SessionEvent[], wake: () => {} };
      const open = streams.get(sessionId) ?? new Set();
      streams.set(sessionId, open);
      open.add(stream);
      request.onOpen?.();
      try {
        while (!request.signal?.aborted) {
          const next = stream.queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await Promise.race([
            waitForAbort(request.signal),
            new Promise<void>((resolve) => (stream.wake = resolve)),
          ]);
        }
      } finally {
        open.delete(stream);
      }
    },
    getQueue: async () => ({
      version: 1,
      effectiveControl: control,
      activePersonalConnections: [],
      stoppingPreviousAttempt: false,
      items: [],
      pendingInputs: [],
      pendingInputAttachment: null,
    }),
    listHumanInputRequests: async () => [],
    listSiteAuthConnections: async () => ({ revision: 0, connections: [] }),
    getComposerDraft: async () => blankDraft(),
    saveComposerDraft: async (_workspace: string, _session: string, draft: object) => ({
      ...blankDraft(),
      ...draft,
      revision: 1,
      updatedAt: new Date().toISOString(),
    }),
    getGoal: async () => {
      throw new OpenGeniApiError(404, "{}", { code: "goal_not_found" });
    },
    // Sending runs the scripted turn above.
    submitComposerDraft: async (
      _workspace: string,
      sessionId: string,
      request: { text: string; clientEventId?: string; expectedDraftRevision?: number },
    ) => {
      const accepted = send(sessionId, request.text, request.clientEventId);
      return {
        accepted,
        turn: { id: `${sessionId}:live-turn-${eventNumber}` },
        draft: {
          ...blankDraft(),
          revision: (request.expectedDraftRevision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        },
        receipt: { appliedQueueVersion: 1 },
        routing: "accepted_for_execution",
        interruptionCount: 0,
        replay: false,
      };
    },
    sendMessage: async (
      _workspace: string,
      sessionId: string,
      input: { text: string; clientEventId?: string },
    ) => send(sessionId, input.text, input.clientEventId),
    // The preview never controls work; the hooks expect the surface.
    ...Object.fromEntries(
      [
        "steerMessage",
        "moveQueueItem",
        "editQueueItem",
        "steerQueueItem",
        "deleteQueueItem",
        "pauseSession",
        "resumeSession",
        "sendApprovalDecision",
        "submitHumanInputResponse",
        "updateSession",
        "deleteGoal",
        "updateGoal",
        "uploadFile",
        "updateSessionMcpApprovalPolicy",
      ].map((name) => [
        name,
        async () => {
          throw new Error("The preview doesn't send messages.");
        },
      ]),
    ),
    updateSessionAttention: async (_workspace: string, id: string) => ({
      id,
      workspaceId,
      unread: false,
    }),
  };
}
