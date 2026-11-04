import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OpenGeniApiError,
  OpenGeniClient,
  type AccessContext,
  type GetWorkspaceCaptureResponse,
  type Session,
  type SessionEvent,
  type WorkspaceCaptureManifest,
} from "@opengeni/sdk";
import { assertScreenshotPainted } from "@opengeni/testing/screenshot";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import { NUMERIC_PERFORMANCE_BUDGETS } from "./workbench-acceptance-contract";
import { isRecord } from "@opengeni/contracts/values";

/** Release acceptance runs this script exactly as committed. Change it here,
 * together with the product, and keep this line unchanged. */
export const workbenchAcceptanceOwnership = "opengeni-workbench-acceptance-source-owned-v1";

const WORKBENCH_CANARY_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:read",
  "files:write",
  "stream:view",
  "stream:acknowledge",
  "terminal:attach",
] as const;
const OBSERVABILITY_PROBE_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
] as const;
const SETTLED = new Set(["idle", "failed", "error", "cancelled"]);
const CHANNEL_A_PATH = /\/sessions\/[^/]+\/(?:fs|git|terminal)\//;
const CAPTURE_FILE_PATH = /\/sessions\/[^/]+\/workspace\/capture\/file$/;
const OPTIONAL_ANALYTICS_CHUNK_PATH = /^\/assets\/analytics-consent-[A-Za-z0-9_-]+\.js$/;
const MANAGED_SESSION_PATH = /^\/v1\/auth\/get-session$/;
const WORKSPACE_SURFACE_SELECTOR = "[data-workspace-surface]";
const CHANGES_LAYOUT_SELECTOR = "[data-workbench-changes-layout]";
const SANDBOX_FILES_VIEWER_SELECTOR = "#sandbox-files-viewer";
const FILE_TREE_READY_SELECTOR =
  '[role="tree"][aria-activedescendant]:not([aria-activedescendant=""])';
const FILE_TREE_MAX_NAVIGATION_STEPS = 4_096;
const FILE_TREE_MAX_DIAGNOSTIC_ROWS = 8;
const FILE_TREE_DIAGNOSTIC_FIELD_LENGTH = 80;
const TERMINAL_SELECTOR = "[data-opengeni-terminal]";
const INTERACTIVE_TERMINAL_SELECTOR =
  '[data-opengeni-terminal][data-opengeni-terminal-status="open"]' +
  '[data-opengeni-terminal-interactive="true"]';
const CAPTURE_API_P95_MS = maximumMillisecondBudget("performance.capture-api-response", "p95");
const CAPTURE_USABLE_WORKBENCH_P95_MS = maximumMillisecondBudget(
  "performance.capture-usable-workbench",
  "p95",
);
const CONTROL_CANCELLATION_WORST_MS = maximumMillisecondBudget(
  "performance.control-cancellation",
  "worst",
);
const shaPattern = /^[0-9a-f]{40}$/;
const runIdPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;

export type LiveAcceptanceArgs = {
  apiUrl: string;
  webUrl: string;
  environment: "staging" | "production";
  sourceSha: string;
  runId: string;
  model: string;
  backend: "modal";
  workspaceId?: string;
  outputDir: string;
  repetitions: number;
  sessionTimeoutMs: number;
  coldTimeoutMs: number;
  captureApiRegionProbeCommand: string;
  captureApiRegion: string;
  captureApiImage: string;
};

export type CaptureApiRegionalProbeRequest = {
  schemaVersion: "opengeni/workbench-capture-api-regional-probe-request/v1";
  apiUrl: string;
  environment: "staging" | "production";
  sourceSha: string;
  runId: string;
  workspaceId: string;
  sessionId: string;
  captureRevision: number;
  captureTurnId: string;
  repetitions: number;
  region: string;
  apiImage: string;
  cookieHeader: string;
};

export type CaptureApiRegionalProbeResult = {
  schemaVersion: "opengeni/workbench-capture-api-regional-probe/v1";
  apiOrigin: string;
  environment: "staging" | "production";
  sourceSha: string;
  runId: string;
  workspaceId: string;
  sessionId: string;
  captureRevision: number;
  captureTurnId: string;
  sampleCount: number;
  region: string;
  apiImage: string;
  decodedBytes: number;
  contentEncoding: "gzip";
  samplesMs: number[];
};

type Check = {
  id: string;
  status: "passed";
  observedAt: string;
  detail: string;
};

type Measurement = {
  sampleCount: number;
  unit: "ms";
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  worst: number;
};

type BrowserRequestFailure = {
  method: string;
  errorText: string;
  path: string;
  resourceType: string;
};

type BrowserProblems = {
  console: string[];
  page: string[];
  failedRequests: BrowserRequestFailure[];
  badResponses: string[];
  channelA: string[];
};

type Artifact = { file: string; sha256: string; sizeBytes: number };

type LiveReceipt = {
  schemaVersion: "opengeni/workbench-live-acceptance/v1";
  generatedAt: string;
  environment: "staging" | "production";
  sourceSha: string;
  runId: string;
  deployment: { apiOrigin: string; webOrigin: string; deploymentRevision: string };
  workspaceId: string;
  sessionId: string;
  captureRevision: number;
  captureStats: WorkspaceCaptureManifest["stats"];
  captureApiRegionProbe: Omit<
    CaptureApiRegionalProbeResult,
    "workspaceId" | "sessionId" | "captureRevision" | "samplesMs"
  >;
  checks: Check[];
  measurements: {
    captureApiResponse: Measurement;
    captureUsableWorkbench: Measurement;
    controlCancellation: Measurement;
  };
  artifacts: Artifact[];
  knownDefects: [];
  failures: [];
};

type ManagedSession = { user?: { id?: unknown; email?: unknown } };

export function parseLiveAcceptanceArgs(argv: string[]): LiveAcceptanceArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? "<missing>"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set([
    "--api-url",
    "--web-url",
    "--environment",
    "--source-sha",
    "--run-id",
    "--model",
    "--backend",
    "--workspace-id",
    "--output-dir",
    "--repetitions",
    "--session-timeout-ms",
    "--cold-timeout-ms",
    "--capture-api-region-probe-command",
    "--capture-api-region",
    "--capture-api-image",
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag ${flag}`);

  const apiUrl = httpsOrigin(required(values, "--api-url"), "--api-url");
  const webUrl = httpsOrigin(required(values, "--web-url"), "--web-url");
  const environment = required(values, "--environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be staging or production");
  }
  const sourceSha = required(values, "--source-sha");
  if (!shaPattern.test(sourceSha)) throw new Error("--source-sha must be a full lowercase SHA");
  const runId = required(values, "--run-id");
  if (!runIdPattern.test(runId)) throw new Error("--run-id must be 3-64 lowercase safe characters");
  const model = required(values, "--model").trim();
  if (!model) throw new Error("--model must not be empty");
  const backend = values.get("--backend") ?? "modal";
  if (backend !== "modal") throw new Error("live workbench acceptance requires --backend modal");
  const repetitions = integer(values.get("--repetitions") ?? "100", "--repetitions", 100);
  const captureApiRegionProbeCommand = required(values, "--capture-api-region-probe-command");
  if (/\0|[\r\n]/.test(captureApiRegionProbeCommand)) {
    throw new Error("--capture-api-region-probe-command is invalid");
  }
  const captureApiRegion = required(values, "--capture-api-region");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(captureApiRegion)) {
    throw new Error("--capture-api-region must be a lowercase deployment region");
  }
  const captureApiImage = required(values, "--capture-api-image");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(captureApiImage)) {
    throw new Error("--capture-api-image must be a digest-pinned image reference");
  }
  return {
    apiUrl,
    webUrl,
    environment,
    sourceSha,
    runId,
    model,
    backend,
    ...(values.get("--workspace-id") ? { workspaceId: values.get("--workspace-id")! } : {}),
    outputDir: resolve(values.get("--output-dir") ?? `.agent/evidence/workbench-${runId}`),
    repetitions,
    sessionTimeoutMs: integer(
      values.get("--session-timeout-ms") ?? "900000",
      "--session-timeout-ms",
      60_000,
    ),
    coldTimeoutMs: integer(
      values.get("--cold-timeout-ms") ?? "900000",
      "--cold-timeout-ms",
      60_000,
    ),
    captureApiRegionProbeCommand: resolve(captureApiRegionProbeCommand),
    captureApiRegion,
    captureApiImage,
  };
}

export function parseProtectedEmails(value: string): ReadonlySet<string> {
  const emails = value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0 || emails.some((email) => !email.includes("@"))) {
    throw new Error("OPENGENI_ACCEPTANCE_PROTECTED_EMAILS must list valid protected accounts");
  }
  return new Set(emails);
}

export function assertDedicatedCanaryEmail(
  actual: unknown,
  expected: string,
  protectedEmails: ReadonlySet<string>,
): string {
  if (typeof actual !== "string" || !actual.includes("@")) {
    throw new Error("managed session did not expose a valid email");
  }
  const normalized = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  if (protectedEmails.has(normalized) || protectedEmails.has(normalizedExpected)) {
    throw new Error("protected manually used account is forbidden for acceptance mutations");
  }
  if (normalized !== normalizedExpected) {
    throw new Error("managed session email does not match the dedicated canary allowlist");
  }
  return normalized;
}

export function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  const cookies = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) throw new Error("acceptance cookie header is malformed");
      return { name: part.slice(0, separator), value: part.slice(separator + 1) };
    });
  if (cookies.length === 0) throw new Error("acceptance cookie header is empty");
  return cookies;
}

async function main(): Promise<void> {
  const args = parseLiveAcceptanceArgs(process.argv.slice(2));
  const productToken = secret("OPENGENI_ACCEPTANCE_PRODUCT_TOKEN");
  const cookieHeader = secret("OPENGENI_ACCEPTANCE_SESSION_COOKIE");
  const expectedEmail = secret("OPENGENI_ACCEPTANCE_EXPECTED_EMAIL");
  const protectedEmails = parseProtectedEmails(secret("OPENGENI_ACCEPTANCE_PROTECTED_EMAILS"));
  const checks: Check[] = [];
  await mkdir(args.outputDir, { recursive: true });

  const health = await getJson<{ deploymentRevision?: unknown; ok?: unknown }>(
    new URL("/healthz", args.apiUrl),
  );
  if (health.ok !== true || health.deploymentRevision !== args.sourceSha) {
    throw new Error("deployment health does not match the exact candidate source SHA");
  }
  pass(checks, "release.exact-source", "API health is bound to the full candidate SHA.");

  const managed = await getJson<ManagedSession>(new URL("/v1/auth/get-session", args.apiUrl), {
    cookie: cookieHeader,
  });
  assertDedicatedCanaryEmail(managed.user?.email, expectedEmail, protectedEmails);
  if (typeof managed.user?.id !== "string" || !managed.user.id) {
    throw new Error("managed session did not expose a stable user id");
  }

  const [cookieAccess, tokenAccess] = await Promise.all([
    getJson<AccessContext>(new URL("/v1/access/me", args.apiUrl), { cookie: cookieHeader }),
    getJson<AccessContext>(new URL("/v1/access/me", args.apiUrl), {
      authorization: `Bearer ${productToken}`,
    }),
  ]);
  const workspaceId = selectWorkspace(args.workspaceId, cookieAccess, tokenAccess);
  assertAcceptancePrincipalScopes(cookieAccess, tokenAccess, workspaceId);
  pass(
    checks,
    "security.auth-preflight",
    "Dedicated cookie and bearer principals resolve to the same allowed workspace and account.",
  );

  const cookieClient = new OpenGeniClient({
    baseUrl: args.apiUrl,
    fetch: retryableIdempotentAcceptanceFetch,
    headers: { cookie: cookieHeader },
  });
  const marker = `OPENGENI_WORKBENCH_${args.runId.replaceAll("-", "_").toUpperCase()}`;
  const session = await cookieClient.createSession(workspaceId, {
    startMode: "realtime",
    model: args.model,
    reasoningEffort: "low",
    sandboxBackend: args.backend,
    sandbox: "new",
    // Acceptance owns its complete execution fixture and must not inherit a
    // mutable workspace-default rig with unrelated setup work.
    rigId: null,
    idempotencyKey: `workbench-acceptance:${args.environment}:${args.sourceSha}:${args.runId}`,
    metadata: {
      origin: "workbench-live-acceptance",
      acceptanceRunId: args.runId,
      acceptanceSourceSha: args.sourceSha,
    },
  });
  const setup = await cookieClient.terminalExec(workspaceId, session.id, {
    command: fixtureSetupScript(marker),
    cwd: "",
    timeoutMs: 60_000,
    emitStream: false,
  });
  if (setup.exitCode !== 0) throw new Error("harness fixture setup failed before the model turn");
  const fixtureAccepted = await cookieClient.sendMessage(workspaceId, session.id, {
    text: fixturePrompt(marker),
    controlEtag: (await cookieClient.getQueue(workspaceId, session.id)).effectiveControl
      .controlEtag,
    clientEventId: "workbench-fixture-edit:" + crypto.randomUUID(),
  });
  const settled = await waitForSettled(
    cookieClient,
    workspaceId,
    session.id,
    args.sessionTimeoutMs,
  );
  if (settled.status !== "idle") {
    throw new Error(`acceptance fixture turn ended in ${settled.status}`);
  }
  const fixtureToolOutputs = await listAllToolOutputEvents(cookieClient, workspaceId, session.id);
  assertFixtureModelPatch(fixtureToolOutputs, marker, fixtureAccepted.id);
  pass(checks, "functional.real-turn", "A real authenticated Modal turn settled successfully.");

  const captureResponse = await waitForCapture(
    cookieClient,
    workspaceId,
    session.id,
    args.sessionTimeoutMs,
  );
  const manifest = await loadManifest(captureResponse);
  assertFixtureCapture(manifest, marker);
  pass(
    checks,
    "functional.capture-content",
    "Capture exactly matches the deterministic ordinary/deep/linked repositories and staged, unstaged, untracked, deleted, renamed, executable, Unicode, symlink, ignored-residue, binary, empty, signed-size, and too-large fixtures.",
  );

  await verifySignedFileExpiry(cookieClient, workspaceId, session.id, manifest);
  pass(
    checks,
    "security.signed-url-expiry-refresh",
    "A signed captured-file URL expired, failed closed, then refreshed through the authenticated API.",
  );

  await waitForCold(cookieClient, workspaceId, session.id, args.coldTimeoutMs);
  pass(
    checks,
    "functional.real-cold-lease",
    "The real Modal lease reached a dormant cold/draining state before UI review.",
  );

  const captureApiRegionProbe = await runCaptureApiRegionalProbe(
    args.captureApiRegionProbeCommand,
    {
      schemaVersion: "opengeni/workbench-capture-api-regional-probe-request/v1",
      apiUrl: args.apiUrl,
      environment: args.environment,
      sourceSha: args.sourceSha,
      runId: args.runId,
      workspaceId,
      sessionId: session.id,
      captureRevision: manifest.revision,
      captureTurnId: manifest.turnId,
      repetitions: args.repetitions,
      region: args.captureApiRegion,
      apiImage: args.captureApiImage,
      cookieHeader,
    },
  );
  const captureApiSamples = captureApiRegionProbe.samplesMs;
  const captureApiResponse = measurement(captureApiSamples);
  if (captureApiResponse.p95 > CAPTURE_API_P95_MS) {
    throw new Error(`capture API p95 ${captureApiResponse.p95}ms exceeds ${CAPTURE_API_P95_MS}ms`);
  }

  const browser = await chromium.launch();
  const artifacts: Artifact[] = [];
  let captureUsableWorkbench: Measurement;
  let controlCancellation: Measurement;
  try {
    const navigationSamples: number[] = [];
    for (let index = 0; index < args.repetitions; index += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installManagedCookies(context, cookieHeader, args.webUrl, args.apiUrl);
      const page = await context.newPage();
      const problems = observePage(page);
      const started = performance.now();
      let navigationFailed = false;
      try {
        await page.goto(sessionUrl(args.webUrl, workspaceId, session.id), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await openWorkspaceIfCollapsed(page);
        await assertChangesDefaultVisible(page);
        navigationSamples.push(performance.now() - started);
        assertNoProblems(problems, true);
      } catch (error) {
        navigationFailed = true;
        // This is the run-owned synthetic canary, never a human conversation.
        // Do not retain cookies, storage state, headers, or a network trace.
        try {
          await writeFile(
            resolve(args.outputDir, "workbench-navigation-failure.json"),
            JSON.stringify(
              {
                schemaVersion: "opengeni/workbench-navigation-failure/v1",
                sampleIndex: index,
                elapsedMs: performance.now() - started,
                path: safePath(page.url()),
                error: error instanceof Error ? error.message : String(error),
                problems,
              },
              null,
              2,
            ) + "\n",
          );
        } catch {
          console.error("Could not retain workbench navigation failure metadata.");
        }
        try {
          await page.screenshot({
            path: resolve(args.outputDir, "workbench-navigation-failure.png"),
            fullPage: true,
            timeout: 5_000,
          });
        } catch {
          console.error("Could not retain workbench navigation failure screenshot.");
        }
        throw error;
      } finally {
        await context.close().catch((error: unknown) => {
          if (!navigationFailed) throw error;
          console.error("Could not close the failed workbench navigation context.");
        });
      }
    }
    captureUsableWorkbench = measurement(navigationSamples);
    if (captureUsableWorkbench.p95 > CAPTURE_USABLE_WORKBENCH_P95_MS) {
      throw new Error(
        `capture-backed usable workbench p95 ${captureUsableWorkbench.p95}ms exceeds ${CAPTURE_USABLE_WORKBENCH_P95_MS}ms`,
      );
    }

    for (const device of [
      { name: "desktop", width: 1440, height: 960, mobile: false },
      { name: "mobile", width: 390, height: 844, mobile: true },
    ]) {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        isMobile: device.mobile,
        hasTouch: device.mobile,
      });
      await installManagedCookies(context, cookieHeader, args.webUrl, args.apiUrl);
      const page = await context.newPage();
      const problems = observePage(page);
      await page.goto(sessionUrl(args.webUrl, workspaceId, session.id), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await openWorkspaceIfCollapsed(page);
      await assertChangesDefaultVisible(page);
      await assertColdReview(page, marker);
      await assertAccessibility(page);
      await assertTouchTargets(page, device.mobile);
      const filesScreenshot = resolve(args.outputDir, `${device.name}-cold-files.png`);
      const filesPng = await page
        .locator("[data-workspace-surface]")
        .screenshot({ path: filesScreenshot });
      await assertScreenshotPainted(page, filesPng, `${device.name} cold Files`);
      artifacts.push(await artifact(filesScreenshot, args.outputDir));

      await selectChangesTab(page);
      await assertAccessibility(page);
      await assertTouchTargets(page, device.mobile);
      assertNoProblems(problems, true);
      const screenshot = resolve(args.outputDir, `${device.name}-cold-changes.png`);
      const changesPng = await page
        .locator("[data-workspace-surface]")
        .screenshot({ path: screenshot });
      await assertScreenshotPainted(page, changesPng, `${device.name} cold Changes`);
      artifacts.push(await artifact(screenshot, args.outputDir));
      await context.close();
    }

    const afterPassiveBrowser = await cookieClient.getStreamCapabilities(workspaceId, session.id);
    if (!isDormantSandboxLiveness(afterPassiveBrowser.liveness)) {
      throw new Error("passive browser acceptance unexpectedly warmed the sandbox");
    }
    pass(
      checks,
      "functional.capture-cold-zero-channel-a",
      "Fresh desktop/mobile browsers rendered capture-backed Changes and Files with zero Channel-A requests and left the lease dormant.",
    );

    const liveFlow = await runLiveWorkspaceFlow({
      browser,
      cookieHeader,
      client: cookieClient,
      args,
      workspaceId,
      sessionId: session.id,
      marker,
      checks,
      artifacts,
    });
    controlCancellation = measurement(liveFlow.controlCancellationSamples);
    await cleanupControlFixtures(cookieClient, workspaceId, session.id);
  } finally {
    await browser.close();
  }
  pass(checks, "accessibility.automated", "Desktop and mobile live surfaces pass axe WCAG 2.2 AA.");
  pass(checks, "accessibility.touch-targets", "All visible mobile controls are at least 44px.");

  const receipt: LiveReceipt = {
    schemaVersion: "opengeni/workbench-live-acceptance/v1",
    generatedAt: new Date().toISOString(),
    environment: args.environment,
    sourceSha: args.sourceSha,
    runId: args.runId,
    deployment: {
      apiOrigin: new URL(args.apiUrl).origin,
      webOrigin: new URL(args.webUrl).origin,
      deploymentRevision: args.sourceSha,
    },
    workspaceId,
    sessionId: session.id,
    captureRevision: manifest.revision,
    captureStats: manifest.stats,
    captureApiRegionProbe: {
      schemaVersion: captureApiRegionProbe.schemaVersion,
      apiOrigin: captureApiRegionProbe.apiOrigin,
      environment: captureApiRegionProbe.environment,
      sourceSha: captureApiRegionProbe.sourceSha,
      runId: captureApiRegionProbe.runId,
      captureTurnId: captureApiRegionProbe.captureTurnId,
      sampleCount: captureApiRegionProbe.sampleCount,
      region: captureApiRegionProbe.region,
      apiImage: captureApiRegionProbe.apiImage,
      decodedBytes: captureApiRegionProbe.decodedBytes,
      contentEncoding: captureApiRegionProbe.contentEncoding,
    },
    checks,
    measurements: { captureApiResponse, captureUsableWorkbench, controlCancellation },
    artifacts,
    knownDefects: [],
    failures: [],
  };
  const receiptPath = resolve(args.outputDir, "workbench-live-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const receiptArtifact = await artifact(receiptPath, args.outputDir);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", receipt: receiptPath, sha256: receiptArtifact.sha256 })}\n`,
  );
}

