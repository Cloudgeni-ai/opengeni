import type {
  AttachedBrowserDevice,
  AuthRun,
  AuthRunListResponse,
  AuthRunMutationResponse,
  AttemptToolResult,
  BrowserAction,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticKind,
  BrowserIdentity,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserLocator,
  BrowserObservation,
  BrowserRevisionListResponse,
  BrowserSession,
  BrowserSessionMutationResponse,
  BrowserTarget,
  BrowserTargetListResponse,
  ComputerAction,
  ComputerActionReceipt,
  ComputerLocator,
  ComputerObservation,
  ComputerSession,
  ComputerSessionMutationResponse,
  ComputerTarget,
  ComputerTargetListResponse,
  InteractionPlacement,
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
  PublishBrowserRevisionResponse,
  ReportAuthRunRequest,
  RequestHumanInteractionToolInput,
  RequestHumanInteractionToolOutput,
  SiteAuthConnection,
  SiteAuthConnectionListResponse,
  StartAuthRunRequest,
  VerifyAuthRunRequest,
} from "@opengeni/contracts";
import type { CodemodeCallOptions, CodemodeClient } from "./index";
import { environmentCodemodeClient, type CodemodeClientProvider } from "./environment";
import { CodemodeArtifactCollection } from "./artifacts";
import { callStructured, codemodeClientProvider } from "./structured";

export { CodemodeToolExecutionError } from "./structured";

const PATH = {
  discover: ["interaction", "discover"],
  browserOpen: ["interaction", "browser", "open"],
  browserTabs: ["interaction", "browser", "tabs"],
  browserObserve: ["interaction", "browser", "observe"],
  browserAct: ["interaction", "browser", "act"],
  browserClipboard: ["interaction", "browser", "clipboard"],
  browserDebug: ["interaction", "browser", "debug"],
  browserAuth: ["interaction", "browser", "auth"],
  requestHuman: ["interaction", "requestHuman"],
  browserIdentity: ["interaction", "browser", "identity"],
  browserPublish: ["interaction", "browser", "publish"],
  browserLifecycle: ["interaction", "browser", "lifecycle"],
  computerOpen: ["interaction", "computer", "open"],
  computerTargets: ["interaction", "computer", "targets"],
  computerObserve: ["interaction", "computer", "observe"],
  computerAct: ["interaction", "computer", "act"],
  computerLifecycle: ["interaction", "computer", "lifecycle"],
} as const;

export type InteractionDiscovery = {
  browserRevision: number;
  computerRevision: number;
  identityRevision: number;
  attachedBrowserRevision: number;
  browsers: BrowserSession[];
  computers: ComputerSession[];
  identities: BrowserIdentity[];
  attachedBrowsers: AttachedBrowserDevice[];
};

export type CodemodeBrowserOpenOptions = {
  browserSessionId?: string | undefined;
  mode?: "reuse_or_create" | "new" | undefined;
  name?: string | undefined;
  initialUrl?: string | undefined;
  headless?: boolean | undefined;
  placement?: InteractionPlacement | undefined;
  identityId?: string | undefined;
  baseRevisionId?: string | undefined;
  linkedComputerSessionId?: string | undefined;
};

export type CodemodeComputerOpenOptions = {
  computerSessionId?: string | undefined;
  mode?: "reuse_or_create" | "new" | undefined;
  name?: string | undefined;
  placement?: InteractionPlacement | undefined;
};

export type BrowserActionFences = {
  expectedTargetGeneration?: string | undefined;
  expectedDocumentGeneration?: string | null | undefined;
  expectedFrameId?: string | null | undefined;
};

export type ComputerActionFences = {
  expectedTargetGeneration?: string | undefined;
  expectedObservationId?: string | null | undefined;
  expectedFrameId?: string | null | undefined;
};

/** Authored object facade over the exact atomic Browser/Computer catalog. */
export class OpenGeniCodemode {
  readonly browsers: CodemodeBrowserCollection;
  readonly computers: CodemodeComputerCollection;
  readonly artifacts: CodemodeArtifactCollection;
  readonly auth: CodemodeAuth;

  constructor(client: CodemodeClient | CodemodeClientProvider = () => environmentCodemodeClient()) {
    const provider = codemodeClientProvider(client);
    this.browsers = new CodemodeBrowserCollection(provider);
    this.computers = new CodemodeComputerCollection(provider);
    this.artifacts = new CodemodeArtifactCollection(provider);
    this.auth = new CodemodeAuth(provider);
  }

