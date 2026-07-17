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
  type WorkspaceCaptureManifest,
} from "@opengeni/sdk";
import { assertScreenshotPainted } from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const REQUIRED_PERMISSIONS = [
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
const SETTLED = new Set(["idle", "failed", "error", "cancelled"]);
const CHANNEL_A_PATH = /\/sessions\/[^/]+\/(?:fs|git|terminal)\//;
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

type BrowserProblems = {
  console: string[];
  page: string[];
  failedRequests: string[];
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
  checks: Check[];
  measurements: {
    captureApiResponse: Measurement;
    captureUsableWorkbench: Measurement;
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

export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"')]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url-redacted]";
      }
    })
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(sig|signature|token|se|sp|sv)=[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 500);
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
  assertWorkspacePermissions(cookieAccess, workspaceId);
  assertWorkspacePermissions(tokenAccess, workspaceId);
  pass(
    checks,
    "security.auth-preflight",
    "Dedicated cookie and bearer principals resolve to the same allowed workspace and account.",
  );

  const cookieClient = new OpenGeniClient({
    baseUrl: args.apiUrl,
    headers: { cookie: cookieHeader },
  });
  const marker = `OPENGENI_WORKBENCH_${args.runId.replaceAll("-", "_").toUpperCase()}`;
  const session = await cookieClient.createSession(workspaceId, {
    initialMessage: fixturePrompt(marker),
    model: args.model,
    reasoningEffort: "low",
    sandboxBackend: args.backend,
    sandbox: "new",
    idempotencyKey: `workbench-acceptance:${args.environment}:${args.sourceSha}:${args.runId}`,
    metadata: {
      origin: "workbench-live-acceptance",
      acceptanceRunId: args.runId,
      acceptanceSourceSha: args.sourceSha,
    },
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
  pass(checks, "functional.real-cold-lease", "The real Modal lease reached cold before UI review.");

  const captureApiSamples = await measureCaptureApi(
    cookieClient,
    workspaceId,
    session.id,
    args.repetitions,
  );
  const captureApiResponse = measurement(captureApiSamples);
  if (captureApiResponse.p95 > 200) {
    throw new Error(`capture API p95 ${captureApiResponse.p95}ms exceeds 200ms`);
  }

  const browser = await chromium.launch();
  const artifacts: Artifact[] = [];
  let captureUsableWorkbench: Measurement;
  try {
    const navigationSamples: number[] = [];
    for (let index = 0; index < args.repetitions; index += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installManagedCookies(context, cookieHeader, args.webUrl, args.apiUrl);
      const page = await context.newPage();
      const problems = observePage(page);
      const started = performance.now();
      await page.goto(sessionUrl(args.webUrl, workspaceId, session.id), {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await openWorkspaceIfCollapsed(page);
      await page.locator("[data-workbench-changes-layout]").waitFor({ timeout: 20_000 });
      navigationSamples.push(performance.now() - started);
      assertNoProblems(problems, true);
      await context.close();
    }
    captureUsableWorkbench = measurement(navigationSamples);
    if (captureUsableWorkbench.p95 > 500) {
      throw new Error(
        `capture-backed usable workbench p95 ${captureUsableWorkbench.p95}ms exceeds 500ms`,
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
      await page.locator("[data-workbench-changes-layout]").waitFor({ timeout: 20_000 });
      await assertColdReview(page, marker);
      await assertAccessibility(page);
      await assertTouchTargets(page, device.mobile);
      const filesScreenshot = resolve(args.outputDir, `${device.name}-cold-files.png`);
      const filesPng = await page
        .locator("[data-workspace-surface]")
        .screenshot({ path: filesScreenshot });
      await assertScreenshotPainted(page, filesPng, `${device.name} cold Files`);
      artifacts.push(await artifact(filesScreenshot, args.outputDir));

      await page.getByRole("tab", { name: /Changes/ }).click();
      await page.locator("[data-workbench-changes-layout]").waitFor();
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
    if (afterPassiveBrowser.liveness !== "cold") {
      throw new Error("passive browser acceptance unexpectedly warmed the sandbox");
    }
    pass(
      checks,
      "functional.capture-cold-zero-channel-a",
      "Fresh desktop/mobile browsers rendered capture-backed Changes and Files with zero Channel-A requests and left the lease cold.",
    );

    await runLiveWorkspaceFlow({
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
    checks,
    measurements: { captureApiResponse, captureUsableWorkbench },
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

export function fixturePrompt(marker: string): string {
  const script = String.raw`set -euo pipefail
rm -rf api web web-linked nested
mkdir -p api web nested/deep/repo
git -C api init -q
git -C api config user.email canary@opengeni.dev
git -C api config user.name "OpenGeni Acceptance"
git -C api config commit.gpgsign false
printf 'node_modules/\ndist/\n' > api/.gitignore
printf 'export const marker = "BASE";\nexport const status = 200;\n' > api/server.ts
printf 'tracked but untouched\n' > api/base.txt
printf '#!/bin/sh\necho base\n' > api/run.sh
chmod +x api/run.sh
git -C api add -A
git -C api commit -q -m base
printf 'export const marker = "${marker}";\nexport const status = 204;\n' > api/server.ts
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
git -C web config user.name "OpenGeni Acceptance"
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
git -C nested/deep/repo config user.name "OpenGeni Acceptance"
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
  return [
    "Run this exact bash script once in the workspace root. Do not alter, summarize, or split it.",
    "After the command succeeds, stop. The exact final marker must be present.",
    "```bash",
    script,
    "```",
  ].join("\n");
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

function assertWorkspacePermissions(context: AccessContext, workspaceId: string): void {
  const grant = context.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  if (!grant) throw new Error("acceptance principal has no workspace grant");
  const missing = REQUIRED_PERMISSIONS.filter(
    (permission) => !grant.permissions.includes(permission),
  );
  if (missing.length > 0) throw new Error(`acceptance principal lacks: ${missing.join(", ")}`);
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

async function waitForCapture(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<Extract<GetWorkspaceCaptureResponse, { available: true }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await client.getWorkspaceCapture(workspaceId, sessionId);
    if (capture.available) return capture;
    if (capture.degradedReason) throw new Error(`capture degraded: ${capture.degradedReason}`);
    await Bun.sleep(1_000);
  }
  throw new Error("capture did not become available before timeout");
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

async function waitForCold(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capabilities = await client.getStreamCapabilities(workspaceId, sessionId);
    if (capabilities.liveness === "cold") return;
    await Bun.sleep(2_000);
  }
  throw new Error("real sandbox did not drain to cold before timeout");
}

async function waitForWarm(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capabilities = await client.getStreamCapabilities(workspaceId, sessionId);
    if (capabilities.liveness === "warm" || capabilities.liveness === "draining") return;
    await Bun.sleep(1_000);
  }
  throw new Error("explicit live intent did not warm the sandbox before timeout");
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
}): Promise<void> {
  const { browser, cookieHeader, client, args, workspaceId, sessionId, marker, checks, artifacts } =
    input;
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await installManagedCookies(context, cookieHeader, args.webUrl, args.apiUrl);
  const page = await context.newPage();
  const problems = observePage(page);
  try {
    await page.goto(sessionUrl(args.webUrl, workspaceId, sessionId), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await openWorkspaceIfCollapsed(page);
    await page.locator("[data-workbench-changes-layout]").waitFor({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await selectTreeFile(page, "api", "base.txt");
    await page.getByText("On machine", { exact: true }).waitFor();
    const channelABeforeWake = problems.channelA.length;
    await page.getByRole("button", { name: "Open live file" }).click();
    await waitForWarm(client, workspaceId, sessionId);
    await page.getByText("tracked but untouched", { exact: false }).waitFor({ timeout: 30_000 });
    if (problems.channelA.length <= channelABeforeWake) {
      throw new Error("explicit live-file action warmed no observable Channel-A file request");
    }
    pass(
      checks,
      "functional.explicit-wake",
      "An untouched captured path remained gated until the user opened it live, then the real sandbox warmed and served it.",
    );

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

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator("[data-opengeni-code-editor]");
    await editor.waitFor({ timeout: 30_000 });
    const editable = editor.locator(".cm-content");
    await editable.waitFor({ timeout: 30_000 });
    await editable.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\nui edit ${marker}`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
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
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nlocal conflict candidate");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
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
    const terminalInput = page.locator(".xterm-helper-textarea");
    await terminalInput.waitFor({ timeout: 30_000 });
    await terminalInput.click();
    const terminalMarker = `TERMINAL_${marker}`;
    await page.keyboard.type(`printf '${terminalMarker}\\n'`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (expected) => document.querySelector(".xterm-rows")?.textContent?.includes(String(expected)),
      terminalMarker,
      { timeout: 30_000 },
    );
    pass(
      checks,
      "functional.terminal-roundtrip",
      "The deployed interactive terminal accepted input and rendered the exact deterministic output.",
    );

    if (args.environment === "staging") {
      const desktopTab = page.getByRole("tab", { name: "Desktop", exact: true });
      if ((await desktopTab.count()) !== 1)
        throw new Error("staging Modal session has no Desktop tab");
      await desktopTab.click();
      const consent = page.getByRole("button", { name: "I understand — show the desktop" });
      if ((await consent.count()) === 1) await consent.click();
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

    assertNoProblems(problems, false);
    const liveShot = resolve(args.outputDir, "desktop-live-workbench.png");
    const livePng = await page.locator("[data-workspace-surface]").screenshot({ path: liveShot });
    await assertScreenshotPainted(page, livePng, "live desktop workbench");
    artifacts.push(await artifact(liveShot, args.outputDir));
  } finally {
    await context.close();
  }
}

async function measureCaptureApi(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  repetitions: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    const response = await client.getWorkspaceCapture(workspaceId, sessionId);
    samples.push(performance.now() - started);
    if (!response.available) throw new Error(`capture disappeared during repetition ${index}`);
  }
  return samples;
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
    throw new Error(`${label} failed unexpectedly: ${sanitizeDiagnostic(String(error))}`, {
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
      problems.console.push(sanitizeDiagnostic(message.text()));
    }
  });
  page.on("pageerror", (error) => problems.page.push(sanitizeDiagnostic(String(error))));
  page.on("request", (request) => {
    const path = safePath(request.url());
    if (CHANNEL_A_PATH.test(path)) problems.channelA.push(path);
  });
  page.on("requestfailed", (request) => problems.failedRequests.push(safePath(request.url())));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.badResponses.push(`${response.status()} ${safePath(response.url())}`);
    }
  });
  return problems;
}

function assertNoProblems(problems: BrowserProblems, requireZeroChannelA: boolean): void {
  const active = {
    ...problems,
    channelA: requireZeroChannelA ? problems.channelA : [],
  };
  if (Object.values(active).some((items) => items.length > 0)) {
    throw new Error(`browser acceptance problems: ${JSON.stringify(active)}`);
  }
}

async function openWorkspaceIfCollapsed(page: Page): Promise<void> {
  const open = page.getByTitle("Open workspace");
  if ((await open.count()) > 0 && (await open.first().isVisible())) await open.first().click();
}

async function selectTreeFile(page: Page, directory: string, file: string): Promise<void> {
  const directoryItem = page.getByRole("treeitem").filter({ hasText: directory }).first();
  const directoryButton = directoryItem.getByRole("button").first();
  if ((await directoryButton.getAttribute("aria-expanded")) !== "true") {
    await directoryButton.click();
  }
  await page.getByRole("treeitem").filter({ hasText: file }).first().getByRole("button").click();
}

async function assertColdReview(page: Page, marker: string): Promise<void> {
  const changes = page.getByRole("tab", { name: /Changes/ });
  if ((await changes.getAttribute("aria-selected")) !== "true") await changes.click();
  await page.locator("[data-workbench-changes-layout]").waitFor();
  await page.getByText("api", { exact: true }).first().waitFor();
  await page.getByText("web", { exact: true }).first().waitFor();

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await selectTreeFile(page, "api", "server.ts");
  await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 15_000 });

  await selectTreeFile(page, "api", "base.txt");
  await page.getByText("On machine", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open live file" }).waitFor();
}

async function assertAccessibility(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
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
        if (rule.id === "color-contrast") {
          return (
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

async function assertTouchTargets(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  const undersized = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'button:not([disabled]),select:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),a[href],[role=button],[role=tab]',
      ),
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44),
  );
  if (undersized.length > 0)
    throw new Error(`undersized touch targets: ${JSON.stringify(undersized)}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) await main();