function maximumMillisecondBudget(requirementId: string, statistic: "p95" | "worst"): number {
  const budget = NUMERIC_PERFORMANCE_BUDGETS[requirementId];
  if (
    !budget ||
    budget.direction !== "maximum" ||
    budget.unit !== "ms" ||
    budget.statistic !== statistic
  ) {
    throw new Error(`missing maximum millisecond budget for ${requirementId}`);
  }
  return budget.limit;
}

export function fixtureSetupScript(marker: string): string {
  const script = String.raw`set -euo pipefail
# opengeni-acceptance-fixture-empty-path-guard-v1
for path in api web web-linked nested; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf 'acceptance fixture path already exists: %s\n' "$path" >&2
    exit 1
  fi
done
mkdir -p api web nested/deep/repo
git -C api init -q
git -C api config user.email canary@opengeni.dev
git -C api config user.name "Opengeni Acceptance"
git -C api config commit.gpgsign false
printf 'node_modules/\ndist/\n' > api/.gitignore
printf 'export const marker = "BASE";\nexport const status = 200;\n' > api/server.ts
printf 'tracked but untouched\n' > api/base.txt
printf '#!/bin/sh\necho base\n' > api/run.sh
chmod +x api/run.sh
git -C api add -A
git -C api commit -q -m base
printf 'untracked ${marker}\n' > api/notes.txt
: > api/empty.txt
printf '\000\001\376\377' > api/binary.dat
head -c 307200 /dev/zero | tr '\000' s > api/signed-preview.txt
head -c 6291456 /dev/zero > api/too-large.bin
printf '#!/bin/sh\necho ${marker}\n' > api/run.sh
chmod +x api/run.sh
unicode_path=$(printf 'api/\303\274ber \316\273.txt')
printf 'unicode ${marker}\n' > "$unicode_path"
ln -s server.ts api/server-link.ts
printf 'outside secret must never be captured\n' > '/tmp/opengeni-${marker}'
ln -s '/tmp/opengeni-${marker}' api/external-link
mkdir -p '/tmp/opengeni-dir-${marker}'
ln -s '/tmp/opengeni-dir-${marker}' api/external-dir
mkdir -p api/node_modules api/dist
printf 'ignored dependency residue\n' > api/node_modules/ignored.js
printf 'ignored build residue\n' > api/dist/ignored.js

git -C web init -q
git -C web config user.email canary@opengeni.dev
git -C web config user.name "Opengeni Acceptance"
git -C web config commit.gpgsign false
printf 'console.log("base");\n' > web/app.js
printf 'rename me\n' > web/old-name.txt
printf 'delete me\n' > web/deleted.txt
git -C web add -A
git -C web commit -q -m base
git -C web worktree add -q ../web-linked -b acceptance-linked
printf 'linked ${marker}\n' > web-linked/worktree-marker.txt
git -C web mv old-name.txt renamed.txt
git -C web rm -q deleted.txt
printf 'console.log("staged");\n' > web/app.js
git -C web add app.js
printf 'console.log("staged and unstaged ${marker}");\n' > web/app.js

git -C nested/deep/repo init -q
git -C nested/deep/repo config user.email canary@opengeni.dev
git -C nested/deep/repo config user.name "Opengeni Acceptance"
git -C nested/deep/repo config commit.gpgsign false
printf 'deep base\n' > nested/deep/repo/deep.txt
git -C nested/deep/repo add -A
git -C nested/deep/repo commit -q -m base
printf 'deep ${marker}\n' > nested/deep/repo/deep.txt

printf '%s\n' '${marker}'
git -C api status --porcelain
git -C web status --porcelain
git -C web-linked status --porcelain
git -C nested/deep/repo status --porcelain`;
  return script;
}

// opengeni-harness-owned-model-fixture-v1
const fixtureInspectionCommands = [
  "pwd; rg --files -g AGENTS.md -g server.ts -g '!node_modules' -g '!vendor'",
  "ls -la /workspace/AGENTS.md /workspace/api/AGENTS.md; cat api/server.ts",
] as const;

export function fixturePrompt(marker: string): string {
  return [
    "The acceptance harness has prepared deterministic test repositories in the workspace.",
    "If you need to inspect paths, repository instructions or the initial file before editing, use only these read-only commands (each at most once): " +
      fixtureInspectionCommands.map((command) => JSON.stringify(command)).join(" or ") +
      ". Do not run other preliminary commands.",
    "Use the apply_patch tool to update only api/server.ts: replace the marker BASE with " +
      marker +
      " and status 200 with 204. Preserve the two lines and final newline exactly.",
    "Then run a read-only terminal command: cat api/server.ts. The file must contain the exact marker. Do not use shell writes, regenerate the fixture, commit, or modify other files. Stop after verification.",
  ].join("\n");
}

export async function readFixtureEventPage(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  after: number,
) {
  const page = await client.listEventPage(workspaceId, sessionId, {
    after,
    limit: 500,
    mode: "forensic",
    payloadMode: "full",
    direction: "after",
  });
  if (
    page.mode !== "forensic" ||
    page.payloadMode !== "full" ||
    page.direction !== "after" ||
    page.forensicExact !== true ||
    typeof page.hasMore !== "boolean"
  )
    throw new Error("fixture history requires exact full forensic pages");
  let last = after;
  for (const event of page.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= last)
      throw new Error("fixture history page is not strictly advancing");
    last = event.sequence;
  }
  const nextAfter = page.nextAfter ?? after;
  if (
    !Number.isSafeInteger(nextAfter) ||
    nextAfter < last ||
    (page.hasMore && nextAfter <= after)
  ) {
    throw new Error("fixture history continuation is missing or non-advancing");
  }
  return { ...page, nextAfter };
}

export function assertFixtureModelPatch(
  events: readonly SessionEvent[],
  marker: string,
  acceptedEventId: string,
): void {
  const accepted = events.find(
    (event) => event.id === acceptedEventId && event.type === "user.message",
  );
  if (!accepted) throw new Error("fixture accepted user message is absent from canonical events");
  const started = events.filter(
    (event) =>
      event.type === "turn.started" &&
      event.sequence > accepted.sequence &&
      (event.payload as any)?.triggerEventId === acceptedEventId,
  );
  if (started.length !== 1 || !started[0]!.turnId || !started[0]!.turnAttemptId) {
    throw new Error("fixture model turn identity is absent or ambiguous");
  }
  const turn = started[0]!;
  const owned = events.filter(
    (event) =>
      event.turnId === turn.turnId &&
      event.turnAttemptId === turn.turnAttemptId &&
      event.sequence > turn.sequence,
  );
  const completed = owned.filter((event) => event.type === "turn.completed");
  if (completed.length !== 1) throw new Error("fixture model turn did not complete uniquely");
  // A correct final read is not authorship proof. Permit only bounded, exact
  // read-only inspection before the patch, then the patch and its final read.
  // This is not a generic shell-read classifier: every other call still fails.
  const calls = events
    .filter(
      (event) =>
        event.type === "agent.toolCall.created" &&
        event.sequence > turn.sequence &&
        event.sequence < completed[0]!.sequence,
    )
    .sort((a, b) => a.sequence - b.sequence);
  if (
    calls.length < 2 ||
    calls.length > 2 + fixtureInspectionCommands.length ||
    calls.some(
      (call) =>
        call.turnId !== turn.turnId ||
        call.turnAttemptId !== turn.turnAttemptId ||
        typeof (call.payload as any)?.id !== "string" ||
        !(call.payload as any).id,
    ) ||
    new Set(calls.map((call) => (call.payload as any).id)).size !== calls.length
  ) {
    throw new Error("fixture contains extra or unowned mutation-capable calls");
  }
  const argsOf = (call: SessionEvent): any => {
    const args = (call.payload as any)?.arguments;
    if (typeof args !== "string") return args;
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  };
  const outputOf = (call: SessionEvent): SessionEvent | undefined => {
    const outputs = events.filter(
      (event) =>
        event.type === "agent.toolCall.output" &&
        event.sequence > call.sequence &&
        event.sequence < completed[0]!.sequence &&
        (event.payload as any)?.id === (call.payload as any)?.id,
    );
    return outputs.length === 1 &&
      outputs[0]!.turnId === turn.turnId &&
      outputs[0]!.turnAttemptId === turn.turnAttemptId
      ? outputs[0]
      : undefined;
  };
  const patch = calls.at(-2)!;
  const inspections = calls.slice(0, -2);
  const inspectedCommands = new Set<string>();
  for (let index = 0; index < inspections.length; index += 1) {
    const inspection = inspections[index]!;
    const args = argsOf(inspection);
    const output = outputOf(inspection);
    const next = inspections[index + 1] ?? patch;
    if (
      (inspection.payload as any)?.name !== "exec_command" ||
      !fixtureInspectionCommands.some((command) => args?.cmd === command) ||
      inspectedCommands.has(args.cmd) ||
      args.shell != null ||
      ![undefined, null, "", "/workspace"].includes(args.workdir) ||
      ![undefined, null, false].includes(args.login) ||
      ![undefined, null, false].includes(args.tty) ||
      !Object.keys(args).every((key) =>
        ["cmd", "workdir", "shell", "login", "tty", "yield_time_ms", "max_output_tokens"].includes(
          key,
        ),
      ) ||
      !output ||
      output.sequence >= next.sequence ||
      typeof (output.payload as any)?.output !== "string" ||
      !/^Process exited with code 0$/mu.test((output.payload as any).output) ||
      /^Process running with session ID|^Command ID:/mu.test((output.payload as any).output)
    ) {
      throw new Error(
        "fixture contains extra or unowned mutation-capable calls: invalid pre-patch inspection",
      );
    }
    inspectedCommands.add(args.cmd);
  }
  const patchArgs = argsOf(patch);
  const patchOutput = outputOf(patch);
  const before = 'export const marker = "BASE";\nexport const status = 200;\n';
  const expected = 'export const marker = "' + marker + '";\nexport const status = 204;\n';
  // Parse the bounded two-line patch grammar. Filenames in hunk content,
  // additions/deletions/moves, extra targets, and partial/context-only edits
  // cannot attest the requested transition. Both native path forms are valid.
  const lines: string[] =
    typeof patchArgs?.patch === "string" ? patchArgs.patch.replace(/\n$/, "").split("\n") : [];
  const hunk = lines.slice(3, -1);
  const patchValid =
    patchArgs &&
    Object.keys(patchArgs).length === 1 &&
    lines[0] === "*** Begin Patch" &&
    ["*** Update File: api/server.ts", "*** Update File: /workspace/api/server.ts"].includes(
      lines[1]!,
    ) &&
    lines[2] === "@@" &&
    lines.at(-1) === "*** End Patch" &&
    hunk.length > 0 &&
    hunk.every((line) => /^[ +-]/.test(line)) &&
    hunk
      .filter((line) => line[0] !== "+")
      .map((line) => line.slice(1) + "\n")
      .join("") === before &&
    hunk
      .filter((line) => line[0] !== "-")
      .map((line) => line.slice(1) + "\n")
      .join("") === expected;
  if (
    (patch.payload as any)?.name !== "apply_patch" ||
    !patchValid ||
    !patchOutput ||
    (patchOutput.payload as any)?.output !== "Patch applied."
  ) {
    throw new Error("fixture lacks successful apply_patch proof owned by its accepted model turn");
  }
  const read = calls.at(-1)!;
  const args = argsOf(read);
  const result = (outputOf(read)?.payload as any)?.output;
  const verified =
    (read.payload as any)?.name === "exec_command" &&
    read.sequence > patchOutput.sequence &&
    args?.cmd === "cat api/server.ts" &&
    args.shell == null &&
    [undefined, null, "", "/workspace"].includes(args.workdir) &&
    Object.keys(args).every((key) =>
      ["cmd", "workdir", "shell", "login", "tty", "yield_time_ms", "max_output_tokens"].includes(
        key,
      ),
    ) &&
    typeof result === "string" &&
    /^Process exited with code 0$/mu.test(result) &&
    result.endsWith("Output:\n" + expected);
  if (!verified) throw new Error("fixture lacks successful read-only verification after its patch");
}
export function fixtureShellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function controlFixtureProgram(
  marker: string,
  mode: "steer" | "pause",
  iteration: number,
): string {
  if (
    !/^OPENGENI_WORKBENCH_[A-Z0-9_]+$/.test(marker) ||
    !Number.isSafeInteger(iteration) ||
    iteration < 0
  ) {
    throw new Error("invalid owned control fixture identity");
  }
  if (mode !== "steer" && mode !== "pause") throw new Error("invalid control fixture mode");
  const controlMarker =
    mode === "steer" ? "CONTROL_READY_" + marker + "_" + iteration : "PAUSE_READY_" + marker;
  const zombiePath =
    mode === "steer"
      ? "steer-stress/zombie-" + iteration + ".txt"
      : "pause-stress/zombie-pause.txt";
  // Steer returns control and leaves an agent-started command running as a
  // session background command (Modal adopts every agent exec, including bare
  // shells). Physically stopping a hostile process is Pause's job, so only the
  // Pause program ignores INT/TERM and writes a delayed zombie artifact. The
  // Steer program stays active until the harness releases it after the Steer
  // (bounded at 120s), so the model's wait is still running when the harness
  // steers. It writes nothing except consuming the harness release file.
  if (mode === "steer") {
    const release = fixtureShellQuote(controlFixtureReleasePath(marker, iteration));
    return [
      "#!/bin/bash",
      "set -euo pipefail",
      "# Harness-owned Steer test: waits (bounded) for the harness release file and writes nothing.",
      "test ! -e " + fixtureShellQuote(zombiePath),
      "test ! -L " + fixtureShellQuote(zombiePath),
      'test "$(find steer-stress -type f | wc -l)" -ge 4350',
      "printf '%s\\n' " + fixtureShellQuote(controlMarker),
      "for _ in $(seq 1 240); do",
      "  if [ -f " +
        release +
        " ] && [ ! -L " +
        release +
        " ]; then rm -f -- " +
        release +
        "; exit 0; fi",
      "  sleep 0.5",
      "done",
      "",
    ].join("\n");
  }
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "# Harness-owned cancellation test: the delayed artifact detects a surviving process.",
    "if mkdir pause-stress/claimed 2>/dev/null; then",
    "printf '%s\\n' " + fixtureShellQuote(controlMarker),
    "trap '' INT TERM",
    "sleep 30",
    "printf zombie > " + fixtureShellQuote(zombiePath),
    "else",
    "printf '%s\\n' " + fixtureShellQuote("PAUSE_RESUMED_SAFE_" + marker),
    "fi",
    "",
  ].join("\n");
}

export function controlFixtureSetup(
  marker: string,
  mode: "steer" | "pause",
  iteration: number,
): { command: string; terminalCommand: string; path: string } {
  const program = controlFixtureProgram(marker, mode, iteration);
  const directory = mode + "-stress/.opengeni-acceptance-" + marker + "-" + iteration;
  const path = directory + "/control-test.sh";
  const quotedPath = fixtureShellQuote(path);
  const command = [
    "set -euo pipefail",
    ...(mode === "steer" && iteration === 0
      ? [
          "test ! -e steer-stress && test ! -L steer-stress",
          "mkdir steer-stress",
          'for d in $(seq 1 150); do mkdir "steer-stress/d$d"; for f in $(seq 1 29); do : > "steer-stress/d$d/f$f.ts"; done; done',
        ]
      : mode === "pause"
        ? ["test ! -e pause-stress && test ! -L pause-stress", "mkdir pause-stress"]
        : []),
    "test -d " +
      fixtureShellQuote(mode + "-stress") +
      " && test ! -L " +
      fixtureShellQuote(mode + "-stress"),
    // mkdir is intentionally exclusive: no existing path (even identical bytes)
    // is adopted or overwritten, and no broad cleanup is permitted.
    "mkdir -m 700 " + fixtureShellQuote(directory),
    "printf '%s' " + fixtureShellQuote(program) + " > " + quotedPath,
    "chmod 500 " + quotedPath,
    'test "$(sha256sum ' +
      quotedPath +
      " | cut -d ' ' -f 1)\" = " +
      fixtureShellQuote(createHash("sha256").update(program).digest("hex")),
  ].join("\n");
  return { command, terminalCommand: "bash " + quotedPath, path };
}

const installedControlFixtures = new Map<
  string,
  { workspaceId: string; sessionId: string; digest: string }
>();

