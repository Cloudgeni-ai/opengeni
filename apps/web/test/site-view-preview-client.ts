// Preview-only: the SDK calls the Site view makes (the Site, its HTML and each
// conversation's history), answered in memory. SiteView and
// SessionConversation are real.
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

export function siteViewPreviewClient(options: {
  workspaceId: string;
  sites: readonly PreviewSite[];
  rows: Session[];
  history: PreviewHistory;
}) {
  const { workspaceId } = options;
  const versionId = (siteId: string) => `${siteId.slice(0, -4)}7e57`;
  const site = (siteId: string) => {
    const found = options.sites.find((candidate) => candidate.id === siteId);
    if (!found) throw new OpenGeniApiError(404, "{}", { code: "artifact_not_found" });
    return found;
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
  const detail = (siteId: string) => {
    const { id, title } = site(siteId);
    const version = {
      id: versionId(id),
      artifactId: id,
      revision: 4,
      requestedTools: [],
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    };
    return {
      artifact: {
        id,
        workspaceId,
        kind: "site",
        title,
        status: "active",
        currentVersion: version,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
      },
      versions: [version],
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
    getWorkspaceArtifactHtml: async (_workspace: string, siteId: string) => site(siteId).html,
    // The header's published-link read. Without the route the header keeps
    // its plain "Live", which is what these previews show.
    getSitePublicationLink: async () => {
      throw new OpenGeniApiError(404, "{}");
    },
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
      _sessionId: string,
      request: { signal?: AbortSignal; onOpen?: () => void } = {},
    ) {
      request.onOpen?.();
      await waitForAbort(request.signal);
      yield* [];
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
    // The preview never sends or controls work; the hooks expect the surface.
    ...Object.fromEntries(
      [
        "submitComposerDraft",
        "sendMessage",
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
