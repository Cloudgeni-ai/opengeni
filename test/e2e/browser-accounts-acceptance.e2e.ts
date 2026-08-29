import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_SESSION_SET_COOKIE,
  managedAuthSha256,
} from "@opengeni/core/managed-auth-session-sets";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  type ManagedAuthSessionSetProjection,
} from "@opengeni/contracts/managed-auth-session-sets";
import { createDb, provisionRoles, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  acquireOwnerMigratedTestDatabase,
  freePort,
  MemoryEventBus,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Locator,
  type Page,
  type Route,
} from "playwright";

import { createApp } from "../../apps/api/src/app";

const repoRoot = new URL("../..", import.meta.url).pathname;
const RUN_ID = crypto.randomUUID();
const PASSWORD = "Browser-accounts-password-1234";
const EVIDENCE_DIR =
  process.env.OPENGENI_ACCOUNT_EVIDENCE_DIR ?? "/tmp/opengeni-account-acceptance";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const requestedEngine = process.env.OPENGENI_ACCOUNT_BROWSER_ENGINE ?? "chromium";

const ENGINES = {
  chromium,
  firefox,
  webkit,
} satisfies Record<string, BrowserType>;

type EngineName = keyof typeof ENGINES;

type AccountFixture = {
  displayName: string;
  email: string;
  organizationName: string;
  organizationId: string;
  workspaceId: string;
  sessionId: string;
};

type PendingFiniteRead = {
  actorEpoch: string | null;
  description: string;
  dispatchPhase: string;
  method: string;
  pathname: string;
  responseSeen: boolean;
  sessionSetAuthorityHashImmediate: string | null;
  sessionSetAuthorityHash: Promise<string | null>;
  startedAt: number;
  url: string;
};

type BrowserProblems = {
  acceptedRequestTerminals: Array<{
    observedAt: number;
    pathnameAndSearch: string;
    responsePhase: string;
    terminal: "failed" | "finished";
  }>;
  activeStreams: Map<object, string>;
  boundedHttp1StreamDispatches: number;
  boundedHttp1NativeSeams: number;
  actorDispatches: Array<{ actorEpoch: string; startedAt: number }>;
  actorFenceResponses: Array<{
    actorEpoch: string | null;
    dispatchPhase: string;
    endedAt: number;
    method: string;
    pathname: string;
    responsePhase: string;
    search: string;
    startedAt: number;
    status: number;
  }>;
  actorTransitionResponses: Array<{
    actorEpoch: string | null;
    dispatchPhase: string;
    endedAt: number;
    method: string;
    pathname: string;
    request: object;
    responsePhase: string;
    startedAt: number;
    status: number;
  }>;
  consoleErrors: string[];
  phase: string;
  pageErrorEvidence: Array<{ message: string; observedAt: number }>;
  pageErrors: string[];
  failedRequests: string[];
  pendingFiniteReads: Map<object, PendingFiniteRead>;
  pendingRequestFailureChecks: Set<Promise<void>>;
  retirementChecks: string[];
  retiredFiniteReads: string[];
  retiredFiniteReadTombstones: Map<object, string>;
};

type CompletionResponseLoss = {
  acceptedAt: number | null;
  attempts: number;
  dropped: boolean;
  exactBodies: boolean[];
  firstBody: string | null;
  path: string;
  statuses: number[];
};

const ACTOR_TRANSITION_PHASES = [
  "cross-tab-select-race",
  "late-old-epoch-setup-beta-to-alpha",
  "late-old-epoch-alpha-to-beta",
  "late-old-epoch-primary-settled-before-old-release",
  "cross-slot-deep-link",
  "slot-revocation-reauthentication",
  "logout-one",
  "csrf-fail-closed",
  "logout-all-response-loss-replay",
  "signed-out-settled",
] as const;

const DIRECT_RACE_ACTOR_RESPONSE_DISPATCH_PHASES = new Set([
  "primary-set-sign-in",
  "second-tab-bootstrap",
  "add-response-loss-replay",
  "cross-tab-select-race",
]);

const SCOPED_ACTOR_READ_CANCELLATION_DISPATCH_PHASES = new Map<string, ReadonlySet<string>>([
  ["add-response-loss-replay", new Set(["primary-set-sign-in", "add-response-loss-replay"])],
  ["cross-tab-select-race", DIRECT_RACE_ACTOR_RESPONSE_DISPATCH_PHASES],
  [
    "late-old-epoch-setup-beta-to-alpha",
    new Set(["cross-tab-select-race", "late-old-epoch-setup-beta-to-alpha"]),
  ],
  [
    "late-old-epoch-alpha-to-beta",
    new Set(["late-old-epoch-setup-beta-to-alpha", "late-old-epoch-alpha-to-beta"]),
  ],
  [
    "late-old-epoch-primary-settled-before-old-release",
    new Set(["late-old-epoch-alpha-to-beta", "late-old-epoch-primary-settled-before-old-release"]),
  ],
  [
    "cross-slot-deep-link",
    new Set([
      "late-old-epoch-alpha-to-beta",
      "late-old-epoch-primary-settled-before-old-release",
      "cross-slot-deep-link",
    ]),
  ],
  [
    "slot-revocation-reauthentication",
    new Set(["cross-slot-deep-link", "slot-revocation-reauthentication"]),
  ],
  ["logout-one", new Set(["slot-revocation-reauthentication", "logout-one"])],
  ["csrf-fail-closed", new Set(["logout-one", "csrf-fail-closed"])],
  [
    "logout-all-response-loss-replay",
    new Set([
      "slot-revocation-reauthentication",
      "logout-one",
      "csrf-fail-closed",
      "logout-all-response-loss-replay",
    ]),
  ],
  ["signed-out-settled", new Set(["logout-all-response-loss-replay", "signed-out-settled"])],
  [
    "independent-set-after-other-logout-all",
    new Set(["independent-set-sign-in", "independent-set-after-other-logout-all"]),
  ],
]);