export async function cleanupControlFixtures(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  for (const [path, owner] of installedControlFixtures) {
    if (owner.workspaceId !== workspaceId || owner.sessionId !== sessionId) continue;
    const directory = path.slice(0, path.lastIndexOf("/"));
    const quoted = fixtureShellQuote(path);
    const command = [
      "set -euo pipefail",
      "test ! -L " + fixtureShellQuote(path.split("/")[0]!),
      "if [ ! -e " +
        fixtureShellQuote(directory) +
        " ] && [ ! -L " +
        fixtureShellQuote(directory) +
        " ]; then exit 0; fi",
      "test ! -L " + fixtureShellQuote(directory),
      "test ! -L " + quoted,
      'test "$(sha256sum ' + quoted + " | cut -d ' ' -f 1)\" = " + fixtureShellQuote(owner.digest),
      'test "$(find ' + fixtureShellQuote(directory) + ' -mindepth 1 -maxdepth 1 | wc -l)" -eq 1',
      "rm -- " + quoted,
      "rmdir -- " + fixtureShellQuote(directory),
    ].join("\n");
    const result = await client.terminalExec(workspaceId, sessionId, {
      command,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    if (result.exitCode !== 0)
      throw new Error("owned control fixture cleanup refused changed bytes or extra paths");
    installedControlFixtures.delete(path);
  }
}

export async function installControlFixture(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  marker: string,
  mode: "steer" | "pause",
  iteration: number,
): Promise<string> {
  const fixture = controlFixtureSetup(marker, mode, iteration);
  const result = await client.terminalExec(workspaceId, sessionId, {
    command: fixture.command,
    cwd: "",
    timeoutMs: 60_000,
    emitStream: false,
  });
  if (result.exitCode !== 0)
    throw new Error("could not install the exclusive harness-owned control fixture");
  installedControlFixtures.set(fixture.path, {
    workspaceId,
    sessionId,
    digest: createHash("sha256")
      .update(controlFixtureProgram(marker, mode, iteration))
      .digest("hex"),
  });
  return fixture.terminalCommand;
}

// The harness release file for one Steer test command. It lives beside the
// test tree, outside the exact-owner fixture directory, and the test command
// consumes it.
export function controlFixtureReleasePath(marker: string, iteration: number): string {
  if (
    !/^OPENGENI_WORKBENCH_[A-Z0-9_]+$/.test(marker) ||
    !Number.isSafeInteger(iteration) ||
    iteration < 0
  ) {
    throw new Error("invalid owned control fixture identity");
  }
  return "steer-stress/.opengeni-release-" + marker + "-" + iteration;
}

export async function releaseSteerControlFixture(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  marker: string,
  iteration: number,
): Promise<void> {
  const release = fixtureShellQuote(controlFixtureReleasePath(marker, iteration));
  const result = await client.terminalExec(workspaceId, sessionId, {
    command: [
      "set -euo pipefail",
      "test -d steer-stress && test ! -L steer-stress",
      "test ! -L " + release,
      ": > " + release,
    ].join("\n"),
    cwd: "",
    timeoutMs: 20_000,
    emitStream: false,
  });
  if (result.exitCode !== 0)
    throw new Error("could not release the harness-owned Steer test command");
}

// The session page persists drafts, so its Steer (Cmd/Ctrl+Enter or the Steer
// button) submits the draft with delivery "steer"; hosts without durable
// drafts call /steer directly. Both return the same accepted Steer receipt.
export function isLiveSteerSubmission(
  response: { url(): string; request(): { method(): string; postDataJSON(): unknown } },
  workspaceId: string,
  sessionId: string,
): boolean {
  if (response.request().method() !== "POST") return false;
  const base =
    "/v1/workspaces/" +
    encodeURIComponent(workspaceId) +
    "/sessions/" +
    encodeURIComponent(sessionId);
  let path: string;
  try {
    path = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  if (path === base + "/steer") return true;
  if (path !== base + "/composer-draft/submit") return false;
  try {
    return (response.request().postDataJSON() as any)?.delivery === "steer";
  } catch {
    return false;
  }
}

const controlSettledStatuses = new Set(["idle", "failed", "error", "cancelled"]);

// Steer hands over at the predecessor's next model step: the running model
// request is cut short, long waits return early with their handle, and the
// turn settles itself as turn.superseded (reason steer, atModelStep) followed
// by its queued status, with no attempt interruption. That settlement is the
// predecessor's last authoritative event. A hard interruption still ends with
// the attempt_quiesced queue receipt. Both are accepted as the Steer fence.
function controlPayload(event: SessionEvent): any {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function isSteerHandoverSupersede(event: SessionEvent, turnId: string, attemptId: string): boolean {
  const payload = controlPayload(event);
  return (
    event.type === "turn.superseded" &&
    event.turnId === turnId &&
    event.turnAttemptId === attemptId &&
    payload.reason === "steer" &&
    payload.atModelStep === true
  );
}

export function steerPredecessorSettlement(
  turnId: string,
  attemptId: string,
): (event: SessionEvent) => boolean {
  let handedOver = false;
  return (event: SessionEvent): boolean => {
    if (event.turnId !== turnId || event.turnAttemptId !== attemptId) return false;
    const payload = controlPayload(event);
    if (event.type === "session.queue.changed")
      return payload.operation === "attempt_quiesced" && payload.attemptId === attemptId;
    if (isSteerHandoverSupersede(event, turnId, attemptId)) {
      handedOver = true;
      return false;
    }
    return handedOver && event.type === "session.status.changed" && payload.status === "queued";
  };
}

export function isSteerHandoverSettlement(event: SessionEvent): boolean {
  return event.type === "session.status.changed" && controlPayload(event).status === "queued";
}

function isSteerHandoverFence(
  events: readonly SessionEvent[],
  quiesced: SessionEvent,
  control: SessionEvent,
): boolean {
  if (!isSteerHandoverSettlement(quiesced) || !quiesced.turnId || !quiesced.turnAttemptId)
    return false;
  const supersedes = events.filter(
    (event) =>
      event.turnId === quiesced.turnId &&
      event.turnAttemptId === quiesced.turnAttemptId &&
      event.type === "turn.superseded",
  );
  return (
    supersedes.length === 1 &&
    isSteerHandoverSupersede(supersedes[0]!, quiesced.turnId, quiesced.turnAttemptId) &&
    supersedes[0]!.sequence > control.sequence &&
    supersedes[0]!.sequence < quiesced.sequence &&
    !events.some(
      (event) =>
        event.turnId === quiesced.turnId &&
        event.turnAttemptId === quiesced.turnAttemptId &&
        event.sequence > supersedes[0]!.sequence &&
        event.sequence < quiesced.sequence,
    )
  );
}

// Steer only means something while the predecessor turn still runs. Wait until
// the API reports that exact turn active and the composer offers Steer as its
// Cmd/Ctrl+Enter choice; fail clearly if the turn already ended.
export async function assertSteerablePredecessor(
  client: Pick<OpenGeniClient, "getSession">,
  page: { locator(selector: string): any },
  workspaceId: string,
  sessionId: string,
  predecessorTurnId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session: any = await client.getSession(workspaceId, sessionId);
    const activeTurnId = typeof session.activeTurnId === "string" ? session.activeTurnId : null;
    if (
      controlSettledStatuses.has(session.status) ||
      (activeTurnId !== null && activeTurnId !== predecessorTurnId)
    ) {
      throw new Error(
        "the Steer target turn ended before the harness could Steer (session " +
          String(session.status) +
          ", active turn " +
          String(activeTurnId ?? "none") +
          ")",
      );
    }
    const alternate = page.locator("[data-og-composer-alternate-send]");
    const alternateSend: string | null =
      (await alternate.count()) === 1 && (await alternate.isVisible())
        ? await alternate.getAttribute("data-analytics-action")
        : null;
    if (alternateSend === "queue") {
      throw new Error(
        "the composer offers Queue as its Cmd/Ctrl+Enter choice (busy Send steers), so the keyboard cannot Steer",
      );
    }
    if (activeTurnId === predecessorTurnId && alternateSend === "steer") return;
    if (Date.now() >= deadline) {
      throw new Error(
        "the composer did not offer Steer for the running predecessor (session " +
          String(session.status) +
          ", active turn " +
          String(activeTurnId ?? "none") +
          ", composer choice " +
          String(alternateSend ?? "none") +
          ")",
      );
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
}

function clipControlDiagnostic(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return value;
  return text.slice(0, max) + "...[truncated " + (text.length - max) + " chars]";
}

export function compactControlDiagnosticEvent(event: SessionEvent): Record<string, unknown> {
  const payload: any =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : {};
  const out: Record<string, unknown> = {
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt,
    turnId: event.turnId ?? null,
    turnAttemptId: event.turnAttemptId ?? null,
  };
  for (const key of [
    "name",
    "id",
    "operation",
    "status",
    "attemptId",
    "replacedTurnId",
    "targetTurnId",
    "triggerEventId",
    "reason",
    "code",
  ]) {
    if (typeof payload[key] === "string") out[key] = clipControlDiagnostic(payload[key], 300);
  }
  if (payload.arguments !== undefined)
    out.arguments = clipControlDiagnostic(payload.arguments, 1_000);
  if (payload.output !== undefined) out.output = clipControlDiagnostic(payload.output, 1_500);
  if (typeof payload.text === "string") out.text = clipControlDiagnostic(payload.text, 1_500);
  if (payload.error !== undefined) out.error = clipControlDiagnostic(payload.error, 1_000);
  return out;
}

// Failure evidence for the run-owned synthetic control session: compact
// events, session and composer state, and a screenshot. No cookies, storage
// or network traces. Never masks the original error.
/** A Pause stopping state can only render once the page holds a queue snapshot
 * with stoppingPreviousAttempt. The client learns it from a debounced queue
 * refetch, so a fast physical stop can settle before the page ever sees it.
 * Require the rendered state only when the page received such a snapshot with
 * enough lead before the observation ended; otherwise record that the state
 * was not observable in the window. */
export const STOPPING_SNAPSHOT_RENDER_LEAD_MS = 300;
/** Beyond this physical stop time the page must have reconciled the queue
 * after Pause (debounce plus round trip fit comfortably), so a client that
 * never refetches cannot pass silently. */
export const PAUSE_QUEUE_RECONCILE_REQUIRED_AFTER_MS = 1_000;
export function observeStoppingQueueSnapshots(
  page: Pick<Page, "on" | "off">,
  workspaceId: string,
  sessionId: string,
) {
  const path =
    "/v1/workspaces/" +
    encodeURIComponent(workspaceId) +
    "/sessions/" +
    encodeURIComponent(sessionId) +
    "/queue";
  const pending: Promise<void>[] = [];
  let snapshots = 0;
  let firstStoppingAt: number | null = null;
  let firstPausedAt: number | null = null;
  const listener = (response: any) => {
    try {
      if (
        response.request().method() !== "GET" ||
        new URL(response.url()).pathname !== path ||
        !response.ok()
      )
        return;
    } catch {
      return;
    }
    const receivedAt = Date.now();
    pending.push(
      (async () => {
        try {
          const body: any = await response.json();
          snapshots += 1;
          if (
            body?.stoppingPreviousAttempt === true &&
            (firstStoppingAt === null || receivedAt < firstStoppingAt)
          )
            firstStoppingAt = receivedAt;
          if (
            body?.effectiveControl?.state === "paused" &&
            (firstPausedAt === null || receivedAt < firstPausedAt)
          )
            firstPausedAt = receivedAt;
        } catch {}
      })(),
    );
  };
  page.on("response", listener);
  return {
    async stop(observationEndedAt: number) {
      page.off("response", listener);
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((wake) => setTimeout(wake, 2_000)),
      ]);
      const leadMs = firstStoppingAt === null ? null : observationEndedAt - firstStoppingAt;
      const pausedReconciled = firstPausedAt !== null && firstPausedAt <= observationEndedAt;
      return {
        snapshots,
        stoppingSnapshotLeadMs: leadMs,
        renderRequired: leadMs !== null && leadMs >= STOPPING_SNAPSHOT_RENDER_LEAD_MS,
        pausedReconciled,
      };
    },
  };
}

export async function writeControlFailureDiagnostics(input: {
  client: OpenGeniClient;
  page: Page;
  workspaceId: string;
  sessionId: string;
  afterSequence: number;
  outputDir: string;
  error: unknown;
}): Promise<void> {
  const { client, page, workspaceId, sessionId, afterSequence, outputDir } = input;
  const diagnostics: Record<string, unknown> = {
    schemaVersion: "opengeni/workbench-control-failure/v1",
    recordedAt: new Date().toISOString(),
    error: clipControlDiagnostic(
      input.error instanceof Error ? input.error.message : String(input.error),
      2_000,
    ),
    afterSequence,
  };
  // After a full Steer loop the session holds thousands of events; read only
  // the recent tail so the bounded diagnostics window is not spent paging.
  let eventsAfter = afterSequence;
  try {
    const session: any = await client.getSession(workspaceId, sessionId);
    diagnostics.session = {
      status: session.status,
      activeTurnId: session.activeTurnId ?? null,
      lastSequence: session.lastSequence,
    };
    if (typeof session.lastSequence === "number")
      eventsAfter = Math.max(afterSequence, session.lastSequence - 1_500);
  } catch (error) {
    diagnostics.sessionError = clipControlDiagnostic(String(error), 500);
  }
  try {
    const queue: any = await client.getQueue(workspaceId, sessionId);
    diagnostics.control = { state: queue.effectiveControl?.state ?? null };
  } catch (error) {
    diagnostics.controlError = clipControlDiagnostic(String(error), 500);
  }
  try {
    diagnostics.ui = await page.evaluate(() => {
      const text = (node: Element | null, max: number) =>
        node ? (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, max) : null;
      const alternate = document.querySelector("[data-og-composer-alternate-send]");
      return {
        path: location.pathname,
        composerChoice: alternate ? alternate.getAttribute("data-analytics-action") : null,
        pauseOffered: Array.from(document.querySelectorAll("button")).some(
          (button) => button.getAttribute("aria-label") === "Pause this workstream",
        ),
        resumeOffered: Array.from(document.querySelectorAll("button")).some(
          (button) => button.getAttribute("aria-label") === "Resume this workstream",
        ),
        composer: text(document.querySelector("[data-og-composer-surface]"), 600),
        sessionChrome: text(document.querySelector('[data-testid="session-chrome"]'), 300),
        stoppingSurfaces: Array.from(
          document.querySelectorAll(
            '[data-testid="session-chrome-stopping"], [data-testid="stopping-previous-attempt"]',
          ),
        ).map((node) => text(node, 160)),
      };
    });
  } catch (error) {
    diagnostics.uiError = clipControlDiagnostic(String(error), 500);
  }
  const retain = async () => {
    try {
      await writeFile(
        resolve(outputDir, "workbench-control-failure.json"),
        JSON.stringify(diagnostics, null, 2) + "\n",
      );
    } catch {
      console.error("Could not retain control failure diagnostics.");
    }
  };
  await retain();
  try {
    await page.screenshot({
      path: resolve(outputDir, "workbench-control-failure.png"),
      fullPage: true,
      timeout: 5_000,
    });
  } catch {
    console.error("Could not retain the control failure screenshot.");
  }
  try {
    diagnostics.eventsAfter = eventsAfter;
    const events = await listAllSessionEventsAfter(client, workspaceId, sessionId, eventsAfter);
    const relevant = events.filter((event) => !event.type.endsWith(".delta"));
    diagnostics.eventCount = events.length;
    diagnostics.omittedEarlierEvents = Math.max(0, relevant.length - 400);
    diagnostics.events = relevant.slice(-400).map(compactControlDiagnosticEvent);
  } catch (error) {
    diagnostics.eventsError = clipControlDiagnostic(String(error), 500);
  }
  await retain();
}

function controlCallArgs(event: SessionEvent): any {
  const args = (event.payload as any)?.arguments;
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

function isExactControlExec(event: SessionEvent, command: string): boolean {
  const args = controlCallArgs(event);
  return (
    (event.payload as any)?.name === "exec_command" &&
    args?.cmd === command &&
    [undefined, null, "/bin/bash", "/bin/sh"].includes(args.shell) &&
    [undefined, null, "", "/workspace"].includes(args.workdir) &&
    [undefined, null, false].includes(args.tty) &&
    Object.keys(args).every((key) =>
      ["cmd", "workdir", "shell", "login", "tty", "yield_time_ms", "max_output_tokens"].includes(
        key,
      ),
    )
  );
}

// A read-only observation of the one adopted command: an empty write_stdin on
// its native session, or command_wait/command_read on its exact Command ID.
function isEmptyControlPoll(event: SessionEvent, sessionId: number, commandId?: string): boolean {
  const args = controlCallArgs(event);
  const name = String((event.payload as any)?.name ?? "").replace(/^opengeni__/, "");
  if (name === "write_stdin") {
    return (
      args?.session_id === sessionId &&
      args.chars === "" &&
      Object.keys(args).every((key) =>
        ["session_id", "chars", "yield_time_ms", "max_output_tokens"].includes(key),
      )
    );
  }
  return (
    (name === "command_wait" || name === "command_read") &&
    typeof commandId === "string" &&
    args?.commandId === commandId &&
    Object.keys(args).every((key) =>
      ["commandId", "cursor", "maxOutputBytes", "waitSeconds"].includes(key),
    )
  );
}

type AdoptedControlCommand = { sessionId: number; commandId: string };

function adoptedControlIdentity(event: SessionEvent): AdoptedControlCommand | null {
  const output = (event.payload as any)?.output;
  if (typeof output !== "string") return null;
  const session = /^Process running with session ID ([1-9][0-9]*)$/mu.exec(output);
  const commandId = /^Command ID: ([0-9a-f-]{36})$/mu.exec(output);
  return session && commandId ? { sessionId: Number(session[1]), commandId: commandId[1]! } : null;
}

// Every adopted test command later produces a background-command completion
// notice that rides into the next turn. A model may observe such a command
// read-only; that never changes custody, so it is allowed in any turn.
function isKnownCommandObservation(
  event: SessionEvent,
  known: readonly AdoptedControlCommand[],
): boolean {
  return known.some((command) => isEmptyControlPoll(event, command.sessionId, command.commandId));
}

function adoptedControlCommands(
  records: readonly { ready: SessionEvent }[] | undefined,
): AdoptedControlCommand[] {
  return (records ?? [])
    .map((record) => adoptedControlIdentity(record.ready))
    .filter((command): command is AdoptedControlCommand => command !== null);
}

// Native command-origin decoding only. Live acceptance additionally requires
// assertAdoptedControlFixtureInvocation and the complete observation audit below.
export function assertControlFixtureInvocation(
  events: readonly SessionEvent[],
  ready: SessionEvent,
  command: string,
  known: readonly AdoptedControlCommand[] = [],
): void {
  const owned = events.filter(
    (event) =>
      event.turnId === ready.turnId &&
      event.turnAttemptId === ready.turnAttemptId &&
      event.sequence < ready.sequence,
  );
  const argsOf = (event: SessionEvent): any => {
    const args = (event.payload as any)?.arguments;
    if (typeof args !== "string") return args;
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  };
  const runningIdentity = adoptedControlIdentity;
  const identity = runningIdentity(ready);
  if (!identity) throw new Error("control fixture lacks native running-command identity");
  const execs = owned.filter(
    (event) =>
      event.type === "agent.toolCall.created" && (event.payload as any)?.name === "exec_command",
  );
  if (execs.length !== 1 || !isExactControlExec(execs[0]!, command))
    throw new Error("control fixture model invoked a different command or execution context");
  if (
    owned.some(
      (event) =>
        event.type === "agent.toolCall.created" &&
        event !== execs[0] &&
        !isEmptyControlPoll(event, identity.sessionId, identity.commandId) &&
        !isKnownCommandObservation(event, known),
    )
  ) {
    throw new Error("control fixture contains unrelated mutation calls");
  }
  const calls = owned.filter(
    (event) =>
      event.type === "agent.toolCall.created" &&
      (event.payload as any)?.id === (ready.payload as any)?.id,
  );
  if (calls.length !== 1) throw new Error("control fixture lacks a unique model-owned tool call");
  const call = calls[0]!;
  if ((call.payload as any)?.name === "exec_command") {
    if (argsOf(call)?.cmd !== command)
      throw new Error("control fixture model invoked a different command");
    return;
  }
  if (
    (call.payload as any)?.name !== "write_stdin" ||
    argsOf(call)?.session_id !== identity.sessionId
  ) {
    throw new Error("control fixture poll does not own the running session");
  }
  const origins = owned.filter((event) => {
    if (
      event.type !== "agent.toolCall.created" ||
      (event.payload as any)?.name !== "exec_command" ||
      argsOf(event)?.cmd !== command
    )
      return false;
    const outputs = owned.filter(
      (output) =>
        output.type === "agent.toolCall.output" &&
        output.sequence > event.sequence &&
        output.sequence < call.sequence &&
        (output.payload as any)?.id === (event.payload as any)?.id,
    );
    if (outputs.length !== 1) return false;
    const prior = runningIdentity(outputs[0]!);
    return prior?.sessionId === identity.sessionId && prior.commandId === identity.commandId;
  });
  if (origins.length !== 1)
    throw new Error("control fixture poll lacks a unique exact model-owned exec origin");
}

// Steer and Pause share one custody shape: the model runs the installed test
// once, the runtime adopts it with a native session and Command ID, and only
// read-only observations of that command follow until the control.
export function assertAdoptedControlFixtureInvocation(
  events: readonly SessionEvent[],
  ready: SessionEvent,
  command: string,
  acceptedEventId: string,
  control: "Steer" | "Pause",
  known: readonly AdoptedControlCommand[] = [],
): void {
  const accepted = events.filter(
    (event) => event.id === acceptedEventId && event.type === "user.message",
  );
  const starts = events.filter(
    (event) =>
      event.type === "turn.started" &&
      event.sequence < ready.sequence &&
      (event.payload as any)?.triggerEventId === acceptedEventId,
  );
  const canonical = events.filter((event) => event.id === ready.id);
  if (
    accepted.length !== 1 ||
    starts.length !== 1 ||
    starts[0]!.sequence <= accepted[0]!.sequence ||
    !ready.turnId ||
    !ready.turnAttemptId ||
    starts[0]!.turnId !== ready.turnId ||
    starts[0]!.turnAttemptId !== ready.turnAttemptId
  ) {
    throw new Error(control + " fixture lacks exact accepted-turn ownership");
  }
  if (
    canonical.length !== 1 ||
    ready.type !== "agent.toolCall.output" ||
    JSON.stringify(canonical[0]) !== JSON.stringify(ready)
  ) {
    throw new Error(control + " fixture lacks a unique canonical ready output");
  }
  const interval = events.filter(
    (event) => event.sequence > starts[0]!.sequence && event.sequence <= ready.sequence,
  );
  if (
    interval.some(
      (event) =>
        event.type === "agent.toolCall.created" &&
        (event.turnId !== ready.turnId || event.turnAttemptId !== ready.turnAttemptId),
    )
  ) {
    throw new Error(control + " fixture contains unowned calls before readiness");
  }
  assertControlFixtureInvocation(interval, ready, command, known);
}

type ControlFixtureCustody = {
  mode: "steer" | "pause";
  afterSequence: number;
  acceptedEventId: string;
  ready: SessionEvent;
  command: string;
  control: SessionEvent;
  quiesced: SessionEvent;
  replacementTurnId?: string;
  replacementCommand?: string;
  replacementOutput?: string;
  resumeOperationId?: string;
  resumeOutput?: string;
};
const controlFixtureCustody = new WeakMap<ControlCancellationAudit, ControlFixtureCustody[]>();

export function assertControlFixtureCustody(
  events: readonly SessionEvent[],
  records: readonly ControlFixtureCustody[],
  earlier: readonly ControlFixtureCustody[] = [],
): void {
  if (records.length === 0) throw new Error("control custody has no registered hostile command");
  const allowed = new Set<SessionEvent>();
  const calls = events.filter((event) => event.type === "agent.toolCall.created");
  const known = adoptedControlCommands([...earlier, ...records]);
  const isNoticeObservation = (call: SessionEvent): boolean =>
    isKnownCommandObservation(call, known);
  const canonical = (event: SessionEvent): void => {
    const matches = events.filter((candidate) => candidate.id === event.id);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(event))
      throw new Error("control custody boundary is not canonical");
  };
  const allowSuccessfulRead = (call: SessionEvent, expectedOutput: string): void => {
    const outputs = events.filter(
      (event) =>
        event.type === "agent.toolCall.output" &&
        event.turnId === call.turnId &&
        event.turnAttemptId === call.turnAttemptId &&
        event.sequence > call.sequence &&
        (event.payload as any)?.id === (call.payload as any)?.id,
    );
    const text = (outputs[0]?.payload as any)?.output;
    if (
      outputs.length !== 1 ||
      typeof text !== "string" ||
      !/^Process exited with code 0$/mu.test(text) ||
      !text.endsWith("Output:\n" + expectedOutput)
    ) {
      throw new Error("control custody lacks successful exact read-only or claimed-replay output");
    }
    allowed.add(call);
  };
  for (const record of records) {
    const { ready, control, quiesced } = record;
    canonical(ready);
    canonical(control);
    canonical(quiesced);
    const hardFence =
      quiesced.type === "session.queue.changed" &&
      (quiesced.payload as any)?.operation === "attempt_quiesced" &&
      (quiesced.payload as any)?.attemptId === ready.turnAttemptId;
    const handoverFence =
      record.mode === "steer" && isSteerHandoverFence(events, quiesced, control);
    if (
      control.sequence <= ready.sequence ||
      quiesced.sequence <= control.sequence ||
      quiesced.turnId !== ready.turnId ||
      quiesced.turnAttemptId !== ready.turnAttemptId ||
      !(hardFence || handoverFence)
    ) {
      throw new Error("control custody lacks its ordered physical quiescence fence");
    }
    if (record.mode === "steer") {
      if (
        control.type !== "session.control.steer_requested" ||
        (control.payload as any)?.replacedTurnId !== ready.turnId ||
        (control.payload as any)?.targetTurnId !== record.replacementTurnId
      )
        throw new Error("control custody Steer target mismatch");
      assertAdoptedControlFixtureInvocation(
        events,
        ready,
        record.command,
        record.acceptedEventId,
        "Steer",
        known,
      );
    } else {
      if (control.type !== "session.control.paused")
        throw new Error("control custody Pause boundary mismatch");
      assertAdoptedControlFixtureInvocation(
        events,
        ready,
        record.command,
        record.acceptedEventId,
        "Pause",
        known,
      );
    }
    const identity = adoptedControlIdentity(ready);
    if (!identity) throw new Error("control custody lacks native session identity");
    const { sessionId, commandId } = identity;
    const originStarts = events.filter(
      (event) =>
        event.type === "turn.started" &&
        event.turnId === ready.turnId &&
        event.turnAttemptId === ready.turnAttemptId,
    );
    if (originStarts.length !== 1) throw new Error("control custody lacks a unique origin attempt");
    for (const call of calls.filter(
      (event) => event.turnId === ready.turnId && event.turnAttemptId === ready.turnAttemptId,
    )) {
      if (
        call.sequence <= originStarts[0]!.sequence ||
        call.sequence > quiesced.sequence ||
        (call.sequence > ready.sequence &&
          !isEmptyControlPoll(call, sessionId, commandId) &&
          !isNoticeObservation(call))
      ) {
        throw new Error("control custody rejects predecessor mutation or post-quiescence calls");
      }
      allowed.add(call);
    }
    if (record.mode === "steer") {
      const starts = events.filter(
        (event) => event.type === "turn.started" && event.turnId === record.replacementTurnId,
      );
      // Read-only observations of known adopted commands (prompted by their
      // completion notices) do not count toward the replacement's one exact call.
      const replacementCalls = calls.filter(
        (event) => event.turnId === record.replacementTurnId && !isNoticeObservation(event),
      );
      if (
        starts.length !== 1 ||
        starts[0]!.sequence <= quiesced.sequence ||
        !starts[0]!.turnAttemptId ||
        replacementCalls.length !== 1 ||
        replacementCalls[0]!.turnAttemptId !== starts[0]!.turnAttemptId ||
        replacementCalls[0]!.sequence <= starts[0]!.sequence ||
        !record.replacementCommand ||
        !record.replacementOutput ||
        !isExactControlExec(replacementCalls[0]!, record.replacementCommand)
      ) {
        throw new Error(
          "control custody rejects replacement tools other than its exact read-only verification",
        );
      }
      allowSuccessfulRead(replacementCalls[0]!, record.replacementOutput);
    } else {
      if (!record.resumeOperationId)
        throw new Error("control custody lacks canonical Resume ownership");
      const resumes = events.filter(
        (event) =>
          event.type === "session.control.resumed" &&
          (event.payload as any)?.operationId === record.resumeOperationId,
      );
      if (resumes.length !== 1 || resumes[0]!.sequence <= quiesced.sequence)
        throw new Error("control custody lacks canonical Resume ownership");
      const resumedCalls = calls.filter(
        (event) => event.turnId === ready.turnId && event.turnAttemptId !== ready.turnAttemptId,
      );
      for (const call of resumedCalls) {
        const starts = events.filter(
          (event) =>
            event.type === "turn.started" &&
            event.turnId === ready.turnId &&
            event.turnAttemptId === call.turnAttemptId,
        );
        if (
          starts.length !== 1 ||
          starts[0]!.sequence <= resumes[0]!.sequence ||
          call.sequence <= starts[0]!.sequence
        ) {
          throw new Error("control custody resumed attempt preceded Resume");
        }
        // A resumed attempt may observe its adopted command, or execute the
        // unchanged claim-guarded script once. No cleanup/writer is permitted.
        if (isEmptyControlPoll(call, sessionId, commandId) || isNoticeObservation(call))
          allowed.add(call);
        else if (
          record.resumeOutput &&
          isExactControlExec(call, record.command) &&
          resumedCalls.filter(
            (other) =>
              other.turnAttemptId === call.turnAttemptId &&
              (other.payload as any)?.name === "exec_command",
          ).length === 1
        ) {
          allowSuccessfulRead(call, record.resumeOutput);
        } else throw new Error("control custody rejects resumed mutation calls");
      }
    }
  }
  for (const call of calls) {
    // Notice-driven reads in any later turn, including replacement turns and
    // turns between controls. Mutations or unknown commands stay rejected.
    const origin = records.find(
      (record) =>
        record.ready.turnId === call.turnId && record.ready.turnAttemptId === call.turnAttemptId,
    );
    if (!origin && isNoticeObservation(call)) allowed.add(call);
  }
  // Includes foreign and replacement attempts, and all calls between controls.
  // Keep the read after the final zombie probe so its entire window is covered.
  if (
    new Set(calls.map((call) => call.id)).size !== calls.length ||
    new Set(
      calls.map((call) =>
        JSON.stringify([call.turnId, call.turnAttemptId, (call.payload as any)?.id]),
      ),
    ).size !== calls.length ||
    calls.some((call) => !allowed.has(call))
  )
    throw new Error("control custody contains an unapproved model call through final observation");
}

function registerControlFixtureCustody(
  audit: ControlCancellationAudit,
  record: ControlFixtureCustody,
): void {
  const records = controlFixtureCustody.get(audit) ?? [];
  records.push(record);
  controlFixtureCustody.set(audit, records);
}

async function auditControlFixtureCustody(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  audit: ControlCancellationAudit,
): Promise<void> {
  const records = controlFixtureCustody.get(audit);
  if (!records?.length) throw new Error("control custody lacks fixture registration");
  assertControlFixtureCustody(
    await listAllSessionEventsAfter(client, workspaceId, sessionId, records[0]!.afterSequence),
    records,
  );
}

// Bounded retry for idempotent API calls on a response the API explicitly
// marks retryable. Reads retry any retryable 503. A POST retries only when it
// carries an idempotency key or client event id and the API reports
// DATABASE_UNAVAILABLE. Its outcome is unknown (the commit may have happened),
// so the replay relies on the server deduplicating by that key: createSession
// replays by idempotencyKey and sendMessage by clientEventId.
export async function retryableIdempotentAcceptanceFetch(
  input: any,
  init?: any,
  retry: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const attempts = retry.attempts ?? 4;
  const delayMs = retry.delayMs ?? 1_000;
  const fetchImpl = retry.fetchImpl ?? fetch;
  const method = String(
    init?.method ??
      (typeof input === "object" && input && "method" in input ? input.method : "GET"),
  ).toUpperCase();
  let keyed = false;
  if (method === "POST" && typeof init?.body === "string") {
    try {
      const parsed = JSON.parse(init.body);
      keyed =
        typeof parsed?.idempotencyKey === "string" || typeof parsed?.clientEventId === "string";
    } catch {
      keyed = false;
    }
  }
  const safe = method === "GET" || method === "HEAD";
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(input, init);
    if ((!safe && !keyed) || response.status !== 503 || attempt >= attempts) return response;
    let error: any = null;
    try {
      error = ((await response.clone().json()) as any)?.error ?? null;
    } catch {
      error = null;
    }
    const retryable =
      error?.retryable === true && (safe || error?.details?.code === "DATABASE_UNAVAILABLE");
    if (!retryable) return response;
    await response.body?.cancel().catch(() => undefined);
    console.warn(
      "Retrying idempotent " +
        method +
        " after a retryable 503 (" +
        String(error?.details?.code ?? error?.code ?? "unknown") +
        "), attempt " +
        attempt +
        " of " +
        attempts,
    );
    await new Promise((wake) => setTimeout(wake, delayMs * 2 ** (attempt - 1)));
  }
}

function selectWorkspace(
  requested: string | undefined,
  cookie: AccessContext,
  token: AccessContext,
): string {
  const cookieIds = new Set(cookie.workspaceGrants.map((grant) => grant.workspaceId));
  const tokenIds = new Set(token.workspaceGrants.map((grant) => grant.workspaceId));
  const workspaceId = requested ?? cookie.defaultWorkspaceId ?? undefined;
  if (!workspaceId || !cookieIds.has(workspaceId) || !tokenIds.has(workspaceId)) {
    throw new Error("cookie and bearer principals do not share the requested canary workspace");
  }
  const cookieAccount = cookie.workspaceGrants.find((grant) => grant.workspaceId === workspaceId);
  const tokenAccount = token.workspaceGrants.find((grant) => grant.workspaceId === workspaceId);
  if (!cookieAccount || cookieAccount.accountId !== tokenAccount?.accountId) {
    throw new Error("cookie and bearer principals resolve to different accounts");
  }
  return workspaceId;
}

export function assertAcceptancePrincipalScopes(
  cookieAccess: AccessContext,
  tokenAccess: AccessContext,
  workspaceId: string,
): void {
  assertWorkspacePermissions(
    cookieAccess,
    workspaceId,
    WORKBENCH_CANARY_PERMISSIONS,
    "workbench canary",
  );
  assertWorkspacePermissions(
    tokenAccess,
    workspaceId,
    OBSERVABILITY_PROBE_PERMISSIONS,
    "observability probe",
  );
}

function assertWorkspacePermissions(
  context: AccessContext,
  workspaceId: string,
  requiredPermissions: readonly string[],
  principalLabel: string,
): void {
  const grant = context.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  if (!grant) throw new Error(`acceptance ${principalLabel} has no workspace grant`);
  const missing = requiredPermissions.filter(
    (permission) => !grant.permissions.includes(permission),
  );
  if (missing.length > 0) {
    throw new Error(`acceptance ${principalLabel} lacks: ${missing.join(", ")}`);
  }
}

async function waitForSettled(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let last: Session | null = null;
  while (Date.now() < deadline) {
    last = await client.getSession(workspaceId, sessionId);
    if (SETTLED.has(last.status)) return last;
    await Bun.sleep(2_000);
  }
  throw new Error(`session did not settle before timeout (last=${last?.status ?? "unknown"})`);
}

const initialCaptureRecoveryPolicyV1 =
  "typed-repository-read-unavailable-single-read-only-retry-v1";

async function waitForCapture(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<Extract<GetWorkspaceCaptureResponse, { available: true }>> {
  const deadline = Date.now() + timeoutMs;
  let repositoryReadRecoveryAttempted = false;
  while (Date.now() < deadline) {
    const capture = await client.getWorkspaceCapture(workspaceId, sessionId);
    if (capture.available) return capture;
    if (capture.degradedReason) {
      if (
        capture.degradedReason !== "repository_read_unavailable" ||
        repositoryReadRecoveryAttempted
      ) {
        throw new Error(
          `capture degraded: ${capture.degradedReason} under ${initialCaptureRecoveryPolicyV1}`,
        );
      }
      repositoryReadRecoveryAttempted = true;
      const retryMarker = `OPENGENI_CAPTURE_RETRY_${sessionId.replaceAll("-", "_").toUpperCase()}`;
      const afterSequence = (await client.getSession(workspaceId, sessionId)).lastSequence;
      const queue = await client.getQueue(workspaceId, sessionId);
      await client.sendMessage(workspaceId, sessionId, {
        text: [
          "Run exactly one terminal command and do nothing else.",
          "The command is read-only and retries a typed transient workspace-capture repository read.",
          "```bash",
          `test -d api/.git && test -d web/.git && test -d nested/deep/repo/.git && git -C api status --porcelain >/dev/null && git -C web status --porcelain >/dev/null && git -C web-linked status --porcelain >/dev/null && git -C nested/deep/repo status --porcelain >/dev/null && printf '${retryMarker}\n'`,
          "```",
          "After the command succeeds, stop.",
        ].join("\n"),
        controlEtag: queue.effectiveControl.controlEtag,
        clientEventId: `workbench-capture-retry:${crypto.randomUUID()}`,
      });
      const remainingForMarker = deadline - Date.now();
      if (remainingForMarker <= 0) break;
      await waitForSessionEvent(
        client,
        workspaceId,
        sessionId,
        afterSequence,
        remainingForMarker,
        (event) =>
          event.type === "agent.toolCall.output" &&
          JSON.stringify(event.payload ?? {}).includes(retryMarker),
        "the typed repository-read capture recovery marker",
      );
      const remainingForSettlement = deadline - Date.now();
      if (remainingForSettlement <= 0) break;
      const settled = await waitForSettled(client, workspaceId, sessionId, remainingForSettlement);
      if (settled.status !== "idle") {
        throw new Error(
          `capture recovery turn ended in ${settled.status} under ${initialCaptureRecoveryPolicyV1}`,
        );
      }
      continue;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("capture did not become available before timeout");
}

async function listAllToolOutputEvents(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await readFixtureEventPage(client, workspaceId, sessionId, cursor);
    collected.push(...page.events);
    cursor = page.nextAfter;
    if (!page.hasMore) return collected;
  }
}

export function assertFixtureToolOutput(events: readonly SessionEvent[], marker: string): void {
  const observed = events.some(
    (event) =>
      event.type === "agent.toolCall.output" &&
      JSON.stringify(event.payload ?? {}).includes(marker),
  );
  if (!observed) {
    throw new Error("acceptance fixture command did not emit its exact marker");
  }
}

async function loadManifest(
  response: Extract<GetWorkspaceCaptureResponse, { available: true }>,
): Promise<WorkspaceCaptureManifest> {
  let value: unknown = response.manifest;
  if (!value && response.manifestUrl) {
    const fetched = await fetch(response.manifestUrl.url, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
    if (!fetched.ok) throw new Error(`capture manifest download returned ${fetched.status}`);
    value = await fetched.json();
  }
  if (!isRecord(value)) throw new Error("capture response has no manifest object");
  const manifest = value as unknown as WorkspaceCaptureManifest;
  if (
    manifest.version !== 1 ||
    manifest.revision !== response.revision ||
    manifest.capturedAt !== response.capturedAt ||
    manifest.turnId !== response.turnId ||
    manifest.leaseEpoch !== response.leaseEpoch ||
    manifest.repos.length !== response.stats.repoCount ||
    manifest.files.length !== response.stats.fileCount
  ) {
    throw new Error("capture manifest identity or counts do not match response metadata");
  }
  return manifest;
}

export function assertFixtureCapture(manifest: WorkspaceCaptureManifest, marker: string): void {
  const roots = new Set(manifest.repos.map((repo) => repo.root));
  for (const root of ["api", "web", "web-linked", "nested/deep/repo"])
    if (!roots.has(root)) throw new Error(`capture is missing repo ${root}`);
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const path of [
    "api/server.ts",
    "api/notes.txt",
    "api/empty.txt",
    "api/binary.dat",
    "api/signed-preview.txt",
    "api/too-large.bin",
    "api/run.sh",
    "api/server-link.ts",
    "api/über λ.txt",
    "web/app.js",
    "web/renamed.txt",
    "web/deleted.txt",
    "web-linked/worktree-marker.txt",
    "nested/deep/repo/deep.txt",
  ]) {
    if (!files.has(path)) throw new Error(`capture is missing fixture file ${path}`);
  }
  if (files.has("api/external-link")) {
    throw new Error("escaping symlink content was captured instead of being confined");
  }
  if (files.has("api/external-dir")) {
    throw new Error("escaping directory symlink content was captured instead of being confined");
  }
  if (!files.get("api/binary.dat")?.isBinary) throw new Error("binary fixture was not classified");
  if (!files.get("api/too-large.bin")?.tooLarge)
    throw new Error("too-large fixture was not guarded");
  if (!files.get("web/deleted.txt")?.deleted) throw new Error("deleted fixture was not retained");
  if (files.get("api/empty.txt")?.sizeBytes !== 0) throw new Error("empty fixture size drifted");
  const expectedContent = new Map<string, Uint8Array>([
    [
      "api/server.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/notes.txt", Buffer.from(`untracked ${marker}\n`)],
    ["api/empty.txt", Buffer.alloc(0)],
    ["api/binary.dat", Buffer.from([0, 1, 254, 255])],
    ["api/signed-preview.txt", Buffer.alloc(307_200, "s")],
    ["api/run.sh", Buffer.from(`#!/bin/sh\necho ${marker}\n`)],
    [
      "api/server-link.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/über λ.txt", Buffer.from(`unicode ${marker}\n`)],
    ["web/app.js", Buffer.from(`console.log("staged and unstaged ${marker}");\n`)],
    ["web/renamed.txt", Buffer.from("rename me\n")],
    ["web-linked/worktree-marker.txt", Buffer.from(`linked ${marker}\n`)],
    ["nested/deep/repo/deep.txt", Buffer.from(`deep ${marker}\n`)],
  ]);
  for (const [path, content] of expectedContent) {
    const file = files.get(path);
    if (file?.sizeBytes !== content.byteLength || file.hash !== sha256(content)) {
      throw new Error(`capture content identity drifted for ${path}`);
    }
  }
  const tooLarge = files.get("api/too-large.bin");
  if (tooLarge?.hash !== null || tooLarge.contentRef !== null) {
    throw new Error("too-large fixture retained content identity or storage reference");
  }
  const deleted = files.get("web/deleted.txt");
  if (deleted?.hash !== null || deleted.contentRef !== null || deleted.sizeBytes !== 0) {
    throw new Error("deleted fixture retained after-image content");
  }

  const repo = (root: string) => manifest.repos.find((candidate) => candidate.root === root);
  const status = (root: string, path: string) =>
    repo(root)?.status.find((candidate) => candidate.path === path);
  if (status("api", "server.ts")?.worktree !== "modified") {
    throw new Error("unstaged fixture status drifted");
  }
  if (status("api", "notes.txt")?.worktree !== "untracked") {
    throw new Error("untracked fixture status drifted");
  }
  const stagedAndUnstaged = status("web", "app.js");
  if (stagedAndUnstaged?.index !== "modified" || stagedAndUnstaged.worktree !== "modified") {
    throw new Error("staged-plus-unstaged fixture status drifted");
  }
  const renamed = status("web", "renamed.txt");
  if (renamed?.index !== "renamed" || renamed.oldPath !== "old-name.txt") {
    throw new Error("renamed fixture status drifted");
  }
  if (status("web", "deleted.txt")?.index !== "deleted") {
    throw new Error("deleted fixture status drifted");
  }
  if (
    manifest.repos.some((candidate) =>
      candidate.status.some(
        (item) => item.path.startsWith("node_modules/") || item.path.startsWith("dist/"),
      ),
    )
  ) {
    throw new Error("ignored dependency or build residue leaked into repository status");
  }

  const apiDiff = manifest.repos.find((candidate) => candidate.root === "api")?.diff ?? [];
  const server = apiDiff.find((file) => file.path === "server.ts");
  if (!server?.hunks.some((hunk) => hunk.lines.some((line) => line.text.includes(marker)))) {
    throw new Error("capture diff does not contain the deterministic marker");
  }
  for (const [path, target] of [
    ["external-link", `/tmp/opengeni-${marker}`],
    ["external-dir", `/tmp/opengeni-dir-${marker}`],
  ] as const) {
    const link = apiDiff.find((file) => file.path === path);
    const diffText = link?.hunks.flatMap((hunk) => hunk.lines).map((line) => line.text);
    if (
      link?.status !== "untracked" ||
      !diffText?.includes(target) ||
      diffText.some((line) => line.includes("outside secret"))
    ) {
      throw new Error(`escaping symlink diff lost link-only semantics for ${path}`);
    }
  }

  const treeNode = (path: string) => {
    const visit = (node: WorkspaceCaptureManifest["treeIndex"]): typeof node | undefined => {
      if (node.path === path) return node;
      for (const child of node.children ?? []) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };
    return visit(manifest.treeIndex);
  };
  for (const path of ["api/server-link.ts", "api/external-link", "api/external-dir"]) {
    if (treeNode(path)?.type !== "symlink")
      throw new Error(`tree lost symlink metadata for ${path}`);
  }
  if (((treeNode("api/run.sh")?.mode ?? 0) & 0o111) === 0) {
    throw new Error("tree lost executable mode metadata");
  }
  if (!treeNode("api/über λ.txt")) throw new Error("tree lost Unicode path metadata");
  if (manifest.stats.binaryCount < 1 || manifest.stats.tooLargeCount < 1) {
    throw new Error("capture statistics lost binary or too-large accounting");
  }
}

async function verifySignedFileExpiry(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  manifest: WorkspaceCaptureManifest,
): Promise<void> {
  const file = manifest.files.find((candidate) => candidate.path === "api/signed-preview.txt");
  if (!file?.hash) throw new Error("signed-size capture fixture has no integrity hash");
  const first = await client.getWorkspaceCaptureFile(
    workspaceId,
    sessionId,
    file.path,
    manifest.revision,
  );
  if (!first.contentUrl || first.content !== null) {
    throw new Error("signed-size fixture did not use a signed content URL");
  }
  const expiresAt = Date.parse(first.contentUrl.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("signed URL expiry is invalid");
  const waitMs = Math.max(0, expiresAt - Date.now() + 2_000);
  progress(`waiting ${Math.ceil(waitMs / 1_000)}s to prove signed URL expiry`);
  await Bun.sleep(waitMs);
  const expired = await fetch(first.contentUrl.url, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (expired?.ok) throw new Error("expired capture URL remained usable");

  const refreshed = await client.getWorkspaceCaptureFile(
    workspaceId,
    sessionId,
    file.path,
    manifest.revision,
  );
  if (!refreshed.contentUrl) throw new Error("capture API did not mint a refreshed signed URL");
  const response = await fetch(refreshed.contentUrl.url, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`refreshed capture URL returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== file.hash)
    throw new Error("refreshed capture bytes failed integrity check");
}

export async function waitForSandboxLiveness(
  client: Pick<OpenGeniClient, "getStreamCapabilities">,
  workspaceId: string,
  sessionId: string,
  accepted: ReadonlySet<string>,
  timeoutMs: number,
  pollIntervalMs = 2_000,
  requestTimeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastTransportError: string | undefined;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const capabilities = await client.getStreamCapabilities(workspaceId, sessionId, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
      });
      lastTransportError = undefined;
      if (accepted.has(capabilities.liveness)) return;
    } catch (error) {
      lastTransportError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }
  throw new Error(
    `sandbox did not reach ${[...accepted].join("/")} before timeout` +
      (lastTransportError ? ` (last transport error: ${lastTransportError})` : ""),
  );
}

export function isDormantSandboxLiveness(liveness: string): boolean {
  return liveness === "cold" || liveness === "draining";
}

export async function waitForCold(
  client: Pick<OpenGeniClient, "getStreamCapabilities">,
  workspaceId: string,
  sessionId: string,
  timeoutMs: number,
  pollIntervalMs = 2_000,
  requestTimeoutMs = 10_000,
): Promise<void> {
  await waitForSandboxLiveness(
    client,
    workspaceId,
    sessionId,
    new Set(["cold", "draining"]),
    timeoutMs,
    pollIntervalMs,
    requestTimeoutMs,
  );
}

export async function waitForWarm(
  client: Pick<OpenGeniClient, "getStreamCapabilities">,
  workspaceId: string,
  sessionId: string,
  timeoutMs = 90_000,
  pollIntervalMs = 1_000,
  requestTimeoutMs = 10_000,
): Promise<void> {
  await waitForSandboxLiveness(
    client,
    workspaceId,
    sessionId,
    new Set(["warm"]),
    timeoutMs,
    pollIntervalMs,
    requestTimeoutMs,
  );
}

export async function waitForInteractiveTerminal(
  page: Pick<Page, "locator">,
  timeoutMs = 90_000,
): Promise<Locator> {
  const terminal = page.locator(TERMINAL_SELECTOR);
  await terminal.waitFor({ state: "visible", timeout: timeoutMs });
  await terminal.click();
  const interactiveTerminal = page.locator(INTERACTIVE_TERMINAL_SELECTOR);
  await interactiveTerminal.waitFor({ state: "visible", timeout: timeoutMs });
  const input = interactiveTerminal.locator(".xterm-helper-textarea");
  await input.waitFor({ state: "attached", timeout: timeoutMs });
  return input;
}

export type TerminalOutputProbe = {
  expect: (marker: string, action: () => Promise<void>, timeoutMs?: number) => Promise<void>;
};

/**
 * Observe the exact PTY bytes delivered to the browser without depending on an
 * xterm renderer's DOM shape. WebGL and canvas render cells without
 * `.xterm-rows`; the DOM renderer happens to expose that private element, but it
 * is not a transport or execution receipt.
 */
export function createTerminalOutputProbe(page: Pick<Page, "on">): TerminalOutputProbe {
  const tails = new Map<object, string>();
  let pending:
    | {
        marker: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  page.on("websocket", (socket) => {
    tails.set(socket, "");
    socket.on("framereceived", ({ payload }) => {
      const chunk = typeof payload === "string" ? payload : payload.toString("utf8");
      const tail = `${tails.get(socket) ?? ""}${chunk}`.slice(-8_192);
      tails.set(socket, tail);
      if (!pending || !tail.includes(pending.marker)) return;
      const observed = pending;
      pending = undefined;
      clearTimeout(observed.timer);
      observed.resolve();
    });
  });

  return {
    async expect(marker, action, timeoutMs = 30_000) {
      if (!marker) throw new Error("terminal output marker must not be empty");
      if (pending) throw new Error("terminal output probe already has a pending observation");
      for (const socket of tails.keys()) tails.set(socket, "");

      let resolveOutput!: () => void;
      let rejectOutput!: (error: Error) => void;
      const output = new Promise<void>((resolvePromise, reject) => {
        resolveOutput = resolvePromise;
        rejectOutput = reject;
      });
      const timer = setTimeout(() => {
        const current = pending;
        pending = undefined;
        current?.reject(new Error(`terminal output marker was not received within ${timeoutMs}ms`));
      }, timeoutMs);
      const observation = { marker, resolve: resolveOutput, reject: rejectOutput, timer };
      pending = observation;
      try {
        await Promise.all([action(), output]);
      } finally {
        if (pending === observation) {
          pending = undefined;
          clearTimeout(timer);
        }
      }
    },
  };
}

export function terminalOutputCommand(marker: string): string {
  if (!/^[A-Z0-9_]+$/.test(marker)) {
    throw new Error("terminal output marker is outside the deterministic acceptance alphabet");
  }
  const encoded = Buffer.from(`${marker}\n`, "utf8").toString("base64");
  const command = `printf '%s' '${encoded}' | base64 -d`;
  if (command.includes(marker)) {
    throw new Error("terminal output marker encoding is not echo-safe");
  }
  return command;
}

async function runLiveWorkspaceFlow(input: {
  browser: Browser;
  cookieHeader: string;
  client: OpenGeniClient;
  args: LiveAcceptanceArgs;
  workspaceId: string;
  sessionId: string;
  marker: string;
  checks: Check[];
  artifacts: Artifact[];
}): Promise<{ controlCancellationSamples: number[] }> {
  const { browser, cookieHeader, client, args, workspaceId, sessionId, marker, checks, artifacts } =
    input;
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await installManagedCookies(context, cookieHeader, args.webUrl, args.apiUrl);
  const page = await context.newPage();
  const terminalOutput = createTerminalOutputProbe(page);
  const problems = observePage(page);
  try {
    await page.goto(sessionUrl(args.webUrl, workspaceId, sessionId), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await openWorkspaceIfCollapsed(page);
    await assertChangesDefaultVisible(page);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await selectTreeFile(page, "api", "base.txt");
    await waitForSandboxFileViewerText(page, "api/base.txt", "On machine", 20_000);
    const fileViewer = page.locator(SANDBOX_FILES_VIEWER_SELECTOR);
    const channelABeforeWake = problems.channelA.length;
    await fileViewer.getByRole("button", { name: "Open live file" }).click();
    await waitForWarm(client, workspaceId, sessionId);
    await waitForSandboxFileViewerText(page, "api/base.txt", "tracked but untouched", 30_000);
    if (problems.channelA.length <= channelABeforeWake) {
      throw new Error("explicit live-file action warmed no observable Channel-A file request");
    }
    pass(
      checks,
      "functional.explicit-wake",
      "An untouched captured path remained gated until the user opened it live, then the real sandbox warmed and served it.",
    );

    const restoredPathConfinementSentinelsV1 = await client.terminalExec(workspaceId, sessionId, {
      command: `set -eu
printf 'outside secret must never be captured\n' > '/tmp/opengeni-${marker}'
rm -rf '/tmp/opengeni-dir-${marker}'
mkdir -p '/tmp/opengeni-dir-${marker}'`,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    if (restoredPathConfinementSentinelsV1.exitCode !== 0) {
      throw new Error(
        "failed to re-establish outside path-confinement sentinels after cold restore",
      );
    }

    await expectApiRejection(
      () => client.fsRead(workspaceId, sessionId, { path: "api/external-link" }),
      400,
      "escaping symlink read",
    );
    await expectApiRejection(
      () =>
        client.fsWrite(workspaceId, sessionId, {
          path: "api/external-link",
          content: "must not overwrite outside target",
          overwrite: true,
        }),
      400,
      "escaping symlink write",
    );
    await expectApiRejection(
      () =>
        client.fsWrite(workspaceId, sessionId, {
          path: "api/external-dir/escaped.txt",
          content: "must stay confined",
          overwrite: true,
          createParents: true,
        }),
      400,
      "escaping symlink parent write",
    );
    await expectApiRejection(
      () => client.fsMkdir(workspaceId, sessionId, { path: "api/external-dir/nested" }),
      400,
      "escaping symlink parent mkdir",
    );
    const outside = await client.terminalExec(workspaceId, sessionId, {
      command: `printf '%s|' "$(cat '/tmp/opengeni-${marker}')"; test ! -e '/tmp/opengeni-dir-${marker}/escaped.txt'; test ! -e '/tmp/opengeni-dir-${marker}/nested'`,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    if (outside.exitCode !== 0 || outside.stdout !== "outside secret must never be captured|") {
      throw new Error("rejected path-confinement probes changed an outside target");
    }
    pass(
      checks,
      "security.path-confinement",
      "Reads and mutations through file and parent-directory symlink escapes returned HTTP 400 and left every outside target byte-for-byte unchanged.",
    );

    await fileViewer.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = fileViewer.locator("[data-opengeni-code-editor]");
    await editor.waitFor({ timeout: 30_000 });
    const editable = editor.locator(".cm-content");
    await editable.waitFor({ timeout: 30_000 });
    await editable.click();
    await editable.press("Control+End");
    await editable.press("Enter");
    await editable.pressSequentially(`ui edit ${marker}`);
    await fileViewer
      .locator('[data-opengeni-code-editor][data-opengeni-editor-dirty="true"]')
      .waitFor({ state: "visible", timeout: 20_000 });
    const saveButton = editor.getByRole("button", { name: "Save", exact: true });
    await saveButton.click();
    await editor.getByText("Saved", { exact: true }).waitFor({ timeout: 20_000 });
    const saved = await client.fsRead(workspaceId, sessionId, { path: "api/base.txt" });
    if (!saved.content.includes(`ui edit ${marker}`)) {
      throw new Error("editor reported Saved but the server content did not match");
    }

    const external = `external race ${marker}\n`;
    await client.fsWrite(workspaceId, sessionId, {
      path: "api/base.txt",
      content: external,
      overwrite: true,
    });
    await editable.click();
    await editable.press("Control+End");
    await editable.press("Enter");
    await editable.pressSequentially("local conflict candidate");
    await fileViewer
      .locator('[data-opengeni-code-editor][data-opengeni-editor-dirty="true"]')
      .waitFor({ state: "visible", timeout: 20_000 });
    await saveButton.click();
    await editor
      .getByText("File changed on machine.", { exact: true })
      .waitFor({ timeout: 20_000 });
    const afterConflict = await client.fsRead(workspaceId, sessionId, { path: "api/base.txt" });
    if (afterConflict.content !== external) {
      throw new Error("guarded editor conflict overwrote the live file");
    }
    await editor.getByRole("button", { name: "Overwrite", exact: true }).click();
    await editor.getByText("Saved", { exact: true }).waitFor({ timeout: 20_000 });
    const overwritten = await client.fsRead(workspaceId, sessionId, { path: "api/base.txt" });
    if (!overwritten.content.includes("local conflict candidate")) {
      throw new Error("explicit editor overwrite did not persist the visible buffer");
    }
    pass(
      checks,
      "functional.editor-guarded-save",
      "The real editor saved, detected a concurrent live change without writing, and required explicit overwrite.",
    );

    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    const terminalInput = await waitForInteractiveTerminal(page);
    await terminalInput.click();
    const terminalMarker = `TERMINAL_${marker}`;
    await terminalOutput.expect(
      terminalMarker,
      async () => {
        await page.keyboard.type(terminalOutputCommand(terminalMarker));
        await page.keyboard.press("Enter");
      },
      30_000,
    );
    pass(
      checks,
      "functional.terminal-roundtrip",
      "The deployed interactive terminal accepted input and returned exact deterministic PTY output to the browser.",
    );

    if (args.environment === "staging") {
      const desktopTab = page.getByRole("tab", { name: "Desktop", exact: true });
      if ((await desktopTab.count()) !== 1)
        throw new Error("staging Modal session has no Desktop tab");
      await desktopTab.click();
      const consent = page.getByRole("button", { name: "I understand — show the desktop" });
      if ((await consent.count()) !== 0) {
        throw new Error("Desktop still renders the removed confirmation step");
      }
      const desktop = page.locator('[data-opengeni-desktop][data-ui-state="connected"]');
      await desktop.waitFor({ timeout: 60_000 });
      const pixelSurface = await page
        .locator("[data-opengeni-desktop-canvas] canvas")
        .evaluate((canvas) => ({
          width: (canvas as HTMLCanvasElement).width,
          height: (canvas as HTMLCanvasElement).height,
          rect: canvas.getBoundingClientRect().toJSON(),
        }));
      if (pixelSurface.width <= 0 || pixelSurface.height <= 0) {
        throw new Error("desktop connected without a non-empty framebuffer canvas");
      }
      const desktopShot = resolve(args.outputDir, "desktop-live-framebuffer.png");
      const desktopPng = await desktop.screenshot({ path: desktopShot });
      await assertScreenshotPainted(page, desktopPng, "live desktop framebuffer");
      const desktopArtifact = await artifact(desktopShot, args.outputDir);
      if (desktopArtifact.sizeBytes < 10_000) {
        throw new Error("desktop framebuffer evidence is implausibly small");
      }
      artifacts.push(desktopArtifact);
      pass(
        checks,
        "functional.desktop-framebuffer",
        "The real staging Modal desktop connected and painted a non-empty framebuffer.",
      );
    }

    const controlCancellationSamples: number[] = [];
    const controlAudit: ControlCancellationAudit = {
      cursor: (await client.getSession(workspaceId, sessionId)).lastSequence,
      evidencePath: resolve(args.outputDir, "workbench-live-cancellation-partial.json"),
      fences: new Map(),
    };
    const controlDiagnosticsAfter = controlAudit.cursor;
    try {
      for (let iteration = 0; iteration < args.repetitions; iteration += 1) {
        controlCancellationSamples.push(
          await proveLiveSteerCancellation({
            client,
            page,
            workspaceId,
            sessionId,
            marker,
            iteration,
            verifyReplacementCapture: iteration === 0,
            audit: controlAudit,
            sessionTimeoutMs: args.sessionTimeoutMs,
          }),
        );
      }
      controlCancellationSamples.push(
        await proveLivePauseCancellation({
          client,
          page,
          workspaceId,
          sessionId,
          marker,
          audit: controlAudit,
          sessionTimeoutMs: args.sessionTimeoutMs,
        }),
      );
    } catch (error) {
      await Promise.race([
        writeControlFailureDiagnostics({
          client,
          page,
          workspaceId,
          sessionId,
          afterSequence: controlDiagnosticsAfter,
          outputDir: args.outputDir,
          error,
        }),
        new Promise((wake) => setTimeout(wake, 30_000).unref()),
      ]);
      throw error;
    }
    // A provider that merely detaches the old terminal process can surface a
    // delayed completion after the replacement is already idle. Keep one quiet
    // window after the final repetition and audit the continuous event cursor.
    await Bun.sleep(35_000);
    await auditCancelledPredecessorEvents(client, workspaceId, sessionId, controlAudit);
    const zombieProbe = await client.terminalExec(workspaceId, sessionId, {
      command:
        "test -z \"$(find steer-stress pause-stress -maxdepth 2 -name 'zombie-*.txt' -print -quit 2>/dev/null)\"",
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    if (zombieProbe.exitCode !== 0) {
      throw new Error("a cancelled predecessor terminal process performed a delayed write");
    }
    await auditControlFixtureCustody(client, workspaceId, sessionId, controlAudit);
    await auditCancelledPredecessorEvents(client, workspaceId, sessionId, controlAudit);
    const controlSummary = measurement(controlCancellationSamples);
    pass(
      checks,
      "functional.control-cancellation",
      `${args.repetitions} real Modal turns with a 4,500-entry workspace were Steered and one hostile terminal turn was Paused without zombie output or late capture commits; the shutdown fence rendered whenever cancellation exceeded the immediate-feedback budget.`,
    );
    pass(
      checks,
      "performance.control-cancellation",
      `Steer replacement/Pause quiescence worst=${round(controlSummary.worst)}ms, p95=${round(controlSummary.p95)}ms across ${controlSummary.sampleCount} controls (shared hard budget ${CONTROL_CANCELLATION_WORST_MS}ms).`,
    );

    assertNoProblems(problems, false);
    const liveShot = resolve(args.outputDir, "desktop-live-workbench.png");
    const livePng = await page.locator("[data-workspace-surface]").screenshot({ path: liveShot });
    await assertScreenshotPainted(page, livePng, "live desktop workbench");
    artifacts.push(await artifact(liveShot, args.outputDir));
    return { controlCancellationSamples };
  } finally {
    await context.close();
  }
}

export async function waitForSandboxFileViewerText(
  page: Page,
  selectedPath: string,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const viewer = page.locator(SANDBOX_FILES_VIEWER_SELECTOR);
  const selectedFile = viewer
    .locator("[data-opengeni-selected-file]")
    .filter({ hasText: selectedPath });
  await selectedFile.waitFor({ state: "visible", timeout: timeoutMs });
  const observedPath = (await selectedFile.textContent())?.trim();
  if (observedPath !== selectedPath) {
    throw new Error(
      `file viewer selected path mismatch: expected ${JSON.stringify(selectedPath)}, received ${JSON.stringify(observedPath)}`,
    );
  }
  await viewer
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

type ControlCancellationPartialEvidence = {
  schemaVersion: "opengeni/workbench-control-cancellation-partial/v2";
  control: "Steer" | "Pause";
  iteration: number | null;
  stage: "control-committed" | "physical-fence-observed";
  recordedAt: string;
  committedAt: string;
  predecessorTurnId: string;
  predecessorAttemptId: string;
  replacementTurnId: string | null;
  controlRequestedSequence: number | null;
  quiescedAt: string | null;
  quiescedSequence: number | null;
  replacementStartedAt: string | null;
  replacementStartedSequence: number | null;
  physicalQuiescenceMs: number | null;
  replacementStartedMs: number | null;
  stoppingStateRendered: boolean | null;
  stoppingStateText: string;
};

type ControlCancellationAudit = {
  cursor: number;
  evidencePath: string;
  fences: Map<
    string,
    {
      control: "Steer" | "Pause";
      controlRequestedSequence: number;
      physicallyStoppedSequence: number;
    }
  >;
};

async function writeControlCancellationPartialEvidence(
  audit: ControlCancellationAudit,
  evidence: Omit<ControlCancellationPartialEvidence, "schemaVersion" | "recordedAt">,
): Promise<void> {
  await writeFile(
    audit.evidencePath,
    JSON.stringify(
      {
        schemaVersion: "opengeni/workbench-control-cancellation-partial/v2",
        recordedAt: new Date().toISOString(),
        ...evidence,
      } satisfies ControlCancellationPartialEvidence,
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

async function startStoppingStateObservation(
  page: Page,
  control: "steer" | "pause",
): Promise<void> {
  await page.evaluate((observedControl) => {
    const key = "__opengeniAcceptanceStoppingStateObservationV2";
    type BrowserObservation = {
      visible: boolean;
      text: string;
      observer: MutationObserver | null;
      record: () => boolean;
    };
    const root = window as unknown as Record<string, BrowserObservation | undefined>;
    root[key]?.observer?.disconnect();
    const expectedCopy =
      observedControl === "steer"
        ? /Stopping previous (?:work|attempt)|Previous work stopping/
        : /Stopping current (?:work|attempt)|Current work stopping/;
    const observation: BrowserObservation = {
      visible: false,
      text: "",
      observer: null,
      record: () => false,
    };
    observation.record = (): boolean => {
      const element = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="session-chrome-stopping"], [data-testid="stopping-previous-attempt"]',
        ),
      ).find((candidate) => {
        if (!expectedCopy.test(candidate.textContent ?? "")) return false;
        const candidateStyle = getComputedStyle(candidate);
        return (
          candidateStyle.display !== "none" &&
          candidateStyle.visibility !== "hidden" &&
          candidateStyle.visibility !== "collapse" &&
          candidate.getClientRects().length > 0
        );
      });
      const text = element?.textContent ?? "";
      if (!element || !expectedCopy.test(text)) return false;
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        element.getClientRects().length === 0
      ) {
        return false;
      }
      observation.visible = true;
      observation.text = text;
      return true;
    };
    root[key] = observation;
    if (observation.record()) return;
    observation.observer = new MutationObserver(() => {
      if (!observation.record()) return;
      observation.observer?.disconnect();
    });
    observation.observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }, control);
}

async function finishStoppingStateObservation(
  page: Page,
): Promise<{ visible: boolean; text: string }> {
  return await page.evaluate(() => {
    const key = "__opengeniAcceptanceStoppingStateObservationV2";
    type BrowserObservation = {
      visible: boolean;
      text: string;
      observer: MutationObserver | null;
      record: () => boolean;
    };
    const root = window as unknown as Record<string, BrowserObservation | undefined>;
    const observation = root[key];
    observation?.record();
    observation?.observer?.disconnect();
    delete root[key];
    return { visible: observation?.visible ?? false, text: observation?.text ?? "" };
  });
}

export function classifyControlCommandMarkerEvent(
  event: Pick<SessionEvent, "type" | "payload">,
  marker: string,
): "running" | "completed" | "malformed" | null {
  if (event.type !== "agent.toolCall.output" || !isRecord(event.payload)) return null;
  const output = event.payload.output;
  if (typeof output !== "string" || !output.includes(marker)) return null;
  const running = /^Process running with session ID [1-9][0-9]*$/mu.test(output);
  const completed = /^Process exited with code -?[0-9]+$/mu.test(output);
  if (running && !completed) return "running";
  if (completed && !running) return "completed";
  return "malformed";
}

function isRunningControlCommandMarkerEvent(event: SessionEvent, marker: string): boolean {
  const state = classifyControlCommandMarkerEvent(event, marker);
  if (state === "completed") {
    throw new Error("the cancellation fixture command completed before control was requested");
  }
  if (state === "malformed") {
    throw new Error("the cancellation fixture command marker had no running-process receipt");
  }
  return state === "running";
}

/** Stopping copy for each control: SessionChrome's chip, or the queue's own
 * status. Neither control's copy matches the other's, and the optimistic
 * "Changing direction" state matches neither. The in-page observer repeats
 * these patterns because it runs in the browser. */
export const LIVE_STOPPING_STATE_PATTERN = {
  steer: /Stopping previous (?:work|attempt)|Previous work stopping/,
  pause: /Stopping current (?:work|attempt)|Current work stopping/,
} as const;

/** Every element that can render a stopping state. */
export const LIVE_STOPPING_SURFACES =
  '[data-testid="session-chrome-stopping"], [data-testid="stopping-previous-attempt"]';

/**
 * The production session route renders control state in SessionChrome and the
 * queue. Match their stable test ids and this control's stopping copy.
 */
export function liveStoppingStateLocator(
  page: Pick<Page, "locator">,
  control: "steer" | "pause",
): Locator {
  // Every rendered stopping surface for this control must clear, so wait on
  // the last match: hidden resolves only once no matching surface remains.
  return page
    .locator(LIVE_STOPPING_SURFACES)
    .filter({ hasText: LIVE_STOPPING_STATE_PATTERN[control] })
    .last();
}

async function proveLiveSteerCancellation(input: {
  client: OpenGeniClient;
  page: Page;
  workspaceId: string;
  sessionId: string;
  marker: string;
  iteration: number;
  verifyReplacementCapture: boolean;
  audit: ControlCancellationAudit;
  sessionTimeoutMs: number;
}): Promise<number> {
  const {
    client,
    page,
    workspaceId,
    sessionId,
    marker,
    iteration,
    verifyReplacementCapture,
    audit,
    sessionTimeoutMs,
  } = input;
  const afterSequence = (await client.getSession(workspaceId, sessionId)).lastSequence;
  const controlMarker = `CONTROL_READY_${marker}_${iteration}`;
  const terminalCommand = await installControlFixture(
    client,
    workspaceId,
    sessionId,
    marker,
    "steer",
    iteration,
  );
  const queue = await client.getQueue(workspaceId, sessionId);
  const initialAccepted = await client.sendMessage(workspaceId, sessionId, {
    text: [
      "Run the harness-provided cancellation test exactly once with exec_command and yield_time_ms 2000. Its generated artifacts test process termination. Do nothing else.",
      "The command deliberately remains active after printing its marker; wait for it to finish using only empty write_stdin calls on its session_id with yield_time_ms 30000. Do not end your turn or call wait_for_input while it runs. Ignore background command completion notices.",
      "```bash",
      terminalCommand,
      "```",
    ].join("\n"),
    controlEtag: queue.effectiveControl.controlEtag,
    clientEventId: `workbench-control-initial:${crypto.randomUUID()}`,
  });
  const ready = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    afterSequence,
    sessionTimeoutMs,
    (event) => isRunningControlCommandMarkerEvent(event, controlMarker),
    "the running live cancellation fixture command marker",
  );
  if (!ready.turnId || !ready.turnAttemptId) {
    throw new Error("control fixture output was not bound to its owning turn attempt");
  }
  assertAdoptedControlFixtureInvocation(
    await listAllSessionEventsAfter(client, workspaceId, sessionId, afterSequence),
    ready,
    terminalCommand,
    initialAccepted.id,
    "Steer",
    adoptedControlCommands(controlFixtureCustody.get(audit)),
  );
  const predecessorTurnId = ready.turnId;
  const predecessorAttemptId = ready.turnAttemptId;
  const predecessorStarted = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    afterSequence,
    10_000,
    (event) => event.type === "turn.started" && event.turnId === predecessorTurnId,
    "the predecessor turn start",
  );
  if (predecessorStarted.sequence >= ready.sequence) {
    throw new Error("control fixture output preceded its turn.start ownership event");
  }
  const initialEvents = await listAllSessionEventsAfter(
    client,
    workspaceId,
    sessionId,
    afterSequence,
  );
  if (!initialEvents.some((event) => event.id === initialAccepted.id)) {
    throw new Error("the initial control fixture prompt disappeared from canonical history");
  }

  const composer = page.getByLabel("Message the agent");
  await composer.waitFor({ timeout: 20_000 });
  const replacementCaptureOwnershipCommandV1 = `test "$(find steer-stress -type f | wc -l)" -ge 4350 && printf 'REPLACEMENT_CAPTURE_READY_${marker}_${iteration}\n'`;
  await composer.fill(
    [
      "Run exactly one terminal command and do nothing else before replying.",
      "Ignore background command completion notices.",
      "The command is read-only and proves the replacement owns the live workspace.",
      "```bash",
      replacementCaptureOwnershipCommandV1,
      "```",
      `Then reply exactly REPLACED_${marker}.`,
    ].join("\n"),
  );
  await assertSteerablePredecessor(client, page, workspaceId, sessionId, predecessorTurnId);
  const stoppingState = liveStoppingStateLocator(page, "steer");
  await startStoppingStateObservation(page, "steer"); // Steer full-fence observer
  const steerResponsePromise = page.waitForResponse(
    (response) => isLiveSteerSubmission(response, workspaceId, sessionId),
    { timeout: 30_000 },
  );
  await composer.press("Control+Enter");
  const steerResponse = await steerResponsePromise;
  if (steerResponse.status() !== 202) {
    throw new Error(`live Steer returned HTTP ${steerResponse.status()}`);
  }
  const steerResult = (await steerResponse.json()) as unknown;
  if (!isRecord(steerResult) || !isRecord(steerResult.accepted) || !isRecord(steerResult.turn)) {
    throw new Error("live Steer returned a malformed receipt");
  }
  const replacementTurnId = steerResult.turn.id;
  const committedAt = Date.parse(String(steerResult.accepted.occurredAt));
  if (typeof replacementTurnId !== "string" || !Number.isFinite(committedAt)) {
    throw new Error("live Steer receipt omitted its turn identity or commit time");
  }
  await writeControlCancellationPartialEvidence(audit, {
    control: "Steer",
    iteration,
    stage: "control-committed",
    committedAt: new Date(committedAt).toISOString(),
    predecessorTurnId,
    predecessorAttemptId,
    replacementTurnId,
    controlRequestedSequence: null,
    quiescedAt: null,
    quiescedSequence: null,
    replacementStartedAt: null,
    replacementStartedSequence: null,
    physicalQuiescenceMs: null,
    replacementStartedMs: null,
    stoppingStateRendered: null,
    stoppingStateText: "",
  });
  const observationDeadline = performance.now() + CONTROL_CANCELLATION_WORST_MS;
  const remainingBudgetMs = (label: string): number => {
    const remaining = Math.ceil(observationDeadline - performance.now());
    if (remaining <= 0) {
      throw new Error(
        `Steer ${label} exhausted the shared ${CONTROL_CANCELLATION_WORST_MS}ms control budget`,
      );
    }
    return remaining;
  };
  const quiesced = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    ready.sequence,
    remainingBudgetMs("physical quiescence"),
    steerPredecessorSettlement(predecessorTurnId, predecessorAttemptId),
    "predecessor Steer handover or physical quiescence inside the shared control budget",
  );
  const replacementStarted = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    quiesced.sequence,
    remainingBudgetMs("replacement admission"),
    (event) => event.type === "turn.started" && event.turnId === replacementTurnId,
    "replacement turn start inside the shared control budget",
  );
  const cancellationTimeline = controlCancellationTimelineMs(
    committedAt,
    Date.parse(quiesced.occurredAt),
    Date.parse(replacementStarted.occurredAt),
  );
  const renderedStoppingState = await finishStoppingStateObservation(page);
  await writeControlCancellationPartialEvidence(audit, {
    control: "Steer",
    iteration,
    stage: "physical-fence-observed",
    committedAt: new Date(committedAt).toISOString(),
    predecessorTurnId,
    predecessorAttemptId,
    replacementTurnId,
    controlRequestedSequence: null,
    quiescedAt: quiesced.occurredAt,
    quiescedSequence: quiesced.sequence,
    replacementStartedAt: replacementStarted.occurredAt,
    replacementStartedSequence: replacementStarted.sequence,
    physicalQuiescenceMs: cancellationTimeline.physicalQuiescenceMs,
    replacementStartedMs: cancellationTimeline.replacementStartedMs,
    stoppingStateRendered: renderedStoppingState.visible,
    stoppingStateText: renderedStoppingState.text,
  });
  if (cancellationTimeline.physicalQuiescenceMs > CONTROL_CANCELLATION_WORST_MS) {
    throw new Error(
      `Steer physical cancellation took ${cancellationTimeline.physicalQuiescenceMs}ms; budget is ${CONTROL_CANCELLATION_WORST_MS}ms`,
    );
  }
  if (cancellationTimeline.replacementStartedMs > CONTROL_CANCELLATION_WORST_MS) {
    throw new Error(
      `Steer replacement took ${cancellationTimeline.replacementStartedMs}ms; budget is ${CONTROL_CANCELLATION_WORST_MS}ms`,
    );
  }
  if (
    !isSteerHandoverSettlement(quiesced) &&
    cancellationTimeline.physicalQuiescenceMs > 100 &&
    !renderedStoppingState.visible
  ) {
    throw new Error(
      `Steer spent ${cancellationTimeline.physicalQuiescenceMs}ms behind the physical fence without rendering its stopping state`,
    );
  }
  await stoppingState.waitFor({ state: "hidden", timeout: 5_000 });

  const settled = await waitForSettled(client, workspaceId, sessionId, sessionTimeoutMs);
  if (settled.status !== "idle") {
    throw new Error(`replacement Steer ended in ${settled.status}`);
  }
  await releaseSteerControlFixture(client, workspaceId, sessionId, marker, iteration);
  await Bun.sleep(500);
  const finalEvents = await listAllSessionEventsAfter(
    client,
    workspaceId,
    sessionId,
    afterSequence,
  );
  if (
    !finalEvents.some(
      (event) => event.type === "turn.superseded" && event.turnId === predecessorTurnId,
    )
  ) {
    throw new Error("predecessor turn was not durably superseded");
  }
  const steerRequested = finalEvents.find(
    (event) =>
      event.type === "session.control.steer_requested" &&
      isRecord(event.payload) &&
      event.payload.targetTurnId === replacementTurnId &&
      event.payload.replacedTurnId === predecessorTurnId,
  );
  if (!steerRequested) {
    throw new Error("Steer receipt had no matching durable control-request event");
  }
  if (
    quiesced.sequence <= steerRequested.sequence ||
    quiesced.sequence >= replacementStarted.sequence
  ) {
    throw new Error("Steer quiescence receipt was outside its control-to-replacement fence");
  }
  registerControlFixtureCustody(audit, {
    mode: "steer",
    afterSequence,
    acceptedEventId: initialAccepted.id,
    ready,
    command: terminalCommand,
    control: steerRequested,
    quiesced,
    replacementTurnId,
    replacementCommand: replacementCaptureOwnershipCommandV1,
    replacementOutput: "REPLACEMENT_CAPTURE_READY_" + marker + "_" + iteration + "\n",
  });
  assertControlFixtureCustody(
    finalEvents,
    controlFixtureCustody.get(audit)!.slice(-1),
    controlFixtureCustody.get(audit)!.slice(0, -1),
  );
  audit.fences.set(predecessorAttemptId, {
    control: "Steer",
    controlRequestedSequence: steerRequested.sequence,
    physicallyStoppedSequence: quiesced.sequence,
  });
  await auditCancelledPredecessorEvents(client, workspaceId, sessionId, audit);
  if (verifyReplacementCapture) {
    const replacementCapture = await waitForCaptureTurn(
      client,
      workspaceId,
      sessionId,
      replacementTurnId,
      sessionTimeoutMs,
    );
    if (replacementCapture.stats.treeEntryCount < 4_500) {
      throw new Error(
        `replacement capture indexed only ${replacementCapture.stats.treeEntryCount} stress-tree entries`,
      );
    }
    const replacementCapturePerformancePolicyV1 =
      "contracted-user-visible-budgets-with-bounded-authoritative-availability-v1";
    if (
      !Number.isFinite(replacementCapture.stats.durationMs) ||
      replacementCapture.stats.durationMs < 0
    ) {
      throw new Error(
        `replacement capture reported invalid duration ${replacementCapture.stats.durationMs}ms under ${replacementCapturePerformancePolicyV1}`,
      );
    }
  }
  return cancellationTimeline.replacementStartedMs;
}

