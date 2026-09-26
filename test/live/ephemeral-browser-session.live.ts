import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserActionReceipt,
  BrowserObservation,
  BrowserSessionMutationResponse,
  BrowserTargetListResponse,
  EPHEMERAL_CHROMIUM_DRIVER_ID,
  signDelegatedAccessToken,
  type BrowserSession,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  readLease,
  type DbClient,
} from "@opengeni/db";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { SessionWorkflowClient } from "@opengeni/core";
import { createApp } from "../../apps/api/src/app";

// Explicitly supply a disposable image built from THIS source revision, with
// OPENGENI_BROWSERD_EPHEMERAL_CONTEXT_POOL=1 in its environment. Never run against
// a production API or mutate a shared image. Alternatively use an explicitly
// isolated disposable Linux sandbox with loopback PostgreSQL and a locally
// installed controller from this source. Missing opt-in is a visible skip.
const image = process.env.OPENGENI_EPHEMERAL_BROWSER_CANARY_IMAGE?.trim();
const isolatedLocal = process.env.OPENGENI_EPHEMERAL_BROWSER_CANARY_LOCAL === "1";
const enabled = Boolean(image) || isolatedLocal;
const secret = "ephemeral-browser-live-delegation-secret";
let shared: SharedTestDatabase | null = null;
let client: DbClient;
beforeAll(async () => {
  if (!enabled) return;
  if (
    isolatedLocal &&
    (process.platform !== "linux" || process.env.OPENGENI_EPHEMERAL_BROWSER_CANARY_ISOLATED !== "1")
  ) {
    throw new Error("local canary requires an explicitly isolated disposable Linux environment");
  }
  const isolatedDatabaseUrl = process.env.OPENGENI_EPHEMERAL_BROWSER_CANARY_DATABASE_URL;
  if (isolatedDatabaseUrl) {
    const url = new URL(isolatedDatabaseUrl);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.startsWith("/og_ephemeral_")
    ) {
      throw new Error("explicit canary database must be a loopback og_ephemeral_* fixture");
    }
    client = createDb(isolatedDatabaseUrl);
    return;
  }
  if (isolatedLocal)
    throw new Error("isolated local canary requires its own loopback PostgreSQL fixture");
  shared = await acquireSharedTestDatabase("ephemeral-browser-live");
  if (!shared) throw new Error("ephemeral BrowserSession acceptance requires PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("ephemeral BrowserSession public HTTP acceptance", () => {
  (enabled ? test : test.skip)(
    "isolates actors and contexts, rejects replay mutation, preserves peer after end",
    async () => {
      const suffix = crypto.randomUUID();
      const bootstrap = {
        accountExternalSource: "test",
        accountExternalId: `ephemeral-${suffix}`,
        accountName: "Ephemeral acceptance",
        workspaceExternalSource: "test",
        workspaceExternalId: `ephemeral-${suffix}`,
        workspaceName: "Ephemeral acceptance",
      };
      const first = await bootstrapWorkspace(client.db, { ...bootstrap, subjectId: "actor-a" });
      await bootstrapWorkspace(client.db, { ...bootstrap, subjectId: "actor-b" });
      const grant = first.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;
      const source = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "Disposable browser acceptance",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: isolatedLocal ? "local" : "docker",
      });
      const settings = testSettings({
        productAccessMode: "managed",
        delegationSecret: secret,
        sandboxBackend: isolatedLocal ? "local" : "docker",
        ...(image ? { dockerImage: image } : {}),
        sandboxOwnershipEnabled: true,
        sandboxIdleGraceMs: 1_000,
        experimentalBrowserContextPoolEnabled: true,
      });
      const dependencies = {
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        managedAuth: null,
        workflowClient: {
          signalUserMessage: async () => undefined,
          wakeSessionWorkflow: async () => undefined,
          signalApprovalDecision: async () => undefined,
          signalSessionControl: async () => undefined,
          syncScheduledTask: async () => undefined,
          deleteScheduledTaskSchedule: async () => undefined,
          triggerScheduledTask: async () => undefined,
        } as unknown as SessionWorkflowClient,
      };
      const router = createApp(dependencies);
      const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: router.fetch });
      const app = {
        request: (path: string, init?: RequestInit) => fetch(new URL(path, http.url), init),
      };
      const disabledApp = createApp({
        ...dependencies,
        settings: { ...settings, experimentalBrowserContextPoolEnabled: false },
      });
      const headers = async (subjectId: string, authorizedWorkspaceId = workspaceId) => ({
        authorization: `Bearer ${await signDelegatedAccessToken(secret, {
          accountId: grant.accountId,
          workspaceId: authorizedWorkspaceId,
          subjectId,
          permissions: [
            "sessions:read",
            "sessions:control",
            "stream:view",
            "files:read",
            "files:upload",
          ],
          principalKind: "human_session",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        })}`,
        "content-type": "application/json",
        origin: "http://localhost:3000",
      });
      const actors = { a: await headers("actor-a"), b: await headers("actor-b") };
      const path = `/v1/workspaces/${workspaceId}/browser-sessions`;
      const fixture = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const set = url.searchParams.get("set");
          const cookie = request.headers.get("cookie") ?? "";
          const who = set ?? /(?:^|;\s*)actor=([^;]+)/u.exec(cookie)?.[1] ?? "empty";
          return new Response(
            `<!doctype html><meta charset="utf-8"><style>body{font:28px sans-serif;background:#eef3fa;padding:32px}main{background:white;border:3px solid #345;padding:24px}</style><main><h1 id="state">Loading</h1><canvas width="200" height="80"></canvas></main><script>
          const setting=${JSON.stringify(set)};
          if(setting)localStorage.setItem('actor',setting);
          document.title='Cookie ${who} / Storage '+(localStorage.getItem('actor')||'empty');
          document.getElementById('state').textContent=document.title;
          const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#458';c.fillRect(8,8,150,60);
          </script>`,
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                ...(set ? { "set-cookie": `actor=${set}; HttpOnly; SameSite=Lax; Path=/` } : {}),
              },
            },
          );
        },
      });
      const fixtureUrl = `http://${isolatedLocal ? "127.0.0.1" : "host.docker.internal"}:${fixture.port}/`;
      const created: { session: BrowserSession; headers: typeof actors.a }[] = [];
      let containerId: string | null = null;
      let primary: unknown;
      const cleanupErrors: unknown[] = [];
      async function json(response: Response, status: number) {
        const body = await response.json();
        expect({ status: response.status, body }).toMatchObject({ status });
        return body;
      }
      async function post(id: string, routeSuffix: string, body: unknown, auth = actors.a) {
        return app.request(`${path}/${id}${routeSuffix}`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        });
      }
      async function observe(id: string, auth = actors.a) {
        const targets = BrowserTargetListResponse.parse(
          await json(await app.request(`${path}/${id}/targets`, { headers: auth }), 200),
        );
        expect(targets.targets).toHaveLength(1);
        const target = targets.targets[0]!;
        return BrowserObservation.parse(
          await json(
            await app.request(`${path}/${id}/targets/${target.id}/observation`, { headers: auth }),
            200,
          ),
        );
      }
      async function navigate(id: string, url: string, auth = actors.a) {
        const observed = await observe(id, auth);
        const receipt = BrowserActionReceipt.parse(
          await json(
            await post(
              id,
              "/actions",
              {
                operationId: crypto.randomUUID(),
                targetId: observed.target.id,
                expectedTargetGeneration: observed.target.targetGeneration,
                expectedDocumentGeneration: observed.target.documentGeneration,
                expectedFrameId: observed.frameId,
                action: { type: "navigate", url },
              },
              auth,
            ),
            200,
          ),
        );
        expect(receipt.state).toBe("completed");
        return observe(id, auth);
      }
      try {
        const input = {
          operationId: crypto.randomUUID(),
          sessionId: source.id,
          storageMode: "ephemeral_context",
          headless: true,
        };
        const denied = await disabledApp.request(path, {
          method: "POST",
          headers: actors.a,
          body: JSON.stringify(input),
        });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(denied.status).toBeLessThan(500);
        expect(await readLease(client.db, workspaceId, source.sandboxGroupId)).toBeNull();
        for (const [label, auth] of [
          ["alpha", actors.a],
          ["sibling", actors.a],
          ["bravo", actors.b],
        ] as const) {
          const body = {
            ...input,
            operationId: crypto.randomUUID(),
            name: label,
            initialUrl: `${fixtureUrl}?set=${label}`,
          };
          const response = await app.request(path, {
            method: "POST",
            headers: auth,
            body: JSON.stringify(body),
          });
          const lease = await readLease(client.db, workspaceId, source.sandboxGroupId);
          containerId = lease?.instanceId ?? null;
          const result = BrowserSessionMutationResponse.parse(await json(response, 201));
          created.push({ session: result.session, headers: auth });
          expect(result.session).toMatchObject({
            lifecycle: "active",
            driverId: EPHEMERAL_CHROMIUM_DRIVER_ID,
            capabilities: {
              privateCheckpoint: false,
              identityPublication: false,
              linkedComputer: false,
            },
          });
          const replay = await app.request(path, {
            method: "POST",
            headers: auth,
            body: JSON.stringify(body),
          });
          expect(BrowserSessionMutationResponse.parse(await json(replay, 200)).session.id).toBe(
            result.session.id,
          );
          const changedMode = await app.request(path, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ ...body, storageMode: "private_profile" }),
          });
          expect(changedMode.status).toBe(409);
          if (label === "alpha") {
            const foreignReplay = await app.request(path, {
              method: "POST",
              headers: actors.b,
              body: JSON.stringify(body),
            });
            expect([403, 409]).toContain(foreignReplay.status);
          }
          const observed = await navigate(result.session.id, fixtureUrl, auth);
          expect(observed.target.title).toBe(`Cookie ${label} / Storage ${label}`);
          const capture = await app.request(
            `${path}/${result.session.id}/targets/${observed.target.id}/screenshot?format=png`,
            { headers: auth },
          );
          expect(capture.status).toBe(200);
          const png = new Uint8Array(await capture.arrayBuffer());
          expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
          expect(png.length).toBeGreaterThan(1_000);
          const evidenceDirectory = process.env.OPENGENI_EPHEMERAL_BROWSER_EVIDENCE_DIR;
          if (evidenceDirectory) {
            await mkdir(evidenceDirectory, { recursive: true });
            await Bun.write(join(evidenceDirectory, `${label}.png`), png);
          }
        }
        // Three contexts, two owners: siblings share a process; different owners do not.
        if (!containerId) throw new Error("expected exact disposable sandbox placement");
        const processCount = Bun.spawn(
          [
            ...(isolatedLocal ? [] : ["docker", "exec", containerId]),
            "python3",
            "-c",
            "import glob,json; args=[open(p,'rb').read().split(bytes([0])) for p in glob.glob('/proc/[0-9]*/cmdline')]; print(json.dumps(sum(any(a.startswith(b'--remote-debugging-port=') for a in v) and not any(a.startswith(b'--type=') for a in v) for v in args)))",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const countText = await new Response(processCount.stdout).text();
        expect(await processCount.exited).toBe(0);
        expect(JSON.parse(countText)).toBe(2);
        const [alpha, sibling, bravo] = created;
        const own = await observe(alpha!.session.id);
        const otherActorTarget = await observe(bravo!.session.id, actors.b);
        const otherActorRead = await app.request(
          `${path}/${alpha!.session.id}/targets/${otherActorTarget.target.id}/observation`,
          { headers: actors.a },
        );
        expect(otherActorRead.status).toBeGreaterThanOrEqual(400);
        expect(otherActorRead.status).toBeLessThan(500);
        const outsider = await headers("other-workspace-actor", crypto.randomUUID());
        const unauthorized = await app.request(`${path}/${alpha!.session.id}/targets`, {
          headers: outsider,
        });
        expect([401, 403, 404]).toContain(unauthorized.status);
        const foreign = await observe(sibling!.session.id);
        // A legitimate source-session actor still cannot aim one context at a peer target.
        const foreignRead = await app.request(
          `${path}/${alpha!.session.id}/targets/${foreign.target.id}/observation`,
          { headers: actors.a },
        );
        expect(foreignRead.status).toBeGreaterThanOrEqual(400);
        expect(foreignRead.status).toBeLessThan(500);
        const foreignAction = await post(alpha!.session.id, "/actions", {
          operationId: crypto.randomUUID(),
          targetId: foreign.target.id,
          expectedTargetGeneration: foreign.target.targetGeneration,
          expectedDocumentGeneration: foreign.target.documentGeneration,
          expectedFrameId: foreign.frameId,
          action: { type: "navigate", url: `${fixtureUrl}?set=corrupted` },
        });
        if (foreignAction.ok) {
          expect(BrowserActionReceipt.parse(await foreignAction.json()).state).not.toBe(
            "completed",
          );
        } else {
          expect(foreignAction.status).toBeGreaterThanOrEqual(400);
          expect(foreignAction.status).toBeLessThan(500);
        }
        expect((await observe(alpha!.session.id)).target.id).toBe(own.target.id);
        expect((await navigate(sibling!.session.id, fixtureUrl)).target.title).toBe(
          "Cookie sibling / Storage sibling",
        );
        const suspended = await post(alpha!.session.id, "/suspend", {
          operationId: crypto.randomUUID(),
        });
        expect(suspended.status).toBeGreaterThanOrEqual(400);
        expect(suspended.status).toBeLessThan(500);
        const ended = BrowserSessionMutationResponse.parse(
          await json(
            await post(alpha!.session.id, "/end", { operationId: crypto.randomUUID() }),
            200,
          ),
        );
        expect(ended.session.lifecycle).toBe("ended");
        expect((await navigate(sibling!.session.id, fixtureUrl)).target.title).toBe(
          "Cookie sibling / Storage sibling",
        );
        expect((await navigate(bravo!.session.id, fixtureUrl, actors.b)).target.title).toBe(
          "Cookie bravo / Storage bravo",
        );
      } catch (error) {
        primary = error;
      } finally {
        for (const browser of created) {
          try {
            const response = await post(
              browser.session.id,
              "/end",
              { operationId: crypto.randomUUID() },
              browser.headers,
            );
            if (!response.ok)
              cleanupErrors.push(
                new Error(`cleanup end returned ${response.status}: ${await response.text()}`),
              );
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        const evidenceDirectory = process.env.OPENGENI_EPHEMERAL_BROWSER_EVIDENCE_DIR;
        if (primary && evidenceDirectory && containerId) {
          await mkdir(evidenceDirectory, { recursive: true });
          const diagnostic = Bun.spawn(
            [
              ...(isolatedLocal ? [] : ["docker", "exec", containerId]),
              "sh",
              "-c",
              "tail -n 100 /tmp/opengeni-browserd/browserd.log 2>/dev/null || true",
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          await Bun.write(
            join(evidenceDirectory, "controller-failure.log"),
            await new Response(diagnostic.stdout).text(),
          );
          await diagnostic.exited;
        }
        fixture.stop(true);
        http.stop(true);
        if (!isolatedLocal && containerId && /^[a-f0-9]{64}$/u.test(containerId)) {
          const cleanup = Bun.spawn(["docker", "rm", "-f", containerId], {
            stdout: "pipe",
            stderr: "pipe",
          });
          if ((await cleanup.exited) !== 0)
            cleanupErrors.push(new Error(await new Response(cleanup.stderr).text()));
        }
      }
      if (primary || cleanupErrors.length)
        throw new AggregateError(
          [...(primary ? [primary] : []), ...cleanupErrors],
          "Ephemeral browser acceptance or cleanup failed",
        );
    },
    300_000,
  );
});