const DOCUMENT_BOOTSTRAP_CANCELLATION_PATHS = new Map<string, ReadonlySet<string>>([
  // These phases intentionally create or reload a whole document. React can
  // cancel only its configuration/session bootstrap reads while replacing
  // that document; keep endpoint and phase checks exact so other reads stay red.
  ["primary-set-sign-in", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["add-response-loss-replay", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["second-tab-bootstrap", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["cross-tab-select-race", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["late-old-epoch-setup-beta-to-alpha", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["late-old-epoch-alpha-to-beta", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  [
    "late-old-epoch-primary-settled-before-old-release",
    new Set(["/v1/config/client", "/v1/auth/get-session"]),
  ],
  ["cross-slot-deep-link", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["slot-revocation-reauthentication", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["logout-one", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["logout-all-response-loss-replay", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["signed-out-settled", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["responsive-evidence-bootstrap", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  ["independent-set-sign-in", new Set(["/v1/config/client", "/v1/auth/get-session"])],
  [
    "independent-set-after-other-logout-all",
    new Set(["/v1/config/client", "/v1/auth/get-session"]),
  ],
]);

const DOCUMENT_WORKSPACE_CATALOG_CANCELLATION_PHASES = new Set([
  "primary-set-sign-in",
  "add-response-loss-replay",
  "second-tab-bootstrap",
  "cross-tab-select-race",
  "late-old-epoch-setup-beta-to-alpha",
  "late-old-epoch-alpha-to-beta",
  "late-old-epoch-primary-settled-before-old-release",
  "cross-slot-deep-link",
  "slot-revocation-reauthentication",
  "logout-one",
  "logout-all-response-loss-replay",
  "signed-out-settled",
  "responsive-evidence-bootstrap",
  "independent-set-sign-in",
  "independent-set-after-other-logout-all",
]);

// Session-page hooks now own their native request lifetime just like the
// catalog hooks above. A deliberate route/document replacement may therefore
// cancel only the exact paged session-list GET dispatched by that same phase.
const DOCUMENT_SESSION_PAGE_CANCELLATION_PHASES = DOCUMENT_WORKSPACE_CATALOG_CANCELLATION_PHASES;

const DOCUMENT_BOOTSTRAP_CANCELLATION_DISPATCH_PHASES = new Map<string, ReadonlySet<string>>([
  ["late-old-epoch-primary-settled-before-old-release", new Set(["late-old-epoch-alpha-to-beta"])],
  ["slot-revocation-reauthentication", new Set(["cross-slot-deep-link"])],
]);

const EXPECTED_HTTP_CONSOLE_ERRORS: ReadonlyArray<{
  phases: ReadonlySet<string>;
  pattern: RegExp;
}> = [
  {
    phases: new Set([
      ...ACTOR_TRANSITION_PHASES,
      "responsive-evidence-bootstrap",
      "second-tab-bootstrap",
      "independent-set-after-other-logout-all",
    ]),
    pattern:
      /^Failed to load resource: the server responded with a status of 409 \(Conflict\) @ \/v1\/auth\/get-session$/u,
  },
  {
    phases: new Set(["cross-tab-select-race"]),
    pattern:
      /^Failed to load resource: the server responded with a status of 409 \(Conflict\) @ \/v1\/auth\/session-set\/select$/u,
  },
  {
    phases: new Set(["csrf-fail-closed"]),
    pattern:
      /^Failed to load resource: the server responded with a status of 403 \(Forbidden\) @ \/v1\/auth\/session-set\/logout-all$/u,
  },
  {
    phases: new Set([
      "primary-set-sign-in",
      "second-tab-bootstrap",
      "add-response-loss-replay",
      "responsive-accessibility-evidence",
      "responsive-evidence-bootstrap",
      "cross-tab-select-race",
      "late-old-epoch-setup-beta-to-alpha",
      "late-old-epoch-alpha-to-beta",
      "late-old-epoch-primary-settled-before-old-release",
      "cross-slot-deep-link",
      "slot-revocation-reauthentication",
      "logout-one",
      "csrf-fail-closed",
      "logout-all-response-loss-replay",
      "independent-set-sign-in",
      "independent-set-after-other-logout-all",
    ]),
    pattern:
      /^Failed to load resource: the server responded with a status of 404 \(Not Found\) @ \/v1\/workspaces\/[0-9a-f-]+\/machines$/u,
  },
];

type ActorMutationAcceptance = {
  acceptedAt: number;
  actorEpoch: string | null;
  path: string;
  sessionSetAuthorityHash: string | null;
};

type BrowserRequestFailureInput = {
  acceptedActorTransitions?: readonly ActorMutationAcceptance[];
  actorEpoch: string | null;
  dispatchPhase: string;
  failedAt?: number;
  failure: string;
  method: string;
  responsePhase: string;
  sessionSetAuthorityHash: string | null;
  startedAt?: number;
  url: string;
};

type FiniteReadRetirementInput = {
  acceptedActorTransitions: readonly ActorMutationAcceptance[];
  actorDispatches: readonly { actorEpoch: string; startedAt: number }[];
  actorEpoch: string | null;
  confirmedActorEpoch: string;
  confirmedAt: number;
  currentSessionSetAuthorityHash: string | null;
  dispatchPhase: string;
  method: string;
  oldWorkspaceId: string;
  pathname: string;
  requestSessionSetAuthorityHash: string | null;
  responseSeen: boolean;
  startedAt: number;
};

type DocumentReplacementRetirementInput = {
  actorEpoch: string | null;
  confirmedActorEpoch: string;
  currentSessionSetAuthorityHash: string | null;
  dispatchPhase: string;
  expectedDispatchPhase: string;
  method: string;
  pathname: string;
  replacementStartedAt: number;
  requestSessionSetAuthorityHash: string | null;
  startedAt: number;
  workspaceId: string;
};

type LogoutAllFiniteReadRetirementInput = {
  acceptedActorTransitions: readonly ActorMutationAcceptance[];
  actorEpoch: string | null;
  confirmedActorEpoch: string;
  confirmedAt: number;
  currentSessionSetAuthorityHash: string | null;
  dispatchPhase: string;
  logoutAllAcceptedAt: number;
  method: string;
  oldWorkspaceId: string;
  pathname: string;
  requestSessionSetAuthorityHash: string | null;
  responseSeen: boolean;
  startedAt: number;
};

const ACTOR_CHANGING_ACCEPTANCE_PATHS = new Set([
  "/v1/auth/session-set/logout-all",
  "/v1/auth/session-set/logout-one",
  "/v1/auth/session-set/select",
  "/v1/auth/session-set/transactions/email-password",
]);

function isExpectedHttpConsoleError(rendered: string, phase: string): boolean {
  return EXPECTED_HTTP_CONSOLE_ERRORS.some(
    (expected) => expected.phases.has(phase) && expected.pattern.test(rendered),
  );
}

function sessionSetAuthorityHash(cookieHeader: string | null): string | null {
  const authority = cookieHeader
    ?.split(";")
    .map((cookie) => cookie.trim().split("=", 2))
    .find(([name]) => name === MANAGED_AUTH_SESSION_SET_COOKIE)?.[1];
  return authority && /^[A-Za-z0-9_-]{43}$/u.test(authority) ? managedAuthSha256(authority) : null;
}

function requestFailureProblem(input: BrowserRequestFailureInput): string | null {
  const requestUrl = new URL(input.url);
  const pathname = requestUrl.pathname;
  const isConnectionReset = /NET_RESET|CONNECTION_RESET/iu.test(input.failure);
  const isCancellation =
    /ERR_ABORTED|NS_(?:BINDING_ABORTED|ERROR_ABORT)|NET_RESET|CONNECTION_RESET|cancelled|canceled/iu.test(
      input.failure,
    );
  const isActorOwnedRead =
    input.method === "GET" &&
    (pathname === "/v1/auth/get-session" ||
      pathname === "/v1/auth/session-set" ||
      pathname === "/v1/workspaces" ||
      pathname.startsWith("/v1/workspaces/"));
  const allowedDispatchPhases = SCOPED_ACTOR_READ_CANCELLATION_DISPATCH_PHASES.get(
    input.responsePhase,
  );
  const isExpectedScopedActorReadCancellation =
    isCancellation &&
    !isConnectionReset &&
    isActorOwnedRead &&
    input.actorEpoch !== null &&
    allowedDispatchPhases?.has(input.dispatchPhase) === true;
  const startedAt = input.startedAt;
  const failedAt = input.failedAt;
  const isAcceptedActorTransitionCancellation =
    isCancellation &&
    isActorOwnedRead &&
    input.actorEpoch !== null &&
    typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    typeof failedAt === "number" &&
    Number.isFinite(failedAt) &&
    input.acceptedActorTransitions?.some(
      (transition) =>
        ACTOR_CHANGING_ACCEPTANCE_PATHS.has(transition.path) &&
        transition.actorEpoch !== null &&
        transition.actorEpoch !== input.actorEpoch &&
        transition.sessionSetAuthorityHash === input.sessionSetAuthorityHash &&
        transition.acceptedAt >= startedAt &&
        transition.acceptedAt <= failedAt,
    ) === true;
  const isExpectedLogoutAllBoundedStreamCancellation =
    isCancellation &&
    !isConnectionReset &&
    input.method === "GET" &&
    input.actorEpoch !== null &&
    input.dispatchPhase === "late-old-epoch-primary-settled-before-old-release" &&
    input.responsePhase === "logout-all-response-loss-replay" &&
    requestUrl.searchParams.get("transport") === "http1-bounded" &&
    /^\/v1\/workspaces\/[0-9a-f-]+\/live-events\/stream$/u.test(pathname) &&
    typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    typeof failedAt === "number" &&
    Number.isFinite(failedAt) &&
    input.acceptedActorTransitions?.some(
      (transition) =>
        transition.path === "/v1/auth/session-set/logout-all" &&
        transition.actorEpoch !== null &&
        transition.actorEpoch !== input.actorEpoch &&
        transition.acceptedAt >= startedAt &&
        transition.acceptedAt <= failedAt,
    ) === true;
  const isExpectedEvidenceCatalogCancellation =
    isCancellation &&
    !isConnectionReset &&
    input.method === "GET" &&
    input.actorEpoch !== null &&
    input.dispatchPhase === input.responsePhase &&
    DOCUMENT_WORKSPACE_CATALOG_CANCELLATION_PHASES.has(input.responsePhase) &&
    /^\/v1\/workspaces\/[0-9a-f-]+\/(?:realtime-)?model-catalog$/u.test(pathname);
  const isExpectedDocumentSessionPageCancellation =
    isCancellation &&
    !isConnectionReset &&
    input.method === "GET" &&
    input.actorEpoch !== null &&
    input.dispatchPhase === input.responsePhase &&
    DOCUMENT_SESSION_PAGE_CANCELLATION_PHASES.has(input.responsePhase) &&
    /^\/v1\/workspaces\/[0-9a-f-]+\/sessions$/u.test(pathname) &&
    requestUrl.searchParams.get("view") === "page";
  const isExpectedDocumentBootstrapCancellation =
    isCancellation &&
    !isConnectionReset &&
    input.method === "GET" &&
    DOCUMENT_BOOTSTRAP_CANCELLATION_PATHS.get(input.responsePhase)?.has(pathname) === true &&
    (input.dispatchPhase === input.responsePhase ||
      DOCUMENT_BOOTSTRAP_CANCELLATION_DISPATCH_PHASES.get(input.responsePhase)?.has(
        input.dispatchPhase,
      ) === true);
  if (
    isExpectedScopedActorReadCancellation ||
    isAcceptedActorTransitionCancellation ||
    isExpectedLogoutAllBoundedStreamCancellation ||
    isExpectedEvidenceCatalogCancellation ||
    isExpectedDocumentSessionPageCancellation ||
    isExpectedDocumentBootstrapCancellation
  ) {
    return null;
  }
  return `[dispatch=${input.dispatchPhase}; actor=${input.actorEpoch ?? "missing"}; response=${input.responsePhase}] ${input.method} ${input.url}: ${input.failure}`;
}

function isExpectedBoundedHttp1NativeSeam(input: {
  failedAt: number;
  failure: string;
  method: string;
  startedAt?: number;
  url: string;
}): boolean {
  if (
    input.method !== "GET" ||
    typeof input.startedAt !== "number" ||
    !Number.isFinite(input.startedAt) ||
    !Number.isFinite(input.failedAt)
  ) {
    return false;
  }
  // Chromium and Firefox expose concrete abort codes; WebKit reports a bare
  // cancellation word. Exact matching prevents an abort-shaped prefix from
  // hiding a reset, timeout, DNS, or other transport failure.
  const isCancellation =
    /^(?:(?:net::)?ERR_ABORTED|NS_(?:BINDING_ABORTED|ERROR_ABORT)|(?:request (?:was )?)?(?:cancelled|canceled))$/iu.test(
      input.failure.trim(),
    );
  const elapsedMs = input.failedAt - input.startedAt;
  // The browser-owned body and pre-header seams fire at eleven seconds. Allow
  // only the request-start offset plus bounded scheduling jitter; the
  // four-second logical reconnect grace does not extend the native request's
  // cancellation deadline.
  return (
    isBoundedHttp1StreamRequest(input.method, input.url) &&
    isCancellation &&
    elapsedMs >= 10_000 &&
    elapsedMs <= 15_000
  );
}

function isBoundedHttp1StreamRequest(method: string, rawUrl: string): boolean {
  if (method !== "GET") return false;
  const url = new URL(rawUrl);
  return (
    (url.pathname.endsWith("/stream") || url.pathname.includes("/live-events/stream")) &&
    url.searchParams.get("transport") === "http1-bounded"
  );
}

function retiredFiniteReadTerminalProblem(
  description: string | undefined,
  terminal: { kind: "finished" } | { kind: "response"; status: number },
): string | null {
  if (description === undefined) return null;
  return terminal.kind === "response"
    ? `${description} [unexpected-late-response=${terminal.status}]`
    : `${description} [unexpected-late-finish]`;
}

function finiteReadMayRetireAfterActorTransition(input: FiniteReadRetirementInput): boolean {
  const exactOldWorkspacePrefix = `/v1/workspaces/${encodeURIComponent(input.oldWorkspaceId)}/`;
  // Chromium can omit the HttpOnly Cookie header from both synchronous and
  // asynchronous Playwright request inspection after an aborted document.
  // That absence is accepted only for the exact second-tab bootstrap/direct
  // select race: the request and positive new-actor dispatch belong to the
  // same Page and BrowserContext, the accepted select carries the context's
  // current authority hash, and no session-set replacement occurs in either
  // phase.
  const requestAuthorityMatches =
    input.requestSessionSetAuthorityHash === input.currentSessionSetAuthorityHash ||
    (input.requestSessionSetAuthorityHash === null &&
      new Set(["second-tab-bootstrap", "cross-tab-select-race"]).has(input.dispatchPhase));
  return (
    new Set(["GET", "HEAD"]).has(input.method) &&
    input.actorEpoch !== null &&
    input.actorEpoch !== input.confirmedActorEpoch &&
    !input.responseSeen &&
    input.pathname.startsWith(exactOldWorkspacePrefix) &&
    input.currentSessionSetAuthorityHash !== null &&
    requestAuthorityMatches &&
    input.acceptedActorTransitions.some(
      (transition) =>
        transition.path === "/v1/auth/session-set/select" &&
        transition.actorEpoch === input.confirmedActorEpoch &&
        transition.sessionSetAuthorityHash === input.currentSessionSetAuthorityHash &&
        transition.acceptedAt <= input.confirmedAt &&
        input.actorDispatches.some(
          (dispatch) =>
            dispatch.actorEpoch === input.confirmedActorEpoch &&
            dispatch.startedAt >= transition.acceptedAt &&
            dispatch.startedAt >= input.startedAt &&
            dispatch.startedAt <= input.confirmedAt,
        ),
    )
  );
}

function finiteReadMayRetireAfterDocumentReplacement(
  input: DocumentReplacementRetirementInput,
): boolean {
  const exactWorkspacePrefix = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/`;
  const documentOwnedSessionRead = new RegExp(
    `^${exactWorkspacePrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}sessions/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:/lineage)?$`,
    "u",
  ).test(input.pathname);
  // Chromium may omit the HttpOnly Cookie header from Playwright metadata
  // after destroying the old document. The only headerless exception is the
  // exact same-actor deep-link document replaced before re-authentication;
  // that interval cannot replace the session-set authority, and every other
  // actor, phase, path, method, and timing check remains mandatory.
  const requestAuthorityMatches =
    input.requestSessionSetAuthorityHash === input.currentSessionSetAuthorityHash ||
    (input.requestSessionSetAuthorityHash === null &&
      input.expectedDispatchPhase === "cross-slot-deep-link");
  return (
    new Set(["GET", "HEAD"]).has(input.method) &&
    input.actorEpoch !== null &&
    input.actorEpoch === input.confirmedActorEpoch &&
    input.dispatchPhase === input.expectedDispatchPhase &&
    documentOwnedSessionRead &&
    input.currentSessionSetAuthorityHash !== null &&
    requestAuthorityMatches &&
    Number.isFinite(input.startedAt) &&
    Number.isFinite(input.replacementStartedAt) &&
    input.startedAt <= input.replacementStartedAt
  );
}

function finiteReadMayRetireAfterLogoutAllAuthorityReset(
  input: LogoutAllFiniteReadRetirementInput,
): boolean {
  // Chromium can omit every Playwright terminal for a finite request that was
  // still queued when logout-all synchronously aborted the old actor. Retire
  // only a pre-acceptance read whose old HttpOnly authority is bound to the
  // exact accepted reset and differs from the confirmed replacement set.
  const exactOldWorkspacePrefix = `/v1/workspaces/${encodeURIComponent(input.oldWorkspaceId)}/`;
  const allowedDispatchPhases = SCOPED_ACTOR_READ_CANCELLATION_DISPATCH_PHASES.get(
    "logout-all-response-loss-replay",
  );
  return (
    new Set(["GET", "HEAD"]).has(input.method) &&
    input.actorEpoch !== null &&
    input.actorEpoch !== input.confirmedActorEpoch &&
    !input.responseSeen &&
    input.pathname.startsWith(exactOldWorkspacePrefix) &&
    allowedDispatchPhases?.has(input.dispatchPhase) === true &&
    input.currentSessionSetAuthorityHash !== null &&
    input.requestSessionSetAuthorityHash !== null &&
    input.requestSessionSetAuthorityHash !== input.currentSessionSetAuthorityHash &&
    Number.isFinite(input.startedAt) &&
    Number.isFinite(input.logoutAllAcceptedAt) &&
    Number.isFinite(input.confirmedAt) &&
    input.startedAt <= input.logoutAllAcceptedAt &&
    input.logoutAllAcceptedAt <= input.confirmedAt &&
    input.acceptedActorTransitions.some(
      (transition) =>
        transition.path === "/v1/auth/session-set/logout-all" &&
        transition.acceptedAt === input.logoutAllAcceptedAt &&
        transition.actorEpoch !== null &&
        transition.actorEpoch !== input.actorEpoch &&
        transition.sessionSetAuthorityHash === input.requestSessionSetAuthorityHash,
    )
  );
}

function actorTransitionResponseDispatchPhaseMatches(input: {
  dispatchPhase: string;
  expectedPhase: string;
  permitsDirectRacePredecessors: boolean;
  responsePhase: string;
}): boolean {
  if (input.responsePhase !== input.expectedPhase) return false;
  return input.permitsDirectRacePredecessors
    ? input.expectedPhase === "cross-tab-select-race" &&
        DIRECT_RACE_ACTOR_RESPONSE_DISPATCH_PHASES.has(input.dispatchPhase)
    : input.dispatchPhase === input.expectedPhase;
}

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let edge: ReturnType<typeof Bun.serve> | null = null;
let publicOrigin = "";
let edgeCookieSummary = "not-observed";
let completionResponseLoss: CompletionResponseLoss | null = null;
const actorMutationAcceptances: ActorMutationAcceptance[] = [];
const observedBrowserProblems = new WeakMap<Page, BrowserProblems>();
let alpha: AccountFixture;
let beta: AccountFixture;

function workflowStub(): SessionWorkflowClient {
  const noop = async () => undefined;
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
}

function appDatabaseUrl(fixture: OwnerMigratedTestDatabase): string {
  const value = new URL(fixture.ownerUrl);
  value.username = "opengeni_app";
  value.password = fixture.appPassword;
  return value.toString();
}

function sdk(cookie: string, actorEpoch: string): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl: publicOrigin,
    headers: { cookie, [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: actorEpoch },
  });
}

async function createActualUser(input: {
  displayName: string;
  email: string;
  organizationName: string;
}): Promise<AccountFixture> {
  if (!owned) throw new Error("database fixture unavailable");
  const signUp = await fetch(`${publicOrigin}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.displayName,
      email: input.email,
      password: PASSWORD,
    }),
  });
  expect(signUp.status).toBeLessThan(300);
  await owned.admin`update auth_users set email_verified = true where email = ${input.email}`;
  return {
    displayName: input.displayName,
    email: input.email,
    organizationName: input.organizationName,
    organizationId: "",
    workspaceId: "",
    sessionId: "",
  };
}

async function browserCookieHeader(context: BrowserContext): Promise<string> {
  return (await context.cookies(publicOrigin))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

async function authSessionCount(email: string): Promise<number> {
  if (!owned) throw new Error("database fixture unavailable");
  const [row] = await owned.admin<{ count: number }[]>`
    select count(*)::int as count
    from auth_sessions session
    inner join auth_users auth_user on auth_user.id = session.user_id
    where auth_user.email = ${email}`;
  if (!row) throw new Error("provider session count unavailable");
  return row.count;
}

function observeBrowser(page: Page): BrowserProblems {
  const problems: BrowserProblems = {
    acceptedRequestTerminals: [],
    activeStreams: new Map(),
    boundedHttp1StreamDispatches: 0,
    boundedHttp1NativeSeams: 0,
    actorDispatches: [],
    actorFenceResponses: [],
    actorTransitionResponses: [],
    consoleErrors: [],
    phase: "initialization",
    pageErrorEvidence: [],
    pageErrors: [],
    failedRequests: [],
    pendingFiniteReads: new Map(),
    pendingRequestFailureChecks: new Set(),
    retirementChecks: [],
    retiredFiniteReads: [],
    retiredFiniteReadTombstones: new Map(),
  };
  observedBrowserProblems.set(page, problems);
  const requestPhases = new WeakMap<
    object,
    {
      actorEpoch: string | null;
      phase: string;
      sessionSetAuthorityHash: Promise<string | null>;
      startedAt: number;
    }
  >();
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    const actorEpoch = request.headers()[MANAGED_AUTH_ACTOR_EPOCH_HEADER] ?? null;
    const startedAt = performance.now();
    const requestSessionSetAuthorityHash = request
      .headerValue("cookie")
      .then(sessionSetAuthorityHash, () => null);
    if (actorEpoch !== null) problems.actorDispatches.push({ actorEpoch, startedAt });
    if (pathname.endsWith("/stream") || pathname.includes("/live-events/stream")) {
      if (requestUrl.searchParams.get("transport") === "http1-bounded") {
        problems.boundedHttp1StreamDispatches += 1;
      }
      problems.activeStreams.set(
        request,
        `[dispatch=${problems.phase}; actor=${actorEpoch ?? "missing"}] ${request.method()} ${request.url()}`,
      );
    }
    // Product mutation helpers are awaited explicitly and remain covered by
    // the strict failure ledger. This tracker prevents a full-document goto
    // from tearing down background finite reads from the just-selected actor.
    const isFiniteApiRead =
      request.method() === "GET" &&
      pathname.startsWith("/v1/") &&
      !pathname.endsWith("/stream") &&
      !pathname.includes("/live-events/stream");
    if (isFiniteApiRead) {
      problems.pendingFiniteReads.set(request, {
        actorEpoch,
        description: `[dispatch=${problems.phase}; actor=${actorEpoch ?? "missing"}; start=${startedAt.toFixed(1)}] ${request.method()} ${request.url()}`,
        dispatchPhase: problems.phase,
        method: request.method(),
        pathname,
        responseSeen: false,
        sessionSetAuthorityHashImmediate: sessionSetAuthorityHash(
          request.headers()["cookie"] ?? null,
        ),
        sessionSetAuthorityHash: requestSessionSetAuthorityHash,
        startedAt,
        url: request.url(),
      });
    }
    requestPhases.set(request, {
      actorEpoch,
      phase: problems.phase,
      sessionSetAuthorityHash: requestSessionSetAuthorityHash,
      startedAt,
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    const pathname = new URL(response.url()).pathname;
    const retiredTerminalProblem = retiredFiniteReadTerminalProblem(
      problems.retiredFiniteReadTombstones.get(request),
      { kind: "response", status: response.status() },
    );
    if (retiredTerminalProblem !== null) {
      problems.failedRequests.push(retiredTerminalProblem);
      problems.retiredFiniteReadTombstones.delete(request);
    }
    const pendingFiniteRead = problems.pendingFiniteReads.get(request);
    if (pendingFiniteRead !== undefined) {
      pendingFiniteRead.description = `${pendingFiniteRead.description} [response=${response.status()}; end=${performance.now().toFixed(1)}]`;
      pendingFiniteRead.responseSeen = true;
    }
    if (response.status() === 401 && pathname.startsWith("/v1/workspaces/")) {
      const dispatch = requestPhases.get(request);
      const responseUrl = new URL(response.url());
      problems.actorFenceResponses.push({
        actorEpoch: dispatch?.actorEpoch ?? null,
        dispatchPhase: dispatch?.phase ?? "unknown",
        endedAt: performance.now(),
        method: request.method(),
        pathname,
        responsePhase: problems.phase,
        search: responseUrl.search,
        startedAt: dispatch?.startedAt ?? Number.NaN,
        status: response.status(),
      });
    }
    const recordsActorTransition =
      (response.status() === 403 &&
        pathname.endsWith("/attention") &&
        new Set(["logout-one", "logout-all-response-loss-replay"]).has(problems.phase)) ||
      (response.status() === 409 &&
        request.method() === "GET" &&
        pathname.startsWith("/v1/workspaces/") &&
        problems.phase === "cross-tab-select-race");
    if (recordsActorTransition) {
      const dispatch = requestPhases.get(request);
      problems.actorTransitionResponses.push({
        actorEpoch: dispatch?.actorEpoch ?? null,
        dispatchPhase: dispatch?.phase ?? "unknown",
        endedAt: performance.now(),
        method: request.method(),
        pathname,
        request,
        responsePhase: problems.phase,
        startedAt: dispatch?.startedAt ?? Number.NaN,
        status: response.status(),
      });
    }
  });
  page.on("requestfinished", (request) => {
    const finishedAt = performance.now();
    const finishedUrl = new URL(request.url());
    const finishedFiniteRead = problems.pendingFiniteReads.get(request);
    const finishedBoundedStream = isBoundedHttp1StreamRequest(request.method(), request.url());
    problems.activeStreams.delete(request);
    problems.pendingFiniteReads.delete(request);
    if (
      problems.phase === "slot-revocation-reauthentication" &&
      (finishedFiniteRead !== undefined || finishedBoundedStream)
    ) {
      // After its finite bytes are detached, WebKit may report the explicit
      // native-fetch retirement—or an old-document finite-read cancellation—
      // as a renderer access-control error while Playwright has already
      // classified the same request as finished. Keep exact terminal evidence
      // for the same bijective page-error fence used by requestfailed;
      // unrelated successful requests cannot authorize it.
      if (finishedBoundedStream) problems.boundedHttp1NativeSeams += 1;
      problems.acceptedRequestTerminals.push({
        observedAt: finishedAt,
        pathnameAndSearch: `${finishedUrl.pathname}${finishedUrl.search}`,
        responsePhase: problems.phase,
        terminal: "finished",
      });
    }
    const retiredTerminalProblem = retiredFiniteReadTerminalProblem(
      problems.retiredFiniteReadTombstones.get(request),
      { kind: "finished" },
    );
    if (retiredTerminalProblem !== null) {
      problems.failedRequests.push(retiredTerminalProblem);
      problems.retiredFiniteReadTombstones.delete(request);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      const rendered = source ? `${message.text()} @ ${new URL(source).pathname}` : message.text();
      // The journey deliberately proves fail-closed 403/409 requests, while a
      // disabled Connected Machines surface deliberately returns 404. Keep
      // every other browser error strict.
      if (!isExpectedHttpConsoleError(rendered, problems.phase)) {
        problems.consoleErrors.push(`[${problems.phase}] ${rendered}`);
      }
    }
  });
  page.on("pageerror", (error) => {
    const message = `[${problems.phase}] ${error.message}`;
    problems.pageErrorEvidence.push({ message, observedAt: performance.now() });
    problems.pageErrors.push(message);
  });
  page.on("requestfailed", (request) => {
    const failedAt = performance.now();
    const dispatch = requestPhases.get(request);
    const failure = request.failure()?.errorText ?? "unknown";
    const responsePhase = problems.phase;
    const failedUrl = new URL(request.url());
    problems.activeStreams.delete(request);
    problems.retiredFiniteReadTombstones.delete(request);
    // A failed finite read is terminal whether expected or not. Remove it from
    // quiescence tracking, but keep every non-transition failure in the strict
    // final ledger—including canceled product mutations.
    problems.pendingFiniteReads.delete(request);
    if (
      isExpectedBoundedHttp1NativeSeam({
        failedAt,
        failure,
        method: request.method(),
        startedAt: dispatch?.startedAt,
        url: request.url(),
      })
    ) {
      problems.boundedHttp1NativeSeams += 1;
      // WebKit can additionally surface the exact canceled request as a page
      // access-control error. Preserve the URL, phase, and timestamp so the
      // page-error gate can require the same strict one-to-one correlation as
      // actor-transition cancellations instead of broadly allowing CORS text.
      problems.acceptedRequestTerminals.push({
        observedAt: failedAt,
        pathnameAndSearch: `${failedUrl.pathname}${failedUrl.search}`,
        responsePhase,
        terminal: "failed",
      });
      return;
    }
    const check = (async () => {
      const problem = requestFailureProblem({
        acceptedActorTransitions: actorMutationAcceptances,
        actorEpoch: dispatch?.actorEpoch ?? null,
        dispatchPhase: dispatch?.phase ?? "unknown",
        failedAt,
        failure,
        method: request.method(),
        responsePhase,
        sessionSetAuthorityHash: dispatch ? await dispatch.sessionSetAuthorityHash : null,
        startedAt: dispatch?.startedAt,
        url: request.url(),
      });
      if (problem !== null) {
        problems.failedRequests.push(problem);
      } else {
        problems.acceptedRequestTerminals.push({
          observedAt: failedAt,
          pathnameAndSearch: `${failedUrl.pathname}${failedUrl.search}`,
          responsePhase,
          terminal: "failed",
        });
      }
    })();
    problems.pendingRequestFailureChecks.add(check);
    void check.finally(() => problems.pendingRequestFailureChecks.delete(check));
  });
  return problems;
}

function setBrowserPhase(problems: BrowserProblems, phase: string): void {
  problems.phase = phase;
}

async function waitForFiniteReadQuiescence(
  problems: BrowserProblems,
  timeout = 30_000,
): Promise<void> {
  await waitForFiniteReadQuiescenceAcross([problems], timeout);
}

async function waitForFiniteReadQuiescenceAcross(
  ledgers: readonly BrowserProblems[],
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    if (ledgers.every((problems) => problems.pendingFiniteReads.size === 0)) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 250) return;
    } else {
      quietSince = null;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `finite browser reads did not settle: ${JSON.stringify(
      ledgers.map((problems) => ({
        pending: [...problems.pendingFiniteReads.values()]
          .map(({ description }) => description)
          .sort(),
        activeStreams: [...problems.activeStreams.values()].sort(),
        actorDispatches: problems.actorDispatches.slice(-20),
        retirementChecks: problems.retirementChecks.slice(-20),
        retiredFiniteReads: problems.retiredFiniteReads.slice(-20),
      })),
    )}; acceptances=${JSON.stringify(actorMutationAcceptances.slice(-20))}`,
  );
}

async function waitForCompanionFiniteReadQuiescence(
  problems: BrowserProblems,
  intentionallyHeldRequest: object,
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    const companions = [...problems.pendingFiniteReads.keys()].filter(
      (request) => request !== intentionallyHeldRequest,
    );
    if (companions.length === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 250) return;
    } else {
      quietSince = null;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `companion browser reads did not settle around the intentional hold: ${JSON.stringify(
      [...problems.pendingFiniteReads.entries()]
        .filter(([request]) => request !== intentionallyHeldRequest)
        .map(([, pending]) => pending.description)
        .sort(),
    )}`,
  );
}

async function retirePendingReadsAfterConfirmedActorTransition(
  page: Page,
  problems: BrowserProblems,
  input: {
    confirmedActorEpoch: string;
    confirmedAt: number;
    oldWorkspaceId: string;
  },
): Promise<void> {
  const currentSessionSetAuthorityHash = sessionSetAuthorityHash(
    await browserCookieHeader(page.context()),
  );
  for (const [request, pending] of [...problems.pendingFiniteReads.entries()]) {
    const requestSessionSetAuthorityHash =
      pending.sessionSetAuthorityHashImmediate ??
      (await Promise.race([pending.sessionSetAuthorityHash, Bun.sleep(1_000).then(() => null)]));
    const retirementInput = {
      acceptedActorTransitions: actorMutationAcceptances,
      actorDispatches: problems.actorDispatches,
      actorEpoch: pending.actorEpoch,
      confirmedActorEpoch: input.confirmedActorEpoch,
      confirmedAt: input.confirmedAt,
      currentSessionSetAuthorityHash,
      dispatchPhase: pending.dispatchPhase,
      method: pending.method,
      oldWorkspaceId: input.oldWorkspaceId,
      pathname: pending.pathname,
      requestSessionSetAuthorityHash,
      responseSeen: pending.responseSeen,
      startedAt: pending.startedAt,
    } satisfies FiniteReadRetirementInput;
    const mayRetire = finiteReadMayRetireAfterActorTransition(retirementInput);
    problems.retirementChecks.push(
      JSON.stringify({
        actorEpoch: pending.actorEpoch,
        confirmedActorEpoch: input.confirmedActorEpoch,
        currentSessionSetAuthorityPresent: currentSessionSetAuthorityHash !== null,
        dispatchPhase: pending.dispatchPhase,
        method: pending.method,
        pathname: pending.pathname,
        requestSessionSetAuthorityMatches:
          requestSessionSetAuthorityHash === currentSessionSetAuthorityHash,
        requestSessionSetAuthorityPresent: requestSessionSetAuthorityHash !== null,
        responseSeen: pending.responseSeen,
        result: mayRetire ? "retired" : "kept",
        startedAt: pending.startedAt,
      }),
    );
    if (!mayRetire) {
      continue;
    }
    problems.retiredFiniteReads.push(
      `${pending.description} [retired=confirmed-actor-${input.confirmedActorEpoch}]`,
    );
    problems.retiredFiniteReadTombstones.set(request, pending.description);
    problems.pendingFiniteReads.delete(request);
  }
}

async function retirePendingReadsAfterConfirmedDocumentReplacement(
  page: Page,
  problems: BrowserProblems,
  input: {
    confirmedActorEpoch: string;
    dispatchPhase: string;
    replacementStartedAt: number;
    workspaceId: string;
  },
): Promise<void> {
  const currentSessionSetAuthorityHash = sessionSetAuthorityHash(
    await browserCookieHeader(page.context()),
  );
  const exactWorkspacePrefix = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sessions/`;
  for (const [request, pending] of [...problems.pendingFiniteReads.entries()]) {
    if (
      (pending.method !== "GET" && pending.method !== "HEAD") ||
      pending.actorEpoch !== input.confirmedActorEpoch ||
      pending.dispatchPhase !== input.dispatchPhase ||
      !pending.pathname.startsWith(exactWorkspacePrefix) ||
      pending.startedAt > input.replacementStartedAt
    ) {
      continue;
    }
    const requestSessionSetAuthorityHash =
      pending.sessionSetAuthorityHashImmediate ??
      (await Promise.race([pending.sessionSetAuthorityHash, Bun.sleep(1_000).then(() => null)]));
    const mayRetire = finiteReadMayRetireAfterDocumentReplacement({
      actorEpoch: pending.actorEpoch,
      confirmedActorEpoch: input.confirmedActorEpoch,
      currentSessionSetAuthorityHash,
      dispatchPhase: pending.dispatchPhase,
      expectedDispatchPhase: input.dispatchPhase,
      method: pending.method,
      pathname: pending.pathname,
      replacementStartedAt: input.replacementStartedAt,
      requestSessionSetAuthorityHash,
      startedAt: pending.startedAt,
      workspaceId: input.workspaceId,
    });
    if (!mayRetire) continue;
    problems.retiredFiniteReads.push(
      `${pending.description} [retired=confirmed-document-replacement]`,
    );
    problems.pendingFiniteReads.delete(request);
  }
}

async function retirePendingReadsAfterConfirmedLogoutAllAuthorityReset(
  page: Page,
  problems: BrowserProblems,
  input: {
    confirmedActorEpoch: string;
    confirmedAt: number;
    logoutAllAcceptedAt: number;
    oldWorkspaceId: string;
  },
): Promise<void> {
  const currentSessionSetAuthorityHash = sessionSetAuthorityHash(
    await browserCookieHeader(page.context()),
  );
  for (const [request, pending] of [...problems.pendingFiniteReads.entries()]) {
    const requestSessionSetAuthorityHash =
      pending.sessionSetAuthorityHashImmediate ??
      (await Promise.race([pending.sessionSetAuthorityHash, Bun.sleep(1_000).then(() => null)]));
    const mayRetire = finiteReadMayRetireAfterLogoutAllAuthorityReset({
      acceptedActorTransitions: actorMutationAcceptances,
      actorEpoch: pending.actorEpoch,
      confirmedActorEpoch: input.confirmedActorEpoch,
      confirmedAt: input.confirmedAt,
      currentSessionSetAuthorityHash,
      dispatchPhase: pending.dispatchPhase,
      logoutAllAcceptedAt: input.logoutAllAcceptedAt,
      method: pending.method,
      oldWorkspaceId: input.oldWorkspaceId,
      pathname: pending.pathname,
      requestSessionSetAuthorityHash,
      responseSeen: pending.responseSeen,
      startedAt: pending.startedAt,
    });
    problems.retirementChecks.push(
      JSON.stringify({
        actorEpoch: pending.actorEpoch,
        confirmedActorEpoch: input.confirmedActorEpoch,
        currentSessionSetAuthorityPresent: currentSessionSetAuthorityHash !== null,
        dispatchPhase: pending.dispatchPhase,
        logoutAllAcceptedAt: input.logoutAllAcceptedAt,
        method: pending.method,
        pathname: pending.pathname,
        requestSessionSetAuthorityChanged:
          requestSessionSetAuthorityHash !== null &&
          requestSessionSetAuthorityHash !== currentSessionSetAuthorityHash,
        requestSessionSetAuthorityPresent: requestSessionSetAuthorityHash !== null,
        responseSeen: pending.responseSeen,
        result: mayRetire ? "retired-after-logout-all" : "kept-after-logout-all",
        startedAt: pending.startedAt,
      }),
    );
    if (!mayRetire) continue;
    problems.retiredFiniteReads.push(
      `${pending.description} [retired=confirmed-logout-all-authority-reset]`,
    );
    problems.retiredFiniteReadTombstones.set(request, pending.description);
    problems.pendingFiniteReads.delete(request);
  }
}

async function settlePendingRequestFailureChecks(problems: BrowserProblems): Promise<void> {
  while (problems.pendingRequestFailureChecks.size > 0) {
    await Promise.all([...problems.pendingRequestFailureChecks]);
  }
}

async function expectNoBrowserProblems(problems: BrowserProblems): Promise<void> {
  await settlePendingRequestFailureChecks(problems);
  expect({
    actorFenceResponses: problems.actorFenceResponses,
    actorTransitionResponses: problems.actorTransitionResponses,
    consoleErrors: problems.consoleErrors,
    failedRequests: problems.failedRequests,
    pageErrors: problems.pageErrors,
    pendingFiniteReads: [...problems.pendingFiniteReads.values()]
      .map(({ description }) => description)
      .sort(),
  }).toEqual({
    actorFenceResponses: [],
    actorTransitionResponses: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    pendingFiniteReads: [],
  });
}

async function expectAndConsumeConsoleErrors(
  page: Page,
  problems: BrowserProblems,
  allowed: string[],
  required: string[] = allowed,
): Promise<void> {
  // Console delivery trails the response event by a task. Consume only the
  // exact fail-closed requests intentionally induced by the current window;
  // every later or additional browser error remains subject to the final gate.
  await page.waitForTimeout(1_000);
  const counts = Object.fromEntries(
    [...new Set(problems.consoleErrors)].map((message) => [
      message,
      problems.consoleErrors.filter((candidate) => candidate === message).length,
    ]),
  );
  const allowedCounts = Object.fromEntries(
    [...new Set(allowed)].map((message) => [
      message,
      allowed.filter((candidate) => candidate === message).length,
    ]),
  );
  expect({
    excess: Object.fromEntries(
      Object.entries(counts).filter(([message, count]) => count > (allowedCounts[message] ?? 0)),
    ),
    missing: required.filter((message) => !problems.consoleErrors.includes(message)),
  }).toEqual({ excess: {}, missing: [] });
  problems.consoleErrors.splice(0);
}

async function expectAndConsumePageErrors(
  page: Page,
  problems: BrowserProblems,
  allowed: string[] | (() => string[]),
  required: string[],
): Promise<void> {
  // A request terminal is delivered over Playwright independently from the
  // renderer task that reports the corresponding page error. Close the
  // complete correlation window for every accepted terminal, cross two renderer
  // task boundaries, then check again for later evidence. This derives the
  // wait from the same fail-closed time fence used by the matcher instead of an
  // arbitrary delay, so delayed evidence is either present now or too late to
  // be accepted and remains in the final strict ledger.
  let latestEvidenceAt = Number.NEGATIVE_INFINITY;
  while (true) {
    await settlePendingRequestFailureChecks(problems);
    latestEvidenceAt = Math.max(
      latestEvidenceAt,
      ...problems.acceptedRequestTerminals.map(({ observedAt }) => observedAt),
      ...problems.pageErrorEvidence.map(({ observedAt }) => observedAt),
    );
    const remainingCorrelationWindow =
      latestEvidenceAt + WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS - performance.now();
    if (remainingCorrelationWindow > 0) await Bun.sleep(remainingCorrelationWindow);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => setTimeout(resolve, 0), 0);
        }),
    );
    await settlePendingRequestFailureChecks(problems);
    const nextLatestEvidenceAt = Math.max(
      Number.NEGATIVE_INFINITY,
      ...problems.acceptedRequestTerminals.map(({ observedAt }) => observedAt),
      ...problems.pageErrorEvidence.map(({ observedAt }) => observedAt),
    );
    if (
      nextLatestEvidenceAt <= latestEvidenceAt &&
      performance.now() >= nextLatestEvidenceAt + WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS
    ) {
      break;
    }
  }
  const allowedMessages = typeof allowed === "function" ? allowed() : allowed;
  const counts = Object.fromEntries(
    [...new Set(problems.pageErrors)].map((message) => [
      message,
      problems.pageErrors.filter((candidate) => candidate === message).length,
    ]),
  );
  const allowedCounts = Object.fromEntries(
    [...new Set(allowedMessages)].map((message) => [
      message,
      allowedMessages.filter((candidate) => candidate === message).length,
    ]),
  );
  expect({
    excess: Object.fromEntries(
      Object.entries(counts).filter(([message, count]) => count > (allowedCounts[message] ?? 0)),
    ),
    missing: required.filter((message) => !problems.pageErrors.includes(message)),
  }).toEqual({ excess: {}, missing: [] });
  problems.pageErrorEvidence.splice(0);
  problems.pageErrors.splice(0);
}

function optionalWebKitReauthenticationReloadError(
  problems: BrowserProblems,
  engine: EngineName,
): string[] {
  if (engine !== "webkit") return [];
  // WebKit can report the deliberately replaced document's canceled root
  // module import after the re-authenticated document has already won. Keep
  // the phase, message, hashed entry asset, and maximum count exact.
  return problems.consoleErrors
    .filter((message) =>
      /^\[slot-revocation-reauthentication\] TypeError: Importing a module script failed\. @ \/assets\/index-[A-Za-z0-9_-]+\.js$/u.test(
        message,
      ),
    )
    .slice(0, 1);
}

// One finite batch plus its reconnect grace separates identical bounded polls.
// Keep the terminal/page-error fence inside that four-second grace so a loaded
// WebKit renderer may deliver its callbacks in either order, while the next
// request to the same URL cannot authorize stale evidence from the prior one.
const WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS = 4_000;

function correlatedWebKitReauthenticationTerminalIndex(
  pageError: BrowserProblems["pageErrorEvidence"][number],
  acceptedRequestTerminals: BrowserProblems["acceptedRequestTerminals"],
): number | null {
  const match =
    /^\[slot-revocation-reauthentication\] \/127\.0\.0\.1:\d+(?<pathnameAndSearch>\/v1\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_./?=&%-]+) due to access control checks\.$/u.exec(
      pageError.message,
    );
  const pathnameAndSearch = match?.groups?.pathnameAndSearch;
  if (pathnameAndSearch === undefined) return null;
  const matchingTerminalIndexes = acceptedRequestTerminals.flatMap((terminal, index) =>
    terminal.responsePhase === "slot-revocation-reauthentication" &&
    terminal.pathnameAndSearch === pathnameAndSearch &&
    Math.abs(pageError.observedAt - terminal.observedAt) <= WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS
      ? [index]
      : [],
  );
  return matchingTerminalIndexes.length === 1 ? matchingTerminalIndexes[0]! : null;
}

function optionalWebKitReauthenticationAccessControlPageError(
  problems: Pick<BrowserProblems, "acceptedRequestTerminals" | "pageErrorEvidence">,
  engine: EngineName,
): string[] {
  if (engine !== "webkit") return [];
  // WebKit can surface reads from the deliberately replaced document as page
  // errors in addition to their request-cancellation events. Native-first
  // transport teardown can expose more than one of those errors, so require a
  // bijection: every page error must have exactly one same-phase, exact-URL
  // failed-or-finished terminal inside the same bounded delivery window, and
  // no terminal may authorize a second error. Playwright delivers renderer
  // page errors and request terminals independently, so either can arrive first.
  // Duplicate, late, concurrent, or stale evidence keeps the strict ledger red.
  const candidates = problems.pageErrorEvidence.flatMap((pageError) => {
    const terminalIndex = correlatedWebKitReauthenticationTerminalIndex(
      pageError,
      problems.acceptedRequestTerminals,
    );
    return terminalIndex === null ? [] : [{ terminalIndex, message: pageError.message }];
  });
  const terminalIndexes = candidates.map(({ terminalIndex }) => terminalIndex);
  if (
    candidates.length !== problems.pageErrorEvidence.length ||
    new Set(terminalIndexes).size !== terminalIndexes.length
  ) {
    return [];
  }
  for (const terminalIndex of [...terminalIndexes].sort((left, right) => right - left)) {
    problems.acceptedRequestTerminals.splice(terminalIndex, 1);
  }
  return candidates.map(({ message }) => message);
}

function logoutAllActorFenceResponseProblem(
  response: BrowserProblems["actorFenceResponses"][number],
  input: {
    acceptedAt: number;
    actorEpoch: string;
    settledAt: number;
    workspaceId: string;
  },
): string | null {
  const expectedWorkspacePrefix = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}`;
  const isSessionList =
    response.pathname === `${expectedWorkspacePrefix}/sessions` && response.search === "";
  const isBoundedLiveStream =
    response.pathname === `${expectedWorkspacePrefix}/live-events/stream` &&
    exactBoundedWorkspaceLiveStreamSearch(response.search);
  const exactShape =
    response.actorEpoch === input.actorEpoch &&
    response.dispatchPhase === "logout-all-response-loss-replay" &&
    response.responsePhase === "logout-all-response-loss-replay" &&
    response.method === "GET" &&
    (isSessionList || isBoundedLiveStream) &&
    response.status === 401;
  const exactTiming =
    Number.isFinite(response.startedAt) &&
    Number.isFinite(response.endedAt) &&
    response.startedAt <= input.settledAt &&
    response.endedAt >= input.acceptedAt &&
    response.endedAt <= input.settledAt;
  return exactShape && exactTiming
    ? null
    : `unexpected logout-all actor fence: ${JSON.stringify({ input, response })}`;
}

function exactBoundedWorkspaceLiveStreamSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  const exactSingleton = (name: string, value: string): boolean => {
    const values = params.getAll(name);
    return values.length === 1 && values[0] === value;
  };
  const exactCursor = (name: string): boolean => {
    const values = params.getAll(name);
    if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(values[0] ?? "")) return false;
    const value = Number(values[0]);
    return Number.isSafeInteger(value) && value >= 0;
  };
  return (
    [...params.keys()].length === 3 &&
    exactSingleton("transport", "http1-bounded") &&
    exactCursor("controlAfter") &&
    exactCursor("interactionAfter")
  );
}

async function expectAndConsumeLogoutAllActorFenceResponses(
  page: Page,
  problems: BrowserProblems,
  input: {
    acceptedAt: number;
    actorEpoch: string;
    settledAt: number;
    workspaceId: string;
  },
): Promise<void> {
  // A sibling tab can dispatch its current session-list read or one bounded
  // event poll immediately before the accepted logout rotates the shared
  // HttpOnly authority. The API must fence that exact old-actor request with
  // 401; a browser may deliver the response instead of a cancellation. Keep
  // the optional race strict by actor, phase, path, transport, method, status,
  // and acceptance window, and leave every other 401 in the final ledger.
  await page.waitForTimeout(1_000);
  const validationInput = { ...input, settledAt: performance.now() };
  expect(problems.actorFenceResponses.length).toBeLessThanOrEqual(2);
  expect(new Set(problems.actorFenceResponses.map(({ pathname }) => pathname)).size).toBe(
    problems.actorFenceResponses.length,
  );
  for (const response of problems.actorFenceResponses) {
    expect(logoutAllActorFenceResponseProblem(response, validationInput)).toBeNull();
  }
  const exactConsoleErrors = problems.actorFenceResponses.map(
    ({ pathname }) =>
      `[logout-all-response-loss-replay] Failed to load resource: the server responded with a status of 401 (Unauthorized) @ ${pathname}`,
  );
  await expectAndConsumeConsoleErrors(page, problems, exactConsoleErrors, []);
  problems.actorFenceResponses.splice(0);
}

async function expectAndConsumeActorTransitionResponse(
  page: Page,
  problems: BrowserProblems,
  input: {
    acceptedAt: number;
    actorEpoch: string;
    method: string;
    pathname: string;
    phase: string;
    status: number;
    statusLabel: string;
    allowedConsoleErrors?: readonly string[];
    workspaceId?: string;
    timing?: { kind: "direct-race-fence"; settledAt: number };
  },
): Promise<void> {
  // Requests may already be in flight when authority accepts the actor
  // mutation. Consume only exact old-epoch fail-closed responses from the
  // prior workspace, with monotonic acceptance evidence; a new-workspace,
  // wrong-epoch, late, or third response stays red.
  await page.waitForTimeout(1_000);
  for (const response of problems.actorTransitionResponses) {
    const { request, ...responseEvidence } = response;
    expect(responseEvidence).toEqual(
      expect.objectContaining({
        actorEpoch: input.actorEpoch,
        method: input.method,
        responsePhase: input.phase,
        status: input.status,
      }),
    );
    const dispatchPhaseValid = actorTransitionResponseDispatchPhaseMatches({
      dispatchPhase: response.dispatchPhase,
      expectedPhase: input.phase,
      permitsDirectRacePredecessors: input.timing !== undefined,
      responsePhase: response.responsePhase,
    });
    if (!dispatchPhaseValid) {
      throw new Error(
        `actor transition response did not originate in its exact transition window: ${JSON.stringify({ input, response: responseEvidence })}`,
      );
    }
    const pathnameValid =
      response.pathname === input.pathname ||
      (input.timing?.kind === "direct-race-fence" &&
        input.workspaceId !== undefined &&
        response.pathname.startsWith(`/v1/workspaces/${encodeURIComponent(input.workspaceId)}/`));
    if (!pathnameValid) {
      throw new Error(
        `actor transition response did not target its exact old workspace: ${JSON.stringify({ input, response: responseEvidence })}`,
      );
    }
    const responseSpansAcceptance =
      response.startedAt <= input.acceptedAt && response.endedAt >= input.acceptedAt;
    const responseIsBoundedAfterDirectAcceptance =
      input.timing !== undefined &&
      response.startedAt >= input.acceptedAt &&
      response.endedAt >= response.startedAt &&
      response.endedAt <= input.timing.settledAt;
    const timingValid = input.timing
      ? responseSpansAcceptance || responseIsBoundedAfterDirectAcceptance
      : responseSpansAcceptance;
    if (!timingValid) {
      throw new Error(
        `actor transition response did not satisfy its exact timing fence: ${JSON.stringify({ acceptances: actorMutationAcceptances.slice(-12), input, response: responseEvidence })}`,
      );
    }
    const pending = problems.pendingFiniteReads.get(request);
    if (pending) {
      problems.retiredFiniteReads.push(
        `${pending.description} [retired=validated-actor-transition-response]`,
      );
      problems.pendingFiniteReads.delete(request);
    }
  }
  expect(problems.actorTransitionResponses.length).toBeLessThanOrEqual(2);
  const exactConsoleErrors = problems.actorTransitionResponses.map(
    (response) =>
      `[${input.phase}] Failed to load resource: the server responded with a status of ${input.status} (${input.statusLabel}) @ ${response.pathname}`,
  );
  await expectAndConsumeConsoleErrors(
    page,
    problems,
    [...exactConsoleErrors, ...(input.allowedConsoleErrors ?? [])],
    requestedEngine === "firefox" ? [] : exactConsoleErrors,
  );
  problems.actorTransitionResponses.splice(0);
}

async function expectNoAxeViolations(page: Page, include?: string): Promise<void> {
  const analyzer = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
  ]);
  if (include) analyzer.include(include);
  const report = await analyzer.analyze();
  expect(
    report.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
        checks: node.any.map(({ data, message }) => ({ data, message })),
      })),
    })),
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const evidence = await page.evaluate(() => {
    const elements = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll<HTMLElement>("body *"),
    ];
    const metrics = elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        className: element.className.toString().slice(0, 160),
        left: Math.round(bounds.left),
        outerHtml: element.outerHTML.replace(/\s+/gu, " ").slice(0, 240),
        overflowX: style.overflowX,
        position: style.position,
        right: Math.round(bounds.right),
        role: element.getAttribute("role"),
        tag: element.tagName.toLowerCase(),
        visuallyHidden: style.clip !== "auto" || style.clipPath !== "none",
        width: Math.round(bounds.width),
      };
    });
    return {
      body: {
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      viewportWidth: innerWidth,
      offenders: metrics
        .filter(
          ({ left, right, visuallyHidden, width }) =>
            !visuallyHidden && width > 0 && (left < -1 || right > innerWidth + 1),
        )
        .map(({ visuallyHidden: _visuallyHidden, ...metric }) => metric)
        .slice(0, 20),
    };
  });
  if (
    evidence.viewportWidth !== page.viewportSize()?.width ||
    evidence.document.scrollWidth > evidence.document.clientWidth ||
    evidence.body.scrollWidth > evidence.body.clientWidth
  ) {
    throw new Error(`horizontal document overflow: ${JSON.stringify(evidence, null, 2)}`);
  }
  expect({
    offenders: evidence.offenders,
  }).toEqual({
    offenders: [],
  });
}