async function proveLivePauseCancellation(input: {
  client: OpenGeniClient;
  page: Page;
  workspaceId: string;
  sessionId: string;
  marker: string;
  audit: ControlCancellationAudit;
  sessionTimeoutMs: number;
}): Promise<number> {
  const { client, page, workspaceId, sessionId, marker, audit, sessionTimeoutMs } = input;
  const terminalCommand = await installControlFixture(
    client,
    workspaceId,
    sessionId,
    marker,
    "pause",
    0,
  );

  const afterSequence = (await client.getSession(workspaceId, sessionId)).lastSequence;
  const controlMarker = `PAUSE_READY_${marker}`;
  const zombiePath = "pause-stress/zombie-pause.txt";
  // The first execution leaves `claimed` behind before it blocks. If recovery
  // resumes the interrupted logical turn, a repeated exact command takes the
  // safe branch and cannot manufacture a false zombie after Resume.
  const pauseAccepted = await client.sendMessage(workspaceId, sessionId, {
    text: [
      "Run the harness-provided cancellation test exactly once with exec_command and yield_time_ms 2000. Its generated artifacts test process termination. Do nothing else.",
      "The command deliberately remains active after printing its marker; wait for it to finish using only empty write_stdin calls on its session_id with yield_time_ms 30000. Do not end your turn or call wait_for_input while it runs. Ignore background command completion notices.",
      "```bash",
      terminalCommand,
      "```",
    ].join("\n"),
    controlEtag: (await client.getQueue(workspaceId, sessionId)).effectiveControl.controlEtag,
    clientEventId: `workbench-pause-initial:${crypto.randomUUID()}`,
  });
  const ready = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    afterSequence,
    sessionTimeoutMs,
    (event) => isRunningControlCommandMarkerEvent(event, controlMarker),
    "the running live Pause fixture command marker",
  );
  if (!ready.turnId || !ready.turnAttemptId) {
    throw new Error("Pause fixture output was not bound to its owning turn attempt");
  }
  assertAdoptedControlFixtureInvocation(
    await listAllSessionEventsAfter(client, workspaceId, sessionId, afterSequence),
    ready,
    terminalCommand,
    pauseAccepted.id,
    "Pause",
    adoptedControlCommands(controlFixtureCustody.get(audit)),
  );
  const predecessorTurnId = ready.turnId;
  const predecessorAttemptId = ready.turnAttemptId;

  const stoppingState = liveStoppingStateLocator(page, "pause");
  await startStoppingStateObservation(page, "pause"); // Pause full-fence observer
  const pauseQueueSnapshots = observeStoppingQueueSnapshots(page, workspaceId, sessionId);
  const pauseResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname ===
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/control`
      );
    },
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Pause this workstream" }).click();
  const pauseResponse = await pauseResponsePromise;
  if (pauseResponse.status() !== 200) {
    throw new Error(`live Pause returned HTTP ${pauseResponse.status()}`);
  }
  const pauseResult = (await pauseResponse.json()) as unknown;
  if (
    !isRecord(pauseResult) ||
    !isRecord(pauseResult.receipt) ||
    !isRecord(pauseResult.effectiveControl) ||
    pauseResult.effectiveControl.state !== "paused" ||
    pauseResult.interruptionCount !== 1
  ) {
    throw new Error("live Pause returned a malformed or non-interrupting receipt");
  }
  const operationId = pauseResult.receipt.id;
  const committedAt = Date.parse(String(pauseResult.receipt.createdAt));
  if (typeof operationId !== "string" || !Number.isFinite(committedAt)) {
    throw new Error("live Pause receipt omitted its operation identity or commit time");
  }
  await writeControlCancellationPartialEvidence(audit, {
    control: "Pause",
    iteration: null,
    stage: "control-committed",
    committedAt: new Date(committedAt).toISOString(),
    predecessorTurnId,
    predecessorAttemptId,
    replacementTurnId: null,
    controlRequestedSequence: null,
    quiescedAt: null,
    quiescedSequence: null,
    replacementStartedAt: null,
    replacementStartedSequence: null,
    physicalQuiescenceMs: null,
    replacementStartedMs: null,
    stoppingStateRendered: null,
    stoppingStateText: "",
  });
  const pauseRequested = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    ready.sequence,
    CONTROL_CANCELLATION_WORST_MS,
    (event) =>
      event.type === "session.control.paused" &&
      isRecord(event.payload) &&
      event.payload.operationId === operationId,
    "the durable Pause request",
  );
  const quiesced = await waitForSessionEvent(
    client,
    workspaceId,
    sessionId,
    pauseRequested.sequence,
    CONTROL_CANCELLATION_WORST_MS,
    (event) =>
      event.type === "session.queue.changed" &&
      event.turnId === predecessorTurnId &&
      isRecord(event.payload) &&
      event.payload.operation === "attempt_quiesced",
    "Pause physical quiescence inside the 2s budget",
  );
  const controlCancellationMs = controlCancellationDurationMs(
    committedAt,
    Date.parse(quiesced.occurredAt),
  );
  const renderedStoppingState = await finishStoppingStateObservation(page);
  const pauseStoppingSnapshot = await pauseQueueSnapshots.stop(Date.now());
  console.log(
    JSON.stringify({
      status: "running",
      at: new Date().toISOString(),
      message:
        "Pause stopping state: quiesced in " +
        controlCancellationMs +
        "ms, rendered " +
        renderedStoppingState.visible +
        ", " +
        pauseStoppingSnapshot.snapshots +
        " queue snapshots, stopping snapshot lead " +
        pauseStoppingSnapshot.stoppingSnapshotLeadMs +
        "ms, paused snapshot " +
        pauseStoppingSnapshot.pausedReconciled,
    }),
  );
  await writeControlCancellationPartialEvidence(audit, {
    control: "Pause",
    iteration: null,
    stage: "physical-fence-observed",
    committedAt: new Date(committedAt).toISOString(),
    predecessorTurnId,
    predecessorAttemptId,
    replacementTurnId: null,
    controlRequestedSequence: pauseRequested.sequence,
    quiescedAt: quiesced.occurredAt,
    quiescedSequence: quiesced.sequence,
    replacementStartedAt: null,
    replacementStartedSequence: null,
    physicalQuiescenceMs: controlCancellationMs,
    replacementStartedMs: null,
    stoppingStateRendered: renderedStoppingState.visible,
    stoppingStateText: renderedStoppingState.text,
  });
  if (controlCancellationMs > CONTROL_CANCELLATION_WORST_MS) {
    throw new Error(
      `Pause physical cancellation took ${controlCancellationMs}ms; budget is ${CONTROL_CANCELLATION_WORST_MS}ms`,
    );
  }
  if (
    controlCancellationMs > PAUSE_QUEUE_RECONCILE_REQUIRED_AFTER_MS &&
    !pauseStoppingSnapshot.pausedReconciled
  ) {
    throw new Error(
      `Pause took ${controlCancellationMs}ms to stop physically but the page never reconciled the queue after Pause`,
    );
  }
  if (
    controlCancellationMs > 100 &&
    !renderedStoppingState.visible &&
    pauseStoppingSnapshot.renderRequired
  ) {
    throw new Error(
      `Pause spent ${controlCancellationMs}ms behind the physical fence without rendering its stopping state, ${pauseStoppingSnapshot.stoppingSnapshotLeadMs}ms after the page received a stopping queue snapshot`,
    );
  }
  if (
    renderedStoppingState.visible &&
    !LIVE_STOPPING_STATE_PATTERN.pause.test(renderedStoppingState.text)
  ) {
    throw new Error("Pause rendered misleading control-state copy while cancellation settled");
  }
  await stoppingState.waitFor({ state: "hidden", timeout: 5_000 });
  await page.getByText("Paused here", { exact: true }).waitFor({ timeout: 5_000 });

  const pauseCustody: ControlFixtureCustody = {
    mode: "pause",
    afterSequence,
    acceptedEventId: pauseAccepted.id,
    ready,
    command: terminalCommand,
    control: pauseRequested,
    quiesced,
    resumeOutput: "PAUSE_RESUMED_SAFE_" + marker + "\n",
  };
  registerControlFixtureCustody(audit, pauseCustody);
  audit.fences.set(predecessorAttemptId, {
    control: "Pause",
    controlRequestedSequence: pauseRequested.sequence,
    physicallyStoppedSequence: quiesced.sequence,
  });
  await Bun.sleep(6_000);
  await auditCancelledPredecessorEvents(client, workspaceId, sessionId, audit);
  const zombieProbe = await client.terminalExec(workspaceId, sessionId, {
    command: `test ! -e '${zombiePath}'`,
    cwd: "",
    timeoutMs: 20_000,
    emitStream: false,
  });
  if (zombieProbe.exitCode !== 0) {
    throw new Error("a Paused predecessor terminal process performed a delayed write");
  }

  const resumeResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname ===
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/control`
      );
    },
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Resume this workstream" }).click();
  const resumeResponse = await resumeResponsePromise;
  if (resumeResponse.status() !== 200) {
    throw new Error(`live Resume returned HTTP ${resumeResponse.status()}`);
  }
  const resumeResult = (await resumeResponse.json()) as unknown;
  if (
    !isRecord(resumeResult) ||
    !isRecord(resumeResult.effectiveControl) ||
    resumeResult.effectiveControl.state !== "active"
  ) {
    throw new Error("live Resume did not reactivate the Paused workstream");
  }
  if (!isRecord(resumeResult.receipt) || typeof resumeResult.receipt.id !== "string")
    throw new Error("Resume omitted its custody receipt");
  pauseCustody.resumeOperationId = resumeResult.receipt.id;
  const settled = await waitForSettled(client, workspaceId, sessionId, sessionTimeoutMs);
  if (settled.status !== "idle") {
    throw new Error(`resumed Pause fixture ended in ${settled.status}`);
  }
  await Bun.sleep(6_000);
  const postResumeZombieProbe = await client.terminalExec(workspaceId, sessionId, {
    command: `test ! -e '${zombiePath}'`,
    cwd: "",
    timeoutMs: 20_000,
    emitStream: false,
  });
  if (postResumeZombieProbe.exitCode !== 0) {
    throw new Error("the interrupted Pause fixture performed a delayed write after Resume");
  }
  return controlCancellationMs;
}

