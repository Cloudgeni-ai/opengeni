import {
  OpenGeniApiError,
  OpenGeniClient,
  type BrowserObservation,
  type BrowserSession,
} from "@opengeni/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Settings } from "../packages/config/src/index";
import { createObjectStorage } from "../packages/storage/src/index";

const TIMEOUT_MS = 120_000;

type Args = {
  apiUrl: string;
  workspaceId: string | null;
  output: string;
};

type Receipt = {
  schemaVersion: "opengeni/interaction-identity-live-acceptance/v1";
  generatedAt: string;
  workspaceId: string;
  identityId: string;
  sourceBrowserSessionId: string;
  defaultConsumerBrowserSessionId: string;
  explicitConsumerBrowserSessionId: string;
  concurrentDefaultConsumerBrowserSessionId: string;
  selectedDefaultConsumerBrowserSessionId: string;
  defaultRevisionId: string;
  explicitRevisionId: string;
  checks: string[];
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accessKey = process.env.OPENGENI_INTERACTION_ACCEPTANCE_ACCESS_KEY?.trim();
  const client = new OpenGeniClient({
    baseUrl: args.apiUrl,
    ...(accessKey ? { headers: { "x-opengeni-access-key": accessKey } } : {}),
  });
  const workspaceId = args.workspaceId ?? (await defaultWorkspace(args.apiUrl));
  const runId = crypto.randomUUID();
  const markerV1 = `IDENTITY_V1_${runId.replaceAll("-", "_").toUpperCase()}`;
  const markerV2 = `IDENTITY_V2_${runId.replaceAll("-", "_").toUpperCase()}`;
  const fixture = await createFixture(runId);
  const browsers: Array<ReturnType<typeof client.interaction.browsers.session>> = [];
  const checks: string[] = [];

  try {
    const sourceSessionId = await createSessionShell(client, workspaceId, runId, "source");
    const source = await client.interaction.browsers.open(workspaceId, {
      operationId: crypto.randomUUID(),
      sessionId: sourceSessionId,
      name: `Identity source ${runId.slice(0, 8)}`,
      initialUrl: `${fixture.url}#set=${encodeURIComponent(markerV1)}`,
      headless: true,
    });
    browsers.push(source);
    let sourceState = await waitForState(source, markerV1);
    assertState(sourceState.observation, markerV1);
    checks.push("source.v1-cookie-local-storage-indexeddb");

    const identity = await client.interaction.identities.create(workspaceId, {
      operationId: crypto.randomUUID(),
      name: `Identity acceptance ${runId.slice(0, 8)}`,
    });
    const emptyIdentity = await identity.get();
    const savedV1 = await source.publishRevision({
      operationId: crypto.randomUUID(),
      identityId: identity.id,
      expectedHeadGeneration: emptyIdentity.headGeneration,
      advanceDefault: true,
    });
    if (
      savedV1.outcome !== "saved_as_default" ||
      savedV1.identity.defaultRevisionId !== savedV1.revision.id ||
      savedV1.revision.ordinal !== 1
    ) {
      throw new Error("first browser revision was not published as immutable default v1");
    }
    checks.push("revision.v1-default");

    await waitForActive(source);
    sourceState = await navigateAndWait(
      source,
      `${fixture.url}#set=${encodeURIComponent(markerV2)}`,
      markerV2,
    );
    assertState(sourceState.observation, markerV2);
    const savedV2 = await source.publishRevision({
      operationId: crypto.randomUUID(),
      identityId: identity.id,
      expectedHeadGeneration: savedV1.identity.headGeneration,
      advanceDefault: false,
    });
    if (
      savedV2.outcome !== "saved_not_default" ||
      savedV2.identity.defaultRevisionId !== savedV1.revision.id ||
      savedV2.revision.parentRevisionId !== savedV1.revision.id ||
      savedV2.revision.ordinal !== 2
    ) {
      throw new Error("second browser revision did not preserve v1 as the default");
    }
    checks.push("revision.v2-non-default-linear-history");

    const listed = await identity.revisions();
    const listedRevisionIds = new Set(listed.revisions.map((revision) => revision.id));
    if (
      listed.identity.headGeneration !== savedV1.identity.headGeneration ||
      listed.identity.revisionCount !== 2 ||
      listedRevisionIds.size !== 2 ||
      !listedRevisionIds.has(savedV1.revision.id) ||
      !listedRevisionIds.has(savedV2.revision.id)
    ) {
      throw new Error("identity revision list did not expose the exact immutable history");
    }
    checks.push("revision.public-list-exact");

    const defaultConsumerSessionId = await createSessionShell(
      client,
      workspaceId,
      runId,
      "default-consumer",
    );
    const defaultConsumer = await client.interaction.browsers.open(workspaceId, {
      operationId: crypto.randomUUID(),
      sessionId: defaultConsumerSessionId,
      name: `Identity default consumer ${runId.slice(0, 8)}`,
      initialUrl: `${fixture.url}#expect=${encodeURIComponent(markerV1)}`,
      headless: true,
      identityId: identity.id,
    });
    browsers.push(defaultConsumer);
    const defaultSession = await waitForActive(defaultConsumer);
    if (defaultSession.baseRevisionId !== savedV1.revision.id) {
      throw new Error("identity-only browser did not resolve the default revision");
    }
    const defaultState = await waitForState(defaultConsumer, markerV1);
    assertState(defaultState.observation, markerV1);
    checks.push("restore.default-fresh-modal-sandbox");

    const explicitConsumerSessionId = await createSessionShell(
      client,
      workspaceId,
      runId,
      "explicit-consumer",
    );
    const explicitConsumer = await client.interaction.browsers.open(workspaceId, {
      operationId: crypto.randomUUID(),
      sessionId: explicitConsumerSessionId,
      name: `Identity explicit consumer ${runId.slice(0, 8)}`,
      initialUrl: `${fixture.url}#expect=${encodeURIComponent(markerV2)}`,
      headless: true,
      identityId: identity.id,
      baseRevisionId: savedV2.revision.id,
    });
    browsers.push(explicitConsumer);
    const explicitSession = await waitForActive(explicitConsumer);
    if (explicitSession.baseRevisionId !== savedV2.revision.id) {
      throw new Error("explicit browser revision was not preserved by placement");
    }
    const explicitState = await waitForState(explicitConsumer, markerV2);
    assertState(explicitState.observation, markerV2);
    checks.push("restore.explicit-fresh-modal-sandbox");

    const concurrentHead = (await identity.get()).headGeneration;
    const leftOperationId = crypto.randomUUID();
    const rightOperationId = crypto.randomUUID();
    const [left, right] = await Promise.all([
      defaultConsumer.publishRevision({
        operationId: leftOperationId,
        identityId: identity.id,
        expectedHeadGeneration: concurrentHead,
        advanceDefault: true,
      }),
      explicitConsumer.publishRevision({
        operationId: rightOperationId,
        identityId: identity.id,
        expectedHeadGeneration: concurrentHead,
        advanceDefault: true,
      }),
    ]);
    if (
      new Set([left.outcome, right.outcome]).size !== 2 ||
      ![left.outcome, right.outcome].includes("saved_as_default") ||
      ![left.outcome, right.outcome].includes("saved_not_default")
    ) {
      throw new Error("concurrent identity publications did not elect exactly one default");
    }
    if (
      left.revision.parentRevisionId !== savedV1.revision.id ||
      right.revision.parentRevisionId !== savedV2.revision.id ||
      left.revision.id === right.revision.id
    ) {
      throw new Error("concurrent identity publications did not preserve independent branches");
    }
    const replay = await defaultConsumer.publishRevision({
      operationId: leftOperationId,
      identityId: identity.id,
      expectedHeadGeneration: concurrentHead,
      advanceDefault: true,
    });
    if (
      !replay.replayed ||
      replay.revision.id !== left.revision.id ||
      replay.outcome !== left.outcome
    ) {
      throw new Error("identity publication replay created a different result");
    }
    const concurrentHistory = await identity.revisions();
    const winner = left.outcome === "saved_as_default" ? left : right;
    if (
      concurrentHistory.identity.defaultRevisionId !== winner.revision.id ||
      concurrentHistory.identity.headGeneration !== concurrentHead + 1 ||
      concurrentHistory.identity.revisionCount !== 4 ||
      new Set(concurrentHistory.revisions.map((revision) => revision.id)).size !== 4
    ) {
      throw new Error("concurrent identity history did not converge on the elected default");
    }
    checks.push("revision.concurrent-branches-single-default", "revision.replay-exactly-once");

    await Promise.all([waitForActive(defaultConsumer), waitForActive(explicitConsumer)]);
    const concurrentDefaultSessionId = await createSessionShell(
      client,
      workspaceId,
      runId,
      "concurrent-default-consumer",
    );
    const concurrentDefault = await client.interaction.browsers.open(workspaceId, {
      operationId: crypto.randomUUID(),
      sessionId: concurrentDefaultSessionId,
      name: `Identity concurrent default ${runId.slice(0, 8)}`,
      initialUrl: `${fixture.url}#expect=${encodeURIComponent(
        winner.revision.id === left.revision.id ? markerV1 : markerV2,
      )}`,
      headless: true,
      identityId: identity.id,
    });
    browsers.push(concurrentDefault);
    const concurrentDefaultSession = await waitForActive(concurrentDefault);
    if (concurrentDefaultSession.baseRevisionId !== winner.revision.id) {
      throw new Error("fresh browser did not materialize the concurrent default winner");
    }
    const winningMarker = winner.revision.id === left.revision.id ? markerV1 : markerV2;
    assertState((await waitForState(concurrentDefault, winningMarker)).observation, winningMarker);
    checks.push("restore.concurrent-default-winner-fresh-modal-sandbox");

    const beforeSelection = await identity.get();
    const selectionOperationId = crypto.randomUUID();
    const selected = await identity.update({
      operationId: selectionOperationId,
      expectedVersion: beforeSelection.version,
      defaultRevisionId: savedV2.revision.id,
    });
    if (
      selected.identity.version !== beforeSelection.version + 1 ||
      selected.identity.defaultRevisionId !== savedV2.revision.id ||
      selected.identity.headGeneration !== beforeSelection.headGeneration + 1 ||
      selected.replayed
    ) {
      throw new Error("selecting a future default did not advance exact identity authority");
    }
    const selectedReplay = await identity.update({
      operationId: selectionOperationId,
      expectedVersion: beforeSelection.version,
      defaultRevisionId: savedV2.revision.id,
    });
    if (
      !selectedReplay.replayed ||
      selectedReplay.identity.version !== selected.identity.version ||
      selectedReplay.identity.defaultRevisionId !== selected.identity.defaultRevisionId
    ) {
      throw new Error("default-selection replay did not return the exact prior result");
    }
    checks.push("identity.select-future-default-cas", "identity.select-default-replay-exact");

    const archived = await identity.update({
      operationId: crypto.randomUUID(),
      expectedVersion: selected.identity.version,
      status: "archived",
    });
    const [activeList, archivedList] = await Promise.all([
      client.interaction.identities.list(workspaceId),
      client.interaction.identities.list(workspaceId, { includeArchived: true }),
    ]);
    if (
      archived.identity.status !== "archived" ||
      activeList.identities.some((candidate) => candidate.id === identity.id) ||
      !archivedList.identities.some(
        (candidate) => candidate.id === identity.id && candidate.status === "archived",
      )
    ) {
      throw new Error("archived BrowserIdentity visibility did not match the public contract");
    }
    const archivedConsumerSessionId = await createSessionShell(
      client,
      workspaceId,
      runId,
      "archived-consumer",
    );
    let archivedRejected = false;
    try {
      await client.interaction.browsers.open(workspaceId, {
        operationId: crypto.randomUUID(),
        sessionId: archivedConsumerSessionId,
        name: `Identity archived consumer ${runId.slice(0, 8)}`,
        headless: true,
        identityId: identity.id,
      });
    } catch (cause) {
      archivedRejected = cause instanceof OpenGeniApiError && cause.status === 409;
    }
    if (!archivedRejected) throw new Error("an archived BrowserIdentity remained launchable");
    checks.push("identity.archive-hidden-and-unlaunchable");

    const restored = await identity.update({
      operationId: crypto.randomUUID(),
      expectedVersion: archived.identity.version,
      status: "active",
    });
    if (
      restored.identity.status !== "active" ||
      restored.identity.defaultRevisionId !== savedV2.revision.id
    ) {
      throw new Error("restoring BrowserIdentity changed its explicitly selected default");
    }
    const selectedDefaultConsumerSessionId = await createSessionShell(
      client,
      workspaceId,
      runId,
      "selected-default-consumer",
    );
    const selectedDefaultConsumer = await client.interaction.browsers.open(workspaceId, {
      operationId: crypto.randomUUID(),
      sessionId: selectedDefaultConsumerSessionId,
      name: `Identity selected default ${runId.slice(0, 8)}`,
      initialUrl: `${fixture.url}#expect=${encodeURIComponent(markerV2)}`,
      headless: true,
      identityId: identity.id,
    });
    browsers.push(selectedDefaultConsumer);
    const selectedDefaultSession = await waitForActive(selectedDefaultConsumer);
    if (selectedDefaultSession.baseRevisionId !== savedV2.revision.id) {
      throw new Error("restored identity did not materialize its explicitly selected default");
    }
    assertState((await waitForState(selectedDefaultConsumer, markerV2)).observation, markerV2);
    checks.push(
      "identity.restore-preserves-default",
      "restore.selected-default-fresh-modal-sandbox",
    );

    const receipt: Receipt = {
      schemaVersion: "opengeni/interaction-identity-live-acceptance/v1",
      generatedAt: new Date().toISOString(),
      workspaceId,
      identityId: identity.id,
      sourceBrowserSessionId: source.id,
      defaultConsumerBrowserSessionId: defaultConsumer.id,
      explicitConsumerBrowserSessionId: explicitConsumer.id,
      concurrentDefaultConsumerBrowserSessionId: concurrentDefault.id,
      selectedDefaultConsumerBrowserSessionId: selectedDefaultConsumer.id,
      defaultRevisionId: savedV1.revision.id,
      explicitRevisionId: savedV2.revision.id,
      checks,
    };
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: "passed", output: args.output, checks }) + "\n");
  } finally {
    await Promise.allSettled(
      browsers.map((browser) => browser.end({ operationId: crypto.randomUUID() })),
    );
    await fixture.dispose();
  }
}