async function signIn(page: Page, account: AccountFixture): Promise<void> {
  await page.goto(publicOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Sign in to OpenGeni" }).waitFor();
  await page.evaluate(() => {
    const debugWindow = window as Window & {
      __accountAcceptanceMessages?: Array<{
        keys: string[];
        origin: string;
        type: string;
      }>;
    };
    debugWindow.__accountAcceptanceMessages = [];
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data;
      debugWindow.__accountAcceptanceMessages?.push({
        keys:
          data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).sort() : [],
        origin: event.origin,
        type:
          data && typeof data === "object" && !Array.isArray(data) && "type" in data
            ? String(data.type)
            : typeof data,
      });
    });
  });
  await sessionSet(page);
  const authorityCookie = (await page.context().cookies(publicOrigin)).find(
    ({ name }) => name === "opengeni.session_set",
  );
  expect(authorityCookie?.value).toHaveLength(43);
  let beginCookieSummary = "not-observed";
  await page.route("**/v1/auth/session-set/transactions", async (route) => {
    const headers = await route.request().allHeaders();
    beginCookieSummary = (headers.cookie ?? "")
      .split(";")
      .map((cookie) => {
        const [name, value = ""] = cookie.trim().split("=", 2);
        return `${name}:${value.length}`;
      })
      .join(",");
    await route.continue();
  });
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Continue with email" }).click(),
  ]);
  try {
    await completePopup(popup, account);
  } catch (error) {
    await page.waitForTimeout(300);
    throw new Error(
      `initial account popup closed before authentication: requestCookies=${beginCookieSummary} edgeCookies=${edgeCookieSummary} main=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
      { cause: error },
    );
  }
  if (!account.workspaceId) {
    try {
      const continueAsAccount = page.getByRole("button", {
        name: new RegExp(`^Continue as ${escapeRegExp(account.displayName)}$`),
      });
      await continueAsAccount.waitFor({ timeout: 30_000 });
      const unselected = await sessionSet(page);
      expect(unselected.selectedSlotId).toBeNull();
      expect(unselected.slots).toEqual([
        expect.objectContaining({
          displayName: account.displayName,
          state: "active",
        }),
      ]);
      await continueAsAccount.click();
      await page.getByRole("heading", { name: "Create your organization" }).waitFor({
        timeout: 30_000,
      });
    } catch (error) {
      const projection = await sessionSet(page);
      const messages = await page.evaluate(() => {
        const debugWindow = window as Window & {
          __accountAcceptanceMessages?: Array<{
            keys: string[];
            origin: string;
            type: string;
          }>;
        };
        return debugWindow.__accountAcceptanceMessages ?? [];
      });
      throw new Error(
        `account settled without reaching organization onboarding: url=${page.url()} projection=${JSON.stringify({ actorEpoch: projection.actorEpoch, generation: projection.generation, selected: projection.selectedSlotId !== null, slots: projection.slots.map(({ displayName, state }) => ({ displayName, state })) })} messages=${JSON.stringify(messages)} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
        { cause: error },
      );
    }
    await page.getByLabel("Organization name").fill(account.organizationName);
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.waitForURL(
      /\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/|$)/iu,
      { timeout: 30_000 },
    );
    const selected = await sessionSet(page);
    expect(selected.selectedSlotId).not.toBeNull();
    const accountClient = sdk(await browserCookieHeader(page.context()), selected.actorEpoch);
    const memberships = await accountClient.listOrganizationMemberships();
    expect(memberships.memberships).toHaveLength(1);
    const membership = memberships.memberships[0]!;
    account.organizationId = membership.organizationId;
    account.workspaceId = membership.personalWorkspaceId;
    const session = await accountClient.createSession(account.workspaceId, {
      initialMessage: `${account.displayName} account acceptance`,
      idempotencyKey: crypto.randomUUID(),
      sandboxBackend: "none",
    });
    account.sessionId = session.id;
    await owned.admin`
      insert into session_goals (account_id, workspace_id, session_id, text)
      select account_id, workspace_id, id, ${`${account.displayName} account acceptance`}
      from sessions
      where id = ${session.id}`;
  }
  try {
    await page.waitForURL(new RegExp(`/workspaces/${account.workspaceId}(?:/|$)`), {
      timeout: 30_000,
    });
  } catch (error) {
    const cookies = await page.context().cookies(publicOrigin);
    throw new Error(
      `sign in did not reach the account workspace: url=${page.url()} cookies=${JSON.stringify(cookies.map(({ name, path, secure }) => ({ name, path, secure })))} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
      { cause: error },
    );
  }
  await accountMenuTrigger(page, account.displayName).waitFor();
}

function accountMenuTrigger(page: Page, displayName: string) {
  return page.getByRole("button", {
    name: new RegExp(`^Account menu\\. ${escapeRegExp(displayName)} is active\\.$`),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function accountMenuSurface(page: Page): Locator {
  return page
    .locator('[data-slot="dropdown-menu-content"][data-state="open"]')
    .filter({ hasText: "Browser accounts" })
    .last();
}

async function openAccountMenu(
  page: Page,
  displayName: string,
  prepareTrigger?: () => Promise<void>,
): Promise<Locator> {
  const trigger = accountMenuTrigger(page, displayName);
  const menu = accountMenuSurface(page);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await menu.isVisible()) {
      try {
        await waitForStableAccountMenu(page, menu);
        return menu;
      } catch (error) {
        lastError = error;
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(100);
      }
    }
    try {
      await prepareTrigger?.();
      await trigger.waitFor({ state: "visible", timeout: 3_000 });
      if ((await trigger.getAttribute("aria-expanded", { timeout: 1_000 })) === "true") {
        await page.keyboard.press("Escape");
      }
      await trigger.click({ timeout: 3_000 });
    } catch (error) {
      // Responsive navigation can finish a route transition after its account
      // trigger first becomes visible, remounting or closing the drawer between
      // two locator operations. Retry that bounded UI transition instead of
      // spending Playwright's full default timeout on the vanished element.
      lastError = error;
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(100);
      continue;
    }
    try {
      await menu.waitFor({ timeout: 3_000 });
      await waitForStableAccountMenu(page, menu);
      return menu;
    } catch (error) {
      lastError = error;
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(100);
    }
  }
  const projection = await sessionSet(page);
  const expanded = await trigger
    .getAttribute("aria-expanded", { timeout: 1_000 })
    .catch(() => null);
  throw new Error(
    `account menu did not open after three pointer gestures: url=${page.url()} expanded=${expanded} projection=${JSON.stringify({ actorEpoch: projection.actorEpoch, generation: projection.generation, selected: projection.selectedSlotId !== null, slots: projection.slots.map(({ displayName: slotDisplayName, state }) => ({ displayName: slotDisplayName, state })) })} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
    { cause: lastError },
  );
}