async function auditCancelledPredecessorEvents(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  audit: ControlCancellationAudit,
): Promise<void> {
  while (true) {
    const page = await readFixtureEventPage(client, workspaceId, sessionId, audit.cursor);
    const events = page.events;
    for (const event of events) {
      const fence = event.turnAttemptId ? audit.fences.get(event.turnAttemptId) : undefined;
      if (!fence) continue;
      if (
        event.sequence > fence.controlRequestedSequence &&
        event.type.startsWith("workspace.revision.")
      ) {
        throw new Error(
          `cancelled predecessor ${event.turnId} committed forbidden ${event.type} after ${fence.control} acceptance`,
        );
      }
      if (
        event.sequence > fence.physicallyStoppedSequence &&
        event.turnAssociation !== "late_rejected"
      ) {
        throw new Error(
          `cancelled predecessor ${event.turnId} emitted authoritative ${event.type} after ${fence.control} physical cancellation`,
        );
      }
    }
    audit.cursor = page.nextAfter;
    if (!page.hasMore) return;
  }
}

async function listAllSessionEventsAfter(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  after: number,
): Promise<Awaited<ReturnType<OpenGeniClient["listEvents"]>>> {
  const collected: Awaited<ReturnType<OpenGeniClient["listEvents"]>> = [];
  let cursor = after;
  while (true) {
    const page = await readFixtureEventPage(client, workspaceId, sessionId, cursor);
    collected.push(...page.events);
    cursor = page.nextAfter;
    if (!page.hasMore) return collected;
  }
}