async function createSessionShell(
  client: OpenGeniClient,
  workspaceId: string,
  runId: string,
  role: string,
): Promise<string> {
  const session = await client.createSession(workspaceId, {
    startMode: "realtime",
    sandboxBackend: "modal",
    sandbox: "new",
    rigId: null,
    idempotencyKey: `interaction-identity-live:${runId}:${role}`,
    metadata: { origin: "interaction-identity-live-acceptance", runId, role },
  });
  return session.id;
}

async function navigateAndWait(
  browser: ReturnType<OpenGeniClient["interaction"]["browsers"]["session"]>,
  url: string,
  marker: string,
): Promise<{ session: BrowserSession; observation: BrowserObservation }> {
  const { session, observation } = await currentObservation(browser);
  const receipt = await browser.act({
    operationId: crypto.randomUUID(),
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    action: { type: "navigate", url },
  });
  if (receipt.state !== "completed") {
    throw new Error(`fixture navigation settled as ${receipt.state}`);
  }
  return await waitForState(browser, marker, session);
}

async function waitForState(
  browser: ReturnType<OpenGeniClient["interaction"]["browsers"]["session"]>,
  marker: string,
  knownSession?: BrowserSession,
): Promise<{ session: BrowserSession; observation: BrowserObservation }> {
  const deadline = performance.now() + TIMEOUT_MS;
  let current = await currentObservation(browser, knownSession);
  while (!semanticText(current.observation).includes(expectedState(marker))) {
    if (performance.now() >= deadline) {
      throw new Error(
        `browser state did not restore ${marker}; observed ${JSON.stringify(semanticText(current.observation).slice(0, 500))}`,
      );
    }
    await Bun.sleep(100);
    current = await currentObservation(browser);
  }
  return current;
}