async function waitForStableAccountMenu(page: Page, menu: Locator): Promise<void> {
  const firstItem = menu.getByRole("menuitem").first();
  for (let sample = 0; sample < 3; sample += 1) {
    await firstItem.waitFor({ timeout: 1_000 });
    await page.waitForTimeout(100);
  }
  if (!(await menu.isVisible()) || !(await firstItem.isVisible())) {
    throw new Error("account menu did not remain ready for evidence");
  }
}

async function openResponsiveAccountMenu(
  page: Page,
  displayName: string,
  width: number,
): Promise<Locator> {
  const prepareTrigger =
    width < 1_024
      ? async () => {
          const trigger = accountMenuTrigger(page, displayName);
          if (await trigger.isVisible()) return;
          const workspaceTab = page.getByRole("tab", { name: "Workspace" });
          if (!(await workspaceTab.isVisible())) {
            await page.getByRole("button", { name: "Open navigation" }).click({ timeout: 3_000 });
          }
          await workspaceTab.click({ timeout: 3_000 });
          await trigger.waitFor({ state: "visible", timeout: 3_000 });
        }
      : undefined;
  const opened = await openAccountMenu(page, displayName, prepareTrigger);
  return opened;
}

async function closeResponsiveAccountMenu(page: Page, width: number): Promise<void> {
  await page.keyboard.press("Escape");
  if (width < 1_024) {
    await page.getByRole("button", { name: "Close navigation" }).click();
  }
}

async function expectActiveAccountAnnouncement(page: Page, account: AccountFixture): Promise<void> {
  await page
    .locator('span[aria-live="polite"][aria-atomic="true"]')
    .filter({
      hasText: `Active account: ${account.displayName}, ${account.email}`,
    })
    .waitFor();
}

async function expectAccountMenuEvidenceVisible(page: Page, displayName: string): Promise<void> {
  const menu = accountMenuSurface(page);
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  const expanded = await accountMenuTrigger(page, displayName).getAttribute("aria-expanded");
  const evidence = {
    bounds,
    boundsInsideViewport:
      bounds !== null &&
      viewport !== null &&
      bounds.x >= -1 &&
      bounds.y >= -1 &&
      bounds.x + bounds.width <= viewport.width + 1 &&
      bounds.y + bounds.height <= viewport.height + 1,
    expanded,
    visible: await menu.isVisible(),
    viewport,
  };
  expect(evidence).toEqual({
    bounds: evidence.bounds,
    boundsInsideViewport: true,
    expanded: "true",
    visible: true,
    viewport: evidence.viewport,
  });
}

async function addOrReauth(
  page: Page,
  selected: AccountFixture,
  target: AccountFixture,
  kind: "add" | "reauth",
): Promise<void> {
  const menu = await openAccountMenu(page, selected.displayName);
  if (kind === "add") {
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      menu.getByRole("menuitem", { name: "Add another account" }).click(),
    ]);
    await completePopup(popup, target, { replayLostResponse: true });
  } else {
    const slot = menu.getByRole("menuitem", {
      name: new RegExp(target.displayName),
    });
    await slot.hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("menuitem", { name: "Re-authenticate" }).click(),
    ]);
    await completePopup(popup, target);
  }
  await accountMenuTrigger(page, selected.displayName).waitFor();
}

async function completePopup(
  popup: Page,
  account: AccountFixture,
  options: { replayLostResponse?: boolean } = {},
): Promise<void> {
  await popup.getByRole("heading", { name: "Authenticate this account" }).waitFor();
  await popup.getByLabel("Email").fill(account.email);
  await popup.getByLabel("Password").fill(PASSWORD);
  if (options.replayLostResponse) {
    completionResponseLoss = {
      acceptedAt: null,
      attempts: 0,
      dropped: false,
      exactBodies: [],
      firstBody: null,
      path: "/v1/auth/session-set/transactions/email-password",
      statuses: [],
    };
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("alert").waitFor();
    expect(completionResponseLoss.dropped).toBe(true);
    await popup.getByLabel("Password").fill(PASSWORD);
  }
  try {
    await Promise.all([
      popup.waitForEvent("close"),
      popup.getByRole("button", { name: "Continue" }).click(),
    ]);
    if (options.replayLostResponse) {
      const responseLossEvidence = completionResponseLoss
        ? {
            attempts: completionResponseLoss.attempts,
            bodyCaptured: completionResponseLoss.firstBody !== null,
            dropped: completionResponseLoss.dropped,
            exactBodies: completionResponseLoss.exactBodies,
            statuses: completionResponseLoss.statuses,
          }
        : null;
      expect(responseLossEvidence).toEqual({
        attempts: 2,
        bodyCaptured: true,
        dropped: true,
        exactBodies: [true, true],
        statuses: [200, 200],
      });
    }
  } catch (error) {
    const opener = await popup.opener();
    const projection = opener && !opener.isClosed() ? await sessionSet(opener) : null;
    throw new Error(
      `account popup did not complete: url=${popup.url()} responseLoss=${JSON.stringify(completionResponseLoss ? { attempts: completionResponseLoss.attempts, dropped: completionResponseLoss.dropped, exactBodies: completionResponseLoss.exactBodies, statuses: completionResponseLoss.statuses } : null)} projection=${JSON.stringify(projection ? { actorEpoch: projection.actorEpoch, generation: projection.generation, selected: projection.selectedSlotId !== null, slots: projection.slots.map(({ displayName, state }) => ({ displayName, state })) } : null)} body=${JSON.stringify((await popup.locator("body").innerText()).slice(0, 2_000))}`,
      { cause: error },
    );
  } finally {
    completionResponseLoss = null;
  }
}