export function controlCancellationDurationMs(committedAt: number, replacementStartedAt: number) {
  if (!Number.isFinite(committedAt) || !Number.isFinite(replacementStartedAt)) {
    throw new Error("control cancellation timestamps must be finite");
  }
  if (replacementStartedAt < committedAt) {
    throw new Error("physical cancellation completed before its control commit timestamp");
  }
  return replacementStartedAt - committedAt;
}

export function controlCancellationTimelineMs(
  committedAt: number,
  quiescedAt: number,
  replacementStartedAt: number,
): { physicalQuiescenceMs: number; replacementStartedMs: number } {
  const physicalQuiescenceMs = controlCancellationDurationMs(committedAt, quiescedAt);
  const replacementStartedMs = controlCancellationDurationMs(committedAt, replacementStartedAt);
  if (replacementStartedAt < quiescedAt) {
    throw new Error("replacement turn started before physical quiescence");
  }
  return { physicalQuiescenceMs, replacementStartedMs };
}

async function waitForSessionEvent(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  after: number,
  timeoutMs: number,
  predicate: (event: Awaited<ReturnType<OpenGeniClient["listEvents"]>>[number]) => boolean,
  label: string,
): Promise<Awaited<ReturnType<OpenGeniClient["listEvents"]>>[number]> {
  const deadline = Date.now() + timeoutMs;
  let cursor = after;
  while (Date.now() < deadline) {
    const page = await readFixtureEventPage(client, workspaceId, sessionId, cursor);
    const events = page.events;
    const found = events.find(predicate);
    if (found) return found;
    cursor = page.nextAfter;
    if (!page.hasMore) await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForCaptureTurn(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  timeoutMs: number,
): Promise<Extract<GetWorkspaceCaptureResponse, { available: true }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await client.getWorkspaceCapture(workspaceId, sessionId);
    if (capture.available && capture.turnId === turnId) return capture;
    if (!capture.available && capture.degradedReason)
      throw new Error(`replacement capture degraded: ${capture.degradedReason}`);
    await Bun.sleep(250);
  }
  throw new Error("replacement turn capture did not become authoritative before timeout");
}

