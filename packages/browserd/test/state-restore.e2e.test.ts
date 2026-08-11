import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  BrowserRevisionMaterialization,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  BrowserSupervisor,
  type BrowserProfileManifest,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "preserves cookie, localStorage, and IndexedDB through a fresh encrypted profile restore",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-state-restore-e2e-");
    const key = Buffer.alloc(32, 0x51);
    const aad = Buffer.from("browser-state:e2e:immutable-revision", "utf8");
    let uploaded: Buffer | null = null;
    const web = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 30,
      fetch(request) {
        if (new URL(request.url).pathname === "/profile.ogbs") {
          return uploaded
            ? new Response(new Uint8Array(uploaded), {
                headers: { "content-length": String(uploaded.byteLength) },
              })
            : new Response("missing", { status: 404 });
        }
        return new Response(identityFixture(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(directory, "state"),
      uploadArtifact: async (path) => {
        uploaded = await readFile(path);
      },
    });
    const source = reference(1);
    const target = reference(2);
    const origin = web.url.toString().replace(/\/$/u, "");
    try {
      const created = await supervisor.createSession({
        ...source,
        headed: false,
        initialUrl: `${origin}/account`,
      });
      const initialized = await supervisor.action(
        command(created.observation, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Initialize identity" },
        }),
      );
      expect(initialized.state).toBe("completed");
      const ready = await waitForSemanticName(
        supervisor,
        source,
        created.observation.target.id,
        "cookie=present local=present idb=present",
      );
      expect(semanticNames(ready)).toContain("cookie=present local=present idb=present");

      const operationId = randomUUID();
      const objectKey = `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/revisions/${operationId}/chromium-profile.ogbs`;
      const captured = await supervisor.captureState({
        ...source,
        operationId,
        objectKey,
        afterCapture: "restart",
        dataKey: key,
        aad,
        upload: {
          url: `${origin}/ignored-upload`,
          requiredHeaders: {
            "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(uploaded).not.toBeNull();
      await supervisor.endSession(source, { removeState: true });

      const restored = await supervisor.createSession({
        ...target,
        headed: false,
        restore: {
          objectKey,
          format: captured.format,
          artifactDigest: captured.artifactDigest,
          contentDigest: captured.contentDigest,
          manifestDigest: canonicalDigest(captured.manifest),
          sizeBytes: captured.sizeBytes,
          dataKey: key,
          aad,
          materialization: materialization(captured.manifest),
          download: {
            url: `${origin}/profile.ogbs?signature=private`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
      const observed = await waitForSemanticName(
        supervisor,
        target,
        restored.observation.target.id,
        "cookie=present local=present idb=present",
      );
      expect(observed.target.url).toBe(`${origin}/account`);
      expect(semanticNames(observed)).toContain("cookie=present local=present idb=present");
    } finally {
      await supervisor.close().catch(() => undefined);
      web.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

function reference(sequence: number) {
  return {
    browserSessionId: `11111111-1111-4111-8111-${sequence.toString().padStart(12, "0")}`,
    controllerGeneration: `controller-${sequence}`,
  };
}

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "system", subjectId: "browser-state-restore-e2e" },
    action,
  };
}

function materialization(manifest: BrowserProfileManifest): BrowserRevisionMaterialization {
  const placementBound = manifest.profileCrypto === "platform_bound";
  return {
    portability: placementBound ? "placement_bound" : "portable",
    reason: placementBound ? "Profile encryption depends on this placement." : null,
    platform: manifest.platform,
    architecture: manifest.architecture,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    driverId: manifest.driverId,
    driverSchemaVersion: manifest.driverSchemaVersion,
    profileCrypto: manifest.profileCrypto,
    providerId: null,
    placement: placementBound
      ? {
          kind: "sandbox_group",
          sandboxGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }
      : null,
  };
}

function semanticNames(observation: BrowserObservation): string[] {
  if (observation.semantic?.kind !== "snapshot") return [];
  const names: string[] = [];
  const visit = (node: InteractionSemanticNodeValue) => {
    if (node.name) names.push(node.name);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of observation.semantic.roots) visit(root);
  return names;
}

async function waitForSemanticName(
  supervisor: BrowserSupervisor,
  referenceValue: ReturnType<typeof reference>,
  targetId: string,
  expected: string,
): Promise<BrowserObservation> {
  const deadline = Date.now() + 10_000;
  let last: BrowserObservation | null = null;
  while (Date.now() < deadline) {
    last = await supervisor.observe(referenceValue, targetId);
    if (semanticNames(last).includes(expected)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`browser identity state did not appear: ${JSON.stringify(last)}`);
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, canonicalValue(input[key])]),
  );
}

function identityFixture(): string {
  return `<!doctype html>
    <title>Identity fixture</title>
    <button id="initialize">Initialize identity</button>
    <p id="status">loading</p>
    <script>
      const status = document.getElementById('status');
      const readIndexedDb = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('opengeni-identity', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('state', 'readonly');
          const get = tx.objectStore('state').get('authenticated');
          get.onerror = () => reject(get.error);
          get.onsuccess = () => resolve(get.result || 'missing');
        };
      });
      const writeIndexedDb = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('opengeni-identity', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('state', 'readwrite');
          tx.objectStore('state').put('present', 'authenticated');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
      const render = async () => {
        const cookie = document.cookie.includes('auth_cookie=present') ? 'present' : 'missing';
        const local = localStorage.getItem('authenticated') || 'missing';
        const idb = await readIndexedDb();
        status.textContent = 'cookie=' + cookie + ' local=' + local + ' idb=' + idb;
      };
      document.getElementById('initialize').onclick = async () => {
        document.cookie = 'auth_cookie=present; path=/; SameSite=Lax';
        localStorage.setItem('authenticated', 'present');
        await writeIndexedDb();
        await render();
      };
      render();
    </script>`;
}