  async discover(
    options: {
      includeTerminal?: boolean | undefined;
      includeArchivedIdentities?: boolean | undefined;
      includeDisconnectedDevices?: boolean | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<InteractionDiscovery> {
    return await callStructured(this.browsers.client, PATH.discover, options, callOptions);
  }

  async requestHuman(
    request: RequestHumanInteractionToolInput,
    callOptions: CodemodeCallOptions = {},
  ): Promise<RequestHumanInteractionToolOutput> {
    return await callStructured(this.browsers.client, PATH.requestHuman, request, callOptions);
  }
}

export class CodemodeBrowserCollection {
  readonly identities: CodemodeBrowserIdentityCollection;

  constructor(readonly client: CodemodeClientProvider) {
    this.identities = new CodemodeBrowserIdentityCollection(client);
  }

  async list(
    options: { includeTerminal?: boolean | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserSession[]> {
    return (
      await callStructured<InteractionDiscovery>(this.client, PATH.discover, options, callOptions)
    ).browsers;
  }

  async open(
    options: CodemodeBrowserOpenOptions = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeBrowser> {
    const opened = await callStructured<{ session: BrowserSession; targets: BrowserTarget[] }>(
      this.client,
      PATH.browserOpen,
      options,
      callOptions,
    );
    return new CodemodeBrowser(this.client, opened.session.id);
  }

  use(browserSessionId: string): CodemodeBrowser {
    return new CodemodeBrowser(this.client, browserSessionId);
  }
}

export class CodemodeBrowserIdentityCollection {
  constructor(private readonly client: CodemodeClientProvider) {}

  async list(
    options: { includeArchived?: boolean | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserIdentityListResponse> {
    const response = await callStructured<{
      operation: "list";
      result: BrowserIdentityListResponse;
    }>(this.client, PATH.browserIdentity, { operation: "list", ...options }, callOptions);
    return response.result;
  }

  async get(identityId: string, callOptions: CodemodeCallOptions = {}): Promise<BrowserIdentity> {
    const response = await callStructured<{ operation: "get"; result: BrowserIdentity }>(
      this.client,
      PATH.browserIdentity,
      { operation: "get", identityId },
      callOptions,
    );
    return response.result;
  }

  async create(
    name: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserIdentityMutationResponse> {
    const response = await callStructured<{
      operation: "create";
      result: BrowserIdentityMutationResponse;
    }>(this.client, PATH.browserIdentity, { operation: "create", name }, callOptions);
    return response.result;
  }

  async revisions(
    identityId: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserRevisionListResponse> {
    const response = await callStructured<{
      operation: "revisions";
      result: BrowserRevisionListResponse;
    }>(this.client, PATH.browserIdentity, { operation: "revisions", identityId }, callOptions);
    return response.result;
  }
}

export class CodemodeBrowser {
  readonly tabs: CodemodeBrowserTabCollection;
  readonly auth: CodemodeBrowserAuth;
  readonly clipboard: CodemodeBrowserClipboard;

  constructor(
    private readonly client: CodemodeClientProvider,
    readonly id: string,
  ) {
    this.tabs = new CodemodeBrowserTabCollection(client, id);
    this.auth = new CodemodeBrowserAuth(client, id);
    this.clipboard = new CodemodeBrowserClipboard(client, id, this.tabs);
  }

  async refresh(callOptions: CodemodeCallOptions = {}): Promise<BrowserSession> {
    const result = await callStructured<{ session: BrowserSession; targets: BrowserTarget[] }>(
      this.client,
      PATH.browserOpen,
      { browserSessionId: this.id },
      callOptions,
    );
    return result.session;
  }

  async observe(
    targetId?: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserObservation> {
    return await this.tabs
      .use(await this.tabs.resolveId(targetId, callOptions))
      .observe(callOptions);
  }

  async act(
    action: BrowserAction,
    options: BrowserActionFences & { targetId?: string | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    const targetId = await this.tabs.resolveId(options.targetId, callOptions);
    return await this.tabs.use(targetId).act(action, options, callOptions);
  }

  async diagnostics(
    targetId?: string,
    options: {
      kinds?: BrowserDiagnosticKind[] | undefined;
      after?: number | undefined;
      limit?: number | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserDiagnosticBatch> {
    return await callStructured(
      this.client,
      PATH.browserDebug,
      {
        browserSessionId: this.id,
        targetId: await this.tabs.resolveId(targetId, callOptions),
        ...options,
      },
      callOptions,
    );
  }

  async publish(
    input: {
      identityId: string;
      expectedHeadGeneration: number;
      advanceDefault?: boolean | undefined;
    },
    callOptions: CodemodeCallOptions = {},
  ): Promise<PublishBrowserRevisionResponse> {
    return await callStructured(
      this.client,
      PATH.browserPublish,
      { browserSessionId: this.id, ...input },
      callOptions,
    );
  }

  async suspend(callOptions: CodemodeCallOptions = {}): Promise<BrowserSessionMutationResponse> {
    return await this.lifecycle("suspend", callOptions);
  }

  async resume(callOptions: CodemodeCallOptions = {}): Promise<BrowserSessionMutationResponse> {
    return await this.lifecycle("resume", callOptions);
  }

  async end(callOptions: CodemodeCallOptions = {}): Promise<BrowserSessionMutationResponse> {
    return await this.lifecycle("end", callOptions);
  }

  private async lifecycle(
    action: "suspend" | "resume" | "end",
    callOptions: CodemodeCallOptions,
  ): Promise<BrowserSessionMutationResponse> {
    return await callStructured(
      this.client,
      PATH.browserLifecycle,
      { browserSessionId: this.id, action },
      callOptions,
    );
  }
}

export class CodemodeBrowserClipboard {
  constructor(
    private readonly client: CodemodeClientProvider,
    private readonly browserSessionId: string,
    private readonly tabs: CodemodeBrowserTabCollection,
  ) {}

  async read(callOptions: CodemodeCallOptions = {}): Promise<BrowserClipboard> {
    return await callStructured(
      this.client,
      PATH.browserClipboard,
      { browserSessionId: this.browserSessionId },
      callOptions,
    );
  }

  async write(
    text: string,
    options: BrowserActionFences & { targetId?: string | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    return await this.act({ type: "clipboard", operation: "write", text }, options, callOptions);
  }

  async clear(
    options: BrowserActionFences & { targetId?: string | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    return await this.act({ type: "clipboard", operation: "clear" }, options, callOptions);
  }

  async copy(
    options: BrowserActionFences & {
      targetId?: string | undefined;
      locator?: BrowserLocator | undefined;
      content?: "selection" | "value" | "text" | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    const {
      targetId,
      expectedTargetGeneration,
      expectedDocumentGeneration,
      expectedFrameId,
      ...copy
    } = options;
    return await this.act(
      { type: "clipboard", operation: "copy", ...copy },
      {
        targetId,
        expectedTargetGeneration,
        expectedDocumentGeneration,
        expectedFrameId,
      },
      callOptions,
    );
  }

  async paste(
    options: BrowserActionFences & {
      targetId?: string | undefined;
      locator?: BrowserLocator | undefined;
      text?: string | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    const {
      targetId,
      expectedTargetGeneration,
      expectedDocumentGeneration,
      expectedFrameId,
      ...paste
    } = options;
    return await this.act(
      { type: "clipboard", operation: "paste", ...paste },
      {
        targetId,
        expectedTargetGeneration,
        expectedDocumentGeneration,
        expectedFrameId,
      },
      callOptions,
    );
  }

  private async act(
    action: BrowserAction,
    options: BrowserActionFences & { targetId?: string | undefined },
    callOptions: CodemodeCallOptions,
  ): Promise<BrowserActionReceipt> {
    const { targetId, ...fences } = options;
    return await this.tabs
      .use(await this.tabs.resolveId(targetId, callOptions))
      .act(action, fences, callOptions);
  }
}

export class CodemodeBrowserTabCollection {
  constructor(
    private readonly client: CodemodeClientProvider,
    private readonly browserSessionId: string,
  ) {}

  async list(callOptions: CodemodeCallOptions = {}): Promise<BrowserTargetListResponse> {
    return await callStructured(
      this.client,
      PATH.browserTabs,
      { operation: "list", browserSessionId: this.browserSessionId },
      callOptions,
    );
  }

  async selected(callOptions: CodemodeCallOptions = {}): Promise<CodemodeBrowserTab> {
    return this.use(await this.resolveId(undefined, callOptions));
  }

  use(targetId: string): CodemodeBrowserTab {
    return new CodemodeBrowserTab(this.client, this.browserSessionId, targetId);
  }

  async open(url?: string, callOptions: CodemodeCallOptions = {}): Promise<CodemodeBrowserTab> {
    const before = await this.list(callOptions);
    const after = await callStructured<BrowserTargetListResponse>(
      this.client,
      PATH.browserTabs,
      {
        operation: "open",
        browserSessionId: this.browserSessionId,
        ...(url ? { url } : {}),
      },
      callOptions,
    );
    const beforeIds = new Set(before.targets.map((target) => target.id));
    const opened =
      after.targets.find((target) => !beforeIds.has(target.id)) ??
      after.targets.find((target) => target.selected);
    if (!opened) throw new Error("Browser opened no discoverable tab");
    return this.use(opened.id);
  }

  async select(
    targetId: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeBrowserTab> {
    const after = await callStructured<BrowserTargetListResponse>(
      this.client,
      PATH.browserTabs,
      { operation: "select", browserSessionId: this.browserSessionId, targetId },
      callOptions,
    );
    if (!after.targets.some((target) => target.id === targetId && target.selected)) {
      throw new Error("Browser did not select the requested tab");
    }
    return this.use(targetId);
  }

  async close(
    targetId: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserTargetListResponse> {
    return await callStructured(
      this.client,
      PATH.browserTabs,
      { operation: "close", browserSessionId: this.browserSessionId, targetId },
      callOptions,
    );
  }

  async resolveId(targetId: string | undefined, callOptions: CodemodeCallOptions): Promise<string> {
    const listed = await this.list(callOptions);
    if (targetId) {
      if (!listed.targets.some((target) => target.id === targetId)) {
        throw new Error(`Browser tab is unavailable: ${targetId}`);
      }
      return targetId;
    }
    const selected = listed.targets.filter((target) => target.selected);
    if (selected.length === 1) return selected[0]!.id;
    if (listed.targets.length === 1) return listed.targets[0]!.id;
    if (listed.targets.length === 0) throw new Error("Browser has no tabs");
    throw new Error("Browser target is ambiguous; select an exact tab");
  }
}

export class CodemodeBrowserTab {
  constructor(
    private readonly client: CodemodeClientProvider,
    readonly browserSessionId: string,
    readonly id: string,
  ) {}

  async observe(callOptions: CodemodeCallOptions = {}): Promise<BrowserObservation> {
    return await callStructured(
      this.client,
      PATH.browserObserve,
      { browserSessionId: this.browserSessionId, targetId: this.id },
      callOptions,
    );
  }

  async act(
    action: BrowserAction,
    fences: BrowserActionFences = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<BrowserActionReceipt> {
    return await callStructured(
      this.client,
      PATH.browserAct,
      { browserSessionId: this.browserSessionId, targetId: this.id, action, ...fences },
      callOptions,
    );
  }

  async navigate(url: string, callOptions: CodemodeCallOptions = {}) {
    return await this.act({ type: "navigate", url }, {}, callOptions);
  }

  async requestHuman(
    reason: string,
    options: {
      kind?: "manual_login" | "mfa" | "external_action" | "confirmation" | "other";
      authRunId?: string | undefined;
      expiresInSeconds?: number | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<RequestHumanInteractionToolOutput> {
    const observation = await this.observe(callOptions);
    return await callStructured(
      this.client,
      PATH.requestHuman,
      {
        operation: "request",
        resourceKind: "browser_session",
        resourceId: this.browserSessionId,
        targetId: this.id,
        expectedControllerGeneration: observation.target.controllerGeneration,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        kind: options.kind ?? "other",
        reason,
        ...(options.authRunId ? { authRunId: options.authRunId } : {}),
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: options.expiresInSeconds }),
      },
      callOptions,
    );
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    return new CodemodeBrowserLocator(this, { kind: "role", role, ...options });
  }

  getByText(text: string) {
    return new CodemodeBrowserLocator(this, { kind: "text", text });
  }

  getByLabel(text: string) {
    return new CodemodeBrowserLocator(this, { kind: "label", text });
  }

  getByPlaceholder(text: string) {
    return new CodemodeBrowserLocator(this, { kind: "placeholder", text });
  }

  getByTestId(value: string) {
    return new CodemodeBrowserLocator(this, { kind: "test_id", value });
  }

  locator(selector: string) {
    return new CodemodeBrowserLocator(this, { kind: "css", selector });
  }

  ref(ref: string) {
    return new CodemodeBrowserLocator(this, { kind: "ref", ref });
  }
}

export class CodemodeBrowserLocator {
  constructor(
    private readonly tab: CodemodeBrowserTab,
    readonly locator: BrowserLocator,
  ) {}

  async click(
    options: { button?: "left" | "right" | "middle" } = {},
    callOptions: CodemodeCallOptions = {},
  ) {
    return await this.tab.act(
      { type: "click", locator: this.locator, ...options },
      {},
      callOptions,
    );
  }

  async doubleClick(callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "double_click", locator: this.locator }, {}, callOptions);
  }

  async hover(callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "hover", locator: this.locator }, {}, callOptions);
  }

  async fill(value: string, callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "fill", locator: this.locator, value }, {}, callOptions);
  }

  async type(text: string, callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "type", locator: this.locator, text }, {}, callOptions);
  }

  async press(key: string, callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "press", locator: this.locator, key }, {}, callOptions);
  }

  async select(values: string[], callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "select", locator: this.locator, values }, {}, callOptions);
  }

  async check(checked = true, callOptions: CodemodeCallOptions = {}) {
    return await this.tab.act({ type: "check", locator: this.locator, checked }, {}, callOptions);
  }
}

export class CodemodeAuth {
  constructor(private readonly client: CodemodeClientProvider) {}

  async listConnections(
    options: { includeArchived?: boolean | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<SiteAuthConnectionListResponse> {
    const response = await callStructured<{
      operation: "list_connections";
      result: SiteAuthConnectionListResponse;
    }>(this.client, PATH.browserAuth, { operation: "list_connections", ...options }, callOptions);
    return response.result;
  }

  async getConnection(
    siteAuthConnectionId: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<SiteAuthConnection> {
    const response = await callStructured<{
      operation: "get_connection";
      result: SiteAuthConnection;
    }>(
      this.client,
      PATH.browserAuth,
      { operation: "get_connection", siteAuthConnectionId },
      callOptions,
    );
    return response.result;
  }

  async listRuns(
    options: {
      browserSessionId?: string | undefined;
      siteAuthConnectionId?: string | undefined;
      includeSettled?: boolean | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<AuthRunListResponse> {
    const response = await callStructured<{ operation: "list_runs"; result: AuthRunListResponse }>(
      this.client,
      PATH.browserAuth,
      { operation: "list_runs", ...options },
      callOptions,
    );
    return response.result;
  }

  async getRun(authRunId: string, callOptions: CodemodeCallOptions = {}): Promise<AuthRun> {
    const response = await callStructured<{ operation: "get_run"; result: AuthRun }>(
      this.client,
      PATH.browserAuth,
      { operation: "get_run", authRunId },
      callOptions,
    );
    return response.result;
  }

  use(browserSessionId: string, authRunId: string): CodemodeAuthRun {
    return new CodemodeAuthRun(this.client, browserSessionId, authRunId);
  }
}

export class CodemodeBrowserAuth {
  constructor(
    private readonly client: CodemodeClientProvider,
    private readonly browserSessionId: string,
  ) {}

  async listRuns(
    options: {
      siteAuthConnectionId?: string | undefined;
      includeSettled?: boolean | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<AuthRunListResponse> {
    const response = await callStructured<{ operation: "list_runs"; result: AuthRunListResponse }>(
      this.client,
      PATH.browserAuth,
      { operation: "list_runs", browserSessionId: this.browserSessionId, ...options },
      callOptions,
    );
    return response.result;
  }

  async start(
    request: Omit<StartAuthRunRequest, "operationId">,
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeAuthRun> {
    const response = await callStructured<{ operation: "start"; result: AuthRunMutationResponse }>(
      this.client,
      PATH.browserAuth,
      { operation: "start", browserSessionId: this.browserSessionId, ...request },
      callOptions,
    );
    return this.use(response.result.run.id);
  }

  use(authRunId: string): CodemodeAuthRun {
    return new CodemodeAuthRun(this.client, this.browserSessionId, authRunId);
  }
}

export class CodemodeAuthRun {
  constructor(
    private readonly client: CodemodeClientProvider,
    readonly browserSessionId: string,
    readonly id: string,
  ) {}

  async get(callOptions: CodemodeCallOptions = {}): Promise<AuthRun> {
    const response = await callStructured<{ operation: "get_run"; result: AuthRun }>(
      this.client,
      PATH.browserAuth,
      { operation: "get_run", authRunId: this.id },
      callOptions,
    );
    if (response.result.browserSessionId !== this.browserSessionId) {
      throw new Error("Auth run belongs to another BrowserSession");
    }
    return response.result;
  }

  async report(
    request: Omit<ReportAuthRunRequest, "operationId">,
    callOptions: CodemodeCallOptions = {},
  ): Promise<AuthRunMutationResponse> {
    const response = await callStructured<{ operation: "report"; result: AuthRunMutationResponse }>(
      this.client,
      PATH.browserAuth,
      {
        operation: "report",
        browserSessionId: this.browserSessionId,
        authRunId: this.id,
        ...request,
      },
      callOptions,
    );
    return response.result;
  }

  async protectedFill(
    request: Omit<ProtectedAuthFillRequest, "operationId">,
    callOptions: CodemodeCallOptions = {},
  ): Promise<ProtectedAuthFillResponse> {
    const response = await callStructured<{
      operation: "protected_fill";
      result: ProtectedAuthFillResponse;
    }>(
      this.client,
      PATH.browserAuth,
      {
        operation: "protected_fill",
        browserSessionId: this.browserSessionId,
        authRunId: this.id,
        ...request,
      },
      callOptions,
    );
    return response.result;
  }

  async verify(
    request: Omit<VerifyAuthRunRequest, "operationId">,
    callOptions: CodemodeCallOptions = {},
  ): Promise<AuthRunMutationResponse> {
    const response = await callStructured<{ operation: "verify"; result: AuthRunMutationResponse }>(
      this.client,
      PATH.browserAuth,
      {
        operation: "verify",
        browserSessionId: this.browserSessionId,
        authRunId: this.id,
        ...request,
      },
      callOptions,
    );
    return response.result;
  }
}

export class CodemodeComputerCollection {
  constructor(private readonly client: CodemodeClientProvider) {}

  async list(
    options: { includeTerminal?: boolean | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<ComputerSession[]> {
    return (
      await callStructured<InteractionDiscovery>(this.client, PATH.discover, options, callOptions)
    ).computers;
  }

  async open(
    options: CodemodeComputerOpenOptions = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeComputer> {
    const opened = await callStructured<{ session: ComputerSession; targets: ComputerTarget[] }>(
      this.client,
      PATH.computerOpen,
      options,
      callOptions,
    );
    return new CodemodeComputer(this.client, opened.session.id);
  }

  use(computerSessionId: string): CodemodeComputer {
    return new CodemodeComputer(this.client, computerSessionId);
  }
}

export class CodemodeComputer {
  readonly targets: CodemodeComputerTargetCollection;
  readonly apps: CodemodeComputerTargetCollection;

  constructor(
    private readonly client: CodemodeClientProvider,
    readonly id: string,
  ) {
    this.targets = new CodemodeComputerTargetCollection(client, id);
    this.apps = this.targets;
  }

  async refresh(callOptions: CodemodeCallOptions = {}): Promise<ComputerSession> {
    const result = await callStructured<{ session: ComputerSession; targets: ComputerTarget[] }>(
      this.client,
      PATH.computerOpen,
      { computerSessionId: this.id },
      callOptions,
    );
    return result.session;
  }

  async observe(
    targetId?: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<ComputerObservation> {
    return await this.targets
      .use(await this.targets.resolveId(targetId, callOptions))
      .observe(callOptions);
  }

  async act(
    action: ComputerAction,
    options: ComputerActionFences & { targetId?: string | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<ComputerActionReceipt> {
    return await this.targets
      .use(await this.targets.resolveId(options.targetId, callOptions))
      .act(action, options, callOptions);
  }

  async launch(applicationId: string, callOptions: CodemodeCallOptions = {}) {
    const targetId = await this.targets.resolveId(undefined, callOptions);
    await this.targets.use(targetId).act({ type: "launch", applicationId }, {}, callOptions);
    return await this.targets.list(callOptions);
  }

  async end(callOptions: CodemodeCallOptions = {}): Promise<ComputerSessionMutationResponse> {
    return await callStructured(
      this.client,
      PATH.computerLifecycle,
      { computerSessionId: this.id, action: "end" },
      callOptions,
    );
  }
}

export class CodemodeComputerTargetCollection {
  constructor(
    private readonly client: CodemodeClientProvider,
    private readonly computerSessionId: string,
  ) {}

  async list(callOptions: CodemodeCallOptions = {}): Promise<ComputerTargetListResponse> {
    return await callStructured(
      this.client,
      PATH.computerTargets,
      { computerSessionId: this.computerSessionId },
      callOptions,
    );
  }

  use(targetId: string): CodemodeComputerTarget {
    return new CodemodeComputerTarget(this.client, this.computerSessionId, targetId);
  }

  async focused(callOptions: CodemodeCallOptions = {}): Promise<CodemodeComputerTarget> {
    return this.use(await this.resolveId(undefined, callOptions));
  }

  async resolveId(targetId: string | undefined, callOptions: CodemodeCallOptions): Promise<string> {
    const listed = await this.list(callOptions);
    if (targetId) {
      if (!listed.targets.some((target) => target.id === targetId)) {
        throw new Error(`Computer target is unavailable: ${targetId}`);
      }
      return targetId;
    }
    const focused = listed.targets.filter((target) => target.focused);
    if (focused.length === 1) return focused[0]!.id;
    if (listed.targets.length === 1) return listed.targets[0]!.id;
    if (listed.targets.length === 0)
      throw new Error("Computer has no app, window, or screen targets");
    throw new Error("Computer target is ambiguous; select an exact app or window");
  }
}

export class CodemodeComputerTarget {
  constructor(
    private readonly client: CodemodeClientProvider,
    readonly computerSessionId: string,
    readonly id: string,
  ) {}

  async observe(callOptions: CodemodeCallOptions = {}): Promise<ComputerObservation> {
    return await callStructured(
      this.client,
      PATH.computerObserve,
      { computerSessionId: this.computerSessionId, targetId: this.id },
      callOptions,
    );
  }

  async act(
    action: ComputerAction,
    fences: ComputerActionFences = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<ComputerActionReceipt> {
    return await callStructured(
      this.client,
      PATH.computerAct,
      { computerSessionId: this.computerSessionId, targetId: this.id, action, ...fences },
      callOptions,
    );
  }

  async requestHuman(
    reason: string,
    options: {
      kind?: "manual_login" | "mfa" | "external_action" | "confirmation" | "other";
      expiresInSeconds?: number | undefined;
    } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<RequestHumanInteractionToolOutput> {
    const observation = await this.observe(callOptions);
    return await callStructured(
      this.client,
      PATH.requestHuman,
      {
        operation: "request",
        resourceKind: "computer_session",
        resourceId: this.computerSessionId,
        targetId: this.id,
        expectedControllerGeneration: observation.target.controllerGeneration,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: null,
        kind: options.kind ?? "other",
        reason,
        ...(options.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: options.expiresInSeconds }),
      },
      callOptions,
    );
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    return new CodemodeComputerLocator(this, { kind: "role", role, ...options });
  }

  getByText(text: string, exact?: boolean) {
    return new CodemodeComputerLocator(this, { kind: "text", text, ...(exact ? { exact } : {}) });
  }

  getByLabel(text: string, exact?: boolean) {
    return new CodemodeComputerLocator(this, { kind: "label", text, ...(exact ? { exact } : {}) });
  }

  getByIdentifier(value: string) {
    return new CodemodeComputerLocator(this, { kind: "identifier", value });
  }

  ref(ref: string) {
    return new CodemodeComputerLocator(this, { kind: "ref", ref });
  }
}

export class CodemodeComputerLocator {
  constructor(
    private readonly target: CodemodeComputerTarget,
    readonly locator: ComputerLocator,
  ) {}

  async invoke(callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("invoke", undefined, callOptions);
  }

  async focus(callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("focus", undefined, callOptions);
  }

  async setValue(value: string | number | boolean, callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("set_value", value, callOptions);
  }

  async select(callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("select", undefined, callOptions);
  }

  async expand(callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("expand", undefined, callOptions);
  }

  async collapse(callOptions: CodemodeCallOptions = {}) {
    return await this.semantic("collapse", undefined, callOptions);
  }

  private async semantic(
    action: Extract<ComputerAction, { type: "semantic" }>["action"],
    value: string | number | boolean | undefined,
    callOptions: CodemodeCallOptions,
  ) {
    return await this.target.act(
      {
        type: "semantic",
        locator: this.locator,
        action,
        ...(value === undefined ? {} : { value }),
      },
      {},
      callOptions,
    );
  }
}

export function createOpenGeniCodemode(
  client: CodemodeClient | CodemodeClientProvider = () => environmentCodemodeClient(),
) {
  return new OpenGeniCodemode(client);
}

export const openGeni = createOpenGeniCodemode();