async function selectAccount(
  page: Page,
  current: AccountFixture,
  target: AccountFixture,
): Promise<void> {
  let lastGestureError: unknown;
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
    try {
      const menu = await openAccountMenu(page, current.displayName);
      const slot = menu.getByRole("menuitem", {
        name: new RegExp(target.displayName),
      });
      await slot.hover({ timeout: 5_000 });
      await page
        .getByRole("menuitem", { name: "Use this account" })
        .last()
        .click({ timeout: 5_000 });
      clicked = true;
    } catch (error) {
      lastGestureError = error;
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(100);
    }
  }
  if (!clicked) {
    throw new Error(`account selection gesture did not settle for ${target.displayName}`, {
      cause: lastGestureError,
    });
  }
  try {
    await Promise.all([
      accountMenuTrigger(page, target.displayName).waitFor({ timeout: 30_000 }),
      page.waitForURL(new RegExp(`/workspaces/${target.workspaceId}(?:/|$)`), {
        timeout: 30_000,
      }),
    ]);
  } catch (error) {
    const projection = await sessionSet(page);
    throw new Error(
      `account selection did not reach ${target.displayName}: url=${page.url()} projection=${JSON.stringify({ actorEpoch: projection.actorEpoch, generation: projection.generation, selected: projection.slots.find((slot) => slot.id === projection.selectedSlotId)?.displayName ?? null, slots: projection.slots.map(({ displayName, state }) => ({ displayName, state })) })} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
      { cause: error },
    );
  }
}

async function sessionSet(page: Page): Promise<ManagedAuthSessionSetProjection> {
  const acceptanceProbeId = crypto.randomUUID();
  const startedAt = performance.now();
  const projection = await page.evaluate(
    async ({ acceptanceProbeId: probeId, contractHeader, contractRevision }) => {
      const response = await fetch(
        `/v1/auth/session-set?acceptance_probe=${encodeURIComponent(probeId)}`,
        {
          credentials: "include",
          headers: { [contractHeader]: contractRevision },
        },
      );
      if (!response.ok) throw new Error(`session set read failed: ${response.status}`);
      return (await response.json()) as ManagedAuthSessionSetProjection;
    },
    {
      acceptanceProbeId,
      contractHeader: MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
      contractRevision: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    },
  );
  const completedAt = performance.now();
  const problems = observedBrowserProblems.get(page);
  if (problems) {
    const completedDirectProbes = [...problems.pendingFiniteReads.entries()].filter(
      ([, pending]) =>
        pending.actorEpoch === null &&
        pending.method === "GET" &&
        pending.pathname === "/v1/auth/session-set" &&
        new URL(pending.url).searchParams.get("acceptance_probe") === acceptanceProbeId &&
        pending.startedAt >= startedAt &&
        pending.startedAt <= completedAt,
    );
    if (completedDirectProbes.length > 1) {
      throw new Error("session-set acceptance probe overlapped another unowned session-set read");
    }
    for (const [request, pending] of completedDirectProbes) {
      problems.retiredFiniteReads.push(`${pending.description} [retired=awaited-json-probe]`);
      problems.pendingFiniteReads.delete(request);
    }
  }
  return projection;
}

async function raceSelect(page: Page, projection: ManagedAuthSessionSetProjection, slotId: string) {
  return await page.evaluate(
    async ({
      projection: acceptedProjection,
      slotId: selectedSlotId,
      operationId,
      contractHeader,
      contractRevision,
    }) => {
      const response = await fetch("/v1/auth/session-set/select", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          [contractHeader]: contractRevision,
          "x-opengeni-session-csrf": acceptedProjection.csrfToken,
          "x-opengeni-actor-epoch": acceptedProjection.actorEpoch,
        },
        body: JSON.stringify({
          operationId,
          expectedGeneration: acceptedProjection.generation,
          slotId: selectedSlotId,
        }),
      });
      return response.status;
    },
    {
      projection,
      slotId,
      operationId: crypto.randomUUID(),
      contractHeader: MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
      contractRevision: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    },
  );
}

async function launchAccountBrowser(engine: EngineName): Promise<Browser> {
  return await ENGINES[engine].launch(
    engine === "chromium" && process.env.OPENGENI_BROWSER_BIN
      ? { executablePath: process.env.OPENGENI_BROWSER_BIN }
      : undefined,
  );
}

async function captureResponsiveEvidence(
  context: BrowserContext,
  engine: EngineName,
): Promise<void> {
  const storageState = await context.storageState();
  // Keep responsive evidence out of the multi-tab journey's native connection
  // pool. The journey deliberately retains live transports in two pages while
  // these short-lived contexts exercise seven viewport/mode combinations; a
  // shared Chromium process can otherwise queue a bootstrap read behind those
  // unrelated transports and turn visual capture into a transport-liveness
  // test. The journey itself continues to prove the shared-tab behavior.
  const evidenceBrowser = await launchAccountBrowser(engine);
  try {
    await captureResponsiveEvidenceInBrowser(evidenceBrowser, storageState, engine);
  } finally {
    await evidenceBrowser.close();
  }
}

async function captureResponsiveEvidenceInBrowser(
  browser: Browser,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
  engine: EngineName,
): Promise<void> {
  const captures = [
    { width: 320, height: 780, scheme: "light" as const },
    { width: 768, height: 900, scheme: "dark" as const },
    { width: 1024, height: 820, scheme: "light" as const },
    { width: 1440, height: 960, scheme: "dark" as const },
  ];
  for (const capture of captures) {
    // Each artifact starts in its target viewport. Chromium can retain the old
    // root scrollable-overflow width when a fixed overlay survives a live
    // desktop-to-mobile resize, which made a nominal 320px full-page capture
    // 718px wide even though every visible element fit the viewport.
    const evidenceContext = await browser.newContext({
      colorScheme: capture.scheme,
      storageState,
      reducedMotion: "reduce",
      viewport: { width: capture.width, height: capture.height },
    });
    const evidencePage = await evidenceContext.newPage();
    const evidenceProblems = observeBrowser(evidencePage);
    setBrowserPhase(evidenceProblems, "responsive-evidence-bootstrap");
    try {
      await evidencePage.goto(`${publicOrigin}/workspaces/${alpha.workspaceId}`, {
        waitUntil: "domcontentloaded",
      });
      await evidencePage.evaluate((theme) => {
        document.documentElement.setAttribute("data-og-theme", theme);
      }, capture.scheme);
      expect(
        await evidencePage.evaluate(() => ({
          attribute: document.documentElement.getAttribute("data-og-theme"),
          computed: getComputedStyle(document.documentElement).colorScheme,
        })),
      ).toEqual({ attribute: capture.scheme, computed: capture.scheme });
      await waitForFiniteReadQuiescence(evidenceProblems);
      await openResponsiveAccountMenu(evidencePage, alpha.displayName, capture.width);
      await expectNoHorizontalOverflow(evidencePage);
      await openResponsiveAccountMenu(evidencePage, alpha.displayName, capture.width);
      await expectNoAxeViolations(evidencePage, '[data-slot="dropdown-menu-content"]');
      await openResponsiveAccountMenu(evidencePage, alpha.displayName, capture.width);
      await expectAccountMenuEvidenceVisible(evidencePage, alpha.displayName);
      const screenshot = await evidencePage.screenshot({
        path: `${EVIDENCE_DIR}/${engine}-accounts-${capture.width}-${capture.scheme}.png`,
        fullPage: true,
      });
      expect(screenshot.readUInt32BE(16)).toBe(capture.width);
      await closeResponsiveAccountMenu(evidencePage, capture.width);
      // Menu open/close and accessibility inspection can trigger ordinary
      // routed refreshes after the initial bootstrap has already settled.
      // Close that second finite-read window before applying the strict final
      // ledger; an in-flight successful read is neither a browser fault nor
      // evidence that can be discarded by closing this short-lived context.
      await waitForFiniteReadQuiescence(evidenceProblems);
      await expectNoBrowserProblems(evidenceProblems);
    } finally {
      await evidenceContext.close();
    }
  }

  const forcedColors = await browser.newContext({
    colorScheme: "light",
    forcedColors: "active",
    reducedMotion: "reduce",
    storageState,
    viewport: { width: 768, height: 900 },
  });
  const forcedColorsPage = await forcedColors.newPage();
  const forcedColorsProblems = observeBrowser(forcedColorsPage);
  setBrowserPhase(forcedColorsProblems, "responsive-evidence-bootstrap");
  try {
    await forcedColorsPage.goto(`${publicOrigin}/workspaces/${alpha.workspaceId}`, {
      waitUntil: "domcontentloaded",
    });
    await forcedColorsPage.evaluate(() => {
      document.documentElement.setAttribute("data-og-theme", "light");
    });
    const forcedColorsTheme = await forcedColorsPage.evaluate(() => ({
      attribute: document.documentElement.getAttribute("data-og-theme"),
      computed: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(forcedColorsTheme.attribute).toBe("light");
    expect(forcedColorsTheme.computed.split(/\s+/u)).toContain("light");
    await waitForFiniteReadQuiescence(forcedColorsProblems);
    await openResponsiveAccountMenu(forcedColorsPage, alpha.displayName, 768);
    await expectNoHorizontalOverflow(forcedColorsPage);
    await openResponsiveAccountMenu(forcedColorsPage, alpha.displayName, 768);
    await expectNoAxeViolations(forcedColorsPage, '[data-slot="dropdown-menu-content"]');
    await openResponsiveAccountMenu(forcedColorsPage, alpha.displayName, 768);
    await expectAccountMenuEvidenceVisible(forcedColorsPage, alpha.displayName);
    const forcedColorsScreenshot = await forcedColorsPage.screenshot({
      path: `${EVIDENCE_DIR}/${engine}-accounts-forced-colors.png`,
      fullPage: true,
    });
    expect(forcedColorsScreenshot.readUInt32BE(16)).toBe(768);
    await closeResponsiveAccountMenu(forcedColorsPage, 768);
    await waitForFiniteReadQuiescence(forcedColorsProblems);
    await expectNoBrowserProblems(forcedColorsProblems);
  } finally {
    await forcedColors.close();
  }

  const zoom = await browser.newContext({
    storageState,
    viewport: { width: 384, height: 450 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const zoomPage = await zoom.newPage();
  const zoomProblems = observeBrowser(zoomPage);
  setBrowserPhase(zoomProblems, "responsive-evidence-bootstrap");
  await zoomPage.goto(`${publicOrigin}/workspaces/${alpha.workspaceId}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForFiniteReadQuiescence(zoomProblems);
  await openResponsiveAccountMenu(zoomPage, alpha.displayName, 384);
  await expectNoHorizontalOverflow(zoomPage);
  await openResponsiveAccountMenu(zoomPage, alpha.displayName, 384);
  await expectNoAxeViolations(zoomPage, '[data-slot="dropdown-menu-content"]');
  await openResponsiveAccountMenu(zoomPage, alpha.displayName, 384);
  await expectAccountMenuEvidenceVisible(zoomPage, alpha.displayName);
  const zoomScreenshot = await zoomPage.screenshot({
    path: `${EVIDENCE_DIR}/${engine}-accounts-200-percent-zoom.png`,
    fullPage: true,
  });
  expect(zoomScreenshot.readUInt32BE(16)).toBe(768);
  await waitForFiniteReadQuiescence(zoomProblems);
  await expectNoBrowserProblems(zoomProblems);
  await zoom.close();

  const touch = await browser.newContext({
    storageState,
    viewport: { width: 320, height: 780 },
    hasTouch: true,
    isMobile: true,
  });
  const touchPage = await touch.newPage();
  const touchProblems = observeBrowser(touchPage);
  setBrowserPhase(touchProblems, "responsive-evidence-bootstrap");
  await touchPage.goto(`${publicOrigin}/workspaces/${alpha.workspaceId}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForFiniteReadQuiescence(touchProblems);
  const touchTrigger = accountMenuTrigger(touchPage, alpha.displayName);
  await touchPage.getByRole("button", { name: "Open navigation" }).tap();
  await touchPage.getByRole("tab", { name: "Workspace" }).tap();
  await touchTrigger.waitFor();
  const touchTarget = await touchTrigger.boundingBox();
  expect(touchTarget?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(touchTarget?.width ?? 0).toBeGreaterThanOrEqual(44);
  await touchTrigger.tap();
  await touchPage.getByRole("menu").waitFor();
  await expectNoHorizontalOverflow(touchPage);
  const menuTargetSizes = await touchPage.getByRole("menuitem").evaluateAll((items) =>
    items.map((item) => {
      const bounds = item.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    }),
  );
  expect(menuTargetSizes.length).toBeGreaterThan(0);
  expect(menuTargetSizes.every(({ height, width }) => height >= 44 && width >= 44)).toBe(true);
  await openResponsiveAccountMenu(touchPage, alpha.displayName, 320);
  await expectNoAxeViolations(touchPage, '[data-slot="dropdown-menu-content"]');
  await openResponsiveAccountMenu(touchPage, alpha.displayName, 320);
  await expectAccountMenuEvidenceVisible(touchPage, alpha.displayName);
  const touchScreenshot = await touchPage.screenshot({
    path: `${EVIDENCE_DIR}/${engine}-accounts-touch-320.png`,
    fullPage: true,
  });
  expect(touchScreenshot.readUInt32BE(16)).toBe(320);
  await waitForFiniteReadQuiescence(touchProblems);
  await expectNoBrowserProblems(touchProblems);
  await touch.close();
}

async function delayedWorkspaceResponse(page: Page, oldActorEpoch: string) {
  let release!: () => void;
  let observed!: (request: object) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<object>((resolve) => {
    observed = resolve;
  });
  let delayed = false;
  const handler = async (route: Route) => {
    if (
      !delayed &&
      route.request().method() === "GET" &&
      route.request().headers()["x-opengeni-actor-epoch"] === oldActorEpoch
    ) {
      delayed = true;
      const response = await route.fetch();
      observed(route.request());
      await released;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  };
  await page.route("**/v1/workspaces", handler);
  return {
    intercepted,
    release,
    dispose: () => page.unroute("**/v1/workspaces", handler),
  };
}

beforeAll(async () => {
  if (!(requestedEngine in ENGINES)) {
    throw new Error(`unsupported OPENGENI_ACCOUNT_BROWSER_ENGINE: ${requestedEngine}`);
  }
  owned = await acquireOwnerMigratedTestDatabase("browser-accounts-acceptance");
  if (!owned) {
    throw new Error(
      requireRealDatabase
        ? "Browser account acceptance requires PostgreSQL"
        : "Browser account acceptance is opt-in and never skips a missing PostgreSQL fixture",
    );
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const databaseUrl = appDatabaseUrl(owned);
  client = createDb(databaseUrl, { max: 16, rlsStrategy: "force" });

  const witnessAccountId = crypto.randomUUID();
  await owned.admin`
    insert into managed_accounts (id, name)
    values (${witnessAccountId}, 'Browser account committed activation witness')`;
  await owned.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) values (
      ${witnessAccountId}, 1, ${"2".repeat(64)}, ${"3".repeat(64)},
      'test:browser-account-committed-product-witness', array[]::uuid[]
    )`;

  publicOrigin = `http://127.0.0.1:${await freePort()}`;
  const settings = testSettings({
    environment: "test",
    productAccessMode: "managed",
    managedAuthSessionSetMode: "broker",
    databaseUrl,
    rlsStrategy: "force",
    runtimeDatabaseRole: "opengeni_app",
    publicBaseUrl: publicOrigin,
    betterAuthSecret: "browser-account-acceptance-secret-at-least-32-bytes",
    sandboxBackend: "none",
  });
  const api = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: workflowStub(),
  });

  const extensionBuild = Bun.spawn(["bun", "run", "build"], {
    cwd: `${repoRoot}/apps/browser-extension`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await extensionBuild.exited) !== 0) {
    throw new Error(
      `Browser extension build failed: ${await new Response(extensionBuild.stderr).text()}`,
    );
  }
  const build = Bun.spawn(["bun", "run", "vite", "build"], {
    cwd: `${repoRoot}/apps/web`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      VITE_API_BASE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`Browser account web build failed: ${await new Response(build.stderr).text()}`);
  }
  const webDist = `${repoRoot}/apps/web/dist`;
  edge = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(publicOrigin).port),
    idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
        if (completionResponseLoss?.path === url.pathname) {
          const requestBody = await request.clone().text();
          const firstBody = completionResponseLoss.firstBody;
          completionResponseLoss.firstBody ??= requestBody;
          completionResponseLoss.attempts += 1;
          completionResponseLoss.exactBodies.push(firstBody === null || firstBody === requestBody);
          const response = await api.fetch(request);
          completionResponseLoss.statuses.push(response.status);
          if (completionResponseLoss.acceptedAt === null && response.ok) {
            completionResponseLoss.acceptedAt = performance.now();
            actorMutationAcceptances.push({
              acceptedAt: completionResponseLoss.acceptedAt,
              actorEpoch: response.headers.get(MANAGED_AUTH_ACTOR_EPOCH_HEADER),
              path: url.pathname,
              sessionSetAuthorityHash: sessionSetAuthorityHash(request.headers.get("cookie")),
            });
          }
          if (!completionResponseLoss.dropped && response.ok) {
            completionResponseLoss.dropped = true;
            await response.body?.cancel();
            const headers = new Headers(response.headers);
            headers.delete("content-encoding");
            headers.delete("content-length");
            // Preserve an accepted response with an unreadable completion payload without
            // throwing from Bun's server-side stream controller after the test has settled.
            return new Response('{"projection":', {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
          return response;
        }
        if (url.pathname === "/v1/auth/session-set/transactions") {
          const lowerCookieHeader = request.headers.get("cookie") ?? "";
          const upperCookieHeader = request.headers.get("Cookie") ?? "";
          const cookieHeader = upperCookieHeader;
          edgeCookieSummary = cookieHeader
            .split(";")
            .map((cookie) => {
              const [name, value = ""] = cookie.trim().split("=", 2);
              return `${name}:${value.length}:${/^[A-Za-z0-9_-]{43}$/u.test(value)}`;
            })
            .join(",");
          edgeCookieSummary += `;caseEqual:${lowerCookieHeader === upperCookieHeader}`;
        }
        const response = await api.fetch(request);
        if (
          response.ok &&
          (new Set([
            "/v1/auth/session-set/logout-one",
            "/v1/auth/session-set/select",
            "/v1/auth/session-set/transactions/email-password",
          ]).has(url.pathname) ||
            (request.method === "GET" && url.pathname === "/v1/auth/session-set"))
        ) {
          actorMutationAcceptances.push({
            acceptedAt: performance.now(),
            actorEpoch: response.headers.get(MANAGED_AUTH_ACTOR_EPOCH_HEADER),
            path: url.pathname,
            sessionSetAuthorityHash: sessionSetAuthorityHash(request.headers.get("cookie")),
          });
        }
        return response;
      }
      const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const requested = safePath.includes("..") ? null : Bun.file(`${webDist}/${safePath}`);
      const asset =
        requested && (await requested.exists()) ? requested : Bun.file(`${webDist}/index.html`);
      return new Response(asset, { headers: { "content-type": asset.type } });
    },
  });
  await mkdir(EVIDENCE_DIR, { recursive: true });

  alpha = await createActualUser({
    displayName: "Account Alpha",
    email: `account-alpha-${RUN_ID}@example.test`,
    organizationName: "Account Alpha Organization",
  });
  beta = await createActualUser({
    displayName: "Account Beta",
    email: `account-beta-${RUN_ID}@example.test`,
    organizationName: "Account Beta Organization",
  });
}, 900_000);