async function currentObservation(
  browser: ReturnType<OpenGeniClient["interaction"]["browsers"]["session"]>,
  knownSession?: BrowserSession,
): Promise<{ session: BrowserSession; observation: BrowserObservation }> {
  const session = knownSession ?? (await waitForActive(browser));
  const targets = await browser.tabs.list();
  const target = targets.targets.find((candidate) => candidate.selected) ?? targets.targets[0];
  if (!target) throw new Error("identity browser opened without a page target");
  return { session, observation: await browser.observe(target.id) };
}

async function waitForActive(
  browser: ReturnType<OpenGeniClient["interaction"]["browsers"]["session"]>,
): Promise<BrowserSession> {
  const deadline = performance.now() + TIMEOUT_MS;
  let session = await browser.get();
  while (session.lifecycle !== "active" || !session.controller) {
    if (session.lifecycle === "ended")
      throw new Error("identity browser ended before becoming active");
    if (performance.now() >= deadline) throw new Error("identity browser did not become active");
    await Bun.sleep(100);
    session = await browser.get();
  }
  return session;
}

function assertState(observation: BrowserObservation, marker: string): void {
  const text = semanticText(observation);
  if (!text.includes(expectedState(marker))) {
    throw new Error(`restored browser state was incomplete: ${JSON.stringify(text.slice(0, 500))}`);
  }
}

