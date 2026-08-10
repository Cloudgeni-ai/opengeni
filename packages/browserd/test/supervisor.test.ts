import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation, BrowserTarget } from "@opengeni/contracts";
import {
  BrowserSupervisor,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  restoreEncryptedBrowserProfile,
  type BrowserStateUploadAuthority,
  type BrowserSupervisorDriver,
  type BrowserSupervisorDriverContext,
} from "../src";

describe("BrowserSupervisor", () => {
  test.skipIf(process.platform === "win32")(
    "rejects a managed socket root before accepting sessions when Unix sockets cannot fit",
    async () => {
      await expect(
        BrowserSupervisor.open({
          rootDirectory: "/tmp/ogb-supervisor-capacity",
          socketRootDirectory: `/tmp/${"socket-root-too-long-".repeat(4)}`,
        }),
      ).rejects.toThrow(
        "agent-browser socket directory and identifiers exceed the Unix socket limit",
      );
    },
  );

  test("hosts independent sessions and journals each causal action", async () => {
    await withSupervisor(async ({ supervisor, contexts }) => {
      const first = reference(1);
      const second = reference(2);
      const [firstCreated, secondCreated] = await Promise.all([
        supervisor.createSession({
          ...first,
          headed: false,
          initialUrl: "https://one.test/",
        }),
        supervisor.createSession({
          ...second,
          headed: true,
          initialUrl: "https://two.test/",
        }),
      ]);
      expect(firstCreated.observation.target.url).toBe("https://one.test/");
      expect(secondCreated.observation.target.url).toBe("https://two.test/");
      expect(supervisor.listSessions()).toHaveLength(2);
      expect(contexts.get(first.browserSessionId)?.profileDirectory).not.toBe(
        contexts.get(second.browserSessionId)?.profileDirectory,
      );

      const receipt = await supervisor.action(command(firstCreated.observation));
      expect(receipt.state).toBe("completed");
      expect(supervisor.receipt(first, receipt.operationId)).toEqual(receipt);
      expect(
        await exists(
          join(contexts.get(first.browserSessionId)!.sessionDirectory, "operations.sqlite"),
        ),
      ).toBe(true);
    });
  });

  test("deduplicates concurrent creation and rejects stale or conflicting bindings", async () => {
    let factoryCalls = 0;
    await withSupervisor(
      async ({ supervisor }) => {
        const session = reference(1);
        const [first, second] = await Promise.all([
          supervisor.createSession({ ...session, headed: false }),
          supervisor.createSession({ ...session, headed: false }),
        ]);
        expect(first.browserSessionId).toBe(second.browserSessionId);
        expect(factoryCalls).toBe(1);
        expect(
          supervisor.createSession({
            ...session,
            controllerGeneration: "controller-stale",
            headed: false,
          }),
        ).rejects.toMatchObject({ code: "controller_stale" });
        expect(supervisor.createSession({ ...session, headed: true })).rejects.toMatchObject({
          code: "operation_conflict",
        });
      },
      {
        onFactory: () => {
          factoryCalls += 1;
        },
      },
    );
  });

  test("launches a headed browser inside one exact ComputerSession environment", async () => {
    await withSupervisor(async ({ supervisor, contexts }) => {
      const session = reference(1);
      const linkedComputer = {
        computerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        controllerGeneration: "computer-controller-1",
      };
      await supervisor.createSession({
        ...session,
        headed: true,
        linkedComputer,
        launchEnvironment: { DISPLAY: ":101", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
      });
      expect(contexts.get(session.browserSessionId)).toMatchObject({
        launchEnvironment: {
          DISPLAY: ":101",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
        },
      });
      await expect(
        supervisor.createSession({
          ...session,
          headed: true,
          linkedComputer: { ...linkedComputer, controllerGeneration: "computer-controller-2" },
          launchEnvironment: { DISPLAY: ":101" },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
    });
  });

  test("fences queued work during end and can remove all private session state", async () => {
    const firstDispatch = deferred();
    const release = deferred();
    let dispatches = 0;
    await withSupervisor(
      async ({ supervisor, contexts }) => {
        const session = reference(1);
        const created = await supervisor.createSession({
          ...session,
          headed: false,
        });
        const first = supervisor.action(command(created.observation, randomUUID()));
        await firstDispatch.promise;
        const queued = supervisor.action(command(created.observation, randomUUID()));
        const sessionDirectory = contexts.get(session.browserSessionId)!.sessionDirectory;
        const ended = supervisor.endSession(session, { removeState: true });
        release.resolve();
        await ended;
        await first;
        const queuedReceipt = await queued;
        expect(queuedReceipt.state).toBe("failed");
        expect(queuedReceipt.error?.code).toBe("resource_unavailable");
        expect(dispatches).toBe(1);
        expect(await exists(sessionDirectory)).toBe(false);
        await expect(supervisor.listTargets(session)).rejects.toMatchObject({
          code: "resource_not_found",
        });
      },
      {
        driverHooks: {
          async dispatch() {
            dispatches += 1;
            firstDispatch.resolve();
            await release.promise;
          },
        },
      },
    );
  });

  test("enforces placement capacity without evicting an active session", async () => {
    await withSupervisor(
      async ({ supervisor }) => {
        const first = reference(1);
        const second = reference(2);
        await supervisor.createSession({ ...first, headed: false });
        await expect(supervisor.createSession({ ...second, headed: false })).rejects.toMatchObject({
          code: "resource_unavailable",
          retryable: true,
        });
        await supervisor.endSession(first);
        expect(
          (await supervisor.createSession({ ...second, headed: false })).browserSessionId,
        ).toBe(second.browserSessionId);
      },
      { maxSessions: 1 },
    );
  });

  test("binds attached Chrome to one exact live profile generation", async () => {
    await withSupervisor(async ({ supervisor, contexts }) => {
      const session = reference(1);
      const transport = {
        kind: "attached_chrome" as const,
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        connectionGeneration: "chrome-generation-1",
        browserName: "Chrome",
        browserVersion: "151.0.0.0",
      };
      await expect(
        supervisor.createSession({ ...session, headed: false, transport }),
      ).rejects.toThrow("always headed");
      await supervisor.createSession({ ...session, headed: true, transport });
      expect(contexts.get(session.browserSessionId)?.transport).toEqual(transport);
      await expect(
        supervisor.captureState({
          ...session,
          operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          objectKey:
            "workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/publications/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/chromium-profile.ogbs",
          afterCapture: "restart",
          dataKey: Buffer.alloc(32),
          aad: Buffer.from("attached"),
          upload: uploadAuthority(),
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: {
            ...withoutProxyAuthority(proxyRoute()),
            kind: "direct",
            consistency: {
              ...proxyRoute().consistency,
              dns: "placement",
              webRtc: "proxy_only",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
    });
  });

  test("binds one exact proxy authority and permits only a secretless replay", async () => {
    await withSupervisor(async ({ supervisor, contexts }) => {
      const session = reference(1);
      const route = proxyRoute("http://user:password@proxy.test:8443/");
      await supervisor.createSession({ ...session, headed: false, networkRoute: route });
      expect(contexts.get(session.browserSessionId)?.networkRoute).toEqual(route);

      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: withoutProxyAuthority(route),
        }),
      ).resolves.toMatchObject(session);
      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: { ...route, authorityDigest: `ogr.${"z".repeat(43)}` },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: { ...route, proxyUrl: "http://user:other@proxy.test:8443/" },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
    });

    await withSupervisor(async ({ supervisor }) => {
      const session = reference(2);
      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: withoutProxyAuthority(proxyRoute()),
        }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: true });
    });
  });

  test("rejects route guarantees that its browser transport cannot provide", async () => {
    await withSupervisor(async ({ supervisor }) => {
      const session = reference(1);
      const transport = {
        kind: "attached_chrome" as const,
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        connectionGeneration: "chrome-generation-1",
        browserName: "Chrome",
        browserVersion: "151.0.0.0",
      };
      await expect(
        supervisor.createSession({
          ...session,
          headed: true,
          transport,
          networkRoute: proxyRoute(),
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
      await expect(
        supervisor.createSession({
          ...session,
          headed: false,
          networkRoute: {
            ...proxyRoute(),
            consistency: { ...proxyRoute().consistency, dns: "placement" },
          },
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
    });
  });

  test("quiesces, captures, restarts, uploads, and replays one exact profile revision", async () => {
    const key = Buffer.alloc(32, 7);
    const aad = Buffer.from("workspace:identity:operation", "utf8");
    let uploaded: Buffer | null = null;
    let uploads = 0;
    let factoryCalls = 0;
    await withSupervisor(
      async ({ supervisor, contexts }) => {
        const session = reference(1);
        const created = await supervisor.createSession({
          ...session,
          headed: false,
          initialUrl: "https://profile.test/",
        });
        const originalTarget = created.observation.target;
        const profileDirectory = contexts.get(session.browserSessionId)!.profileDirectory;
        await writeFile(join(profileDirectory, "Cookies"), "durable-cookie-state");
        const operationId = "22222222-2222-4222-8222-222222222222";
        const input = {
          ...session,
          operationId,
          objectKey: `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/publications/${operationId}/chromium-profile.ogbs`,
          afterCapture: "restart" as const,
          dataKey: key,
          aad,
          upload: uploadAuthority(),
        };
        const captured = await supervisor.captureState(input);
        expect(captured.manifest.tabs).toEqual([{ url: "https://profile.test/", selected: true }]);
        expect(uploads).toBe(1);
        expect(factoryCalls).toBe(2);
        expect(uploaded).not.toBeNull();

        const current = (await supervisor.listTargets(session))[0]!;
        expect(current.id).not.toBe(originalTarget.id);
        expect(current.targetGeneration).not.toBe(originalTarget.targetGeneration);
        const stale = await supervisor.action(
          command({
            ...created.observation,
            target: originalTarget,
          }),
        );
        expect(stale.state).toBe("failed");
        expect(stale.error?.code).toBe("target_not_found");

        expect(await supervisor.captureState(input)).toEqual(captured);
        expect(uploads).toBe(1);
        expect(factoryCalls).toBe(2);

        const uploadedPath = join(profileDirectory, "..", "uploaded.ogbs");
        const restored = join(profileDirectory, "..", "restored-profile");
        await writeFile(uploadedPath, uploaded!);
        await restoreEncryptedBrowserProfile({
          artifactPath: uploadedPath,
          outputProfileDirectory: restored,
          dataKey: key,
          aad,
          expectedArtifactDigest: captured.artifactDigest,
          expectedContentDigest: captured.contentDigest,
          expectedSizeBytes: captured.sizeBytes,
        });
        expect(await readFile(join(restored, "Cookies"), "utf8")).toBe("durable-cookie-state");
      },
      {
        onFactory: () => {
          factoryCalls += 1;
        },
        uploadArtifact: async (path) => {
          uploads += 1;
          uploaded = await readFile(path);
        },
      },
    );
  });

  test("quiesces, captures, and leaves one exact session stopped for durable suspension", async () => {
    const key = Buffer.alloc(32, 8);
    const aad = Buffer.from("workspace:session:suspension", "utf8");
    let uploads = 0;
    let factoryCalls = 0;
    await withSupervisor(
      async ({ supervisor, contexts }) => {
        const session = reference(9);
        await supervisor.createSession({
          ...session,
          headed: false,
          initialUrl: "https://suspend.test/",
        });
        const operationId = "99999999-9999-4999-8999-999999999999";
        const input = {
          ...session,
          operationId,
          objectKey: `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/checkpoints/${operationId}/chromium-profile.ogbs`,
          afterCapture: "stop" as const,
          dataKey: key,
          aad,
          upload: uploadAuthority(),
        };

        const captured = await supervisor.captureState(input);
        expect(captured.manifest.tabs).toEqual([{ url: "https://suspend.test/", selected: true }]);
        expect(supervisor.listSessions()).toEqual([]);
        expect(uploads).toBe(1);
        expect(factoryCalls).toBe(1);

        const unavailable = await supervisor.listTargets(session).catch((error) => error);
        expect(unavailable).toMatchObject({ code: "resource_unavailable" });
        expect(await supervisor.captureState(input)).toEqual(captured);
        expect(uploads).toBe(1);
        expect(factoryCalls).toBe(1);

        await supervisor.endSession(session, { removeState: true });
        expect(await exists(contexts.get(session.browserSessionId)!.sessionDirectory)).toBe(false);
      },
      {
        onFactory: () => {
          factoryCalls += 1;
        },
        uploadArtifact: async () => {
          uploads += 1;
        },
      },
    );
  });

  test("restores one immutable profile into a fresh session and binds exact retries", async () => {
    const key = Buffer.alloc(32, 7);
    const aad = Buffer.from("workspace:identity:restored-revision", "utf8");
    let uploaded: Buffer | null = null;
    let engineVersion = "140.0.0.0";
    await withSupervisor(
      async ({ supervisor, contexts }) => {
        const source = reference(1);
        await supervisor.createSession({
          ...source,
          headed: false,
          initialUrl: "https://authenticated.test/account",
        });
        const sourceProfile = contexts.get(source.browserSessionId)!.profileDirectory;
        await writeFile(join(sourceProfile, "Cookies"), "session=durable");
        await writeFile(join(sourceProfile, "Local State"), "identity-state");
        const operationId = "33333333-3333-4333-8333-333333333333";
        const objectKey = `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/revisions/${operationId}/chromium-profile.ogbs`;
        const captured = await supervisor.captureState({
          ...source,
          operationId,
          objectKey,
          afterCapture: "restart",
          dataKey: key,
          aad,
          upload: uploadAuthority(),
        });
        expect(uploaded).not.toBeNull();
        await supervisor.endSession(source, { removeState: true });

        const storage = Bun.serve({
          port: 0,
          fetch() {
            return new Response(new Uint8Array(uploaded!), {
              headers: { "content-length": String(uploaded!.byteLength) },
            });
          },
        });
        const target = reference(2);
        const materialization = {
          portability:
            captured.manifest.profileCrypto === "platform_bound"
              ? ("placement_bound" as const)
              : ("portable" as const),
          reason:
            captured.manifest.profileCrypto === "platform_bound"
              ? "Profile encryption depends on this placement."
              : null,
          platform: captured.manifest.platform,
          architecture: captured.manifest.architecture,
          engine: captured.manifest.engine,
          engineVersion: captured.manifest.engineVersion,
          driverId: captured.manifest.driverId,
          driverSchemaVersion: captured.manifest.driverSchemaVersion,
          profileCrypto: captured.manifest.profileCrypto,
          providerId: null,
          placement:
            captured.manifest.profileCrypto === "platform_bound"
              ? {
                  kind: "sandbox_group" as const,
                  sandboxGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                }
              : null,
        };
        const restore = {
          objectKey,
          format: captured.format,
          artifactDigest: captured.artifactDigest,
          contentDigest: captured.contentDigest,
          manifestDigest: canonicalDigest(captured.manifest),
          sizeBytes: captured.sizeBytes,
          dataKey: key,
          aad,
          materialization,
          download: {
            url: `${storage.url}/profile?signature=first`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
        try {
          const restored = await supervisor.createSession({
            ...target,
            headed: false,
            restore,
          });
          expect(restored.observation.target.url).toBe("https://authenticated.test/account");
          const targetProfile = contexts.get(target.browserSessionId)!.profileDirectory;
          expect(await readFile(join(targetProfile, "Cookies"), "utf8")).toBe("session=durable");
          expect(await readFile(join(targetProfile, "Local State"), "utf8")).toBe("identity-state");

          expect(
            (
              await supervisor.createSession({
                ...target,
                headed: false,
                restore: {
                  ...restore,
                  download: {
                    ...restore.download,
                    url: `${storage.url}/profile?signature=renewed`,
                  },
                },
              })
            ).browserSessionId,
          ).toBe(target.browserSessionId);
          await expect(
            supervisor.createSession({
              ...target,
              headed: false,
              restore: { ...restore, dataKey: Buffer.alloc(32, 8) },
            }),
          ).rejects.toMatchObject({ code: "operation_conflict" });

          const invalid = reference(3);
          await expect(
            supervisor.createSession({
              ...invalid,
              headed: false,
              restore: { ...restore, dataKey: Buffer.alloc(32, 8) },
            }),
          ).rejects.toMatchObject({ code: "driver_failed" });
          expect(
            await exists(
              join(supervisor.rootDirectory, "sessions", invalid.browserSessionId, "profile"),
            ),
          ).toBe(false);

          engineVersion = "141.0.0.0";
          const incompatible = reference(4);
          await expect(
            supervisor.createSession({
              ...incompatible,
              headed: false,
              restore,
            }),
          ).rejects.toThrow("saved browser state requires another Chromium build");
          expect(
            await exists(
              join(supervisor.rootDirectory, "sessions", incompatible.browserSessionId, "profile"),
            ),
          ).toBe(false);
        } finally {
          storage.stop(true);
        }
      },
      {
        driverHooks: { engineVersion: () => engineVersion },
        uploadArtifact: async (path) => {
          uploaded = await readFile(path);
        },
      },
    );
  });
});

async function withSupervisor(
  callback: (fixture: {
    supervisor: BrowserSupervisor;
    contexts: Map<string, BrowserSupervisorDriverContext>;
  }) => Promise<void>,
  options: {
    maxSessions?: number;
    onFactory?: () => void;
    driverHooks?: {
      dispatch?: () => void | Promise<void>;
      engineVersion?: () => string;
    };
    uploadArtifact?: (path: string, authority: BrowserStateUploadAuthority) => Promise<void>;
  } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-supervisor-");
  const contexts = new Map<string, BrowserSupervisorDriverContext>();
  let driverInstance = 0;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: join(directory, "sockets"),
    ...(options.maxSessions ? { maxSessions: options.maxSessions } : {}),
    createDriver: async (context) => {
      options.onFactory?.();
      contexts.set(context.browserSessionId, context);
      driverInstance += 1;
      return fakeDriver(context, options.driverHooks, driverInstance);
    },
    ...(options.uploadArtifact ? { uploadArtifact: options.uploadArtifact } : {}),
  });
  try {
    await callback({ supervisor, contexts });
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeDriver(
  context: BrowserSupervisorDriverContext,
  hooks: {
    dispatch?: () => void | Promise<void>;
    engineVersion?: () => string;
  } = {},
  instance = 1,
): BrowserSupervisorDriver {
  const target: BrowserTarget = {
    id: `target-${context.browserSessionId}-${instance}`,
    browserSessionId: context.browserSessionId,
    controllerGeneration: context.controllerGeneration,
    targetGeneration: `target-${instance}`,
    documentGeneration: `document-${instance}`,
    kind: "page",
    title: "Fixture",
    url: "about:blank",
    selected: true,
    attached: true,
    createdAt: "2026-08-09T12:00:00.000Z",
  };
  let closed = false;
  const observation = (): BrowserObservation => ({
    protocolVersion: 1,
    observationId: randomUUID(),
    browserSessionId: context.browserSessionId,
    target: { ...target },
    frameId: "frame-1",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: "2026-08-09T12:00:00.000Z",
  });
  const requireOpen = () => {
    if (closed) throw new Error("driver closed");
  };
  return {
    async start(url) {
      requireOpen();
      target.url = url ?? "about:blank";
      return observation();
    },
    async target(targetId) {
      requireOpen();
      return targetId === target.id ? { ...target } : null;
    },
    async listTargets() {
      requireOpen();
      return [{ ...target }];
    },
    async openTarget(url) {
      requireOpen();
      target.url = url ?? "about:blank";
      return observation();
    },
    async selectTarget() {
      requireOpen();
      return observation();
    },
    async closeTarget() {
      requireOpen();
      return [];
    },
    async observe() {
      requireOpen();
      return observation();
    },
    async dispatch() {
      requireOpen();
      await hooks.dispatch?.();
      return observation();
    },
    async protectedFill() {
      requireOpen();
      return { target: { ...target }, status: "submitted" };
    },
    async captureScreenshot() {
      requireOpen();
      return {
        frameId: randomUUID(),
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        targetId: target.id,
        targetGeneration: target.targetGeneration,
        documentGeneration: target.documentGeneration!,
        sequence: 1,
        mediaType: "image/png",
        width: 1,
        height: 1,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
        capturedAt: "2026-08-09T12:00:00.000Z",
        data: new Uint8Array([1]),
      };
    },
    async subscribeFrames() {
      throw new Error("unused");
    },
    async debug() {
      requireOpen();
      return {
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        targetId: target.id,
        targetGeneration: target.targetGeneration,
        entries: [],
        cursor: 0,
        truncated: false,
      };
    },
    async runtimeSnapshot() {
      requireOpen();
      return {
        engine: "chromium" as const,
        engineVersion: hooks.engineVersion?.() ?? "140.0.0.0",
        tabs: [{ url: target.url, selected: target.selected }],
      };
    },
    async close() {
      closed = true;
    },
  };
}

function reference(sequence: number) {
  return {
    browserSessionId: `11111111-1111-4111-8111-${sequence.toString().padStart(12, "0")}`,
    controllerGeneration: `controller-${sequence}`,
  };
}

function proxyRoute(proxyUrl = "http://user:password@proxy.test:8443/") {
  return {
    routeId: "22222222-2222-4222-8222-222222222222",
    routeVersion: 1,
    authorityDigest: `ogr.${"a".repeat(43)}`,
    kind: "proxy" as const,
    consistency: {
      dns: "proxy" as const,
      expectedPublicIp: null,
      expectedRegion: null,
      locale: "en-US",
      timezone: "Europe/Oslo",
      geolocation: { latitude: 59.9139, longitude: 10.7522, accuracyMeters: 50 },
      webRtc: "disable_non_proxied_udp" as const,
      stability: "session" as const,
    },
    proxyUrl,
  };
}

function withoutProxyAuthority(route: ReturnType<typeof proxyRoute>) {
  const { proxyUrl: _proxyUrl, ...authority } = route;
  return authority;
}

function command(
  observation: BrowserObservation,
  operationId = randomUUID(),
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId,
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    actor: { kind: "system", subjectId: "fixture" },
    action: { type: "click", locator: { kind: "ref", ref: "e1" } },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function uploadAuthority(): BrowserStateUploadAuthority {
  return {
    url: "https://storage.test/upload?signature=fixture",
    requiredHeaders: { "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