export async function runCaptureApiRegionalProbe(
  command: string,
  request: CaptureApiRegionalProbeRequest,
): Promise<CaptureApiRegionalProbeResult> {
  const child = Bun.spawn([process.execPath, command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: captureApiRegionalProbeEnvironment(process.env),
  });
  const timeout = setTimeout(() => child.kill(), 300_000);
  timeout.unref();
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readBoundedText(child.stdout, 256 * 1024, "capture API regional probe output"),
      readBoundedText(child.stderr, 256 * 1024, "capture API regional probe diagnostics"),
      child.exited,
    ]);
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (exitCode !== 0) {
    const detail = maskKnownPublicEvidenceValues(stderr, [request.cookieHeader])
      .trim()
      .slice(0, 2_048);
    throw new Error(
      `capture API regional probe failed with exit code ${exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("capture API regional probe did not return one JSON object");
  }
  return validateCaptureApiRegionalProbeResult(value, request);
}

/**
 * Mask exact values already known to this public CI/release evidence sink.
 * This intentionally does not scan arbitrary Opengeni content for patterns.
 */
export function maskKnownPublicEvidenceValues(
  value: string,
  knownSecretValues: readonly string[],
): string {
  const secrets = [...new Set(knownSecretValues.filter((candidate) => candidate.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return secrets.reduce(
    (result, knownSecretValue) => result.replaceAll(knownSecretValue, "[masked]"),
    value,
  );
}

export function captureApiRegionalProbeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("OPENGENI_ACCEPTANCE_"),
    ),
  );
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new Error(`${label} exceeded 256 KiB`);
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function validateCaptureApiRegionalProbeResult(
  value: unknown,
  request: CaptureApiRegionalProbeRequest,
): CaptureApiRegionalProbeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture API regional probe result is not an object");
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    "apiImage",
    "apiOrigin",
    "captureRevision",
    "captureTurnId",
    "contentEncoding",
    "decodedBytes",
    "environment",
    "region",
    "runId",
    "sampleCount",
    "samplesMs",
    "schemaVersion",
    "sessionId",
    "sourceSha",
    "workspaceId",
  ];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("capture API regional probe result fields are invalid");
  }
  const exact: Array<[keyof CaptureApiRegionalProbeResult, unknown]> = [
    ["schemaVersion", "opengeni/workbench-capture-api-regional-probe/v1"],
    ["apiOrigin", new URL(request.apiUrl).origin],
    ["environment", request.environment],
    ["sourceSha", request.sourceSha],
    ["runId", request.runId],
    ["workspaceId", request.workspaceId],
    ["sessionId", request.sessionId],
    ["captureRevision", request.captureRevision],
    ["captureTurnId", request.captureTurnId],
    ["sampleCount", request.repetitions],
    ["region", request.region],
    ["apiImage", request.apiImage],
    ["contentEncoding", "gzip"],
  ];
  for (const [key, expected] of exact) {
    if (result[key] !== expected) throw new Error(`capture API regional probe ${key} mismatch`);
  }
  if (!Number.isSafeInteger(result.decodedBytes) || Number(result.decodedBytes) < 1) {
    throw new Error("capture API regional probe decoded byte count is invalid");
  }
  if (!Array.isArray(result.samplesMs) || result.samplesMs.length !== request.repetitions) {
    throw new Error("capture API regional probe sample count mismatch");
  }
  if (
    result.samplesMs.some(
      (sample) =>
        typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0 || sample > 60_000,
    )
  ) {
    throw new Error("capture API regional probe samples are invalid");
  }
  return result as CaptureApiRegionalProbeResult;
}

async function expectApiRejection(
  operation: () => Promise<unknown>,
  status: number,
  label: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof OpenGeniApiError && error.status === status) return;
    throw new Error(`${label} failed unexpectedly: ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function installManagedCookies(
  context: BrowserContext,
  header: string,
  webUrl: string,
  apiUrl: string,
): Promise<void> {
  const cookies = parseCookieHeader(header);
  const origins = [...new Set([new URL(webUrl).origin, new URL(apiUrl).origin])];
  await context.addCookies(
    origins.flatMap((url) =>
      cookies.map((cookie) => ({
        ...cookie,
        url,
        secure: true,
        httpOnly: true,
        sameSite: "Lax" as const,
      })),
    ),
  );
}

function observePage(page: Page): BrowserProblems {
  const problems: BrowserProblems = {
    console: [],
    page: [],
    failedRequests: [],
    badResponses: [],
    channelA: [],
  };
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      problems.console.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.page.push(String(error)));
  page.on("request", (request) => {
    const path = safePath(request.url());
    if (CHANNEL_A_PATH.test(path)) problems.channelA.push(path);
  });
  page.on("requestfailed", (request) => {
    const path = safePath(request.url());
    const errorText = request.failure()?.errorText ?? "unknown request failure";
    if (isExpectedBrowserCancellation(path, errorText)) return;
    problems.failedRequests.push({
      method: request.method(),
      errorText,
      path,
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.badResponses.push(`${response.status()} ${safePath(response.url())}`);
    }
  });
  return problems;
}

export function isExpectedBrowserCancellation(path: string, errorText: string): boolean {
  if (errorText !== "net::ERR_ABORTED") return false;
  return (
    CAPTURE_FILE_PATH.test(path) ||
    OPTIONAL_ANALYTICS_CHUNK_PATH.test(path) ||
    MANAGED_SESSION_PATH.test(path)
  );
}

const acceptanceUuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// A background GET the browser aborted is a client-side cancellation
// (navigation, unmount, superseded query). Server and transport failures
// surface as other net:: errors or as bad responses, and aborted document
// loads (pages, iframes, previews) are never benign; all still fail acceptance.
function isClientCancelledBackgroundGetV8(failure: BrowserRequestFailure): boolean {
  return (
    failure.method === "GET" &&
    failure.errorText === "net::ERR_ABORTED" &&
    failure.resourceType !== "document"
  );
}
const optionalCapabilityResponse = new RegExp(
  `^(?:403 /v1/workspaces/${acceptanceUuid}/(?:github/app|machines)|404 /v1/workspaces/${acceptanceUuid}/sessions/${acceptanceUuid}/goal)$`,
  "i",
);

function expectedResourceConsole(response: string): string | undefined {
  const status = /^(403|404) /.exec(response)?.[1];
  return status
    ? `Failed to load resource: the server responded with a status of ${status} ()`
    : undefined;
}

function assertNoProblems(problems: BrowserProblems, requireZeroChannelA: boolean): void {
  const console = [...problems.console];
  const badResponses = problems.badResponses.filter((response) => {
    if (!optionalCapabilityResponse.test(response)) return true;
    const expectedConsole = expectedResourceConsole(response);
    const consoleIndex = expectedConsole ? console.indexOf(expectedConsole) : -1;
    if (consoleIndex >= 0) console.splice(consoleIndex, 1);
    return false;
  });
  const active = {
    console,
    page: problems.page,
    failedRequests: problems.failedRequests.filter(
      (failure) => !isClientCancelledBackgroundGetV8(failure),
    ),
    badResponses,
    channelA: requireZeroChannelA ? problems.channelA : [],
  };
  if (Object.values(active).some((items) => items.length > 0)) {
    throw new Error(`browser acceptance problems: ${JSON.stringify(active)}`);
  }
}

export async function openWorkspaceIfCollapsed(page: Page): Promise<void> {
  const workspace = page.locator(WORKSPACE_SURFACE_SELECTOR);
  if (await workspace.isVisible()) return;

  // The standalone SDK dock owns an "Open workspace" control. The hosted app
  // controls the same collapsed state from its session header instead, so the
  // dock intentionally omits that duplicate button. Acceptance must exercise
  // whichever public affordance the mounted surface exposes.
  const open = page
    .getByRole("button", { name: "Show session panel" })
    .or(page.getByTitle("Open workspace"))
    .first();
  await open.waitFor({ state: "visible", timeout: 20_000 });
  await open.click();
}

export async function assertChangesDefaultVisible(page: Page): Promise<void> {
  const changes = page.getByRole("tab", { name: /Changes/ });
  await changes.waitFor({ state: "visible", timeout: 20_000 });
  await page
    .getByRole("tab", { name: /Changes/, selected: true })
    .waitFor({ state: "visible", timeout: 20_000 });

  await page.locator(CHANGES_LAYOUT_SELECTOR).waitFor({
    state: "visible",
    timeout: 20_000,
  });
}

async function selectChangesTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /Changes/ }).click();
  await page.locator(CHANGES_LAYOUT_SELECTOR).waitFor({
    state: "visible",
    timeout: 20_000,
  });
}