function expectedState(marker: string): string {
  return `cookie=${marker} local=${marker} idb=${marker}`;
}

function semanticText(observation: BrowserObservation): string {
  const semantic = observation.semantic;
  const pending =
    semantic?.kind === "snapshot"
      ? [...(semantic.roots ?? [])]
      : semantic?.kind === "diff"
        ? [...(semantic.changed ?? [])]
        : [];
  const values: string[] = [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.name) values.push(node.name);
    if (typeof node.value === "string") values.push(node.value);
    if (node.description) values.push(node.description);
    pending.unshift(...(node.children ?? []));
  }
  return values.join(" ");
}

async function createFixture(runId: string): Promise<{ url: string; dispose(): Promise<void> }> {
  const localEndpoint = requiredEnv("OPENGENI_OBJECT_STORAGE_ENDPOINT");
  // This is the exact endpoint used by ordinary sandbox object URLs. The dev
  // stack resolves it to its worktree-scoped Cloudflare edge and writes it to
  // .env.runtime; deployments resolve it to their configured object endpoint.
  // Identity acceptance must exercise that canonical path rather than inventing
  // a second fixture tunnel with separate discovery and failure modes.
  const publicEndpoint = requiredEnv("OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT");
  const storage = createObjectStorage({
    objectStorageBackend: "s3-compatible",
    objectStorageBucket: requiredEnv("OPENGENI_OBJECT_STORAGE_BUCKET"),
    objectStorageRegion: process.env.OPENGENI_OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    objectStorageForcePathStyle:
      process.env.OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE?.trim() !== "false",
    objectStorageEndpoint: localEndpoint,
    objectStorageSandboxEndpoint: publicEndpoint,
    objectStorageInternalEndpoint: null,
    objectStorageAccessKeyId: requiredEnv("OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID"),
    objectStorageSecretAccessKey: requiredEnv("OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY"),
  } as Settings);
  if (!storage) throw new Error("object storage is not configured");
  const key = `acceptance/browser-identity/${runId}.html`;
  await storage.putObject({
    key,
    contentType: "text/html; charset=utf-8",
    body: new TextEncoder().encode(identityFixtureHtml()),
  });
  const { url } = await storage.createGetUrl({
    key,
    audience: "sandbox",
    expiresInSeconds: 3_600,
  });
  return {
    url,
    dispose: async () => {
      await storage.deleteObject(key).catch(() => undefined);
    },
  };
}

function identityFixtureHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>OpenGeni identity acceptance</title>
<h1>Browser identity acceptance</h1>
<div id="state">loading</div>
<script>
const state = document.querySelector("#state");
const request = indexedDB.open("opengeni-identity-acceptance", 1);
request.onupgradeneeded = () => request.result.createObjectStore("state");
request.onerror = () => { state.textContent = "indexeddb-error"; };
request.onsuccess = () => {
  const db = request.result;
  const render = () => {
    const setting = new URLSearchParams(location.hash.slice(1)).get("set");
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    if (setting) {
      document.cookie = "og_identity=" + encodeURIComponent(setting) + "; Path=/; SameSite=Lax";
      localStorage.setItem("og_identity", setting);
      store.put(setting, "marker");
    }
    tx.oncomplete = () => {
      const read = db.transaction("state").objectStore("state").get("marker");
      read.onsuccess = () => {
        const cookie = decodeURIComponent((document.cookie.match(/(?:^|; )og_identity=([^;]*)/) || [])[1] || "missing");
        const local = localStorage.getItem("og_identity") || "missing";
        state.textContent = "cookie=" + cookie + " local=" + local + " idb=" + (read.result || "missing");
      };
    };
  };
  addEventListener("hashchange", render);
  render();
};
</script>`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set(["--api-url", "--workspace-id", "--output"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag ${flag}`);
  const apiUrl = new URL(values.get("--api-url") ?? "http://127.0.0.1:8200").origin;
  return {
    apiUrl,
    workspaceId: values.get("--workspace-id") ?? null,
    output: resolve(
      values.get("--output") ?? `.agent/evidence/interaction-identity-live-${Date.now()}.json`,
    ),
  };
}

async function defaultWorkspace(apiUrl: string): Promise<string> {
  const response = await fetch(new URL("/v1/access/me", apiUrl));
  if (!response.ok) throw new Error(`access discovery returned ${response.status}`);
  const value = (await response.json()) as { defaultWorkspaceId?: unknown };
  if (typeof value.defaultWorkspaceId !== "string" || !value.defaultWorkspaceId) {
    throw new Error("access discovery did not return a default workspace");
  }
  return value.defaultWorkspaceId;
}

void main().catch((cause: unknown) => {
  const message =
    cause instanceof OpenGeniApiError ? `${cause.status} ${cause.message}` : String(cause);
  process.stderr.write(`interaction identity acceptance failed: ${message}\n`);
  process.exitCode = 1;
});