afterAll(async () => {
  edge?.stop(true);
  await client?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("provider-neutral browser account acceptance", () => {
  test("the strict browser ledger only permits scoped old-actor read cancellations", () => {
    const oldActorRead = {
      actorEpoch: "old-actor-epoch",
      dispatchPhase: "late-old-epoch-alpha-to-beta",
      failure: "net::ERR_ABORTED",
      method: "GET",
      responsePhase: "late-old-epoch-primary-settled-before-old-release",
      sessionSetAuthorityHash: "a".repeat(64),
      url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions`,
    } satisfies BrowserRequestFailureInput;
    expect(requestFailureProblem(oldActorRead)).toBeNull();
    expect(requestFailureProblem({ ...oldActorRead, failure: "NS_ERROR_ABORT" })).toBeNull();
    expect(requestFailureProblem({ ...oldActorRead, failure: "NS_ERROR_NET_RESET" })).toContain(
      "/sessions",
    );
    expect(
      requestFailureProblem({
        ...oldActorRead,
        dispatchPhase: "add-response-loss-replay",
        responsePhase: "cross-tab-select-race",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        actorEpoch: "primary-actor",
        dispatchPhase: "primary-set-sign-in",
        responsePhase: "primary-set-sign-in",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/model-catalog`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        actorEpoch: "add-replay-actor",
        dispatchPhase: "add-response-loss-replay",
        responsePhase: "add-response-loss-replay",
        url: `${publicOrigin}/v1/config/client`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        dispatchPhase: "independent-set-sign-in",
        responsePhase: "independent-set-after-other-logout-all",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        dispatchPhase: "late-old-epoch-setup-beta-to-alpha",
        responsePhase: "late-old-epoch-alpha-to-beta",
        url: `${publicOrigin}/v1/workspaces`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        dispatchPhase: "responsive-accessibility-evidence",
      }),
    ).toContain("responsive-accessibility-evidence");
    expect(requestFailureProblem({ ...oldActorRead, method: "POST" })).toContain("POST");
    expect(requestFailureProblem({ ...oldActorRead, actorEpoch: null })).toContain("actor=missing");
    expect(
      requestFailureProblem({
        ...oldActorRead,
        actorEpoch: null,
        dispatchPhase: "independent-set-sign-in",
        responsePhase: "independent-set-sign-in",
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        actorEpoch: "independent-actor",
        dispatchPhase: "independent-set-sign-in",
        responsePhase: "independent-set-sign-in",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/realtime-model-catalog`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...oldActorRead,
        actorEpoch: "independent-actor",
        dispatchPhase: "independent-set-sign-in",
        responsePhase: "independent-set-sign-in",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions`,
      }),
    ).toContain("/sessions");
    const longLivedOldActorStream = {
      ...oldActorRead,
      acceptedActorTransitions: [
        {
          acceptedAt: 200,
          actorEpoch: "new-actor-epoch",
          path: "/v1/auth/session-set/logout-all",
          sessionSetAuthorityHash: "a".repeat(64),
        },
      ],
      dispatchPhase: "late-old-epoch-primary-settled-before-old-release",
      failedAt: 300,
      responsePhase: "logout-all-response-loss-replay",
      startedAt: 100,
      url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream`,
    } satisfies BrowserRequestFailureInput;
    expect(requestFailureProblem(longLivedOldActorStream)).toBeNull();
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        failure: "NS_ERROR_NET_RESET",
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [],
        failure: "NS_ERROR_NET_RESET",
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: longLivedOldActorStream.actorEpoch,
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "a".repeat(64),
          },
        ],
      }),
    ).toContain("/live-events/stream");
    const signedOutOldActorBoundedStream = {
      ...longLivedOldActorStream,
      acceptedActorTransitions: [
        {
          acceptedAt: 200,
          actorEpoch: "signed-out-actor-epoch",
          path: "/v1/auth/session-set/logout-all",
          sessionSetAuthorityHash: "b".repeat(64),
        },
      ],
      url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream?after=12&transport=http1-bounded`,
    } satisfies BrowserRequestFailureInput;
    expect(requestFailureProblem(signedOutOldActorBoundedStream)).toBeNull();
    expect(
      requestFailureProblem({
        ...signedOutOldActorBoundedStream,
        acceptedActorTransitions: [],
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...signedOutOldActorBoundedStream,
        failure: "NS_ERROR_NET_RESET",
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...signedOutOldActorBoundedStream,
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream?transport=sse`,
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...signedOutOldActorBoundedStream,
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions?transport=http1-bounded`,
      }),
    ).toContain("/sessions");
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [
          {
            acceptedAt: 99,
            actorEpoch: "new-actor-epoch",
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "a".repeat(64),
          },
        ],
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: "new-actor-epoch",
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "b".repeat(64),
          },
        ],
      }),
    ).toContain("/live-events/stream");
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [],
        dispatchPhase: "primary-set-sign-in",
        responsePhase: "primary-set-sign-in",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/model-catalog`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...longLivedOldActorStream,
        acceptedActorTransitions: [],
        dispatchPhase: "primary-set-sign-in",
        failure: "NS_ERROR_NET_RESET",
        responsePhase: "primary-set-sign-in",
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/model-catalog`,
      }),
    ).toContain("/model-catalog");
    expect(
      requestFailureProblem({
        ...oldActorRead,
        url: `${publicOrigin}/assets/app.js`,
      }),
    ).toContain("/assets/app.js");
    const evidenceCatalogRead = {
      ...oldActorRead,
      dispatchPhase: "responsive-evidence-bootstrap",
      responsePhase: "responsive-evidence-bootstrap",
      url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/model-catalog`,
    };
    expect(requestFailureProblem(evidenceCatalogRead)).toBeNull();
    expect(
      requestFailureProblem({
        ...evidenceCatalogRead,
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions`,
      }),
    ).toContain("/sessions");
    const evidenceSessionPageRead = {
      ...evidenceCatalogRead,
      url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions?view=page&limit=50&parentSessionId=null`,
    };
    expect(requestFailureProblem(evidenceSessionPageRead)).toBeNull();
    expect(
      requestFailureProblem({
        ...evidenceSessionPageRead,
        failure: "NS_ERROR_NET_RESET",
      }),
    ).toContain("/sessions");
    expect(
      requestFailureProblem({
        ...evidenceSessionPageRead,
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions?view=array`,
      }),
    ).toContain("/sessions");
    const crossTabBootstrapRead = {
      ...oldActorRead,
      actorEpoch: null,
      dispatchPhase: "cross-tab-select-race",
      responsePhase: "cross-tab-select-race",
      url: `${publicOrigin}/v1/config/client`,
    };
    expect(requestFailureProblem(crossTabBootstrapRead)).toBeNull();
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        actorEpoch: "current-actor",
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        responsePhase: "cross-slot-deep-link",
      }),
    ).toContain("/v1/config/client");
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        dispatchPhase: "late-old-epoch-setup-beta-to-alpha",
        responsePhase: "late-old-epoch-setup-beta-to-alpha",
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        dispatchPhase: "second-tab-bootstrap",
        responsePhase: "second-tab-bootstrap",
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();
    const lateOldActorBootstrapRead = {
      ...crossTabBootstrapRead,
      actorEpoch: "old-actor-epoch",
      dispatchPhase: "late-old-epoch-alpha-to-beta",
      responsePhase: "late-old-epoch-primary-settled-before-old-release",
    };
    expect(requestFailureProblem(lateOldActorBootstrapRead)).toBeNull();
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        dispatchPhase: "late-old-epoch-setup-beta-to-alpha",
      }),
    ).toContain("/v1/config/client");
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        responsePhase: "responsive-evidence-bootstrap",
      }),
    ).toContain("/v1/config/client");
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        failure: "NS_ERROR_NET_RESET",
      }),
    ).toContain("/v1/config/client");
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        method: "POST",
      }),
    ).toContain("POST");
    expect(
      requestFailureProblem({
        ...lateOldActorBootstrapRead,
        url: `${publicOrigin}/v1/config/other`,
      }),
    ).toContain("/v1/config/other");
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        actorEpoch: "current-actor",
        dispatchPhase: "cross-slot-deep-link",
        responsePhase: "cross-slot-deep-link",
        url: `${publicOrigin}/v1/config/client`,
      }),
    ).toBeNull();
    const reauthenticationBootstrapRead = {
      ...crossTabBootstrapRead,
      actorEpoch: "current-actor",
      dispatchPhase: "slot-revocation-reauthentication",
      responsePhase: "slot-revocation-reauthentication",
    };
    expect(requestFailureProblem(reauthenticationBootstrapRead)).toBeNull();
    expect(
      requestFailureProblem({
        ...reauthenticationBootstrapRead,
        dispatchPhase: "cross-slot-deep-link",
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...reauthenticationBootstrapRead,
        dispatchPhase: "late-old-epoch-alpha-to-beta",
      }),
    ).toContain("/v1/config/client");
    expect(
      requestFailureProblem({
        ...reauthenticationBootstrapRead,
        url: `${publicOrigin}/v1/config/other`,
      }),
    ).toContain("/v1/config/other");
    const acceptedWebKitCancellation = {
      observedAt: 100,
      pathnameAndSearch:
        "/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/sessions/45779fe5-3636-4d7e-b4af-0ba46f90ffc0/turns?latestStarted=1",
      responsePhase: "slot-revocation-reauthentication",
      terminal: "failed" as const,
    };
    const correlatedWebKitPageError = {
      message:
        "[slot-revocation-reauthentication] /127.0.0.1:20035/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/sessions/45779fe5-3636-4d7e-b4af-0ba46f90ffc0/turns?latestStarted=1 due to access control checks.",
      observedAt: 150,
    };
    expect(
      correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [
        acceptedWebKitCancellation,
      ]),
    ).toBe(0);
    expect(correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [])).toBeNull();
    expect(
      correlatedWebKitReauthenticationTerminalIndex(
        {
          message:
            "[cross-slot-deep-link] /127.0.0.1:20035/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/sessions/45779fe5-3636-4d7e-b4af-0ba46f90ffc0/turns?latestStarted=1 due to access control checks.",
          observedAt: 150,
        },
        [acceptedWebKitCancellation],
      ),
    ).toBeNull();
    expect(
      correlatedWebKitReauthenticationTerminalIndex(
        {
          message:
            "[slot-revocation-reauthentication] /127.0.0.1:20035/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/realtime-model-catalog due to access control checks.",
          observedAt: 150,
        },
        [
          {
            observedAt: 100,
            pathnameAndSearch:
              "/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/realtime-model-catalog",
            responsePhase: "slot-revocation-reauthentication",
            terminal: "failed",
          },
        ],
      ),
    ).toBe(0);
    expect(
      correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [
        {
          ...acceptedWebKitCancellation,
          observedAt: 151,
          terminal: "finished",
        },
      ]),
    ).toBe(0);
    expect(
      correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [
        {
          ...acceptedWebKitCancellation,
          observedAt: 150 + WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS + 1,
        },
      ]),
    ).toBeNull();
    expect(
      correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [
        {
          ...acceptedWebKitCancellation,
          observedAt: 150 - WEBKIT_PAGE_ERROR_CORRELATION_WINDOW_MS - 1,
        },
      ]),
    ).toBeNull();
    expect(
      correlatedWebKitReauthenticationTerminalIndex(correlatedWebKitPageError, [
        acceptedWebKitCancellation,
        {
          ...acceptedWebKitCancellation,
          observedAt: 125,
          terminal: "finished",
        },
      ]),
    ).toBeNull();
    const consumableWebKitFailures = [acceptedWebKitCancellation];
    expect(
      optionalWebKitReauthenticationAccessControlPageError(
        {
          acceptedRequestTerminals: consumableWebKitFailures,
          pageErrorEvidence: [correlatedWebKitPageError],
        },
        "webkit",
      ),
    ).toEqual([correlatedWebKitPageError.message]);
    expect(consumableWebKitFailures).toEqual([]);
    expect(
      optionalWebKitReauthenticationAccessControlPageError(
        {
          acceptedRequestTerminals: [acceptedWebKitCancellation],
          pageErrorEvidence: [correlatedWebKitPageError, correlatedWebKitPageError],
        },
        "webkit",
      ),
    ).toEqual([]);
    const secondAcceptedWebKitCancellation = {
      ...acceptedWebKitCancellation,
      pathnameAndSearch:
        "/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/sessions/45779fe5-3636-4d7e-b4af-0ba46f90ffc0/queue",
    };
    const secondCorrelatedWebKitPageError = {
      message:
        "[slot-revocation-reauthentication] /127.0.0.1:20035/v1/workspaces/f7acfc16-b1dc-4683-bd9b-317782ed74e2/sessions/45779fe5-3636-4d7e-b4af-0ba46f90ffc0/queue due to access control checks.",
      observedAt: 175,
    };
    const bijectiveWebKitFailures = [acceptedWebKitCancellation, secondAcceptedWebKitCancellation];
    expect(
      optionalWebKitReauthenticationAccessControlPageError(
        {
          acceptedRequestTerminals: bijectiveWebKitFailures,
          pageErrorEvidence: [correlatedWebKitPageError, secondCorrelatedWebKitPageError],
        },
        "webkit",
      ),
    ).toEqual([correlatedWebKitPageError.message, secondCorrelatedWebKitPageError.message]);
    expect(bijectiveWebKitFailures).toEqual([]);
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        dispatchPhase: "cross-slot-deep-link",
        responsePhase: "cross-slot-deep-link",
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        dispatchPhase: "cross-slot-deep-link",
        responsePhase: "cross-slot-deep-link",
        url: `${publicOrigin}/v1/auth/session-set`,
      }),
    ).toContain("/v1/auth/session-set");
    expect(
      requestFailureProblem({
        ...crossTabBootstrapRead,
        dispatchPhase: "responsive-evidence-bootstrap",
        responsePhase: "responsive-evidence-bootstrap",
        url: `${publicOrigin}/v1/auth/get-session`,
      }),
    ).toBeNull();

    const retirement = {
      acceptedActorTransitions: [
        {
          acceptedAt: 200,
          actorEpoch: "new-actor-epoch",
          path: "/v1/auth/session-set/select",
          sessionSetAuthorityHash: "a".repeat(64),
        },
      ],
      actorDispatches: [{ actorEpoch: "new-actor-epoch", startedAt: 250 }],
      actorEpoch: "old-actor-epoch",
      confirmedActorEpoch: "new-actor-epoch",
      confirmedAt: 300,
      currentSessionSetAuthorityHash: "a".repeat(64),
      dispatchPhase: "second-tab-bootstrap",
      method: "GET",
      oldWorkspaceId: "00000000-0000-0000-0000-000000000001",
      pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions",
      requestSessionSetAuthorityHash: "a".repeat(64),
      responseSeen: false,
      startedAt: 100,
    } satisfies FiniteReadRetirementInput;
    expect(finiteReadMayRetireAfterActorTransition(retirement)).toBe(true);
    const retiredDescription = "GET /v1/workspaces/old-workspace/sessions";
    expect(
      retiredFiniteReadTerminalProblem(retiredDescription, {
        kind: "response",
        status: 200,
      }),
    ).toContain("unexpected-late-response=200");
    expect(
      retiredFiniteReadTerminalProblem(retiredDescription, {
        kind: "finished",
      }),
    ).toContain("unexpected-late-finish");
    expect(
      retiredFiniteReadTerminalProblem(undefined, {
        kind: "response",
        status: 200,
      }),
    ).toBeNull();
    expect(
      finiteReadMayRetireAfterActorTransition({
        ...retirement,
        requestSessionSetAuthorityHash: null,
      }),
    ).toBe(true);
    expect(
      finiteReadMayRetireAfterActorTransition({
        ...retirement,
        dispatchPhase: "cross-tab-select-race",
        requestSessionSetAuthorityHash: null,
      }),
    ).toBe(true);
    for (const invalid of [
      { ...retirement, method: "POST" },
      { ...retirement, actorEpoch: "new-actor-epoch" },
      { ...retirement, actorEpoch: null },
      { ...retirement, pathname: "/v1/workspaces/another-workspace/sessions" },
      { ...retirement, pathname: "/v1/workspaces" },
      { ...retirement, requestSessionSetAuthorityHash: "b".repeat(64) },
      {
        ...retirement,
        dispatchPhase: "late-old-epoch-setup-beta-to-alpha",
        requestSessionSetAuthorityHash: null,
      },
      {
        ...retirement,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: "new-actor-epoch",
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "a".repeat(64),
          },
        ],
        requestSessionSetAuthorityHash: null,
      },
      { ...retirement, responseSeen: true },
      { ...retirement, startedAt: 251 },
      { ...retirement, confirmedAt: 199 },
      { ...retirement, actorDispatches: [] },
      {
        ...retirement,
        actorDispatches: [{ actorEpoch: "new-actor-epoch", startedAt: 99 }],
      },
    ]) {
      expect(finiteReadMayRetireAfterActorTransition(invalid)).toBe(false);
    }
    expect(
      finiteReadMayRetireAfterActorTransition({
        ...retirement,
        startedAt: 225,
      }),
    ).toBe(true);

    const documentReplacementRetirement = {
      actorEpoch: "current-actor-epoch",
      confirmedActorEpoch: "current-actor-epoch",
      currentSessionSetAuthorityHash: "a".repeat(64),
      dispatchPhase: "cross-slot-deep-link",
      expectedDispatchPhase: "cross-slot-deep-link",
      method: "GET",
      pathname:
        "/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions/00000000-0000-4000-8000-000000000002/lineage",
      replacementStartedAt: 200,
      requestSessionSetAuthorityHash: "a".repeat(64),
      startedAt: 100,
      workspaceId: "00000000-0000-0000-0000-000000000001",
    } satisfies DocumentReplacementRetirementInput;
    expect(finiteReadMayRetireAfterDocumentReplacement(documentReplacementRetirement)).toBe(true);
    expect(
      finiteReadMayRetireAfterDocumentReplacement({
        ...documentReplacementRetirement,
        requestSessionSetAuthorityHash: null,
      }),
    ).toBe(true);
    for (const invalid of [
      { ...documentReplacementRetirement, method: "POST" },
      { ...documentReplacementRetirement, actorEpoch: null },
      { ...documentReplacementRetirement, actorEpoch: "old-actor-epoch" },
      {
        ...documentReplacementRetirement,
        dispatchPhase: "slot-revocation-reauthentication",
      },
      {
        ...documentReplacementRetirement,
        pathname:
          "/v1/workspaces/another-workspace/sessions/00000000-0000-4000-8000-000000000002/lineage",
      },
      {
        ...documentReplacementRetirement,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions/not-a-uuid/lineage",
      },
      {
        ...documentReplacementRetirement,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/model-catalog",
      },
      {
        ...documentReplacementRetirement,
        currentSessionSetAuthorityHash: null,
      },
      {
        ...documentReplacementRetirement,
        dispatchPhase: "slot-revocation-reauthentication",
        expectedDispatchPhase: "slot-revocation-reauthentication",
        requestSessionSetAuthorityHash: null,
      },
      {
        ...documentReplacementRetirement,
        requestSessionSetAuthorityHash: "b".repeat(64),
      },
      { ...documentReplacementRetirement, startedAt: 201 },
    ]) {
      expect(finiteReadMayRetireAfterDocumentReplacement(invalid)).toBe(false);
    }

    const logoutAllRetirement = {
      acceptedActorTransitions: [
        {
          acceptedAt: 200,
          actorEpoch: "accepted-reset-epoch",
          path: "/v1/auth/session-set/logout-all",
          sessionSetAuthorityHash: "a".repeat(64),
        },
      ],
      actorEpoch: "old-actor-epoch",
      confirmedActorEpoch: "new-neutral-epoch",
      confirmedAt: 300,
      currentSessionSetAuthorityHash: "b".repeat(64),
      dispatchPhase: "slot-revocation-reauthentication",
      logoutAllAcceptedAt: 200,
      method: "GET",
      oldWorkspaceId: "00000000-0000-0000-0000-000000000001",
      pathname:
        "/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions/00000000-0000-4000-8000-000000000002/queue",
      requestSessionSetAuthorityHash: "a".repeat(64),
      responseSeen: false,
      startedAt: 100,
    } satisfies LogoutAllFiniteReadRetirementInput;
    expect(finiteReadMayRetireAfterLogoutAllAuthorityReset(logoutAllRetirement)).toBe(true);
    for (const invalid of [
      { ...logoutAllRetirement, method: "POST" },
      { ...logoutAllRetirement, actorEpoch: null },
      { ...logoutAllRetirement, actorEpoch: "new-neutral-epoch" },
      { ...logoutAllRetirement, responseSeen: true },
      { ...logoutAllRetirement, dispatchPhase: "cross-slot-deep-link" },
      {
        ...logoutAllRetirement,
        pathname: "/v1/workspaces/another-workspace/sessions",
      },
      { ...logoutAllRetirement, pathname: "/v1/workspaces" },
      { ...logoutAllRetirement, requestSessionSetAuthorityHash: null },
      {
        ...logoutAllRetirement,
        currentSessionSetAuthorityHash: "a".repeat(64),
      },
      { ...logoutAllRetirement, startedAt: 201 },
      { ...logoutAllRetirement, confirmedAt: 199 },
      { ...logoutAllRetirement, logoutAllAcceptedAt: 201 },
      { ...logoutAllRetirement, acceptedActorTransitions: [] },
      {
        ...logoutAllRetirement,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: "old-actor-epoch",
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "a".repeat(64),
          },
        ],
      },
      {
        ...logoutAllRetirement,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: "accepted-reset-epoch",
            path: "/v1/auth/session-set/select",
            sessionSetAuthorityHash: "a".repeat(64),
          },
        ],
      },
      {
        ...logoutAllRetirement,
        acceptedActorTransitions: [
          {
            acceptedAt: 200,
            actorEpoch: "accepted-reset-epoch",
            path: "/v1/auth/session-set/logout-all",
            sessionSetAuthorityHash: "c".repeat(64),
          },
        ],
      },
    ]) {
      expect(finiteReadMayRetireAfterLogoutAllAuthorityReset(invalid)).toBe(false);
    }

    expect(
      actorTransitionResponseDispatchPhaseMatches({
        dispatchPhase: "second-tab-bootstrap",
        expectedPhase: "cross-tab-select-race",
        permitsDirectRacePredecessors: true,
        responsePhase: "cross-tab-select-race",
      }),
    ).toBe(true);
    expect(
      actorTransitionResponseDispatchPhaseMatches({
        dispatchPhase: "second-tab-bootstrap",
        expectedPhase: "cross-tab-select-race",
        permitsDirectRacePredecessors: false,
        responsePhase: "cross-tab-select-race",
      }),
    ).toBe(false);
    expect(
      actorTransitionResponseDispatchPhaseMatches({
        dispatchPhase: "second-tab-bootstrap",
        expectedPhase: "cross-tab-select-race",
        permitsDirectRacePredecessors: true,
        responsePhase: "late-old-epoch-setup-beta-to-alpha",
      }),
    ).toBe(false);
    expect(
      actorTransitionResponseDispatchPhaseMatches({
        dispatchPhase: "logout-one",
        expectedPhase: "logout-one",
        permitsDirectRacePredecessors: true,
        responsePhase: "logout-one",
      }),
    ).toBe(false);

    const expectedRaceConsole =
      "Failed to load resource: the server responded with a status of 409 (Conflict) @ /v1/auth/session-set/select";
    expect(isExpectedHttpConsoleError(expectedRaceConsole, "cross-tab-select-race")).toBe(true);
    expect(
      isExpectedHttpConsoleError(expectedRaceConsole, "responsive-accessibility-evidence"),
    ).toBe(false);
    const expectedIndependentReloadConsole =
      "Failed to load resource: the server responded with a status of 409 (Conflict) @ /v1/auth/get-session";
    expect(
      isExpectedHttpConsoleError(
        expectedIndependentReloadConsole,
        "independent-set-after-other-logout-all",
      ),
    ).toBe(true);
    expect(isExpectedHttpConsoleError(expectedIndependentReloadConsole, "logout-one")).toBe(true);
    expect(
      isExpectedHttpConsoleError(expectedIndependentReloadConsole, "independent-set-sign-in"),
    ).toBe(false);
  });

  test("the strict browser ledger bounds native HTTP/1 stream seams by URL, cause, and time", () => {
    const boundedLiveUrl = `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream?transport=http1-bounded`;
    expect(isBoundedHttp1StreamRequest("GET", boundedLiveUrl)).toBe(true);
    expect(
      isBoundedHttp1StreamRequest(
        "GET",
        `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions/00000000-0000-0000-0000-000000000002/events/stream?after=4&transport=http1-bounded`,
      ),
    ).toBe(true);
    expect(isBoundedHttp1StreamRequest("POST", boundedLiveUrl)).toBe(false);
    expect(isBoundedHttp1StreamRequest("GET", boundedLiveUrl.replace("http1-bounded", "h2"))).toBe(
      false,
    );
    expect(
      isBoundedHttp1StreamRequest(
        "GET",
        `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001?transport=http1-bounded`,
      ),
    ).toBe(false);
    const expected = {
      failedAt: 11_100,
      failure: "net::ERR_ABORTED",
      method: "GET",
      startedAt: 100,
      url: boundedLiveUrl,
    };
    expect(isExpectedBoundedHttp1NativeSeam(expected)).toBe(true);
    expect(isExpectedBoundedHttp1NativeSeam({ ...expected, failedAt: 10_099 })).toBe(false);
    expect(isExpectedBoundedHttp1NativeSeam({ ...expected, failedAt: 15_101 })).toBe(false);
    expect(
      isExpectedBoundedHttp1NativeSeam({
        ...expected,
        failure: "net::ERR_CONNECTION_RESET",
      }),
    ).toBe(false);
    expect(
      isExpectedBoundedHttp1NativeSeam({
        ...expected,
        failure: "cancelled: connection reset",
      }),
    ).toBe(false);
    expect(
      isExpectedBoundedHttp1NativeSeam({
        ...expected,
        failure: "canceled: transport failure",
      }),
    ).toBe(false);
    expect(
      isExpectedBoundedHttp1NativeSeam({
        ...expected,
        url: `${publicOrigin}/v1/workspaces?transport=http1-bounded`,
      }),
    ).toBe(false);
    expect(
      isExpectedBoundedHttp1NativeSeam({
        ...expected,
        url: `${publicOrigin}/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream`,
      }),
    ).toBe(false);

    const logoutAllFence = {
      actorEpoch: "old-actor",
      dispatchPhase: "logout-all-response-loss-replay",
      endedAt: 220,
      method: "GET",
      pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/sessions",
      responsePhase: "logout-all-response-loss-replay",
      search: "",
      startedAt: 100,
      status: 401,
    } satisfies BrowserProblems["actorFenceResponses"][number];
    const logoutAllFenceInput = {
      acceptedAt: 200,
      actorEpoch: "old-actor",
      settledAt: 300,
      workspaceId: "00000000-0000-0000-0000-000000000001",
    };
    expect(logoutAllActorFenceResponseProblem(logoutAllFence, logoutAllFenceInput)).toBeNull();
    expect(
      logoutAllActorFenceResponseProblem(
        {
          ...logoutAllFence,
          pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream",
          search: "?controlAfter=12&interactionAfter=34&transport=http1-bounded",
        },
        logoutAllFenceInput,
      ),
    ).toBeNull();
    for (const invalid of [
      { ...logoutAllFence, actorEpoch: "new-actor" },
      { ...logoutAllFence, dispatchPhase: "signed-out-settled" },
      { ...logoutAllFence, responsePhase: "signed-out-settled" },
      { ...logoutAllFence, method: "POST" },
      { ...logoutAllFence, pathname: "/v1/workspaces" },
      { ...logoutAllFence, search: "?view=page" },
      {
        ...logoutAllFence,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream",
        search: "?transport=h2",
      },
      {
        ...logoutAllFence,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream",
        search: "?controlAfter=12&interactionAfter=34&transport=http1-bounded&transport=h2",
      },
      {
        ...logoutAllFence,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream",
        search: "?controlAfter=12&interactionAfter=34&transport=http1-bounded&unexpected=1",
      },
      {
        ...logoutAllFence,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000001/live-events/stream",
        search: "?controlAfter=012&interactionAfter=34&transport=http1-bounded",
      },
      {
        ...logoutAllFence,
        pathname: "/v1/workspaces/00000000-0000-0000-0000-000000000002/live-events/stream",
        search: "?controlAfter=12&interactionAfter=34&transport=http1-bounded",
      },
      { ...logoutAllFence, status: 403 },
      { ...logoutAllFence, endedAt: 199 },
      { ...logoutAllFence, endedAt: 301 },
      { ...logoutAllFence, startedAt: 301, endedAt: 302 },
    ]) {
      expect(logoutAllActorFenceResponseProblem(invalid, logoutAllFenceInput)).toContain(
        "unexpected logout-all actor fence",
      );
    }
  });

  test("real users add, race, switch, re-authenticate, deep-link, and revoke without stale tenant state", async () => {
    if (!owned) throw new Error("database fixture unavailable");
    const engine = requestedEngine as EngineName;
    const browser = await launchAccountBrowser(engine);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    const otherBrowserSet = await browser.newContext({
      viewport: { width: 1024, height: 768 },
    });
    const page = await context.newPage();
    const secondTab = await context.newPage();
    const otherPage = await otherBrowserSet.newPage();
    const pageProblems = observeBrowser(page);
    const secondTabProblems = observeBrowser(secondTab);
    const otherProblems = observeBrowser(otherPage);

    try {
      setBrowserPhase(otherProblems, "independent-set-sign-in");
      await signIn(otherPage, beta);
      // A sign-in is not settled merely because its account trigger mounted:
      // the routed tree can still be finishing actor-owned finite bootstrap
      // reads. Prove each sequential bootstrap independently before starting
      // the next browser set, without exempting any cancellation or failure.
      await waitForFiniteReadQuiescence(otherProblems);
      await expectNoBrowserProblems(otherProblems);
      setBrowserPhase(pageProblems, "primary-set-sign-in");
      await signIn(page, alpha);
      await waitForFiniteReadQuiescence(pageProblems);
      await expectNoBrowserProblems(pageProblems);
      await expectActiveAccountAnnouncement(page, alpha);
      setBrowserPhase(secondTabProblems, "second-tab-bootstrap");
      await secondTab.goto(`${publicOrigin}/workspaces/${alpha.workspaceId}`, {
        waitUntil: "domcontentloaded",
      });
      await accountMenuTrigger(secondTab, alpha.displayName).waitFor();
      // Loading a full document in the shared browser set is a distinct
      // bootstrap boundary. Both tabs must be finite-read quiescent and clean
      // before the deliberate cross-tab actor races begin below.
      await waitForFiniteReadQuiescenceAcross([pageProblems, secondTabProblems]);
      await expectNoBrowserProblems(pageProblems);
      await expectNoBrowserProblems(secondTabProblems);

      setBrowserPhase(pageProblems, "add-response-loss-replay");
      const betaProviderSessionsBeforeReplay = await authSessionCount(beta.email);
      await addOrReauth(page, alpha, beta, "add");
      let projection = await sessionSet(page);
      expect(projection.slots).toHaveLength(2);
      expect(
        projection.slots.find((slot) => slot.id === projection.selectedSlotId)?.displayName,
      ).toBe(alpha.displayName);
      expect(await authSessionCount(beta.email)).toBe(betaProviderSessionsBeforeReplay + 1);

      // Wait until the React projection has incorporated the added slot before
      // exercising focus ownership. The authoritative GET above can lead the
      // cross-tab projection broadcast by one task.
      await waitForFiniteReadQuiescence(pageProblems);
      const settledMenu = await openAccountMenu(page, alpha.displayName);
      await settledMenu.getByRole("menuitem", { name: new RegExp(beta.displayName) }).waitFor();
      const trigger = accountMenuTrigger(page, alpha.displayName);
      await page.keyboard.press("Escape");
      await settledMenu.waitFor({ state: "detached" });
      await trigger.focus();
      await page.waitForFunction(
        (label) => document.activeElement?.getAttribute("aria-label") === label,
        `Account menu. ${alpha.displayName} is active.`,
      );
      await page.keyboard.press("Enter");
      const keyboardMenu = page
        .locator('[data-slot="dropdown-menu-content"][data-state="open"]')
        .filter({ hasText: "Browser accounts" });
      await keyboardMenu.getByRole("menuitem").first().waitFor();
      expect(await keyboardMenu.getByRole("menuitem").count()).toBeGreaterThan(0);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-slot="dropdown-menu-content"]')].some(
          (menu) =>
            menu.textContent?.includes("Browser accounts") && menu.contains(document.activeElement),
        ),
      );
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-slot="dropdown-menu-content"]')].some(
          (menu) =>
            menu.textContent?.includes("Browser accounts") && menu.contains(document.activeElement),
        ),
      );
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (label) => document.activeElement?.getAttribute("aria-label") === label,
        `Account menu. ${alpha.displayName} is active.`,
      );
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

      if (engine === "chromium") {
        setBrowserPhase(pageProblems, "responsive-accessibility-evidence");
        await captureResponsiveEvidence(context, engine);
      }

      setBrowserPhase(pageProblems, "cross-tab-select-race");
      setBrowserPhase(secondTabProblems, "cross-tab-select-race");
      projection = await sessionSet(page);
      const betaSlot = projection.slots.find((slot) => slot.displayName === beta.displayName);
      if (!betaSlot) throw new Error("Beta slot missing after add");
      const [pageProjection, tabProjection] = await Promise.all([
        sessionSet(page),
        sessionSet(secondTab),
      ]);
      const raced = await Promise.all([
        raceSelect(page, pageProjection, betaSlot.id),
        raceSelect(secondTab, tabProjection, betaSlot.id),
      ]);
      expect(raced.sort()).toEqual([200, 409]);
      await Promise.all([
        page.reload({ waitUntil: "domcontentloaded" }),
        secondTab.reload({ waitUntil: "domcontentloaded" }),
      ]);
      await Promise.all([
        accountMenuTrigger(page, beta.displayName).waitFor(),
        accountMenuTrigger(secondTab, beta.displayName).waitFor(),
      ]);
      await expectActiveAccountAnnouncement(page, beta);
      expect(page.url()).toContain(beta.workspaceId);
      expect(secondTab.url()).toContain(beta.workspaceId);
      const racedSelectionSettledAt = performance.now();
      const racedSelectAcceptedAt = actorMutationAcceptances
        .filter(({ path }) => path === "/v1/auth/session-set/select")
        .at(-1)?.acceptedAt;
      if (racedSelectAcceptedAt === undefined) {
        throw new Error(
          "successful raced select acceptance timestamp was not observed at the edge",
        );
      }
      for (const [observedPage, observedProblems] of [
        [page, pageProblems],
        [secondTab, secondTabProblems],
      ] as const) {
        await expectAndConsumeActorTransitionResponse(observedPage, observedProblems, {
          acceptedAt: racedSelectAcceptedAt,
          actorEpoch: pageProjection.actorEpoch,
          method: "GET",
          pathname: `/v1/workspaces/${alpha.workspaceId}/live-events/stream`,
          phase: "cross-tab-select-race",
          status: 409,
          statusLabel: "Conflict",
          workspaceId: alpha.workspaceId,
          timing: {
            kind: "direct-race-fence",
            settledAt: racedSelectionSettledAt,
          },
          allowedConsoleErrors:
            engine === "chromium"
              ? [
                  `[cross-tab-select-race] Failed to load resource: net::ERR_CONNECTION_RESET @ /v1/workspaces/${alpha.workspaceId}/live-events/stream`,
                ]
              : [],
        });
      }
      const racedSelectionAcceptance = actorMutationAcceptances
        .filter(({ path }) => path === "/v1/auth/session-set/select")
        .at(-1);
      if (!racedSelectionAcceptance?.actorEpoch) {
        throw new Error("raced selection did not expose its accepted actor epoch");
      }
      await Promise.all([
        retirePendingReadsAfterConfirmedActorTransition(page, pageProblems, {
          confirmedActorEpoch: racedSelectionAcceptance.actorEpoch,
          confirmedAt: racedSelectionSettledAt,
          oldWorkspaceId: alpha.workspaceId,
        }),
        retirePendingReadsAfterConfirmedActorTransition(secondTab, secondTabProblems, {
          confirmedActorEpoch: racedSelectionAcceptance.actorEpoch,
          confirmedAt: racedSelectionSettledAt,
          oldWorkspaceId: alpha.workspaceId,
        }),
      ]);

      setBrowserPhase(pageProblems, "late-old-epoch-setup-beta-to-alpha");
      setBrowserPhase(secondTabProblems, "late-old-epoch-setup-beta-to-alpha");
      await selectAccount(page, beta, alpha);
      await accountMenuTrigger(secondTab, alpha.displayName).waitFor({
        timeout: 30_000,
      });
      const confirmedAlphaAt = performance.now();
      const alphaSelectionAcceptance = actorMutationAcceptances
        .filter(({ path }) => path === "/v1/auth/session-set/select")
        .at(-1);
      if (!alphaSelectionAcceptance?.actorEpoch) {
        throw new Error("alpha selection did not expose its accepted actor epoch");
      }
      await Promise.all([
        retirePendingReadsAfterConfirmedActorTransition(page, pageProblems, {
          confirmedActorEpoch: alphaSelectionAcceptance.actorEpoch,
          confirmedAt: confirmedAlphaAt,
          oldWorkspaceId: beta.workspaceId,
        }),
        retirePendingReadsAfterConfirmedActorTransition(secondTab, secondTabProblems, {
          confirmedActorEpoch: alphaSelectionAcceptance.actorEpoch,
          confirmedAt: confirmedAlphaAt,
          oldWorkspaceId: beta.workspaceId,
        }),
      ]);
      await waitForFiniteReadQuiescenceAcross([pageProblems, secondTabProblems]);
      const oldProjection = await sessionSet(secondTab);
      const delay = await delayedWorkspaceResponse(secondTab, oldProjection.actorEpoch);
      const reload = secondTab.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
      const intentionallyHeldRequest = await delay.intercepted;
      await waitForCompanionFiniteReadQuiescence(secondTabProblems, intentionallyHeldRequest);
      setBrowserPhase(pageProblems, "late-old-epoch-alpha-to-beta");
      setBrowserPhase(secondTabProblems, "late-old-epoch-alpha-to-beta");
      await selectAccount(page, alpha, beta);
      setBrowserPhase(pageProblems, "late-old-epoch-primary-settled-before-old-release");
      setBrowserPhase(secondTabProblems, "late-old-epoch-primary-settled-before-old-release");
      delay.release();
      await reload;
      await delay.dispose();
      await accountMenuTrigger(secondTab, beta.displayName).waitFor({
        timeout: 30_000,
      });
      const confirmedTabBetaAfterDelayAt = performance.now();
      const betaSelectionAcceptance = actorMutationAcceptances
        .filter(({ path }) => path === "/v1/auth/session-set/select")
        .at(-1);
      if (!betaSelectionAcceptance?.actorEpoch) {
        throw new Error("beta selection did not expose its accepted actor epoch");
      }
      await retirePendingReadsAfterConfirmedActorTransition(secondTab, secondTabProblems, {
        confirmedActorEpoch: betaSelectionAcceptance.actorEpoch,
        confirmedAt: confirmedTabBetaAfterDelayAt,
        oldWorkspaceId: alpha.workspaceId,
      });
      expect(secondTab.url()).toContain(beta.workspaceId);
      expect(secondTab.url()).not.toContain(alpha.workspaceId);

      setBrowserPhase(pageProblems, "cross-slot-deep-link");
      await selectAccount(page, beta, alpha);
      await waitForFiniteReadQuiescence(pageProblems);
      await page.goto(`${publicOrigin}/sessions/${beta.sessionId}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("heading", { name: "Open with another account" }).waitFor();
      expect(await page.getByText(beta.displayName, { exact: false }).count()).toBeGreaterThan(0);
      expect(await page.getByText(beta.email, { exact: false }).count()).toBeGreaterThan(0);
      expect(await page.getByText("Account Beta Organization", { exact: false }).count()).toBe(0);
      await page.getByRole("button", { name: `Open as ${beta.displayName}` }).click();
      await accountMenuTrigger(page, beta.displayName).waitFor({
        timeout: 30_000,
      });
      await expectAndConsumeConsoleErrors(
        page,
        pageProblems,
        [
          `[cross-slot-deep-link] Failed to load resource: the server responded with a status of 404 (Not Found) @ /v1/workspaces/${alpha.workspaceId}/sessions/${beta.sessionId}`,
          `[cross-slot-deep-link] Failed to load resource: the server responded with a status of 404 (Not Found) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/stream-capabilities`,
          `[cross-slot-deep-link] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ /v1/workspaces/${beta.workspaceId}/editable-artifacts`,
          `[cross-slot-deep-link] Failed to load resource: the server responded with a status of 403 (Forbidden) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/attention`,
        ],
        engine === "chromium" || engine === "webkit"
          ? [
              `[cross-slot-deep-link] Failed to load resource: the server responded with a status of 404 (Not Found) @ /v1/workspaces/${alpha.workspaceId}/sessions/${beta.sessionId}`,
            ]
          : [],
      );

      setBrowserPhase(pageProblems, "slot-revocation-reauthentication");
      const projectionBeforeSlotRevocation = await sessionSet(page);
      const alphaSlot = projectionBeforeSlotRevocation.slots.find(
        (slot) => slot.displayName === alpha.displayName,
      );
      if (!alphaSlot) throw new Error("Alpha slot missing before re-authentication");
      await owned.admin`
        delete from auth_sessions where id = (
          select auth_session_id from managed_auth_login_slots where id = ${alphaSlot.id}
        )`;
      const slotRevocationReloadStartedAt = performance.now();
      await page.reload({ waitUntil: "domcontentloaded" });
      await accountMenuTrigger(page, beta.displayName).waitFor();
      await retirePendingReadsAfterConfirmedDocumentReplacement(page, pageProblems, {
        confirmedActorEpoch: projectionBeforeSlotRevocation.actorEpoch,
        dispatchPhase: "cross-slot-deep-link",
        replacementStartedAt: slotRevocationReloadStartedAt,
        workspaceId: beta.workspaceId,
      });
      const reauthMenu = await openAccountMenu(page, beta.displayName);
      const alphaReauthSlot = reauthMenu.getByRole("menuitem", {
        name: new RegExp(alpha.displayName),
      });
      expect(await alphaReauthSlot.innerText()).toContain("Re-authentication required");
      await page.keyboard.press("Escape");
      await addOrReauth(page, beta, alpha, "reauth");
      projection = await sessionSet(page);
      expect(projection.selectedSlotId).toBe(
        projection.slots.find((slot) => slot.displayName === beta.displayName)?.id,
      );
      expect(projection.slots.find((slot) => slot.displayName === alpha.displayName)?.state).toBe(
        "active",
      );
      await expectAndConsumeConsoleErrors(
        page,
        pageProblems,
        [
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 404 (Not Found) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/stream-capabilities`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 404 (Not Found) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/stream-capabilities`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ /v1/workspaces/${beta.workspaceId}/editable-artifacts`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ /v1/workspaces/${beta.workspaceId}/editable-artifacts`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ /v1/workspaces/${beta.workspaceId}/editable-artifacts`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 403 (Forbidden) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/attention`,
          `[slot-revocation-reauthentication] Failed to load resource: the server responded with a status of 403 (Forbidden) @ /v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/attention`,
          ...optionalWebKitReauthenticationReloadError(pageProblems, engine),
        ],
        [],
      );
      await expectAndConsumePageErrors(
        page,
        pageProblems,
        () => optionalWebKitReauthenticationAccessControlPageError(pageProblems, engine),
        [],
      );

      const projectionBeforeLogoutOne = projection;
      setBrowserPhase(pageProblems, "logout-one");
      await openAccountMenu(page, beta.displayName);
      await page.getByRole("menuitem", { name: new RegExp(alpha.displayName) }).hover();
      await page.getByRole("menuitem", { name: "Sign out this account" }).click();
      await page.getByRole("heading", { name: `Sign out ${alpha.displayName}?` }).waitFor();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await accountMenuTrigger(page, beta.displayName).waitFor();
      expect((await sessionSet(page)).slots.map((slot) => slot.displayName)).toEqual([
        beta.displayName,
      ]);
      const logoutOneAcceptedAt = actorMutationAcceptances
        .filter(({ path }) => path === "/v1/auth/session-set/logout-one")
        .at(-1)?.acceptedAt;
      if (logoutOneAcceptedAt === undefined) {
        throw new Error("logout-one acceptance timestamp was not observed at the edge");
      }
      await expectAndConsumeActorTransitionResponse(page, pageProblems, {
        acceptedAt: logoutOneAcceptedAt,
        actorEpoch: projectionBeforeLogoutOne.actorEpoch,
        method: "PUT",
        pathname: `/v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/attention`,
        phase: "logout-one",
        status: 403,
        statusLabel: "Forbidden",
      });

      setBrowserPhase(pageProblems, "csrf-fail-closed");
      const csrfFailure = await page.evaluate(
        async ({ contractHeader, contractRevision }) =>
          (
            await fetch("/v1/auth/session-set/logout-all", {
              method: "POST",
              credentials: "include",
              headers: {
                "content-type": "application/json",
                [contractHeader]: contractRevision,
              },
              body: JSON.stringify({
                operationId: crypto.randomUUID(),
                expectedGeneration: "1",
              }),
            })
          ).status,
        {
          contractHeader: MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
          contractRevision: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
        },
      );
      expect(csrfFailure).toBe(403);

      const authorityBeforeLogoutAll = (await context.cookies(publicOrigin)).find(
        ({ name }) => name === "opengeni.session_set",
      )?.value;
      expect(authorityBeforeLogoutAll).toHaveLength(43);
      const projectionBeforeLogoutAll = await sessionSet(page);
      setBrowserPhase(pageProblems, "logout-all-response-loss-replay");
      setBrowserPhase(secondTabProblems, "logout-all-response-loss-replay");
      completionResponseLoss = {
        acceptedAt: null,
        attempts: 0,
        dropped: false,
        exactBodies: [],
        firstBody: null,
        path: "/v1/auth/session-set/logout-all",
        statuses: [],
      };
      await openAccountMenu(page, beta.displayName);
      await page.getByRole("menuitem", { name: "Sign out all browser accounts" }).click();
      await page.getByRole("heading", { name: "Sign out all browser accounts?" }).waitFor();
      await page.getByRole("button", { name: "Sign out all", exact: true }).click();
      try {
        await page.getByRole("heading", { name: "Sign in to OpenGeni" }).waitFor({
          timeout: 30_000,
        });
      } catch (error) {
        const signedOutProjection = await sessionSet(page);
        throw new Error(
          `logout-all did not reach neutral sign-in: url=${page.url()} projection=${JSON.stringify({ actorEpoch: signedOutProjection.actorEpoch, generation: signedOutProjection.generation, selected: signedOutProjection.selectedSlotId !== null, slots: signedOutProjection.slots.map(({ displayName, state }) => ({ displayName, state })) })} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
          { cause: error },
        );
      }
      const logoutAllResponseLoss = completionResponseLoss
        ? {
            acceptedAt: completionResponseLoss.acceptedAt,
            attempts: completionResponseLoss.attempts,
            bodyCaptured: completionResponseLoss.firstBody !== null,
            dropped: completionResponseLoss.dropped,
            exactBodies: completionResponseLoss.exactBodies,
            statuses: completionResponseLoss.statuses,
          }
        : null;
      completionResponseLoss = null;
      expect(logoutAllResponseLoss).toEqual(
        expect.objectContaining({
          acceptedAt: expect.any(Number),
          attempts: 2,
          bodyCaptured: true,
          dropped: true,
          exactBodies: [true, true],
          statuses: [200, 200],
        }),
      );
      const terminalAttentionPath = `/v1/workspaces/${beta.workspaceId}/sessions/${beta.sessionId}/attention`;
      await expectAndConsumeActorTransitionResponse(page, pageProblems, {
        acceptedAt: logoutAllResponseLoss!.acceptedAt!,
        actorEpoch: projectionBeforeLogoutAll.actorEpoch,
        method: "PUT",
        pathname: terminalAttentionPath,
        phase: "logout-all-response-loss-replay",
        status: 403,
        statusLabel: "Forbidden",
      });
      const signedOutProjection = await sessionSet(page);
      expect(signedOutProjection).toEqual(
        expect.objectContaining({
          actorEpoch: "1",
          generation: "1",
          selectedSlotId: null,
          slots: [],
          state: "ready",
        }),
      );
      const authorityAfterLogoutAll = (await context.cookies(publicOrigin)).find(
        ({ name }) => name === "opengeni.session_set",
      )?.value;
      expect(authorityAfterLogoutAll).toHaveLength(43);
      expect(authorityAfterLogoutAll).not.toBe(authorityBeforeLogoutAll);
      await secondTab.getByRole("heading", { name: "Sign in to OpenGeni" }).waitFor({
        timeout: 30_000,
      });
      const signedOutSecondTabProjection = await sessionSet(secondTab);
      expect(signedOutSecondTabProjection).toEqual(
        expect.objectContaining({
          actorEpoch: "1",
          generation: "1",
          selectedSlotId: null,
          slots: [],
          state: "ready",
        }),
      );
      const signedOutSecondTabUrl = new URL(secondTab.url());
      expect({
        hash: signedOutSecondTabUrl.hash,
        origin: signedOutSecondTabUrl.origin,
        pathname: signedOutSecondTabUrl.pathname,
        search: signedOutSecondTabUrl.search,
      }).toEqual({ hash: "", origin: publicOrigin, pathname: "/", search: "" });
      const signedOutSecondTabBody = await secondTab.locator("body").innerText();
      for (const tenantValue of [
        alpha.displayName,
        beta.displayName,
        alpha.email,
        beta.email,
        alpha.organizationName,
        beta.organizationName,
        alpha.workspaceId,
        beta.workspaceId,
        alpha.sessionId,
        beta.sessionId,
      ]) {
        expect(signedOutSecondTabBody).not.toContain(tenantValue);
      }
      await Promise.all([
        expectAndConsumeLogoutAllActorFenceResponses(page, pageProblems, {
          acceptedAt: logoutAllResponseLoss!.acceptedAt!,
          actorEpoch: projectionBeforeLogoutAll.actorEpoch,
          workspaceId: beta.workspaceId,
        }),
        expectAndConsumeLogoutAllActorFenceResponses(secondTab, secondTabProblems, {
          acceptedAt: logoutAllResponseLoss!.acceptedAt!,
          actorEpoch: projectionBeforeLogoutAll.actorEpoch,
          workspaceId: beta.workspaceId,
        }),
      ]);
      const logoutAllConfirmedAt = performance.now();
      await Promise.all([
        retirePendingReadsAfterConfirmedLogoutAllAuthorityReset(page, pageProblems, {
          confirmedActorEpoch: signedOutProjection.actorEpoch,
          confirmedAt: logoutAllConfirmedAt,
          logoutAllAcceptedAt: logoutAllResponseLoss!.acceptedAt!,
          oldWorkspaceId: beta.workspaceId,
        }),
        retirePendingReadsAfterConfirmedLogoutAllAuthorityReset(secondTab, secondTabProblems, {
          confirmedActorEpoch: signedOutSecondTabProjection.actorEpoch,
          confirmedAt: logoutAllConfirmedAt,
          logoutAllAcceptedAt: logoutAllResponseLoss!.acceptedAt!,
          oldWorkspaceId: beta.workspaceId,
        }),
      ]);
      setBrowserPhase(pageProblems, "signed-out-settled");
      setBrowserPhase(secondTabProblems, "signed-out-settled");
      setBrowserPhase(otherProblems, "independent-set-after-other-logout-all");
      await otherPage.reload({ waitUntil: "domcontentloaded" });
      await accountMenuTrigger(otherPage, beta.displayName).waitFor();
      expect(otherPage.url()).toContain(beta.workspaceId);

      const [posture] = await owned.admin<
        Array<{
          superuser: boolean;
          bypassRls: boolean;
          setForced: boolean;
          slotForced: boolean;
          operationForced: boolean;
          setDml: boolean;
          slotDml: boolean;
          operationDml: boolean;
        }>
      >`
        select
          (select rolsuper from pg_roles where rolname = 'opengeni_app') as superuser,
          (select rolbypassrls from pg_roles where rolname = 'opengeni_app') as "bypassRls",
          (select relforcerowsecurity from pg_class where oid = 'managed_auth_session_sets'::regclass) as "setForced",
          (select relforcerowsecurity from pg_class where oid = 'managed_auth_login_slots'::regclass) as "slotForced",
          (select relforcerowsecurity from pg_class where oid = 'managed_auth_session_set_operations'::regclass) as "operationForced",
          has_table_privilege('opengeni_app', 'managed_auth_session_sets', 'INSERT,UPDATE,DELETE') as "setDml",
          has_table_privilege('opengeni_app', 'managed_auth_login_slots', 'INSERT,UPDATE,DELETE') as "slotDml",
          has_table_privilege('opengeni_app', 'managed_auth_session_set_operations', 'INSERT,UPDATE,DELETE') as "operationDml"`;
      expect(posture).toEqual({
        superuser: false,
        bypassRls: false,
        setForced: true,
        slotForced: true,
        operationForced: true,
        setDml: false,
        slotDml: false,
        operationDml: false,
      });
      const [secretShape] = await owned.admin<
        Array<{
          rawAuthorityColumns: number;
          rawCsrfColumns: number;
          providerTokenColumns: number;
        }>
      >`
        select
          count(*) filter (where column_name in ('authority', 'authority_token', 'authority_secret'))::int as "rawAuthorityColumns",
          count(*) filter (where column_name in ('csrf', 'csrf_token', 'csrf_secret'))::int as "rawCsrfColumns",
          count(*) filter (where column_name in ('provider_token', 'access_token', 'refresh_token'))::int as "providerTokenColumns"
        from information_schema.columns
        where table_schema = current_schema()
          and table_name like 'managed_auth_%'`;
      expect(secretShape).toEqual({
        rawAuthorityColumns: 0,
        rawCsrfColumns: 0,
        providerTokenColumns: 0,
      });

      await waitForFiniteReadQuiescenceAcross([pageProblems, secondTabProblems, otherProblems]);
      for (const problems of [pageProblems, secondTabProblems, otherProblems]) {
        expect(problems.boundedHttp1StreamDispatches).toBeGreaterThan(0);
      }
      await expectNoBrowserProblems(pageProblems);
      await expectNoBrowserProblems(secondTabProblems);
      await expectNoBrowserProblems(otherProblems);
      await writeFile(
        `${EVIDENCE_DIR}/${engine}-account-acceptance.json`,
        `${JSON.stringify(
          {
            runId: RUN_ID,
            engine,
            productionWebBuild: true,
            sameOrigin: true,
            ownerMigratedPostgres: true,
            restrictedRuntimeRole: "opengeni_app",
            actualBetterAuthUsers: 2,
            tabsInOneBrowserSet: 2,
            finiteReadRetirements: {
              primary: pageProblems.retiredFiniteReads.length,
              secondTab: secondTabProblems.retiredFiniteReads.length,
              independentSet: otherProblems.retiredFiniteReads.length,
            },
            boundedHttp1StreamDispatches: {
              primary: pageProblems.boundedHttp1StreamDispatches,
              secondTab: secondTabProblems.boundedHttp1StreamDispatches,
              independentSet: otherProblems.boundedHttp1StreamDispatches,
            },
            boundedHttp1NativeSeams: {
              primary: pageProblems.boundedHttp1NativeSeams,
              secondTab: secondTabProblems.boundedHttp1NativeSeams,
              independentSet: otherProblems.boundedHttp1NativeSeams,
            },
            sameSetSecondTabNeutralizedAfterLogoutAll: true,
            anotherBrowserSetSurvivedLogoutAll: true,
            screenshots:
              engine === "chromium"
                ? [
                    "chromium-accounts-320-light.png",
                    "chromium-accounts-768-dark.png",
                    "chromium-accounts-1024-light.png",
                    "chromium-accounts-1440-dark.png",
                    "chromium-accounts-forced-colors.png",
                    "chromium-accounts-200-percent-zoom.png",
                    "chromium-accounts-touch-320.png",
                  ]
                : [],
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await context.close().catch(() => undefined);
      await otherBrowserSet.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }, 600_000);
});