type FileTreeObservation = {
  id: string;
  label: string;
  level: number | null;
  expanded: boolean | null;
};

function normalizeFileTreeLabel(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, FILE_TREE_DIAGNOSTIC_FIELD_LENGTH);
}

async function readActiveFileTreeItem(
  page: Page,
  tree: Locator,
): Promise<{ activeId: string; item: Locator; observation: FileTreeObservation } | undefined> {
  const activeId = await tree.getAttribute("aria-activedescendant");
  if (!activeId) return undefined;

  const item = page.locator(`[id=${JSON.stringify(activeId)}]`);
  await item.waitFor({ state: "visible", timeout: 2_000 });
  const rawLevel = await item.getAttribute("aria-level");
  const level = Number(rawLevel);
  const rawExpanded = await item.getAttribute("aria-expanded");
  return {
    activeId,
    item,
    observation: {
      id: activeId.slice(0, FILE_TREE_DIAGNOSTIC_FIELD_LENGTH),
      label: normalizeFileTreeLabel(await item.textContent()),
      level: Number.isInteger(level) && level >= 1 ? level : null,
      expanded: rawExpanded === null ? null : rawExpanded === "true",
    },
  };
}

function rememberFileTreeObservation(
  observations: FileTreeObservation[],
  observation: FileTreeObservation,
): void {
  const previous = observations[observations.length - 1];
  if (
    previous?.id === observation.id &&
    previous.label === observation.label &&
    previous.level === observation.level &&
    previous.expanded === observation.expanded
  ) {
    return;
  }
  observations.push(observation);
  if (observations.length > FILE_TREE_MAX_DIAGNOSTIC_ROWS) observations.shift();
}

function fileTreeSelectionError(
  directory: string,
  file: string,
  reason: string,
  observations: readonly FileTreeObservation[],
): Error {
  return new Error(
    `file tree could not select ${directory}/${file}: ${reason}; observations=${JSON.stringify(observations)}`,
  );
}

export async function selectTreeFile(page: Page, directory: string, file: string): Promise<void> {
  const directoryItem = page.getByRole("treeitem").filter({ hasText: directory }).first();
  const directoryVisible = await directoryItem.isVisible();
  if (directoryVisible && (await directoryItem.getAttribute("aria-expanded")) !== "true") {
    await directoryItem.getByRole("button").first().click();
  }

  // The Files tree is virtualized: an expanded directory can truthfully contain
  // a file whose row is not mounted until keyboard navigation scrolls it into
  // view. Prefer the direct click when the row is already visible, then exercise
  // the tree's public composite-keyboard contract instead of assuming every
  // logical row permanently exists in the DOM.
  const fileItem = page.getByRole("treeitem").filter({ hasText: file }).first();
  if (directoryVisible && (await fileItem.isVisible())) {
    await fileItem.getByRole("button").click();
    return;
  }

  const tree = page.getByRole("tree").first();
  await tree.waitFor({ state: "visible", timeout: 20_000 });
  await tree.focus();
  await tree.press("Home");

  if (!(await tree.getAttribute("aria-activedescendant"))) {
    // A cold Files tab can mount the composite before its async capture rows
    // hydrate. Wait on the ARIA readiness contract rather than sleeping or
    // assuming the first virtual row already exists.
    await page.locator(FILE_TREE_READY_SELECTOR).first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await tree.focus();
    await tree.press("Home");
  }

  const observations: FileTreeObservation[] = [];
  let directoryLevel: number | undefined;
  let directoryFailureReason = `directory traversal exceeded ${FILE_TREE_MAX_NAVIGATION_STEPS} steps`;
  for (let index = 0; index < FILE_TREE_MAX_NAVIGATION_STEPS; index += 1) {
    const active = await readActiveFileTreeItem(page, tree);
    if (!active) {
      directoryFailureReason = "the tree lost its active descendant during directory traversal";
      break;
    }
    rememberFileTreeObservation(observations, active.observation);
    if ((await active.item.getByText(directory, { exact: true }).count()) > 0) {
      if (active.observation.level === null) {
        throw fileTreeSelectionError(
          directory,
          file,
          `directory ${directory} has no valid aria-level`,
          observations,
        );
      }
      directoryLevel = active.observation.level;
      if (active.observation.expanded !== true) {
        await tree.press("ArrowRight");
      }
      await page
        .locator(
          `[id=${JSON.stringify(active.activeId)}][aria-expanded="true"]:not([aria-busy="true"])`,
        )
        .waitFor({ state: "visible", timeout: 20_000 });
      await tree.press("ArrowDown");
      const childId = await tree.getAttribute("aria-activedescendant");
      if (!childId) {
        throw fileTreeSelectionError(
          directory,
          file,
          `directory ${directory} lost the active descendant after expansion`,
          observations,
        );
      }
      if (childId === active.activeId) {
        throw fileTreeSelectionError(
          directory,
          file,
          `directory ${directory} exposed no navigable child after expansion`,
          observations,
        );
      }
      break;
    }

    await tree.press("ArrowDown");
    const nextActiveId = await tree.getAttribute("aria-activedescendant");
    if (!nextActiveId) {
      directoryFailureReason = "the tree lost its active descendant during directory traversal";
      break;
    }
    if (nextActiveId === active.activeId) {
      directoryFailureReason = "navigation stalled at the tree boundary";
      break;
    }
  }

  if (directoryLevel === undefined) {
    throw fileTreeSelectionError(directory, file, directoryFailureReason, observations);
  }

  let fileFailureReason = `file traversal exceeded ${FILE_TREE_MAX_NAVIGATION_STEPS} steps`;
  for (let index = 0; index < FILE_TREE_MAX_NAVIGATION_STEPS; index += 1) {
    const active = await readActiveFileTreeItem(page, tree);
    if (!active) {
      fileFailureReason = "the tree lost its active descendant during file traversal";
      break;
    }
    rememberFileTreeObservation(observations, active.observation);
    if (active.observation.level === null) {
      throw fileTreeSelectionError(
        directory,
        file,
        `tree item ${active.observation.id} has no valid aria-level`,
        observations,
      );
    }
    if (active.observation.level <= directoryLevel) {
      fileFailureReason = `navigation left the ${directory} subtree`;
      break;
    }
    if ((await active.item.getByText(file, { exact: true }).count()) > 0) {
      await tree.press("Enter");
      return;
    }

    await tree.press("ArrowDown");
    const nextActiveId = await tree.getAttribute("aria-activedescendant");
    if (!nextActiveId) {
      fileFailureReason = "the tree lost its active descendant during file traversal";
      break;
    }
    if (nextActiveId === active.activeId) {
      fileFailureReason = `navigation stalled inside the ${directory} subtree`;
      break;
    }
  }
  throw fileTreeSelectionError(directory, file, fileFailureReason, observations);
}

async function assertColdReview(page: Page, marker: string): Promise<void> {
  await assertChangesDefaultVisible(page);
  await assertRepositoryChangesVisible(page, ["api", "web"]);

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await selectTreeFile(page, "api", "server.ts");
  await waitForSandboxFileViewerText(page, "api/server.ts", marker, 15_000);

  await selectTreeFile(page, "api", "base.txt");
  await waitForSandboxFileViewerText(page, "api/base.txt", "On machine", 15_000);
  await page
    .locator(SANDBOX_FILES_VIEWER_SELECTOR)
    .getByRole("button", { name: "Open live file" })
    .waitFor();
}

export async function assertRepositoryChangesVisible(
  page: Page,
  repositoryRoots: readonly string[],
): Promise<void> {
  const layout = page.locator(CHANGES_LAYOUT_SELECTOR);
  const mode = await layout.getAttribute("data-workbench-changes-layout");
  if (mode === "rail") {
    for (const root of repositoryRoots) {
      await page.getByText(root, { exact: true }).first().waitFor();
    }
    return;
  }
  if (mode === "compact") {
    const picker = page.locator("[data-compact-file-picker]");
    await picker.waitFor({ state: "visible", timeout: 20_000 });
    assertChangedFileLabelsContainRepositoryRoots(
      await picker.locator("option").allTextContents(),
      repositoryRoots,
    );
    return;
  }
  throw new Error(`unsupported workbench changes layout: ${mode ?? "missing"}`);
}

export function assertChangedFileLabelsContainRepositoryRoots(
  labels: readonly string[],
  repositoryRoots: readonly string[],
): void {
  for (const root of repositoryRoots) {
    if (!labels.some((label) => label.includes(`${root}/`))) {
      throw new Error(`compact workbench changes omitted repository ${root}`);
    }
  }
}

async function assertAccessibility(page: Page): Promise<void> {
  // Bun currently resolves Axe's Playwright peer to a second declaration copy.
  // The runtime Page is the same protocol object; erase only that duplicate-type
  // identity at this boundary instead of weakening the script's Page type.
  const report = await new AxeBuilder({ page: page as never })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const manuallyAuditedContrastTargets = new Set(
    await markIncompleteContrastTargetsForManualAudit(
      page,
      report.incomplete
        .filter((rule) => rule.id === "color-contrast")
        .flatMap((rule) => rule.nodes.map((node) => node.target)),
    ),
  );
  const manuallyAuditedSessionListTargets = new Set(
    await markIncompleteSessionListsForManualAudit(
      page,
      report.incomplete
        .filter((rule) => rule.id === "aria-required-children")
        .flatMap((rule) => rule.nodes.map((node) => node.target)),
    ),
  );
  const manual = await manualAccessibilityAudit(page);
  if (report.violations.length > 0) {
    throw new Error(
      `axe violations: ${report.violations.map((item) => `${item.id}:${item.nodes.length}`).join(",")}`,
    );
  }
  const unexpectedIncomplete = report.incomplete.flatMap((rule) =>
    rule.nodes
      .filter((node) => {
        const target = JSON.stringify(node.target);
        if (rule.id === "aria-valid-attr-value") return false;
        if (rule.id === "aria-required-children") {
          return !manuallyAuditedSessionListTargets.has(target);
        }
        if (rule.id === "color-contrast") {
          return (
            !manuallyAuditedContrastTargets.has(target) &&
            !target.includes("diffs-container") &&
            !target.includes("data-line-number-content") &&
            !target.includes("data-contrast-audited") &&
            !node.html.includes("data-contrast-audited")
          );
        }
        return true;
      })
      .map((node) => ({ id: rule.id, target: node.target })),
  );
  if (unexpectedIncomplete.length > 0) {
    throw new Error(
      `axe incomplete checks require resolution: ${JSON.stringify(unexpectedIncomplete)}`,
    );
  }
  if (manual.missingAriaControls.length > 0) {
    throw new Error(
      `aria-controls references missing elements: ${JSON.stringify(manual.missingAriaControls)}`,
    );
  }
  if (
    manual.minimumContrast === null &&
    report.incomplete.some((rule) => rule.id === "color-contrast")
  ) {
    throw new Error("manual contrast audit produced no measurements for axe-incomplete content");
  }
  if (manual.minimumContrast !== null && manual.minimumContrast < 4.5) {
    throw new Error(`manual text contrast ${manual.minimumContrast} is below WCAG AA 4.5:1`);
  }
}

export function axeManualContrastSelector(target: unknown): string | null {
  if (!Array.isArray(target) || target.length !== 1 || typeof target[0] !== "string") return null;
  const selector = target[0].trim();
  return selector.length > 0 ? selector : null;
}

async function markIncompleteContrastTargetsForManualAudit(
  page: Page,
  targets: readonly unknown[],
): Promise<string[]> {
  const candidates = targets.flatMap((target) => {
    const selector = axeManualContrastSelector(target);
    return selector ? [{ selector, serializedTarget: JSON.stringify(target) }] : [];
  });
  return page.evaluate((browserCandidates) => {
    const audited: string[] = [];
    for (const { selector, serializedTarget } of browserCandidates) {
      try {
        const visibleMatches = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
          (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          },
        );
        if (visibleMatches.length === 0) continue;
        for (const element of visibleMatches) {
          element.setAttribute("data-contrast-audited", "");
        }
        audited.push(serializedTarget);
      } catch {
        // Invalid or non-DOM Axe target paths remain unresolved and fail below.
      }
    }
    return audited;
  }, candidates);
}

async function markIncompleteSessionListsForManualAudit(
  page: Page,
  targets: readonly unknown[],
): Promise<string[]> {
  return page.evaluate((candidates) => {
    const audited: string[] = [];
    for (const target of candidates) {
      if (!Array.isArray(target) || target.length !== 1 || typeof target[0] !== "string") {
        continue;
      }
      try {
        const matches = Array.from(document.querySelectorAll<HTMLElement>(target[0]));
        if (matches.length !== 1) continue;
        const element = matches[0]!;
        const isVisible = (candidate: HTMLElement): boolean => {
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const label = element.getAttribute("aria-label") ?? "";
        const children = Array.from(element.children);
        const owner = element.parentElement;
        const expectedOwnerLabel = label.endsWith(" sessions")
          ? label.slice(0, -" sessions".length)
          : "";
        const populatedListIsValid =
          children.length > 0 &&
          isVisible(element) &&
          children.every((child) => child.getAttribute("role") === "listitem");
        const emptyListHasVisibleOwner =
          children.length === 0 &&
          owner instanceof HTMLElement &&
          owner.getAttribute("role") === "group" &&
          owner.getAttribute("aria-label") === expectedOwnerLabel &&
          isVisible(owner);
        if (
          element.getAttribute("role") !== "list" ||
          !label.endsWith(" sessions") ||
          (!populatedListIsValid && !emptyListHasVisibleOwner)
        ) {
          continue;
        }
        element.setAttribute("data-session-list-owner-audited", "");
        audited.push(JSON.stringify(target));
      } catch {
        // Invalid, ambiguous, orphaned, or malformed targets remain unresolved.
      }
    }
    return audited;
  }, targets);
}

async function assertTouchTargets(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  const undersized = await page.evaluate(findUndersizedTouchTargets);
  if (undersized.length > 0)
    throw new Error(`undersized touch targets: ${JSON.stringify(undersized)}`);
}

/** Runs in the page, so it must stay self-contained. A compact control may
 * extend its tap area beyond its painted box, for example with a pseudo-element
 * over its row's padding. Judge what a tap actually reaches: every probe at the
 * edges and corners of the 44 px square around the control's centre must hit
 * the control itself, so clipping or an overlapping neighbour still fails.
 * Inert content takes no taps or focus, so it holds no touch targets: on a
 * narrow screen the open workspace covers the chat and makes it inert, and only
 * the workspace's own controls can be tapped. Those are still checked. */
export function findUndersizedTouchTargets(): Array<{
  label: string | undefined;
  width: number;
  height: number;
}> {
  const minimum = 44;
  const reachesMinimum = (element: HTMLElement, rect: DOMRect) => {
    const half = minimum / 2 - 1;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const probes: Array<[number, number]> = [
      [x, y - half],
      [x, y + half],
      [x - half, y],
      [x + half, y],
      [x - half, y - half],
      [x + half, y - half],
      [x - half, y + half],
      [x + half, y + half],
    ];
    return probes.every(([probeX, probeY]) => {
      const hit = document.elementFromPoint(probeX, probeY);
      return hit !== null && (hit === element || element.contains(hit));
    });
  };
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'button:not([disabled]),select:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),a[href],[role=button],[role=tab]',
    ),
  )
    .filter((element) => {
      if (element.closest("[inert]")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width >= minimum && rect.height >= minimum) return [];
      if (reachesMinimum(element, rect)) return [];
      return [
        {
          label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      ];
    });
}

async function manualAccessibilityAudit(page: Page): Promise<{
  missingAriaControls: string[];
  minimumContrast: number | null;
}> {
  return page.evaluate(() => {
    const missingAriaControls = Array.from(
      document.querySelectorAll<HTMLElement>("[aria-controls]"),
    )
      .map((element) => element.getAttribute("aria-controls"))
      .filter((id): id is string => Boolean(id && !document.getElementById(id)));

    type Rgba = [red: number, green: number, blue: number, alpha: number];
    const toRgba = (color: string): Rgba => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(from ${color} r g b / alpha)`;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const values = resolved.match(/[\d.]+/g)?.map(Number) ?? [];
      const channels = resolved.startsWith("rgb")
        ? values.slice(0, 3).map((value) => value / 255)
        : values.slice(0, 3);
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, values[3] ?? 1];
    };
    const luminance = (color: readonly number[]) => {
      const channels = color
        .slice(0, 3)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    };
    const blend = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) /
          alpha,
        alpha,
      ];
    };
    const backgroundBehind = (element: Element): Rgba => {
      const layers: Rgba[] = [];
      let current: Element | null = element;
      while (current) {
        layers.push(toRgba(getComputedStyle(current).backgroundColor));
        const root = current.getRootNode();
        current =
          current.parentElement ?? (root instanceof ShadowRoot ? (root.host as Element) : null);
      }
      const darkCanvas = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      let composite: Rgba = darkCanvas ? [0, 0, 0, 1] : [1, 1, 1, 1];
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        composite = blend(layers[index]!, composite);
      }
      return composite;
    };
    const contrast = (element: Element) => {
      const background = backgroundBehind(element);
      const foreground = blend(toRgba(getComputedStyle(element).color), background);
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };

    const ratios: number[] = [];
    for (const host of document.querySelectorAll("diffs-container")) {
      for (const textLeaf of host.shadowRoot?.querySelectorAll("*") ?? []) {
        const hasDirectText = Array.from(textLeaf.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        );
        const style = getComputedStyle(textLeaf);
        const rect = textLeaf.getBoundingClientRect();
        if (
          hasDirectText &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          ratios.push(contrast(textLeaf));
        }
      }
    }
    for (const audited of document.querySelectorAll("[data-contrast-audited]")) {
      ratios.push(contrast(audited));
    }
    return {
      missingAriaControls,
      minimumContrast: ratios.length > 0 ? Math.min(...ratios) : null,
    };
  });
}

function sessionUrl(webUrl: string, workspaceId: string, sessionId: string): string {
  return `${webUrl}/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function measurement(values: number[]): Measurement {
  if (values.length === 0) throw new Error("measurement requires samples");
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    unit: "ms",
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    worst: round(sorted.at(-1)!),
  };
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function getJson<T>(url: URL, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function artifact(path: string, root: string): Promise<Artifact> {
  const bytes = await readFile(path);
  return {
    file: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  };
}

function pass(checks: Check[], id: string, detail: string): void {
  checks.push({ id, status: "passed", observedAt: new Date().toISOString(), detail });
}

function progress(message: string): void {
  process.stdout.write(
    `${JSON.stringify({ status: "running", at: new Date().toISOString(), message })}\n`,
  );
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function httpsOrigin(value: string, flag: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${flag} must be a credential-free HTTPS origin`);
  }
  return url.origin;
}

function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required secret ${name} is not configured`);
  return value;
}

function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "[invalid-url]";
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) await main();
